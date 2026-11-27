import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../durable_file.js";
import { wrapSandboxedCommand } from "../../sandbox.js";
import { runProbeProcess, scrubProbeEnv } from "./probe_process.js";
import { copyProbeTree } from "./probe_tree.js";
import { writeProbeArtifacts } from "./probe_artifacts.js";
import type { ProbeResult } from "./types.js";
import type { ProbeAdapter, ProbeInput } from "./probe_adapter.js";
import { AutonomousAgent } from "../../agent.js";
import type { HarnessConfig } from "../../types.js";
import type { TurnResult } from "../turn.js";
import { resolveCoreBinary } from "../../tools.js";

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
  createAgent?: (config: HarnessConfig, workspace: string) => { run: (prompt: string, signal?: AbortSignal) => Promise<TurnResult>; shutdown?: () => void };
  resolveConfig?: (input: ProbeInput) => NexusAgentProbeOptions | undefined;
  resolveCoreBinary?: () => string | undefined;
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
      copyProbeTree(input.candidatePath, candidateWork);
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
      const coreBinaryPath = this.opts.createAgent ? undefined : (this.opts.resolveCoreBinary ?? resolveCoreBinary)();
      if (!this.opts.createAgent) {
        if (!cfg) {
          const blocked: ProbeResult = {
            schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
            status: "BLOCKED", startedAt, endedAt: new Date().toISOString(),
            metrics: { wallClockMs: Date.now() - started, tokens: 0, toolErrors: 0, verifierPass: null, score: null },
            artifacts: {}, observations: ["nexus agent probe config unavailable; provide model/endpoint or injected createAgent"],
          };
          return input.store ? writeProbeArtifacts(input.store, blocked, { stderr: blocked.observations.join("\n") + "\n" }) : blocked;
        }
        if (!coreBinaryPath) {
          const blocked: ProbeResult = {
            schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
            status: "BLOCKED", startedAt, endedAt: new Date().toISOString(),
            metrics: { wallClockMs: Date.now() - started, tokens: 0, toolErrors: 0, verifierPass: null, score: null },
            artifacts: {}, observations: ["harness-core binary not found; build core or set NEXUS_CORE_BIN before running Nexus agent probes"],
          };
          return input.store ? writeProbeArtifacts(input.store, blocked, { stderr: blocked.observations.join("\n") + "\n" }) : blocked;
        }
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
        ...(coreBinaryPath ? { coreBinaryPath } : {}),
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
              const a = new AutonomousAgent(agentCfg, 1, { durable: false });
              return { run: (prompt: string, signal?: AbortSignal) => a.run(prompt, undefined, { signal }), shutdown: () => a.shutdown() };
            })();
        try {
          turn = await agent.run(input.case.prompt, input.signal);
          trajectory += JSON.stringify({
            type: "turn",
            execution: (turn as any).execution,
            outcome: (turn as any).outcome,
            reason: (turn as any).reason,
            detail: (turn as any).detail,
            steps: (turn as any).steps,
            continuation: (turn as any).continuation,
            capacity: (turn as any).capacity,
            usage: (turn as any).usage,
          }) + "\n";
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
      if (turn) {
        observations.push(
          `turn_execution=${(turn as any).execution ?? ""}`,
          `turn_outcome=${(turn as any).outcome ?? ""}`,
          `turn_reason=${(turn as any).reason ?? ""}`,
          `turn_steps=${String((turn as any).steps?.used ?? "")}`,
          `turn_tool_invocations=${String((turn as any).continuation?.toolInvocations ?? "")}`,
        );
      }
      observations.push(`sandbox=${String((agentCfg as any).sandbox ?? "auto")}`, `network=${String((agentCfg as any).sandboxNetwork ?? false)}`);

      const turnTokens = Number((turn as any)?.usage?.totalTokens ?? (turn as any)?.usage?.promptTokens ?? 0);
      const turnToolErrors = Number((turn as any)?.continuation?.toolInvocations != null && (turn as any)?.execution !== "COMPLETED" ? 1 : 0);
      let verifierPass: boolean | null = null;
      const turnOk = !!turn && (turn as any).execution === "COMPLETED";
      let status: ProbeResult["status"] = input.signal?.aborted ? "CANCELLED" : turnOk ? "SUCCEEDED" : "FAILED";
      let toolErrors = input.signal?.aborted ? 0 : turnOk ? 0 : Math.max(1, turnToolErrors);
      let score: number | null = null;
      let stdout = "";
      let stderr = "";
      const cmd = input.case.expected?.verifierCommand;
      if (cmd && !input.signal?.aborted) {
        const sandboxed = wrapSandboxedCommand(cmd, candidateWork, { mode: "auto", network: false });
        if (!sandboxed.sandboxed || !sandboxed.argv?.length) {
          status = "BLOCKED";
          verifierPass = null;
          toolErrors = 0;
          score = null;
          observations.push(`os_sandbox_unavailable:${sandboxed.warning ?? sandboxed.denial?.reason ?? "no sandbox engine"}`);
        } else {
          const probeId = `hprobe_${randomUUID()}`;
          const containerName = sandboxed.engine === "docker" ? `nexus-hir-${probeId.slice(-24)}` : undefined;
          const args = sandboxed.argv.slice(1);
          if (containerName && sandboxed.argv[0] === "docker" && args[0] === "run") args.splice(1, 0, "--name", containerName);
          const r = await runProbeProcess(sandboxed.argv[0], args, {
            cwd: candidateWork, timeoutMs: input.timeoutMs, signal: input.signal, env: scrubProbeEnv(),
            ...(containerName ? { dockerContainerName: containerName } : {}),
          });
          stdout = r.stdout;
          stderr = r.stderr;
          verifierPass = r.cancelled || r.timedOut || r.error ? null : r.status === 0;
          status = r.cancelled ? "CANCELLED" : r.timedOut ? "TIMED_OUT" : r.status === 0 ? "SUCCEEDED" : "FAILED";
          toolErrors = status === "FAILED" || status === "TIMED_OUT" ? 1 : 0;
          score = verifierPass === null ? null : verifierPass ? 1 : 0;
          observations.push(`os_sandbox=${sandboxed.engine}`, `verifier_exit=${String(r.status)}`);
          if (r.error) observations.push(`error:${r.error}`);
        }
      } else if (input.case.expected?.artifactPath && !input.signal?.aborted) {
        const p = path.resolve(candidateWork, input.case.expected.artifactPath);
        const rel = path.relative(candidateWork, p);
        const ok = !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(p);
        verifierPass = ok; status = ok ? "SUCCEEDED" : "FAILED"; toolErrors = ok ? 0 : 1; score = ok ? 1 : 0;
        observations.push(ok ? "artifact_present" : "artifact_missing");
      }

      const result: ProbeResult = {
        schemaVersion: 1, id: `hprobe_${randomUUID()}`, runId: input.runId, candidateId: input.candidateId, caseId: input.case.id,
        status, startedAt, endedAt: new Date().toISOString(),
        metrics: { wallClockMs: Date.now() - started, tokens: Number.isFinite(turnTokens) ? turnTokens : 0, toolErrors, verifierPass, score },
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
