import * as path from "node:path";
import { ensurePrivateDir, writeFileDurably } from "../durable_file.js";
import { HarnessStore } from "./store.js";
import type { ProbeResult } from "./types.js";

export function writeProbeArtifacts(store: HarnessStore, result: ProbeResult, artifacts: { stdout?: string; stderr?: string; trajectory?: string; diff?: string }): ProbeResult {
  const dir = store.probeDir(result.id);
  ensurePrivateDir(dir);
  const out: ProbeResult = { ...result, artifacts: { ...result.artifacts } };
  if (typeof artifacts.stdout === "string") {
    const p = path.join(dir, "stdout.txt");
    writeFileDurably(p, artifacts.stdout, 0o600);
    out.artifacts.stdoutRef = p;
  }
  if (typeof artifacts.stderr === "string") {
    const p = path.join(dir, "stderr.txt");
    writeFileDurably(p, artifacts.stderr, 0o600);
    out.artifacts.stderrRef = p;
  }
  if (typeof artifacts.trajectory === "string") {
    const p = path.join(dir, "trajectory.jsonl");
    writeFileDurably(p, artifacts.trajectory, 0o600);
    out.artifacts.trajectoryRef = p;
  }
  if (typeof artifacts.diff === "string") {
    const p = path.join(dir, "diff.txt");
    writeFileDurably(p, artifacts.diff, 0o600);
    out.artifacts.diffRef = p;
  }
  return out;
}
