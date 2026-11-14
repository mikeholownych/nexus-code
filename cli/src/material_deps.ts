/**
 * What a validation receipt depends on besides the candidate's own files: the toolchain that ran the verifier and
 * the build/test configuration it read. A change in any of them means the recorded pass no longer speaks for the
 * current environment.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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

/**
 * node comes from the running process and typescript from its installed package.json, so neither runs a command.
 * rustc is probed with a bounded `rustc --version` (no shell, 3s) and only when the workspace is a Rust project.
 */
export const defaultVersionProbe: VersionProbe = (tool, workspace) => {
  if (tool === "node") return process.version;
  if (tool === "tsc") return readJsonVersion(path.join(workspace, "node_modules", "typescript", "package.json"));
  if (tool === "rustc") {
    if (!fs.existsSync(path.join(workspace, "Cargo.toml"))) return null;
    const run = spawnSync("rustc", ["--version"], { cwd: workspace, encoding: "utf-8", timeout: 3000, shell: false });
    return run.status === 0 ? run.stdout.trim().slice(0, 200) : null;
  }
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
