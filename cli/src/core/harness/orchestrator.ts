import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessStore } from "./store.js";
import { snapshotHarnessFromPath } from "./snapshot.js";
import { snapshotHarnessFromProfile } from "./profile_snapshot.js";
import { loadTaskSuiteFile } from "./task_suite.js";
import { gateCandidateTree } from "./gate.js";
import { MockProbeAdapter, type ProbeAdapter } from "./probe_adapter.js";
import { RealProbeAdapter } from "./real_probe_adapter.js";
import { compareProbes } from "./compare.js";
import { composeDecision } from "./compose.js";
import { buildPromotionReport, renderPromotionReportMd } from "./report.js";
import { draftLibraryEntriesFromReport } from "./library.js";
import { recordEvidence, recordEvent } from "./events.js";
import { assertValid, validateHirRun } from "./schema.js";
import type { HarnessCandidate, HarnessImprovementRun, ProbeResult } from "./types.js";

export interface HirInitOptions {
  taskSuitePath: string;
  basePath: string;
  baseKind?: "fixture" | "path" | "profile";
  store?: HarnessStore;
  runId?: string;
  baseHarnessId?: string;
  maxProbes?: number;
  maxWallClockMs?: number;
  maxProbeWallClockMs?: number;
}

export interface HirRunOptions {
  store?: HarnessStore;
  mock?: boolean;
  real?: boolean;
  dryRun?: boolean;
  candidatePath?: string; // optional explicit candidate for MVP
  adapter?: ProbeAdapter;
  allowUnsandboxedRealProbe?: boolean;
}

function nowIso() { return new Date().toISOString(); }

function defaultBudgets(opts: HirInitOptions) {
  return {
    maxRounds: 1,
    maxCandidatesPerRound: 1,
    maxProbes: opts.maxProbes ?? 4,
    maxWallClockMs: opts.maxWallClockMs ?? 60_000,
    maxProbeWallClockMs: opts.maxProbeWallClockMs ?? 30_000,
    maxConcurrentProbes: 1,
  };
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
    const run = store.loadRun(runId);
    if (["COMPLETED", "CANCELLED", "FAILED"].includes(run.status)) return run;
    if (!opts.mock && !opts.real && !opts.adapter) {
      run.status = "BLOCKED";
      run.reason = "Select a probe adapter: use --mock for deterministic mock probes, or --real for isolated real probes (requires deterministic verifier/artifact expectations).";
      run.nextAction = "Use `nexus harness run <id> --mock` or `--real`. HIR never mutates live harness state.";
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
    const adapter = opts.adapter ?? (opts.real ? new RealProbeAdapter({ allowUnsandboxed }) : new MockProbeAdapter());
    const baseManifest = store.loadBaseManifest(run.baseHarnessId);
    const suite = store.loadTaskSuite(run.taskSuiteRef);
    const started = Date.now();
    if (opts.dryRun) {
      run.status = "COMPLETED";
      run.reason = "Dry run: validated inputs, base snapshot, task suite, and gate plan; no probes executed.";
      run.nextAction = "Run without --dry-run to execute probes.";
      run.updatedAt = nowIso();
      store.saveRun(run);
      recordEvent(store, run.id, "hir.completed", run.reason, { dryRun: true, mock: !!opts.mock, real: !!opts.real, cases: suite.cases.length });
      return run;
    }
    run.status = "PROBING";
    run.updatedAt = nowIso();
    store.saveRun(run);
    recordEvent(store, run.id, "hir.started", `Started HIR ${run.id}`, { mock: !!opts.mock, real: !!opts.real, dryRun: !!opts.dryRun, allowUnsandboxedRealProbe: !!opts.allowUnsandboxedRealProbe });

    // MVP: baseline = base tree, candidate = explicit candidatePath or base tree copy.
    const baseTree = path.join(store.baseDir(baseManifest.id), "tree");
    const candidatePath = opts.candidatePath ? path.resolve(opts.candidatePath) : baseTree;
    const candidateId = `hcand_${randomUUID()}`;
    const gate = await gateCandidateTree({ baseManifest, candidatePath, policy: run.policy });
    recordEvidence(store, run.id, { kind: "gate", subjectId: candidateId, summary: `Gate ${gate.status}`, refs: [], confidence: "high", deterministic: true });
    const candidate: HarnessCandidate = {
      schemaVersion: 1, id: candidateId, runId: run.id, round: 1, baseHarnessId: baseManifest.id,
      treeRef: candidatePath, diffRef: "", proposal: { source: "imported", rationale: opts.candidatePath ? "explicit candidate" : "baseline self-candidate", targetWeaknesses: [] },
      gate,
    };
    store.saveCandidate(candidate);
    run.candidateIds.push(candidateId);
    if (gate.status === "FAIL") {
      run.status = "BLOCKED";
      run.reason = "Candidate failed structural gate";
      run.nextAction = "Inspect gate findings and provide a compliant candidate.";
      run.updatedAt = nowIso();
      store.saveRun(run);
      recordEvent(store, run.id, "candidate.gate_failed", run.reason, { findings: gate.findings });
      return run;
    }

    const baseProbes: ProbeResult[] = [];
    const candProbes: ProbeResult[] = [];
    for (const c of suite.cases) {
      if (run.actualUsage.probes + 2 > run.budgets.maxProbes) {
        run.status = "BLOCKED";
        run.reason = "HIR probe budget exhausted";
        run.nextAction = "Increase maxProbes or reduce suite size.";
        recordEvent(store, run.id, "hir.blocked", run.reason, { maxProbes: run.budgets.maxProbes, actualProbes: run.actualUsage.probes });
        break;
      }
      const b = await adapter.run({ runId: run.id, candidateId: "base", candidatePath: baseTree, case: c, timeoutMs: run.budgets.maxProbeWallClockMs });
      const p = await adapter.run({ runId: run.id, candidateId, candidatePath, case: c, timeoutMs: run.budgets.maxProbeWallClockMs });
      baseProbes.push(b); candProbes.push(p);
      store.saveProbe(b); store.saveProbe(p);
      run.probeIds.push(b.id, p.id);
      run.actualUsage.probes += 2;
      recordEvidence(store, run.id, { kind: "probe", subjectId: b.id, summary: `base ${c.id} ${b.status}`, refs: [b.id], confidence: "high", deterministic: b.metrics.verifierPass !== null });
      recordEvidence(store, run.id, { kind: "probe", subjectId: p.id, summary: `candidate ${c.id} ${p.status}`, refs: [p.id], confidence: "high", deterministic: p.metrics.verifierPass !== null });
      if (Date.now() - started > run.budgets.maxWallClockMs) {
        run.status = "BLOCKED";
        run.reason = "HIR wall-clock budget exhausted";
        run.nextAction = "Increase maxWallClockMs or reduce suite.";
        break;
      }
    }

    const scorecard = compareProbes(baseProbes, candProbes, candidateId);
    const decision = composeDecision(candidateId, scorecard);
    recordEvidence(store, run.id, { kind: "comparison", subjectId: candidateId, summary: `decision=${decision.recommendation}`, refs: [], confidence: "medium", deterministic: true });
    const report = buildPromotionReport({
      id: `hprom_${randomUUID()}`,
      runId: run.id,
      baseHarnessId: run.baseHarnessId,
      candidateId,
      decision,
      scorecard,
    });
    const md = renderPromotionReportMd(report);
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
    recordEvent(store, run.id, "promotion.report.created", `Report ${report.id} created`, { recommendation: decision.recommendation });
    recordEvent(store, run.id, run.status === "COMPLETED" ? "hir.completed" : "hir.blocked", `HIR ${run.status}`);
    return run;
  }

  cancel(runId: string, reason = "Cancelled by operator"): HarnessImprovementRun {
    const run = this.store.loadRun(runId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return run;
    run.status = "CANCELLED";
    run.reason = reason;
    run.updatedAt = nowIso();
    this.store.saveRun(run);
    recordEvent(this.store, run.id, "hir.cancelled", reason);
    return run;
  }
}
