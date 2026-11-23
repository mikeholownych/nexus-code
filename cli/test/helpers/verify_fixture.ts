/**
 * What the `nexus verify` test files share: the fixture repository, Git helpers, the two ways to run verification (the
 * real CLI, and `verifyChange` in this process) and the schema check every result document goes through.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyChange, type VerifyDependencies, type VerifyOperatorContext, type VerifyRequest } from "../../src/core/verify.js";
import { VERIFY_RESULT_SCHEMA_VERSION, verifyExitCode, verifyExitNameFor, verifyVerdictFor, type VerifyJsonResult } from "../../src/verify_contract.js";
import { verifyResultSchemaFile } from "../../scripts/gen_verify_result_schema.mjs";
import { makeHome, makeRepo } from "./fixtures.js";
import { validate, type Schema } from "./json_schema.js";

export const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERIFY_SCHEMA_TEXT = fs.readFileSync(verifyResultSchemaFile(VERIFY_RESULT_SCHEMA_VERSION), "utf8");
export const VERIFY_SCHEMA: Schema = JSON.parse(VERIFY_SCHEMA_TEXT);

// ---- The fixture: one product file with a bug, one test file whose second test fails because of it ----

export const PACKAGE = JSON.stringify({ name: "verify-fixture", version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } });
export const MATH_BUGGY = "export const add = (a, b) => a - b;\nexport const double = (a) => a * 2;\n";
export const MATH_FIXED = "export const add = (a, b) => a + b;\nexport const double = (a) => a * 2;\n";
export const MATH_BROKEN = "export const add = (a, b) => a - b;\nexport const double = (a) => a * 3;\n";
export const TEST_HEAD = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, double } from "../src/math.js";\ntest("double", () => assert.equal(double(2), 4));\n';
export const TEST_FULL = `${TEST_HEAD}test("add", () => assert.equal(add(2, 3), 5));\n`;
/** The known-bad change: the bug stays and the failing test is deleted. */
export const TEST_WEAKENED = TEST_HEAD;
export const TEST_FILE = "test/math.test.mjs";
export const BASE_FILES = { "package.json": PACKAGE, "src/math.js": MATH_BUGGY, [TEST_FILE]: TEST_FULL };
export const GOOD = { "src/math.js": MATH_FIXED };
export const BAD = { [TEST_FILE]: TEST_WEAKENED };
/** sha256 of "npm test\nnode --test": the digest of the verifier the BASE tree defines. */
export const BASE_VERIFIER_DIGEST = createHash("sha256").update("npm test\nnode --test").digest("hex");
export const DELIVERABLE = ["--deliverable-file", "src/math.js"];

export const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const head = (repo: string) => git(repo, "rev-parse", "HEAD");

export function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
}

/** Commits `files` on top of the current commit (a null content deletes the file) and returns the new commit. */
export function commit(repo: string, files: Record<string, string | null>, author = "t <t@t.invalid>"): string {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) fs.rmSync(path.join(repo, name));
    else writeFiles(repo, { [name]: content });
  }
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=committer", "-c", "user.email=c@c.invalid", "commit", "-q", "--author", author, "-m", "change");
  return head(repo);
}

/** Runs `check` on fresh repositories built from the given files and removes them afterwards. */
export async function withRepos<T>(files: Array<Record<string, string>>, check: (...repos: string[]) => Promise<T>): Promise<T> {
  const repos = files.map((set) => makeRepo(set));
  try {
    return await check(...repos);
  } finally {
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
  }
}

/** A result document is what the published schema says, and its verdict, reason and exit code agree with the contract's tables. */
export function assertVerifyResult(doc: any): void {
  assert.deepEqual(validate(doc, VERIFY_SCHEMA, VERIFY_SCHEMA), [], `the document validates against docs/protocol/verify-result-v${VERIFY_RESULT_SCHEMA_VERSION}.schema.json`);
  assert.equal(Object.keys(doc)[0], "schema_version");
  assert.equal(doc.schema_version, VERIFY_RESULT_SCHEMA_VERSION);
  assert.equal(doc.verdict, verifyVerdictFor(doc.reason), `${doc.verdict}/${doc.reason}: ${doc.detail}`);
  assert.equal(doc.exitCode, verifyExitCode(verifyExitNameFor(doc.reason)));
  assert.equal(doc.verdict === "VERIFIED", doc.exitCode === 0, "exit 0 if and only if VERIFIED");
  assert.equal(doc.verdict === "VERIFIED", doc.outcome === "VERIFIED");
  assert.ok(["NOT_RUN", "COMPLETE"].includes(doc.review.status), "the reviewer's status is one the contract declares");
  if (doc.review.status === "COMPLETE") {
    assert.ok(["ACCEPT", "REJECT"].includes(doc.review.verdict), "a completed review has a verdict");
    for (const member of ["verifiedObservations", "suspectedDefects", "unprovenCriteria", "scopeViolations"]) assert.ok(Array.isArray(doc.review[member]), member);
    if (doc.review.verdict === "REJECT") assert.notEqual(doc.verdict, "VERIFIED", "a rejected review never accompanies VERIFIED");
  }
  // The sandbox record is always written, and every run says the same as it: a run is never outside a sandbox that was used.
  assert.equal(typeof doc.sandbox?.requested, "boolean");
  assert.ok(["none", "bwrap", "docker"].includes(doc.sandbox.engine), `sandbox.engine ${doc.sandbox.engine}`);
  if (doc.sandbox.engine === "none") assert.equal(doc.sandbox.network, false);
  for (const ran of doc.runs) assert.equal(ran.sandboxed, doc.sandbox.engine !== "none", `the ${ran.phase} run's sandboxed flag agrees with sandbox.engine`);
  if (doc.reason === "SANDBOX_UNAVAILABLE") {
    assert.equal(doc.sandbox.engine, "none");
    assert.deepEqual(doc.runs, [], "an unavailable default or selected sandbox starts no verifier process");
  }
  // Nothing waits for a decision in a VERIFIED result, and no finding that needed approval is in one.
  if (doc.verdict === "VERIFIED") {
    assert.equal(doc.guard.status, "CLEAR");
    assert.equal(doc.guard.complete, true);
    assert.deepEqual(doc.guard.findings.filter((finding: any) => finding.requiresApproval), []);
  }
}

export interface CliRun { code: number | null; stdout: string; stderr: string; leftovers: string[] }

/**
 * Runs `nexus verify <args>` (the source entry) with a throwaway HOME, its own temp directory and no operator
 * environment. `leftovers`: what verify left in that temp directory (its scratch trees and verifier output files).
 */
export function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_)/.test(key) || key === "NODE_TEST_CONTEXT") delete env[key];
  const home = makeHome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-test-tmp-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "verify", ...args], {
      cwd: CLI_DIR,
      env: { ...env, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith("nexus-"));
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, leftovers });
    });
  });
}

/** What a consumer does: stdout is exactly one JSON document, `schema_version` first, `exitCode` the process exit code. */
export function consume(run: CliRun): any {
  let doc: any;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    assert.fail(`stdout is not one JSON document: ${run.stdout.slice(0, 200)}\nstderr: ${run.stderr.slice(0, 400)}`);
  }
  assert.equal(run.stdout, `${JSON.stringify(doc, null, 2)}\n`, "nothing but the document on stdout");
  assert.deepEqual(validate(doc, VERIFY_SCHEMA, VERIFY_SCHEMA), [], "the document validates against the published schema");
  assert.equal(Object.keys(doc)[0], "schema_version");
  assert.equal(doc.schema_version, VERIFY_RESULT_SCHEMA_VERSION);
  assert.equal(doc.exitCode, run.code, "exitCode repeats the process exit code");
  assert.deepEqual(run.leftovers, [], "no scratch directory is left behind");
  return doc;
}

/** A result document from the CLI (see assertVerifyResult). */
export function consumeResult(run: CliRun): any {
  const doc = consume(run);
  assertVerifyResult(doc);
  return doc;
}

const TSC_BIN = path.join(CLI_DIR, "node_modules", "typescript", "bin", "tsc");

/**
 * A PATH for a verification run: the ambient one without any directory that provides `tsc`, behind a directory that
 * holds `tsc` when asked: "real" is this repository's own compiler (no network, nothing copied), a string is the body of
 * a script that stands in for it, and undefined leaves no `tsc` at all. Returns the PATH and the directory to remove.
 */
export function toolPath(tsc: "real" | string | undefined): { PATH: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-bin-"));
  if (tsc === "real") fs.symlinkSync(TSC_BIN, path.join(dir, "tsc"));
  else if (tsc !== undefined) fs.writeFileSync(path.join(dir, "tsc"), tsc, { mode: 0o755 });
  const ambient = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry && !fs.existsSync(path.join(entry, "tsc")));
  return { PATH: [dir, ...ambient].join(path.delimiter), dir };
}

export interface InProcessRun { result: VerifyJsonResult; leftovers: string[] }

/**
 * `verifyChange` in this process, as the CLI would call it: a throwaway HOME, its own temp directory, no operator
 * environment but `env`, and a PATH from toolPath. The result has been through JSON (it is the document) and the
 * schema. The environment is put back and every directory removed, whatever happens.
 */
export async function verifyInProcess(
  request: VerifyRequest,
  operator: VerifyOperatorContext = {},
  options: { env?: Record<string, string>; tsc?: "real" | string; deps?: VerifyDependencies } = {},
): Promise<InProcessRun> {
  const saved = { ...process.env };
  const home = makeHome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-test-tmp-"));
  const tools = toolPath(options.tsc);
  for (const key of Object.keys(process.env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_|XDG_)/.test(key) || key === "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, { HOME: home, TMPDIR: tmp, PATH: tools.PATH }, options.env ?? {});
  try {
    const result = JSON.parse(JSON.stringify(await verifyChange(request, operator, options.deps ?? {}))) as VerifyJsonResult;
    assertVerifyResult(result);
    for (const [name, value] of Object.entries(options.env ?? {})) assert.equal(process.env[name], value, `${name} is left as the caller set it`);
    return { result, leftovers: fs.readdirSync(tmp).filter((name) => name.startsWith("nexus-")) };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    for (const dir of [tmp, home, tools.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A directory to put first on PATH, holding stand-ins for the sandbox engines. `refuses`: the program exits 1 whatever it
 * is asked, which is how an engine that is not installed looks to the availability probe, on any host. `records`: it
 * answers `--version` and otherwise writes its arguments, NUL-separated, to `<dir>/<name>.argv` and exits 0 without
 * running anything (enough for the wrapper to build a command line; the probe still finds it unusable).
 */
export function fakeEngines(engines: Record<string, "refuses" | "records">): { dir: string; PATH: string; argvOf: (name: string) => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-engines-"));
  for (const [name, how] of Object.entries(engines)) {
    const record = path.join(dir, `${name}.argv`);
    fs.writeFileSync(path.join(dir, name), how === "refuses"
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${name} 0.0.0"; exit 0; }\nprintf '%s\\0' "$@" > '${record}'\nexit 0\n`, { mode: 0o755 });
  }
  return {
    dir,
    PATH: [dir, ...(process.env.PATH ?? "").split(path.delimiter)].join(path.delimiter),
    argvOf: (name) => fs.readFileSync(path.join(dir, `${name}.argv`), "utf8").split("\0").slice(0, -1),
  };
}
