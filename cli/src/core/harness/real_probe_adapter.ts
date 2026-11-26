import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../durable_file.js";
import type { HirTaskCase, ProbeResult } from "./types.js";
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

export class RealProbeAdapter implements ProbeAdapter {
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
        const r = spawnSync("bash", ["-lc", cmd], {
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
      return {
        schemaVersion: 1,
        id: `hprobe_${randomUUID()}`,
        runId: input.runId,
        candidateId: input.candidateId,
        caseId: input.case.id,
        status,
        startedAt,
        endedAt,
        metrics: { wallClockMs: Date.now() - start, tokens: 0, toolErrors, verifierPass, score },
        artifacts: { stdoutRef: undefined, stderrRef: undefined },
        observations,
      };
    } catch (err) {
      return {
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
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}
