/**
 * What a validation receipt depends on besides the candidate's own files: the toolchain that ran the verifier and
 * the build/test configuration it read. A change in any of them means the recorded pass no longer speaks for the
 * current environment.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { buildLspEnvironment } from "./lsp.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import type { MaterialValidationDependency } from "./core/candidate.js";

const CONFIG_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "Makefile",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "pyproject.toml",
  "go.mod",
  "go.sum",
];

export const TOOLCHAIN_PREFIX = "toolchain:";

/** Reads one version string; null when the tool is absent or the probe fails. Injected in tests. */
export type VersionProbe = (tool: string, workspace: string) => string | null;

function readJsonVersion(file: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8"))?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export const UNVERIFIED_UNTRUSTED = "unverified (workspace untrusted)";

const rustcVersions = new Map<string, string>();

/**
 * `rustc --version` from an absolute PATH entry outside the workspace, run from the temp directory with the
 * language-server environment allowlist, bounded to 3s and cached per resolved binary and mtime.
 */
export function probeRustc(workspace: string, run: typeof spawnSync = spawnSync): string | null {
  if (!fs.existsSync(path.join(workspace, "Cargo.toml"))) return null;
  if (!isWorkspaceTrusted(workspace)) return UNVERIFIED_UNTRUSTED;
  const env = buildLspEnvironment(workspace);
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, "rustc");
    let mtime: number;
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      mtime = fs.statSync(bin).mtimeMs;
    } catch {
      continue;
    }
    const key = `${bin}\0${mtime}`;
    const cached = rustcVersions.get(key);
    if (cached) return cached;
    const result = run(bin, ["--version"], { cwd: os.tmpdir(), env, encoding: "utf-8", timeout: 3000, shell: false });
    const version = result.status === 0 ? String(result.stdout).trim().slice(0, 200) : "";
    if (!version) return null;
    rustcVersions.set(key, version);
    return version;
  }
  return null;
}

/** node comes from the running process and typescript from its installed package.json; neither runs a command. */
export const defaultVersionProbe: VersionProbe = (tool, workspace) => {
  if (tool === "node") return process.version;
  if (tool === "tsc") return readJsonVersion(path.join(workspace, "node_modules", "typescript", "package.json"));
  if (tool === "rustc") return probeRustc(workspace);
  return null;
};

export function collectMaterialDependencies(workspace: string, probe: VersionProbe = defaultVersionProbe): MaterialValidationDependency[] {
  const deps: MaterialValidationDependency[] = [];
  for (const tool of ["node", "tsc", "rustc"]) {
    const version = probe(tool, workspace);
    if (version) deps.push({ name: `${TOOLCHAIN_PREFIX}${tool}`, versionOrHash: version });
  }
  for (const name of CONFIG_FILES) {
    try {
      deps.push({ name, path: name, versionOrHash: crypto.createHash("sha256").update(fs.readFileSync(path.join(workspace, name))).digest("hex") });
    } catch {
      // Not part of this project.
    }
  }
  return deps;
}
