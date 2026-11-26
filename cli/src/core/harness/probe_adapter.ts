import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../durable_file.js";
import type { HirTaskCase, ProbeResult } from "./types.js";

export interface ProbeInput {
  runId: string;
  candidateId: string;
  candidatePath: string;
  case: HirTaskCase;
  timeoutMs: number;
}

export interface ProbeAdapter {
  run(input: ProbeInput): Promise<ProbeResult>;
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

export class MockProbeAdapter implements ProbeAdapter {
  async run(input: ProbeInput): Promise<ProbeResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hir-mock-"));
    const work = path.join(workspace, "candidate");
    try {
      copyDir(input.candidatePath, work);
      let verifierPass: boolean | null = null;
      let status: ProbeResult["status"] = "SUCCEEDED";
      let observations: string[] = ["mock_probe_isolated_workspace=true"];
      let score: number | null = null;

      if (input.case.expected?.verifierCommand) {
        const r = spawnSync("bash", ["-lc", input.case.expected.verifierCommand], { cwd: work, encoding: "utf8", timeout: input.timeoutMs, env: { ...process.env }, maxBuffer: 1024 * 1024 });
        verifierPass = r.status === 0;
        status = r.signal === "SIGTERM" ? "TIMED_OUT" : r.status === 0 ? "SUCCEEDED" : "FAILED";
        observations.push(`verifier_exit=${String(r.status)}`);
        score = r.status === 0 ? 1 : 0;
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
      return {
        schemaVersion: 1,
        id: `hprobe_${randomUUID()}`,
        runId: input.runId,
        candidateId: input.candidateId,
        caseId: input.case.id,
        status,
        startedAt,
        endedAt,
        metrics: { wallClockMs: Date.now() - start, tokens: 0, toolErrors: status === "FAILED" ? 1 : 0, verifierPass, score },
        artifacts: {},
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
