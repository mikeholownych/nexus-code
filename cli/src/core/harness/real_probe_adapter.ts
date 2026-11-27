import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../durable_file.js";
import { isSandboxAvailable, wrapSandboxedCommand } from "../../sandbox.js";
import { writeProbeArtifacts } from "./probe_artifacts.js";
import type { ProbeResult } from "./types.js";
import type { ProbeAdapter, ProbeInput } from "./probe_adapter.js";

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
  const allow = new Set(["PATH","HOME","USER","SHELL","LANG","LC_ALL","TERM","TMPDIR","TMP","TEMP","NODE_ENV"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k)) env[k] = v;
  }
  env.NEXUS_HIR_PROBE = "1";
  env.NEXUS_HIR_LIVE_MUTATION = "0";
  return env;
}

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
      copyDir(input.candidatePath, candidateWork);
      let verifierPass: boolean | null = null;
      let status: ProbeResult["status"] = "SUCCEEDED";
      let observations: string[] = [`isolated_workspace=${workspace}`];
      let score: number | null = null;
      let toolErrors = 0;

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
        const r = useSandbox
          ? spawnSync(sandboxed.argv![0], sandboxed.argv!.slice(1), {
              cwd: candidateWork,
              encoding: "utf8",
              timeout: input.timeoutMs,
              env: scrubEnv(),
              maxBuffer: 1024 * 1024,
            })
          : spawnSync("bash", ["-lc", cmd], {
              cwd: candidateWork,
              encoding: "utf8",
              timeout: input.timeoutMs,
              env: scrubEnv(),
              maxBuffer: 1024 * 1024,
            });
        verifierPass = r.status === 0;
        status = r.signal === "SIGTERM" ? "TIMED_OUT" : r.status === 0 ? "SUCCEEDED" : "FAILED";
        toolErrors = r.status === 0 ? 0 : 1;
        observations.push(`verifier_exit=${String(r.status)}`);
        if (r.error) observations.push(`error:${r.error.message}`);
        score = r.status === 0 ? 1 : 0;
        const out = (r.stdout ?? "") + ((r.stderr ?? "") ? `\n[stderr]\n${r.stderr}` : "");
        (observations as any)._stdout = r.stdout ?? "";
        (observations as any)._stderr = r.stderr ?? "";
        (observations as any)._cmdOut = out;
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
      const stdout = String((observations as any)._stdout ?? "");
      const stderr = String((observations as any)._stderr ?? (observations as any)._cmdOut ?? "");
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
