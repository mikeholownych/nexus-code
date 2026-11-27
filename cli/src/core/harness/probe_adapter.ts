import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { wrapSandboxedCommand } from "../../sandbox.js";
import { runProbeProcess, scrubProbeEnv } from "./probe_process.js";
import { copyProbeTree } from "./probe_tree.js";
import { HarnessStore } from "./store.js";
import { writeProbeArtifacts } from "./probe_artifacts.js";
import type { HirTaskCase, ProbeResult } from "./types.js";

export interface ProbeInput {
  runId: string;
  candidateId: string;
  candidatePath: string;
  case: HirTaskCase;
  timeoutMs: number;
  store?: HarnessStore;
  signal?: AbortSignal;
}

export interface ProbeAdapter {
  run(input: ProbeInput): Promise<ProbeResult>;
}

export class MockProbeAdapter implements ProbeAdapter {
  async run(input: ProbeInput): Promise<ProbeResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hir-mock-"));
    const work = path.join(workspace, "candidate");
    try {
      copyProbeTree(input.candidatePath, work);
      let verifierPass: boolean | null = null;
      let status: ProbeResult["status"] = "SUCCEEDED";
      let observations: string[] = ["mock_probe_isolated_workspace=true"];
      let score: number | null = null;
      let stdout = "";
      let stderr = "";

      if (input.case.expected?.verifierCommand) {
        const sandboxed = wrapSandboxedCommand(input.case.expected.verifierCommand, work, { mode: "auto", network: false });
        if (!sandboxed.sandboxed || !sandboxed.argv?.length) {
          status = "BLOCKED";
          verifierPass = null;
          observations.push(`os_sandbox_unavailable:${sandboxed.warning ?? sandboxed.denial?.reason ?? "no sandbox engine"}`);
          observations.push("mock verifier blocked: OS sandbox required; task-suite commands are untrusted data");
        } else {
          observations.push(`os_sandbox=${sandboxed.engine}`);
          const probeId = `hprobe_${randomUUID()}`;
          const containerName = sandboxed.engine === "docker" ? `nexus-hir-${probeId.slice(-24)}` : undefined;
          const args = sandboxed.argv.slice(1);
          if (containerName && sandboxed.argv[0] === "docker" && args[0] === "run") args.splice(1, 0, "--name", containerName);
          const r = await runProbeProcess(sandboxed.argv[0], args, {
            cwd: work,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
            env: scrubProbeEnv(),
            ...(containerName ? { dockerContainerName: containerName } : {}),
          });
          stdout = r.stdout;
          stderr = r.stderr;
          verifierPass = r.cancelled || r.timedOut || r.error ? null : r.status === 0;
          status = r.cancelled ? "CANCELLED" : r.timedOut ? "TIMED_OUT" : r.status === 0 ? "SUCCEEDED" : "FAILED";
          observations.push(`verifier_exit=${String(r.status)}`);
          if (r.error) observations.push(`error:${r.error}`);
        }
        score = verifierPass === null ? null : verifierPass ? 1 : 0;
      } else if (input.case.expected?.artifactPath) {
        const p = path.resolve(work, input.case.expected.artifactPath);
        const rel = path.relative(work, p);
        const ok = !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(p);
        verifierPass = ok;
        status = ok ? "SUCCEEDED" : "FAILED";
        observations.push(ok ? "artifact_present" : "artifact_missing");
        score = ok ? 1 : 0;
      } else {
        verifierPass = null;
        status = "SUCCEEDED";
        observations.push("no_deterministic_oracle");
        score = null;
      }

      const endedAt = new Date().toISOString();
      const result: ProbeResult = {
        schemaVersion: 1,
        id: `hprobe_${randomUUID()}`,
        runId: input.runId,
        candidateId: input.candidateId,
        caseId: input.case.id,
        status,
        startedAt,
        endedAt,
        metrics: { wallClockMs: Date.now() - start, tokens: 0, toolErrors: status === "FAILED" || status === "TIMED_OUT" ? 1 : 0, verifierPass, score },
        artifacts: {},
        observations,
      };
      return input.store ? writeProbeArtifacts(input.store, result, { stdout: stdout || observations.join("\n") + "\n", stderr }) : result;
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
