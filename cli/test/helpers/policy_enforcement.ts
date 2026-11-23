/**
 * GV-1 enforcement tests: policies injected through the library's explicit inputs (an in-memory file system and
 * injected uids), and a child process that runs the real CLI or the real modules with the file system interposed for
 * exactly the system policy directory and file. Nothing here reads the machine's own system policy or the operator's
 * own configuration directory, and production has no seam for either: the interposition lives in the child's script.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProductionPolicyInputs } from "../../src/core/managed_policy_inputs.js";
import { PROJECT_POLICY_FILE_NAME, SYSTEM_POLICY_PATH, type LoadedPolicy } from "../../src/core/managed_policy_load.js";
import { createPolicyHost, type PolicyHost, type WorkspaceTrustFacts } from "../../src/core/policy_runtime.js";
import { FakeFs } from "./policy_fixture.js";

export const FAKE_SYSTEM_DIR = "/fake/etc/nexus";
export const FAKE_SYSTEM = `${FAKE_SYSTEM_DIR}/policy.toml`;
export const FAKE_USER = "/fake/home/op/.config/nexus/policy.toml";
export const FAKE_STORE = "/fake/home/op/.config/nexus/policy_trust.json";
export const FAKE_UID = 1000;

export interface PolicyWorld {
  fake: FakeFs;
  host: PolicyHost;
  inputs: ProductionPolicyInputs;
  /** How often the host asked for its inputs. */
  resolved: () => number;
  /** The policy in force in `workspace` under these trust facts (untrusted when omitted). */
  load(workspace: string, trust?: Partial<WorkspaceTrustFacts>): LoadedPolicy;
  /** Puts a project file into the in-memory file system. */
  project(workspace: string, content: unknown): string;
  /** Records the project file's current bytes as approved, as the approval store would hold it. */
  approve(workspace: string): void;
}

export const toml = (...lines: string[]): string => ["schema_version = 1", ...lines, ""].join("\n");
export const sha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

/** A policy host over an in-memory file system: a sound system directory, and the tier files that are given. */
export function policyWorld(tiers: { system?: string; user?: string } = {}): PolicyWorld {
  const fake = new FakeFs().dir(FAKE_SYSTEM_DIR);
  if (tiers.system !== undefined) fake.put(FAKE_SYSTEM, tiers.system);
  if (tiers.user !== undefined) fake.put(FAKE_USER, tiers.user, { uid: FAKE_UID });
  const inputs: ProductionPolicyInputs = { systemPath: FAKE_SYSTEM, systemOwnerUid: 0, userPath: FAKE_USER, userUid: FAKE_UID, trustStorePath: FAKE_STORE, fs: fake };
  let resolved = 0;
  const host = createPolicyHost(() => {
    resolved++;
    return inputs;
  });
  const approvals: Record<string, { sha256: string; approvedAt: string }> = {};
  return {
    fake,
    host,
    inputs,
    resolved: () => resolved,
    load: (workspace, trust = {}) => host.forWorkspace(workspace, { workspaceTrusted: false, envTrustRequested: false, ...trust }),
    project(workspace, content) {
      const file = path.join(workspace, PROJECT_POLICY_FILE_NAME);
      fake.put(file, typeof content === "string" ? content : JSON.stringify(content), { uid: FAKE_UID });
      return file;
    },
    approve(workspace) {
      approvals[workspace] = { sha256: sha256(fake.nodes.get(path.join(workspace, PROJECT_POLICY_FILE_NAME))!.bytes), approvedAt: "2026-01-01T00:00:00.000Z" };
      fake.put(FAKE_STORE, JSON.stringify({ version: 1, workspaces: approvals }), { uid: FAKE_UID, mode: 0o100600 });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The real CLI and the real modules, in a child process.

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

let builtIsCurrent: boolean | undefined;
/**
 * Where the child loads Nexus from: `dist/` when it is at least as new as every file under `src/`, else the source
 * through the TypeScript loader (about 3 s a start here). CI builds before it tests; a stale build is never tested.
 */
function moduleRoot(): { dir: string; ext: string; nodeArgs: string[] } {
  if (builtIsCurrent === undefined) {
    const built = path.join(CLI_DIR, "dist", "index.js");
    builtIsCurrent = fs.existsSync(built) && fs.statSync(built).mtimeMs >= newestMtime(path.join(CLI_DIR, "src"));
  }
  return builtIsCurrent ? { dir: path.join(CLI_DIR, "dist"), ext: ".js", nodeArgs: [] } : { dir: path.join(CLI_DIR, "src"), ext: ".ts", nodeArgs: ["--import", import.meta.resolve("tsx")] };
}

export interface PolicyChildOptions {
  /** The text of the system policy file; undefined: the system directory and file do not exist. */
  system?: string;
  /** The throwaway HOME (the user tier lives under it). */
  home: string;
  /** The working directory; the CLI directory when omitted. */
  cwd?: string;
  env?: Record<string, string>;
  /** Run the CLI with these arguments... */
  args?: string[];
  /** ...or run this module code instead. `load(name)` imports a Nexus module (`"security"`, `"core/policy_runtime"`). */
  probe?: string;
}

export interface PolicyChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** How often the child opened the system policy file. */
  systemPolicyOpens: number;
}

/**
 * Runs the child with `node:fs` interposed for exactly the system policy directory and file: they are served from a
 * private stand-in (reported as owned by root), or reported absent. Every other path reaches the real file system.
 */
export function runUnderPolicy(options: PolicyChildOptions): Promise<PolicyChildResult> {
  const root = moduleRoot();
  const standIn = options.system === undefined ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-system-"));
  if (standIn) fs.writeFileSync(path.join(standIn, "policy.toml"), options.system!, { mode: 0o644 });
  const entry = path.join(root.dir, `index${root.ext}`);
  const script = `
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const FILE = ${JSON.stringify(SYSTEM_POLICY_PATH)};
    const DIR = ${JSON.stringify(path.dirname(SYSTEM_POLICY_PATH))};
    const standIn = ${JSON.stringify(standIn ?? null)};
    const mapped = (candidate) => (candidate === DIR ? [standIn] : candidate === FILE ? [standIn && standIn + "/policy.toml"] : undefined);
    const absent = () => Object.assign(new Error("ENOENT: no system policy in this test"), { code: "ENOENT" });
    const fds = new Set();
    let opens = 0;
    const real = { lstatSync: fs.lstatSync.bind(fs), openSync: fs.openSync.bind(fs), fstatSync: fs.fstatSync.bind(fs), closeSync: fs.closeSync.bind(fs) };
    fs.lstatSync = (candidate, ...rest) => {
      const to = mapped(candidate);
      if (!to) return real.lstatSync(candidate, ...rest);
      if (!to[0]) throw absent();
      return Object.assign(real.lstatSync(to[0], ...rest), { uid: 0 });
    };
    fs.openSync = (candidate, ...rest) => {
      const to = mapped(candidate);
      if (!to) return real.openSync(candidate, ...rest);
      if (!to[0]) throw absent();
      const fd = real.openSync(to[0], ...rest);
      fds.add(fd);
      if (candidate === FILE) opens++;
      return fd;
    };
    fs.fstatSync = (fd, ...rest) => (fds.has(fd) ? Object.assign(real.fstatSync(fd, ...rest), { uid: 0 }) : real.fstatSync(fd, ...rest));
    fs.closeSync = (fd) => { fds.delete(fd); return real.closeSync(fd); };
    syncBuiltinESMExports();
    process.on("exit", () => process.stderr.write("\\n[system-policy-opens " + opens + "]\\n"));
    const load = (name) => import(${JSON.stringify(pathToFileURL(root.dir).href)} + "/" + name + ${JSON.stringify(root.ext)});
    ${options.probe ?? `process.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(options.args ?? [])}]; await import(${JSON.stringify(pathToFileURL(entry).href)});`}
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...root.nodeArgs, "--input-type=module", "-e", script], {
      cwd: options.cwd ?? CLI_DIR,
      env: { PATH: process.env.PATH, HOME: options.home, XDG_CONFIG_HOME: path.join(options.home, ".config"), NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (standIn) fs.rmSync(standIn, { recursive: true, force: true });
      const marker = /\n\[system-policy-opens (\d+)\]\n$/.exec(stderr);
      resolve({ status, stdout, stderr: marker ? stderr.slice(0, marker.index) : stderr, systemPolicyOpens: marker ? Number(marker[1]) : -1 });
    });
  });
}

/** A throwaway HOME, optionally with a user policy file. */
export function policyHome(userPolicy?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-home-"));
  if (userPolicy !== undefined) {
    fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "nexus", "policy.toml"), userPolicy, { mode: 0o600 });
  }
  return home;
}
