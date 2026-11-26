import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessManifest, HirPolicy } from "./types.js";

export interface GateFinding { severity: "info" | "warn" | "error"; code: string; message: string; path?: string }
export interface GateResult { status: "PASS" | "FAIL"; findings: GateFinding[] }

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    const lst = await fs.promises.lstat(full);
    if (lst.isSymbolicLink()) {
      out.push(full);
      const real = await fs.promises.realpath(full).catch(() => "");
      if (!real || !isWithin(root, real)) {
        // finding added by caller
      }
      continue;
    }
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.push(full);
  }
}

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /NEXUS_[A-Z0-9_]*(TOKEN|KEY|SECRET)\s*=\s*\S+/,
];

const WEAKENING_PATTERNS = [
  /allowLiveProfileMutation\s*:\s*true/i,
  /allowRepoMutation\s*:\s*true/i,
  /allowNetwork\s*:\s*true/i,
  /redactSecrets\s*:\s*false/i,
  /approvalModePinned\s*:\s*"?none"?/i,
  /sandbox\s*:\s*"?none"?/i,
  /approvals?\.mode\s*:\s*"?off"?/i,
];

export async function gateCandidateTree(opts: { baseManifest: HarnessManifest; candidatePath: string; policy: HirPolicy }): Promise<GateResult> {
  const findings: GateFinding[] = [];
  const root = path.resolve(opts.candidatePath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { status: "FAIL", findings: [{ severity: "error", code: "missing_candidate", message: "candidate path missing or not directory" }] };
  }
  const rootReal = await fs.promises.realpath(root);
  const files: string[] = [];
  await walk(rootReal, rootReal, files);
  for (const full of files) {
    const lst = await fs.promises.lstat(full);
    const rel = path.relative(rootReal, full).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      findings.push({ severity: "error", code: "path_escape", message: "path escapes candidate root", path: full });
      continue;
    }
    if (lst.isSymbolicLink()) {
      const real = await fs.promises.realpath(full).catch(() => "");
      if (!real || !isWithin(rootReal, real)) findings.push({ severity: "error", code: "symlink_escape", message: "symlink escapes candidate root", path: rel });
      else findings.push({ severity: "warn", code: "symlink", message: "symlink in candidate tree", path: rel });
      continue;
    }
    if (!lst.isFile()) continue;
    if (lst.size > 256 * 1024) findings.push({ severity: "error", code: "too_large", message: "component exceeds 256KiB", path: rel });
    const buf = await fs.promises.readFile(full);
    const text = buf.toString("utf8");
    for (const pat of SECRET_PATTERNS) if (pat.test(text)) findings.push({ severity: "error", code: "secret_material", message: `potential secret matches ${pat}`, path: rel });
    for (const pat of WEAKENING_PATTERNS) if (pat.test(text)) findings.push({ severity: "error", code: "policy_weakening", message: `policy weakening pattern: ${pat}`, path: rel });
  }
  if (files.length === 0) findings.push({ severity: "error", code: "empty_candidate", message: "candidate has no files" });
  // Policy invariants are also enforced by run schema; gate is defense in depth.
  if (opts.policy.allowLiveProfileMutation !== false) findings.push({ severity: "error", code: "policy", message: "live profile mutation not allowed" });
  const status = findings.some((f) => f.severity === "error") ? "FAIL" : "PASS";
  return { status, findings };
}
