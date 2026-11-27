import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../durable_file.js";
import { writeProbeArtifacts } from "./probe_artifacts.js";
import type { ProbeResult } from "./types.js";
import type { ProbeAdapter, ProbeInput } from "./probe_adapter.js";
import { AutonomousAgent } from "../../agent.js";
import type { HarnessConfig } from "../../types.js";
import type { TurnResult } from "../turn.js";

export interface NexusAgentProbeOptions {
  model: string;
  endpoint: string;
  apiKey?: string;
  maxSteps?: number;
  temperature?: number;
  sandbox?: "auto" | "bwrap" | "docker" | "none";
  network?: boolean;
}

export interface NexusAgentProbeAdapterOptions {
  createAgent?: (config: HarnessConfig, workspace: string) => { run: (prompt: string) => Promise<TurnResult>; shutdown?: () => void };
  resolveConfig?: (input: ProbeInput) => NexusAgentProbeOptions | undefined;
}

function copyDir(src: string, dst: string): void {
  ensurePrivateDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const lst = fs.lstatSync(s);
    if (lst.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      const rel = path.relative(path.resolve(src), real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`symlink escapes probe source: ${s}`);
      if (fs.statSync(real).isDirectory()) copyDir(real, d);
      else { ensurePrivateDir(path.dirname(d)); fs.copyFileSync(real, d); }
      continue;
    }
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) { ensurePrivateDir(path.dirname(d)); fs.copyFileSync(s, d); }
  }
}

function scrubEnv(): NodeJS.ProcessEnv {
  const allow = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "SHELL"]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k) && typeof v === "string") out[k] = v;
  }
  out.NEXUS_HIR_PROBE = "1";
  out.NEXUS_HIR_LIVE_MUTATION = "0";
  return out;
}

function hasDeterministicOracle(input: ProbeInput): boolean {
  return Boolean(input.case.expected?.verifierCommand || input.case.expected?.artifactPath);
}

export class NexusAgentProbeAdapter implements ProbeAdapter {
  constructor(private readonly opts: NexusAgentProbeAdapterOptions = {}) {}

  async run(input: ProbeInput): Promise<ProbeResult> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hir-nexus-probe-"));
    const candidateWork = path.join(tempRoot, "work");
    try {
      copyDir(input.candidatePath, candidateWork);
      if (!hasDeterministicOracle(input)) {
        const blocked: ProbeResult = {
          schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
          status: "BLOCKED", startedAt, endedAt: new Date().toISOString(),
          metrics: { wallClockMs: Date.now() - started, tokens: 0, toolErrors: 0, verifierPass: null, score: null },
          artifacts: {}, observations: ["no_deterministic_oracle; nexus agent probe requires verifierCommand or artifactPath"],
        };
        return input.store ? writeProbeArtifacts(input.store, blocked, { stderr: blocked.observations.join("\n") + "\n" }) : blocked;
      }

      const cfg = this.opts.resolveConfig?.(input);
      if (!cfg && !this.opts.createAgent) {
        const blocked: ProbeResult = {
          schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
          status: "BLOCKED", startedAt, endedAt: new Date().toISOString(),
          metrics: { wallClockMs: Date.now() - started, tokens: 0, toolErrors: 0, verifierPass: null, score: null },
          artifacts: {}, observations: ["nexus agent probe config unavailable; provide model/endpoint or injected createAgent"],
        };
        return input.store ? writeProbeArtifacts(input.store, blocked, { stderr: blocked.observations.join("\n") + "\n" }) : blocked;
      }

      const tempHome = path.join(tempRoot, "home");
      ensurePrivateDir(tempHome);
      const stateDir = path.join(tempHome, ".nexus", "state");
      const agentCfg: HarnessConfig = {
        model: cfg?.model ?? "test-model",
        endpoint: cfg?.endpoint ?? "http://127.0.0.1:1/v1",
        apiKey: cfg?.apiKey,
        maxSteps: cfg?.maxSteps ?? 8,
        temperature: cfg?.temperature ?? 0,
        workspace: candidateWork,
        shell: "bash",
        approvalMode: "auto",
        fullAccess: true,
        sandbox: cfg?.sandbox ?? "auto",
        sandboxNetwork: cfg?.network ?? false,
      } as any;

      const prevHome = process.env.HOME;
      const prevState = process.env.NEXUS_STATE_DIR;
      process.env.HOME = tempHome;
      process.env.NEXUS_STATE_DIR = stateDir;
      let turn: TurnResult | undefined;
      let trajectory = "";
      let agentErr: unknown;
      try {
        const agent = this.opts.createAgent
          ? this.opts.createAgent(agentCfg, candidateWork)
          : (() => {
              const a = new AutonomousAgent(agentCfg);
              return { run: (prompt: string) => a.run(prompt), shutdown: () => a.shutdown() };
            })();
        try {
          turn = await agent.run(input.case.prompt);
          trajectory += JSON.stringify({ type: "turn", execution: (turn as any).execution, outcome: (turn as any).outcome, reason: (turn as any).reason, detail: (turn as any).detail }) + "\n";
        } finally {
          try { agent.shutdown?.(); } catch {}
        }
      } catch (err) {
        agentErr = err;
      } finally {
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
        if (prevState === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = prevState;
      }

      const observations: string[] = [];
      if (agentErr) observations.push(`agent_error:${agentErr instanceof Error ? agentErr.message : String(agentErr)}`);
      if (turn) observations.push(`turn_execution=${(turn as any).execution ?? ""}`, `turn_outcome=${(turn as any).outcome ?? ""}`, `turn_reason=${(turn as any).reason ?? ""}`);

      let verifierPass: boolean | null = null;
      const turnOk = !!turn && (turn as any).execution === "COMPLETED";
      let status: ProbeResult["status"] = turnOk ? "SUCCEEDED" : "FAILED";
      let toolErrors = turnOk ? 0 : 1;
      let score: number | null = null;
      let stdout = "";
      let stderr = "";
      const cmd = input.case.expected?.verifierCommand;
      if (cmd) {
        const r = spawnSync("bash", ["-lc", cmd], { cwd: candidateWork, encoding: "utf8", timeout: input.timeoutMs, env: scrubEnv(), maxBuffer: 1024 * 1024 });
        stdout = r.stdout ?? "";
        stderr = r.stderr ?? "";
        verifierPass = r.status === 0;
        status = r.signal === "SIGTERM" ? "TIMED_OUT" : r.status === 0 ? "SUCCEEDED" : "FAILED";
        toolErrors = r.status === 0 ? 0 : 1;
        score = r.status === 0 ? 1 : 0;
        observations.push(`verifier_exit=${String(r.status)}`);
      } else if (input.case.expected?.artifactPath) {
        const p = path.resolve(candidateWork, input.case.expected.artifactPath);
        const rel = path.relative(candidateWork, p);
        const ok = !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(p);
        verifierPass = ok; status = ok ? "SUCCEEDED" : "FAILED"; toolErrors = ok ? 0 : 1; score = ok ? 1 : 0;
        observations.push(ok ? "artifact_present" : "artifact_missing");
      }

      const result: ProbeResult = {
        schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
        status, startedAt, endedAt: new Date().toISOString(),
        metrics: { wallClockMs: Date.now() - started, tokens: 0, toolErrors, verifierPass, score },
        artifacts: {}, observations,
      };
      return input.store ? writeProbeArtifacts(input.store, result, { stdout, stderr, trajectory }) : result;
    } catch (err) {
      const result: ProbeResult = {
        schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
        status: "FAILED", startedAt, endedAt: new Date().toISOString(),
        metrics: { wallClockMs: Date.now() - started, tokens: 0, toolErrors: 1, verifierPass: null, score: null },
        artifacts: {}, observations: [`error:${err instanceof Error ? err.message : String(err)}`],
      };
      return input.store ? writeProbeArtifacts(input.store, result, { stderr: result.observations.join("\n") + "\n" }) : result;
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
