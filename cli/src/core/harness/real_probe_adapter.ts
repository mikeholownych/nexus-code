import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { wrapSandboxedCommand } from "../../sandbox.js";
import { runProbeProcess, scrubProbeEnv } from "./probe_process.js";
import { copyProbeTree } from "./probe_tree.js";
import { writeProbeArtifacts } from "./probe_artifacts.js";
import type { ProbeResult } from "./types.js";
import type { ProbeAdapter, ProbeInput } from "./probe_adapter.js";

export interface RealProbeAdapterOptions {
  allowUnsandboxed?: boolean;
}

export class RealProbeAdapter implements ProbeAdapter {
  constructor(private readonly opts: RealProbeAdapterOptions = {}) {}

  async run(input: ProbeInput): Promise<ProbeResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hir-probe-"));
    const candidateWork = path.join(workspace, "candidate");
    try {
      copyProbeTree(input.candidatePath, candidateWork);
      let verifierPass: boolean | null = null;
      let status: ProbeResult["status"] = "SUCCEEDED";
      let observations: string[] = [`isolated_workspace=${workspace}`];
      let score: number | null = null;
      let toolErrors = 0;
      let stdout = "";
      let stderr = "";

      const cmd = input.case.expected?.verifierCommand;
      if (cmd) {
        const sandboxed = wrapSandboxedCommand(cmd, candidateWork, { mode: "auto", network: false });
        const useSandbox = sandboxed.sandboxed && !!sandboxed.argv?.length;
        if (!useSandbox && !this.opts.allowUnsandboxed) {
          const blocked: ProbeResult = {
            schemaVersion: 1,
            id: `hprobe_${randomUUID()}`,
            runId: input.runId,
            candidateId: input.candidateId,
            caseId: input.case.id,
            status: "BLOCKED",
            startedAt,
            endedAt: new Date().toISOString(),
            metrics: { wallClockMs: Date.now() - start, tokens: 0, toolErrors: 0, verifierPass: null, score: null },
            artifacts: {},
            observations: [
              `os_sandbox_unavailable:${sandboxed.warning ?? sandboxed.denial?.reason ?? "no sandbox engine"}`,
              "real probe blocked: OS sandbox required; rerun only with explicit owner-approved --allow-unsandboxed-real-probe",
            ],
          };
          return input.store ? writeProbeArtifacts(input.store, blocked, { stderr: blocked.observations.join("\n") + "\n" }) : blocked;
        }
        observations.push(useSandbox ? `os_sandbox=${sandboxed.engine}` : "os_sandbox=UNSANDBOXED_EXPLICIT_OVERRIDE");
        const probeId = `hprobe_${randomUUID()}`;
        const containerName = useSandbox && sandboxed.engine === "docker" ? `nexus-hir-${probeId.slice(-24)}` : undefined;
        const file = useSandbox ? sandboxed.argv![0] : (process.platform === "win32" ? "bash" : "/bin/bash");
        const args = useSandbox ? sandboxed.argv!.slice(1) : ["-lc", cmd];
        if (containerName && file === "docker" && args[0] === "run") args.splice(1, 0, "--name", containerName);
        const r = await runProbeProcess(file, args, {
          cwd: candidateWork,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          env: scrubProbeEnv(),
          ...(containerName ? { dockerContainerName: containerName } : {}),
        });
        stdout = r.stdout;
        stderr = r.stderr;
        verifierPass = r.cancelled || r.timedOut || r.error ? null : r.status === 0;
        status = r.cancelled ? "CANCELLED" : r.timedOut ? "TIMED_OUT" : r.status === 0 ? "SUCCEEDED" : "FAILED";
        toolErrors = status === "FAILED" || status === "TIMED_OUT" ? 1 : 0;
        observations.push(`verifier_exit=${String(r.status)}`);
        if (r.error) observations.push(`error:${r.error}`);
        score = verifierPass === null ? null : verifierPass ? 1 : 0;
      } else if (input.case.expected?.artifactPath) {
        const p = path.resolve(candidateWork, input.case.expected.artifactPath);
        const rel = path.relative(candidateWork, p);
        const ok = !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(p);
        verifierPass = ok;
        status = ok ? "SUCCEEDED" : "FAILED";
        toolErrors = ok ? 0 : 1;
        observations.push(ok ? "artifact_present" : "artifact_missing");
        score = ok ? 1 : 0;
      } else {
        verifierPass = null;
        status = "BLOCKED";
        observations.push("no_deterministic_oracle; real probe requires verifierCommand or artifactPath");
        score = null;
      }

      const endedAt = new Date().toISOString();
      const cleanObs = observations.filter((o) => typeof o === "string");
      const result: ProbeResult = {
        schemaVersion: 1,
        id: `hprobe_${randomUUID()}`,
        runId: input.runId,
        candidateId: input.candidateId,
        caseId: input.case.id,
        status,
        startedAt,
        endedAt,
        metrics: { wallClockMs: Date.now() - start, tokens: 0, toolErrors, verifierPass, score },
        artifacts: {},
        observations: cleanObs,
      };
      return input.store ? writeProbeArtifacts(input.store, result, { stdout: stdout || cleanObs.join("\n") + "\n", stderr }) : result;
    } catch (err) {
      const result: ProbeResult = {
        schemaVersion: 1,
        id: `hprobe_${randomUUID()}`,
        runId: input.runId,
        candidateId: input.candidateId,
        caseId: input.case.id,
        status: "FAILED",
        startedAt,
        endedAt: new Date().toISOString(),
        metrics: { wallClockMs: Date.now() - start, tokens: 0, toolErrors: 1, verifierPass: null, score: null },
        artifacts: {},
        observations: [`error:${err instanceof Error ? err.message : String(err)}`],
      };
      return input.store ? writeProbeArtifacts(input.store, result, { stderr: result.observations.join("\n") + "\n" }) : result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}
