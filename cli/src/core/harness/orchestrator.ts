import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir, writeFileDurably } from "../durable_file.js";
import { HarnessStore } from "./store.js";
import { snapshotHarnessFromPath } from "./snapshot.js";
import { snapshotHarnessFromProfile } from "./profile_snapshot.js";
import { loadTaskSuiteFile } from "./task_suite.js";
import { gateCandidateTree } from "./gate.js";
import { MockProbeAdapter, type ProbeAdapter } from "./probe_adapter.js";
import { RealProbeAdapter } from "./real_probe_adapter.js";
import { NexusAgentProbeAdapter } from "./nexus_agent_probe_adapter.js";
import { compareProbes } from "./compare.js";
import { composeDecision } from "./compose.js";
import { buildPromotionReport, renderPromotionReportMd } from "./report.js";
import { draftLibraryEntriesFromReport, retrieveRelevantLibraryEntries } from "./library.js";
import { recordEvidence, recordEvent } from "./events.js";
import { reflectCandidate, type ReflectionSummary } from "./reflection.js";
import { NoopProposalAdapter, type ProposalAdapter } from "./proposal_adapter.js";
import { NexusModelProposalAdapter } from "./nexus_model_proposal_adapter.js";
import { copyProbeTree } from "./probe_tree.js";
import { assertValid, validateHirRun } from "./schema.js";
import type { HarnessCandidate, HarnessImprovementRun, ProbeResult, ScorecardEntry } from "./types.js";

export interface HirInitOptions {
  taskSuitePath: string;
  basePath: string;
  baseKind?: "fixture" | "path" | "profile";
  store?: HarnessStore;
  runId?: string;
  baseHarnessId?: string;
  maxRounds?: number;
  maxProbes?: number;
  maxWallClockMs?: number;
  maxProbeWallClockMs?: number;
  maxCandidatesPerRound?: number;
}

export interface HirRunOptions {
  store?: HarnessStore;
  mock?: boolean;
  real?: boolean;
  nexusAgent?: boolean;
  nexusPropose?: boolean;
  dryRun?: boolean;
  candidatePath?: string; // explicit candidate; may be passed repeatedly by CLI
  candidatePaths?: string[];
  adapter?: ProbeAdapter;
  proposalAdapter?: ProposalAdapter;
  allowUnsandboxedRealProbe?: boolean;
  signal?: AbortSignal;
  nexusAgentConfig?: { model: string; endpoint: string; apiKey?: string; maxSteps?: number; temperature?: number; sandbox?: "auto" | "bwrap" | "docker" | "none"; network?: boolean };
  nexusProposalConfig?: { model: string; endpoint: string; apiKey?: string; maxSteps?: number; temperature?: number; sandbox?: "auto" | "bwrap" | "docker" | "none"; network?: boolean };
}

function nowIso() { return new Date().toISOString(); }

function defaultBudgets(opts: HirInitOptions) {
  return {
    maxRounds: Math.max(1, opts.maxRounds ?? 1),
    maxCandidatesPerRound: Math.max(1, opts.maxCandidatesPerRound ?? 4),
    maxProbes: Math.max(1, opts.maxProbes ?? 8),
    maxWallClockMs: Math.max(1, opts.maxWallClockMs ?? 60_000),
    maxProbeWallClockMs: Math.max(1, opts.maxProbeWallClockMs ?? 30_000),
    maxConcurrentProbes: 1,
  };
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function ensureCandidateTree(store: HarnessStore, candidateId: string, sourcePath: string): string {
  const abs = path.resolve(sourcePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`candidate path missing or not directory: ${abs}`);
  const dir = store.candidateDir(candidateId);
  const treeDir = path.join(dir, "tree");
  fs.rmSync(treeDir, { recursive: true, force: true });
  copyProbeTree(abs, treeDir);
  return treeDir;
}

function buildDiffRef(store: HarnessStore, baseTree: string, candidateId: string, candidateTree: string): string {
  const baseFiles = new Map<string, string>();
  const candFiles = new Map<string, string>();
  const walk = (root: string, dir: string, out: Map<string, string>) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      const lst = fs.lstatSync(full);
      if (lst.isSymbolicLink() || !lst.isFile() && !lst.isDirectory()) continue;
      if (e.isDirectory()) { walk(root, full, out); continue; }
      if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        out.set(rel, fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(baseTree, baseTree, baseFiles);
  walk(candidateTree, candidateTree, candFiles);
  const all = Array.from(new Set([...baseFiles.keys(), ...candFiles.keys()])).sort();
  const lines: string[] = [];
  for (const rel of all) {
    const b = baseFiles.get(rel);
    const c = candFiles.get(rel);
    if (b === c) continue;
    if (b === undefined) lines.push(`+++ ${rel}\n${c}`);
    else if (c === undefined) lines.push(`--- ${rel}\n${b}`);
    else lines.push(`*** ${rel}\n--- base\n${b}\n+++ candidate\n${c}`);
  }
  const diff = lines.join("\n\n").slice(0, 256 * 1024);
  const dir = store.candidateDir(candidateId);
  ensurePrivateDir(dir);
  const diffPath = path.join(dir, "diff.txt");
  writeFileDurably(diffPath, diff + (diff ? "\n" : ""), 0o600);
  return diffPath;
}

function defaultPolicy() {
  return {
    allowLiveProfileMutation: false as const,
    allowRepoMutation: false as const,
    allowNetwork: false as const,
    redactSecrets: true as const,
    approvalModePinned: "pinned" as const,
  };
}

export class HarnessOrchestrator {
  readonly store: HarnessStore;
  constructor(store = new HarnessStore()) { this.store = store; }

  async init(opts: HirInitOptions): Promise<HarnessImprovementRun> {
    const store = opts.store ?? this.store;
    const suite = loadTaskSuiteFile(opts.taskSuitePath);
    const suiteRef = store.saveTaskSuite(suite);
    const runId = opts.runId ?? `hir_${randomUUID()}`;
    const baseHarnessId = opts.baseHarnessId ?? `harn_${randomUUID()}`;
    const baseKind = opts.baseKind ?? "path";
    const baseManifest = baseKind === "profile"
      ? await snapshotHarnessFromProfile({ profilePath: opts.basePath, store, id: baseHarnessId })
      : await snapshotHarnessFromPath({ sourcePath: path.resolve(opts.basePath), store, id: baseHarnessId, sourceKind: baseKind, sourceRef: path.resolve(opts.basePath) });
    const run: HarnessImprovementRun = {
      schemaVersion: 1,
      id: runId,
      status: "CREATED",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      baseHarnessId: baseManifest.id,
      taskSuiteRef: suiteRef,
      budgets: defaultBudgets(opts),
      policy: defaultPolicy(),
      rounds: [],
      candidateIds: [],
      probeIds: [],
      evidenceIds: [],
      actualUsage: { probes: 0, wallClockMs: 0, tokens: 0 },
      nextAction: "Run `nexus harness run <id> --mock` to evaluate with deterministic mock probes.",
    };
    assertValid("run", run, validateHirRun);
    store.saveRun(run);
    recordEvent(store, run.id, "hir.created", `Created HIR ${run.id}`, { baseHarnessId: baseManifest.id, taskSuiteRef: suiteRef });
    return run;
  }

  load(runId: string): HarnessImprovementRun { return this.store.loadRun(runId); }

  async run(runId: string, opts: HirRunOptions = {}): Promise<HarnessImprovementRun> {
    const store = opts.store ?? this.store;
    const cancellation = new AbortController();
    const poll = setInterval(() => {
      if (store.cancellationRequested(runId)) cancellation.abort(new Error("HIR cancellation requested"));
    }, 50);
    poll.unref?.();
    const signal = opts.signal ? AbortSignal.any([opts.signal, cancellation.signal]) : cancellation.signal;
    try {
      return await this.runInternal(runId, { ...opts, store, signal });
    } finally {
      clearInterval(poll);
    }
  }

  private async runInternal(runId: string, opts: HirRunOptions): Promise<HarnessImprovementRun> {
    const store = opts.store ?? this.store;
    const run = store.loadRun(runId);
    if (["COMPLETED", "CANCELLED", "FAILED"].includes(run.status)) return run;
    if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
    if (!opts.mock && !opts.real && !opts.nexusAgent && !opts.adapter) {
      run.status = "BLOCKED";
      run.reason = "Select a probe adapter: use --mock, --real, or --nexus-agent (deterministic oracle required).";
      run.nextAction = "Use `nexus harness run <id> --mock`, `--real`, or `--nexus-agent`. HIR never mutates live harness state.";
      run.updatedAt = nowIso();
      store.saveRun(run);
      recordEvent(store, run.id, "hir.blocked", run.reason);
      return run;
    }
    const allowUnsandboxed = !!opts.allowUnsandboxedRealProbe && process.env.NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE === "1";
    if (opts.allowUnsandboxedRealProbe && !allowUnsandboxed) {
      run.status = "BLOCKED";
      run.reason = "Unsafe real-probe override requires NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE=1 in addition to --allow-unsandboxed-real-probe.";
      run.nextAction = "Set NEXUS_ALLOW_UNSANDBOXED_HIR_PROBE=1 only for owner-approved unsafe debugging, or run with OS sandbox available.";
      run.updatedAt = nowIso();
      store.saveRun(run);
      recordEvent(store, run.id, "hir.blocked", run.reason);
      return run;
    }
    const adapter = opts.adapter
      ?? (opts.nexusAgent ? new NexusAgentProbeAdapter({ resolveConfig: () => opts.nexusAgentConfig }) : opts.real ? new RealProbeAdapter({ allowUnsandboxed }) : new MockProbeAdapter());
    const proposalAdapter = opts.proposalAdapter
      ?? (opts.nexusPropose ? new NexusModelProposalAdapter({ resolveConfig: () => opts.nexusProposalConfig }) : new NoopProposalAdapter());
    const baseManifest = store.loadBaseManifest(run.baseHarnessId);
    const suite = store.loadTaskSuite(run.taskSuiteRef);
    const started = Date.now();
    if (opts.dryRun) {
      const baseTree = path.join(store.baseDir(baseManifest.id), "tree");
      const candidateInputs = (opts.candidatePaths && opts.candidatePaths.length > 0)
        ? opts.candidatePaths.map((p) => path.resolve(p))
        : (opts.candidatePath ? [path.resolve(opts.candidatePath)] : [baseTree]);
      const uniqueCandidates = Array.from(new Set(candidateInputs)).slice(0, run.budgets.maxCandidatesPerRound);
      const gates = [];
      for (const candidatePath of uniqueCandidates) {
        if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
        const gate = await gateCandidateTree({ baseManifest, candidatePath, policy: run.policy });
        gates.push({ candidatePath, status: gate.status, findings: gate.findings.length });
      }
      run.status = "COMPLETED";
      run.reason = "Dry run: validated inputs, base snapshot, task suite, and gate plan; no probes executed.";
      run.nextAction = "Run without --dry-run to execute probes.";
      run.updatedAt = nowIso();
      store.saveRun(run);
      recordEvent(store, run.id, "hir.completed", run.reason, { dryRun: true, mock: !!opts.mock, real: !!opts.real, cases: suite.cases.length, candidates: uniqueCandidates.length, gates });
      return run;
    }
    run.status = "PROBING";
    run.updatedAt = nowIso();
    store.saveRun(run);
    recordEvent(store, run.id, "hir.started", `Started HIR ${run.id}`, { mock: !!opts.mock, real: !!opts.real, dryRun: !!opts.dryRun, allowUnsandboxedRealProbe: !!opts.allowUnsandboxedRealProbe });

    const baseTree = path.join(store.baseDir(baseManifest.id), "tree");
    const requestedInputs = (opts.candidatePaths && opts.candidatePaths.length > 0)
      ? opts.candidatePaths.map((p) => path.resolve(p))
      : (opts.candidatePath ? [path.resolve(opts.candidatePath)] : [baseTree]);
    const uniqueRequested = Array.from(new Set(requestedInputs));
    const totalCandidateBudget = Math.max(1, run.budgets.maxRounds * run.budgets.maxCandidatesPerRound);

    const candidates: HarnessCandidate[] = [];
    const baseProbeByCase = new Map<string, ProbeResult>();
    const allScorecards: ScorecardEntry[] = [];
    const allReflections: ReflectionSummary[] = [];
    const decisions: Array<{ candidateId: string; round: number; decision: ReturnType<typeof composeDecision>; scorecard: ScorecardEntry[] }> = [];
    let usedCandidates = 0;

    for (let round = 1; round <= run.budgets.maxRounds; round++) {
      if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
      const remaining = totalCandidateBudget - usedCandidates;
      if (remaining <= 0) {
        recordEvent(store, run.id, "hir.warning", "Candidate budget exhausted before round", { round, totalCandidateBudget });
        break;
      }
      let roundInputs = round === 1 ? uniqueRequested : [baseTree];
      if (round > 1) {
        const libraryEntries = retrieveRelevantLibraryEntries(store, { baseHarnessId: baseManifest.id, limit: 5, statuses: ["accepted", "draft"] });
        const proposals = await proposalAdapter.propose({
          signal: opts.signal,
          run,
          suite,
          baseTree,
          round,
          priorCandidates: candidates.map((c) => ({ id: c.id, treeRef: c.treeRef, diffRef: c.diffRef })),
          priorProbes: run.probeIds.map((id) => { try { return store.loadProbe(id); } catch { return undefined; } }).filter(Boolean) as ProbeResult[],
          priorScorecards: allScorecards,
          priorReflections: allReflections,
          libraryEntries,
        });
        if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
        if (proposals.length > 0) {
          roundInputs = proposals.map((p) => path.resolve(p.candidatePath));
          recordEvent(store, run.id, "hir.proposals", `Round ${round} received ${proposals.length} proposal(s)`, { round, proposals: proposals.map((p) => ({ candidatePath: p.candidatePath, source: p.source, rationale: p.rationale, targetWeaknesses: p.targetWeaknesses })) });
        } else {
          recordEvent(store, run.id, "hir.proposals.empty", `Round ${round} had no proposals; using baseline self-candidate`, { round });
        }
      }
      const capped = roundInputs.slice(0, Math.min(run.budgets.maxCandidatesPerRound, remaining));
      if (round === 1 && uniqueRequested.length > capped.length) {
        recordEvent(store, run.id, "hir.warning", "Candidate inputs capped by budgets", { requested: uniqueRequested.length, used: capped.length, maxCandidatesPerRound: run.budgets.maxCandidatesPerRound, maxRounds: run.budgets.maxRounds });
      }
      const roundRecord: import("./types.js").HirRound & { probeIds: string[]; scorecard: ScorecardEntry[] } = {
        round,
        status: "RUNNING",
        baselineProbeIds: [],
        candidateIds: [],
        probeIds: [],
        scorecard: [],
        startedAt: nowIso(),
      };
      run.rounds.push(roundRecord);
      run.status = round === 1 ? "PROBING" : "PROPOSING";
      run.updatedAt = nowIso();
      store.saveRun(run);
      recordEvent(store, run.id, "hir.round.started", `Round ${round} started`, { round, candidates: capped.length });

      const roundCandidates: HarnessCandidate[] = [];
      for (const candidatePath of capped) {
        if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
        const candidateId = `hcand_${randomUUID()}`;
        const gate = await gateCandidateTree({ baseManifest, candidatePath, policy: run.policy });
        recordEvidence(store, run.id, { kind: "gate", subjectId: candidateId, summary: `Gate ${gate.status}`, refs: [], confidence: "high", deterministic: true });
        let treeRef = candidatePath;
        let diffRef = "";
        if (gate.status === "PASS") {
          treeRef = ensureCandidateTree(store, candidateId, candidatePath);
          diffRef = buildDiffRef(store, baseTree, candidateId, treeRef);
        }
        const candidate: HarnessCandidate = {
          schemaVersion: 1,
          id: candidateId,
          runId: run.id,
          round,
          baseHarnessId: baseManifest.id,
          treeRef,
          diffRef,
          proposal: { source: round === 1 ? "imported" : "agent", rationale: candidatePath === baseTree ? "baseline self-candidate" : `round ${round} candidate`, targetWeaknesses: [] },
          gate,
        };
        store.saveCandidate(candidate);
        candidates.push(candidate);
        roundCandidates.push(candidate);
        roundRecord.candidateIds.push(candidateId);
        run.candidateIds.push(candidateId);
        usedCandidates += 1;
        if (gate.status === "FAIL") {
          recordEvent(store, run.id, "candidate.gate_failed", `Candidate ${candidateId} failed gate`, { findings: gate.findings, candidatePath, round });
        }
      }

      if (roundCandidates.length === 0) {
        roundRecord.completedAt = nowIso();
        roundRecord.status = "FAILED";
        continue;
      }

      const gated = roundCandidates.filter((c) => c.gate.status === "PASS");
      if (gated.length === 0) {
        roundRecord.completedAt = nowIso();
        roundRecord.status = "BLOCKED";
        recordEvent(store, run.id, "hir.round.blocked", `Round ${round} had no gated candidates`, { round });
        if (round === 1) {
          run.status = "BLOCKED";
          run.reason = "All candidates failed structural gate";
          run.nextAction = "Inspect candidate gate findings and provide compliant candidates.";
          run.updatedAt = nowIso();
          store.saveRun(run);
          recordEvent(store, run.id, "hir.blocked", run.reason, { candidateIds: roundCandidates.map((c) => c.id) });
          return run;
        }
        continue;
      }

      for (const candidate of gated) {
        const candProbes: ProbeResult[] = [];
        const baseProbes: ProbeResult[] = [];
        const candidateTree = candidate.treeRef;
        for (const c of suite.cases) {
          if (Date.now() - started > run.budgets.maxWallClockMs) {
            run.status = "BLOCKED";
            run.reason = "HIR wall-clock budget exhausted";
            run.nextAction = "Increase maxWallClockMs or reduce suite/candidates/rounds.";
            break;
          }
          let b = baseProbeByCase.get(c.id);
          if (!b) {
            if (run.actualUsage.probes + 1 > run.budgets.maxProbes) {
              run.status = "BLOCKED"; run.reason = "HIR probe budget exhausted"; run.nextAction = "Increase maxProbes or reduce suite/candidates/rounds."; break;
            }
            b = await adapter.run({ runId: run.id, candidateId: "base", candidatePath: baseTree, case: c, timeoutMs: run.budgets.maxProbeWallClockMs, store, signal: opts.signal });
            store.saveProbe(b);
            run.probeIds.push(b.id);
            roundRecord.probeIds.push(b.id);
            if (!roundRecord.baselineProbeIds.includes(b.id)) roundRecord.baselineProbeIds.push(b.id);
            run.actualUsage.probes += 1;
            recordEvidence(store, run.id, { kind: "probe", subjectId: b.id, summary: `base ${c.id} ${b.status}`, refs: [b.id], confidence: "high", deterministic: b.metrics.verifierPass !== null });
            if (opts.signal?.aborted || store.cancellationRequested(runId) || b.status === "CANCELLED") return this.cancelInStore(runId, store);
            if (b.status === "BLOCKED" || b.status === "TIMED_OUT" || (b.status === "FAILED" && b.metrics.verifierPass === null)) {
              run.status = "BLOCKED";
              run.reason = `Required baseline probe ${b.id} did not complete with usable evidence (${b.status}).`;
              run.nextAction = "Resolve the probe failure or sandbox requirement, then start a new HIR run.";
              run.actualUsage.wallClockMs += Date.now() - started;
              run.updatedAt = nowIso();
              store.saveRun(run);
              recordEvent(store, run.id, "hir.blocked", run.reason, { probeId: b.id, probeStatus: b.status });
              return run;
            }
            baseProbeByCase.set(c.id, b);
          }
          if (run.actualUsage.probes + 1 > run.budgets.maxProbes) {
            run.status = "BLOCKED"; run.reason = "HIR probe budget exhausted"; run.nextAction = "Increase maxProbes or reduce suite/candidates/rounds."; break;
          }
          const p = await adapter.run({ runId: run.id, candidateId: candidate.id, candidatePath: candidateTree, case: c, timeoutMs: run.budgets.maxProbeWallClockMs, store, signal: opts.signal });
          candProbes.push(p);
          baseProbes.push(b);
          store.saveProbe(p);
          run.probeIds.push(p.id);
          roundRecord.probeIds.push(p.id);
          run.actualUsage.probes += 1;
          recordEvidence(store, run.id, { kind: "probe", subjectId: p.id, summary: `candidate ${candidate.id} ${c.id} ${p.status}`, refs: [p.id], confidence: "high", deterministic: p.metrics.verifierPass !== null });
          if (opts.signal?.aborted || store.cancellationRequested(runId) || p.status === "CANCELLED") return this.cancelInStore(runId, store);
          if (p.status === "BLOCKED" || p.status === "TIMED_OUT" || (p.status === "FAILED" && p.metrics.verifierPass === null)) {
            run.status = "BLOCKED";
            run.reason = `Required candidate probe ${p.id} did not complete with usable evidence (${p.status}).`;
            run.nextAction = "Resolve the probe failure or sandbox requirement, then start a new HIR run.";
            run.actualUsage.wallClockMs += Date.now() - started;
            run.updatedAt = nowIso();
            store.saveRun(run);
            recordEvent(store, run.id, "hir.blocked", run.reason, { probeId: p.id, probeStatus: p.status });
            return run;
          }
        }
        const scorecard = compareProbes(baseProbes, candProbes, candidate.id);
        roundRecord.scorecard.push(...scorecard);
        allScorecards.push(...scorecard);
        const decision = composeDecision(candidate.id, scorecard);
        decisions.push({ candidateId: candidate.id, round, decision, scorecard });
        recordEvidence(store, run.id, { kind: "comparison", subjectId: candidate.id, summary: `decision=${decision.recommendation}`, refs: [], confidence: "medium", deterministic: true });
        const reflection = reflectCandidate({ candidateId: candidate.id, round, recommendation: decision.recommendation, scorecard, probes: candProbes });
        allReflections.push(reflection);
        recordEvidence(store, run.id, { kind: "reflection", subjectId: candidate.id, summary: `reflection ${decision.recommendation}; strengths=${reflection.strengths.length}; weaknesses=${reflection.weaknesses.length}`, refs: reflection.evidenceIds, confidence: "medium", deterministic: false });
        recordEvent(store, run.id, "hir.reflection", `Reflection for ${candidate.id}`, reflection as unknown as Record<string, unknown>);
        if (run.status === "BLOCKED") break;
      }
      roundRecord.completedAt = nowIso();
      roundRecord.status = run.status === "BLOCKED" ? "BLOCKED" : "COMPLETED";
      store.saveRun(run);
      recordEvent(store, run.id, "hir.round.completed", `Round ${round} completed`, { round, candidates: roundRecord.candidateIds.length, probes: roundRecord.probeIds.length, blocked: run.status === "BLOCKED" });
      if (run.status === "BLOCKED") break;
      const roundHasBetter = decisions.some((d) => d.round === round && d.scorecard.some((s) => s.dimension === "correctness" && s.verdict === "better"));
      if (roundHasBetter) {
        recordEvent(store, run.id, "hir.early_stop", "Deterministic improvement found; stopping further rounds", { round });
        break;
      }
    }

    if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
    const rank = (r: "apply" | "review" | "reject" | "defer") => ({ apply: 4, review: 3, defer: 2, reject: 1 }[r]);
    const betterCount = (sc: ScorecardEntry[]) => sc.filter((s) => s.dimension === "correctness" && s.verdict === "better").length;
    const worseCount = (sc: ScorecardEntry[]) => sc.filter((s) => s.dimension === "correctness" && s.verdict === "worse").length;
    const picked = decisions.sort((a, b) => {
      const rd = rank(b.decision.recommendation) - rank(a.decision.recommendation);
      if (rd !== 0) return rd;
      const bd = betterCount(b.scorecard) - betterCount(a.scorecard);
      if (bd !== 0) return bd;
      return worseCount(a.scorecard) - worseCount(b.scorecard);
    })[0];
    const report = buildPromotionReport({
      id: `hprom_${randomUUID()}`,
      runId: run.id,
      baseHarnessId: run.baseHarnessId,
      candidateId: picked?.candidateId,
      decision: picked?.decision ?? { recommendation: "defer", reasons: ["no candidate decision available"] },
      scorecard: allScorecards,
      candidates: candidates.map((c) => ({ id: c.id, diffRef: c.diffRef, gateStatus: c.gate.status })),
    });
    const md = renderPromotionReportMd(report);
    if (opts.signal?.aborted || store.cancellationRequested(runId)) return this.cancelInStore(runId, store);
    store.saveReport(run.id, report, md);
    run.promotionReportId = report.id;
    draftLibraryEntriesFromReport(store, report);
    if (run.status !== "BLOCKED") {
      run.status = "COMPLETED";
      run.nextAction = "Review promotion report; HIR does not apply changes.";
    }
    run.actualUsage.wallClockMs += Date.now() - started;
    run.updatedAt = nowIso();
    store.saveRun(run);
    recordEvent(store, run.id, "promotion.report.created", `Report ${report.id} created`, { recommendation: report.status, candidateId: picked?.candidateId, candidates: candidates.length });
    recordEvent(store, run.id, run.status === "COMPLETED" ? "hir.completed" : "hir.blocked", `HIR ${run.status}`);
    return run;
  }

  cancel(runId: string, reason = "Cancelled by operator"): HarnessImprovementRun {
    return this.cancelInStore(runId, this.store, reason);
  }

  private cancelInStore(runId: string, store: HarnessStore, reason = "Cancelled by operator"): HarnessImprovementRun {
    const run = store.loadRun(runId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return run;
    store.requestCancellation(runId);
    run.status = "CANCELLED";
    run.reason = reason;
    run.updatedAt = nowIso();
    store.saveRun(run);
    recordEvent(store, run.id, "hir.cancelled", reason);
    return run;
  }
}
