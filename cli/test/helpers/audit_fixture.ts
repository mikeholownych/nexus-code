/**
 * What the audit-bundle tests share (GV-2): a fixture with one artefact of every kind, the schema checks every manifest
 * and result document goes through, a helper that re-seals a manifest the way someone rewriting a bundle would, and a
 * spy that records every path handed to `node:fs`. For the collectors and the commands: a saved task or session with
 * every artefact an export takes (no model involved), the export in this process, and the real CLI.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { auditBundleSchemaFile, auditVerifyResultSchemaFile } from "../../scripts/gen_audit_schema.mjs";
import { AUDIT_BUNDLE_SCHEMA_VERSION, AUDIT_VERIFY_RESULT_SCHEMA_VERSION, auditExitCode, type AuditExitName, type AuditManifest, type AuditVerifyOutput, type AuditVerifyResult } from "../../src/audit_contract.js";
import { renderAuditVerifyText, verifyAuditBundle, writeAuditBundle, type AuditBundleInput, type VerifyAuditBundleOptions, type WrittenAuditBundle } from "../../src/core/audit_bundle.js";
import { canonicalJson, linkRecord, type ChainLink } from "../../src/core/hash_chain.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DurableStateManager } from "../../src/core/state.js";
import { WorkspacePath } from "../../src/core/workspace_path.js";
import { FlightRecorder } from "../../src/flight.js";
import { exportAuditBundle, type AuditExport, type AuditExportRequest } from "../../src/audit_export.js";
import { makeHome } from "./fixtures.js";
import { validate, type Schema } from "./json_schema.js";

export const AUDIT_BUNDLE_SCHEMA_TEXT = fs.readFileSync(auditBundleSchemaFile(AUDIT_BUNDLE_SCHEMA_VERSION), "utf8");
export const AUDIT_BUNDLE_SCHEMA: Schema = JSON.parse(AUDIT_BUNDLE_SCHEMA_TEXT);
export const AUDIT_VERIFY_SCHEMA_TEXT = fs.readFileSync(auditVerifyResultSchemaFile(AUDIT_VERIFY_RESULT_SCHEMA_VERSION), "utf8");
export const AUDIT_VERIFY_SCHEMA: Schema = JSON.parse(AUDIT_VERIFY_SCHEMA_TEXT);

export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const tempDirs: string[] = [];
/** A fresh directory; `cleanTemp` (call it from `after`) removes every one made. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gv2-"));
  tempDirs.push(dir);
  return dir;
}
export function cleanTemp(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Chained records as one JSON line each, the form of a flight log and of the config-attempt log. */
export function chainedLines(contents: object[]): string[] {
  const lines: string[] = [];
  let previous: ChainLink | undefined;
  for (const content of contents) {
    const record = linkRecord(content, previous);
    previous = record.chain;
    lines.push(JSON.stringify(record));
  }
  return lines;
}

export const FLIGHT_PATH = "flights/flight-1.flightlog";
export const ATTEMPTS_PATH = "verification/config-attempts.jsonl";
export const FLIGHT_EVENTS = [
  { type: "session_start", timestamp: 0, payload: { flightId: "flight-1", model: "m", taskPrompt: "do the thing" } },
  { type: "turn_start", step: 1, timestamp: 1, payload: { prompt: "do the thing" } },
  { type: "tool_call", step: 1, timestamp: 2, payload: { name: "read_file", args: { path: "a.ts" } } },
  { type: "tool_result", step: 1, timestamp: 3, payload: { ok: true, output: "contents héllo ✓" } },
  { type: "session_end", timestamp: 4, payload: { summary: "done", success: true } },
];
const text = (value: string): Uint8Array => Buffer.from(value, "utf8");
const json = (value: unknown): Uint8Array => text(`${JSON.stringify(value, null, 2)}\n`);

/** One artefact of every role the first slices write, two of them chained logs. The same bytes on every call. */
export function fixtureInput(): AuditBundleInput {
  return {
    subject: { kind: "task", task_id: "task-1", session_id: null, store: "tasks", workspace_path: "/work/repo", workspace_sha256: sha256("/work/repo"), status: "completed", updated_at: "2026-11-22T09:00:00.000Z", at_rest: true },
    nexus: { version: "1.3.0", commit: "0123abc", dirty: false },
    redaction: "standard",
    artefacts: [
      { path: "session/export.json", role: "session_export", bytes: json({ format: "nexus-session-export/2", messages: [{ role: "user", content: "do the thing" }] }) },
      { path: "session/export.md", role: "session_export_markdown", bytes: text("# Session\n\ndo the thing\n") },
      { path: "receipts/validation-receipts.json", role: "validation_receipts", bytes: json([{ id: "r1", command: "npm test", passed: true }]) },
      { path: "receipts/last-turn.json", role: "last_turn", bytes: json({ execution: "COMPLETED", outcome: "VERIFIED" }) },
      { path: "verification/attempts.json", role: "verification_attempts", bytes: json([{ attempt: 1, verdict: "pass" }]) },
      { path: ATTEMPTS_PATH, role: "verification_config_attempts", bytes: text(`${chainedLines([{ path: "package.json", decision: "blocked" }, { path: "vitest.config.ts", decision: "approved" }]).join("\n")}\n`) },
      { path: "evidence/provenance.json", role: "evidence_provenance", bytes: json({ "REQ-1": ["test:a"] }) },
      { path: "evidence/findings.json", role: "evidence_findings", bytes: json([]) },
      { path: "evidence/diffs/op-1.diff", role: "diff", bytes: text("@@ -1 +1 @@\n-a\n+b\n") },
      { path: FLIGHT_PATH, role: "flight_log", bytes: text(`${chainedLines(FLIGHT_EVENTS).join("\n")}\n`) },
    ],
    chainedLogs: [
      { path: FLIGHT_PATH, kind: "flight", closed: true, selection: "explicit" },
      { path: ATTEMPTS_PATH, kind: "verification_config_attempts" },
    ],
    omitted: [{ artefact: "traces", reason: "not requested" }],
  };
}

export const FIXED_NOW = (): Date => new Date("2026-11-22T10:00:00.000Z");
export const FIXED_ID = "ab".repeat(16);

export function assertManifestValid(manifest: unknown): void {
  assert.deepEqual(validate(manifest, AUDIT_BUNDLE_SCHEMA, AUDIT_BUNDLE_SCHEMA), [], "the manifest does not validate against docs/protocol/audit-bundle schema");
}

/** Writes `input` as a bundle named `bundle` in a fresh directory, and checks the manifest written against the schema. */
export function writeFixture(input: AuditBundleInput = fixtureInput()): WrittenAuditBundle & { parent: string } {
  const parent = tempDir();
  const written = writeAuditBundle(input, { out: path.join(parent, "bundle"), now: FIXED_NOW, bundleId: FIXED_ID, durable: false });
  assertManifestValid(written.manifest);
  assertManifestValid(JSON.parse(fs.readFileSync(path.join(written.dir, "manifest.json"), "utf8")));
  return { ...written, parent };
}

export interface Checked {
  document: AuditVerifyOutput;
  /** The document as a result; an assertion fails when it is an error document. */
  result: AuditVerifyResult;
  exit: AuditExitName;
  code: number;
  text: string;
  kinds: string[];
}

/** Verifies a bundle; every document produced goes through the published schema and agrees with its exit-code row. */
export function check(dir: string, options?: VerifyAuditBundleOptions): Checked {
  const { document, exit } = verifyAuditBundle(dir, options);
  assert.deepEqual(validate(document, AUDIT_VERIFY_SCHEMA, AUDIT_VERIFY_SCHEMA), [], "the result does not validate against docs/protocol/audit-verify-result schema");
  assert.equal(document.exitCode, auditExitCode(exit));
  assert.equal(Object.keys(document)[0], "schema_version");
  if ("result" in document) assert.equal(document.result, exit);
  return {
    document,
    get result(): AuditVerifyResult {
      assert.ok("result" in document, `expected a result, got the error document: ${JSON.stringify(document)}`);
      return document;
    },
    exit,
    code: document.exitCode,
    text: renderAuditVerifyText(document),
    kinds: "result" in document ? document.findings.map((finding) => finding.kind) : [],
  };
}

export const manifestFile = (dir: string): string => path.join(dir, "manifest.json");
export const readManifestText = (dir: string): string => fs.readFileSync(manifestFile(dir), "utf8");
export const readManifest = (dir: string): AuditManifest => JSON.parse(readManifestText(dir));

/**
 * What someone rewriting a bundle does: recompute every file-entry link, the head and the root for the manifest as it
 * now is, and write it in canonical form. Written apart from the library's own writer on purpose.
 */
export function reseal(dir: string, manifest: Record<string, any>): string {
  let previous: ChainLink | undefined;
  manifest.files = manifest.files.map((entry: Record<string, unknown>) => {
    const { chain: _chain, ...content } = entry;
    const linked = linkRecord(content, previous);
    previous = linked.chain;
    return linked;
  });
  manifest.files_head = previous ? { seq: previous.seq, hash: previous.hash } : null;
  delete manifest.root_sha256;
  manifest.root_sha256 = sha256(canonicalJson(manifest));
  const bytes = `${canonicalJson(manifest)}\n`;
  fs.writeFileSync(manifestFile(dir), bytes);
  return sha256(bytes);
}

/** Replaces a payload file and re-seals the manifest to match: the rewrite an unsigned bundle cannot reveal. */
export function rewritePayload(dir: string, file: string, bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  fs.writeFileSync(path.join(dir, file), data);
  const manifest = readManifest(dir) as Record<string, any>;
  const entry = manifest.files.find((candidate: { path: string }) => candidate.path === file);
  entry.bytes = data.length;
  entry.sha256 = sha256(data);
  return reseal(dir, manifest);
}

/** Flips one bit of the byte in the middle of a file. */
export function flipByte(file: string): void {
  const bytes = fs.readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(file, bytes);
}

/**
 * Runs `run` with every function of `node:fs` (and `fs.promises`) wrapped, and returns each path one was called with:
 * every path the library opened, listed or examined (the named exports of `node:fs` are re-synced, so a module that
 * imports the namespace is seen too). `events` is the same in order with the function's name, plus each `fsyncSync`
 * under the path its descriptor was opened with.
 */
export function spyFs<T>(run: () => T): { value: T; paths: string[]; events: Array<{ fn: string; path: string }> } {
  const paths: string[] = [];
  const events: Array<{ fn: string; path: string }> = [];
  const open = new Map<number, string>();
  const restore: Array<() => void> = [];
  for (const holder of [fs, fs.promises] as any[]) {
    for (const key of Object.keys(holder)) {
      const original = holder[key];
      if (typeof original !== "function" || /^[A-Z]/.test(key)) continue;
      holder[key] = function (this: unknown, ...args: unknown[]) {
        const first = args[0];
        if (typeof first === "string" || Buffer.isBuffer(first) || first instanceof URL) {
          paths.push(String(first));
          events.push({ fn: key, path: String(first) });
        }
        if (key === "fsyncSync") events.push({ fn: key, path: open.get(first as number) ?? "(unknown descriptor)" });
        if (key === "closeSync") open.delete(first as number);
        const value = original.apply(this, args);
        if (key === "openSync") open.set(value, String(first));
        return value;
      };
      restore.push(() => {
        holder[key] = original;
      });
    }
  }
  syncBuiltinESMExports();
  try {
    return { value: run(), paths, events };
  } finally {
    for (const undo of restore) undo();
    syncBuiltinESMExports();
  }
}

/** Every file under `dir` as `relative path -> hex of bytes`, and every entry's mode. */
export function snapshot(dir: string): { files: Record<string, string>; modes: Record<string, number> } {
  const files: Record<string, string> = {};
  const modes: Record<string, number> = { ".": fs.lstatSync(dir).mode & 0o777 };
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(path.join(dir, child));
      modes[child] = stat.mode & 0o777;
      if (stat.isDirectory()) walk(child);
      else files[child] = fs.readFileSync(path.join(dir, child)).toString("hex");
    }
  };
  walk("");
  return { files, modes };
}

// ---- A saved subject (the collectors and the commands) ----

export const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface SubjectFixture {
  /** Holds everything below; removed by `cleanTemp`. */
  root: string;
  tasks: string;
  sessions: string;
  workspace: string;
  id: string;
  store: "tasks" | "sessions";
  /** The directory of the store the subject is in. */
  storeDir: string;
  /** A bundle path that does not exist yet, in a directory that does. */
  out(name?: string): string;
  /** An export request for this subject with a fixed clock and id, not durable. */
  request(extra?: Partial<AuditExportRequest>): AuditExportRequest;
}

/** Two verification-configuration attempts as SecurityManager.recordVerificationAttempt links them. */
export function configAttempts(paths: string[] = ["package.json", "vitest.config.ts"]): object[] {
  return chainedLines(paths.map((file, index) => ({ path: file, class: "test_config", tool: "write_file", decision: index === 0 ? "blocked" : "approved", role: null, timestamp: `2026-11-22T09:00:0${index}.000Z` }))).map((line) => JSON.parse(line));
}

/** Records a flight in `workspace` with the real recorder; `end` false leaves it without its session end. */
export function recordFlight(workspace: string, id: string, end = true): string {
  const flight = new FlightRecorder(workspace, id);
  flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1", taskPrompt: "do the thing" });
  flight.recordTurnStart(1, "do the thing");
  flight.recordToolCall(1, "c1", "read_file", { path: "a.ts" });
  flight.recordToolResult(1, "c1", "read_file", true, "contents", 3);
  if (end) flight.recordSessionEnd("done", true);
  return flight.getLogPath();
}

let bundles = 0;

export interface SubjectOptions {
  id?: string;
  store?: "tasks" | "sessions";
  status?: "pending" | "in_progress" | "completed" | "failed" | "interrupted";
  /** Members laid over the saved state. */
  state?: Record<string, unknown>;
  /** Record one closed flight inside the subject's time window (default true). */
  flight?: boolean;
  /** Write one operation diff (default true). */
  diff?: boolean;
  /** Reuse the directories of another fixture (to put the same id in the other store). */
  beside?: SubjectFixture;
}

/**
 * A task or session saved through the real state manager, with an objective holding verifier attempts and evidence,
 * validation receipts, a last turn, findings, two chained verification-configuration attempts, one operation diff and
 * one recorded flight. Nothing here needs a model.
 */
export function savedSubject(options: SubjectOptions = {}): SubjectFixture {
  const root = options.beside?.root ?? tempDir();
  const tasks = path.join(root, "state", "tasks");
  const sessions = path.join(root, "state", "sessions");
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  const id = options.id ?? "task-audit-1";
  const store = options.store ?? "tasks";
  const storeDir = store === "tasks" ? tasks : sessions;
  const createdAt = new Date(Date.now() - 1000).toISOString();
  if (options.flight !== false && !options.beside) recordFlight(workspace, "flight-in-window");
  const manager = new DurableStateManager({ baseDir: storeDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(workspace)] });
  manager.saveTaskState({
    schemaVersion: 2,
    taskId: id,
    sessionId: id,
    id,
    title: "audit fixture",
    workspacePath: workspace,
    workspace,
    model: "fixture-model",
    endpoint: "http://127.0.0.1:1/v1",
    createdAt,
    updatedAt: createdAt,
    status: options.status ?? "completed",
    activePlan: [],
    milestones: [],
    validationReceipts: [{ receiptId: "r1", candidateId: "c1", verifierCommand: "npm test", exitCode: 0, stdoutHash: "0".repeat(64), timestamp: createdAt, status: "PASSED", materialDependencies: [] }],
    lastTurn: { execution: "COMPLETED", outcome: "VERIFIED", acceptance: "PENDING", modelStop: "stop", finalOutputComplete: true, verification: null, interruption: null, inferenceFailure: null, steps: { used: 3, max: 30, limitReached: false } },
    messages: [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "done: the thing is in src/thing.ts" },
    ],
    objective: {
      version: 1,
      objective: "do the thing",
      objectiveSha256: sha256("do the thing"),
      startedAt: createdAt,
      requirements: [{ id: "R1", text: "the thing is done", status: "verified", source: "model", evidence: ["npm test"], evidenceSources: { "npm test": "tool" } }],
      scopeChanges: [],
      steering: [],
      verification: [{ n: 1, command: "npm test", inputs: "candidate-1", status: "PASSED", at: createdAt }],
      continuation: { segments: 1, totalSteps: 3, lastProgressStep: 3 },
      amendments: [],
    },
    findings: ["src/thing.ts exports thing()"],
    verificationConfigAttempts: configAttempts(),
    ...options.state,
  } as any);
  if (options.diff !== false) {
    const diffs = path.join(storeDir, `${id}.diffs`);
    fs.mkdirSync(diffs, { mode: 0o700 });
    fs.writeFileSync(path.join(diffs, "op-1.diff"), "--- a/src/thing.ts\n+++ b/src/thing.ts\n@@ -1 +1 @@\n-a\n+b\n", { mode: 0o600 });
  }
  return {
    root,
    tasks,
    sessions,
    workspace,
    id,
    store,
    storeDir,
    out: (name = `bundle-${++bundles}`) => path.join(root, "out", name),
    request(extra = {}) {
      return { id, tasksDir: tasks, sessionsDir: sessions, out: this.out(), now: FIXED_NOW, bundleId: FIXED_ID, durable: false, nexus: { version: "1.3.0", commit: "0123abc", dirty: false }, ...extra };
    },
  };
}

/** Exports in this process; the manifest written and the result document go through the published schemas. */
export function exportChecked(request: AuditExportRequest): AuditExport {
  const exported = exportAuditBundle(request);
  assertManifestValid(readManifest(exported.written.dir));
  assert.deepEqual(validate(exported.document, AUDIT_VERIFY_SCHEMA, AUDIT_VERIFY_SCHEMA), [], "the export result does not validate against docs/protocol/audit-verify-result schema");
  assert.equal(Object.keys(exported.document)[0], "schema_version");
  assert.equal(exported.document.manifest_sha256, sha256(fs.readFileSync(manifestFile(exported.written.dir))));
  return exported;
}

/** Every payload file of a bundle as `path -> text`. */
export function bundleTexts(dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshot(dir).files).map(([file, hex]) => [file, Buffer.from(hex, "hex").toString("utf8")]));
}

/** Newest modification time under a directory (0 when it does not exist). */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true, recursive: true }) : []) {
    if (entry.isFile()) newest = Math.max(newest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

let entry: string[] | undefined;
/**
 * How to start the CLI: the built entry (`dist/index.js`) when it is at least as new as every file under `src`,
 * otherwise the source entry through tsx. The source entry loads the whole CLI through the TypeScript loader on every
 * start (about 3 s here against 0.65 s for the build), which over this suite's process starts exceeded the 300 s
 * per-file limit on a CI runner. CI builds before it tests; a checkout whose build is missing or older than its
 * source runs the source, so a stale build is never what is tested.
 */
export function cliEntry(): string[] {
  if (entry) return entry;
  const built = path.join(CLI_DIR, "dist", "index.js");
  const current = fs.existsSync(built) && fs.statSync(built).mtimeMs >= newestMtime(path.join(CLI_DIR, "src"));
  return (entry = current ? [built] : ["--import", "tsx", "src/index.ts"]);
}

export interface AuditCliRun { code: number | null; stdout: string; stderr: string; leftovers: string[] }

/**
 * Runs `nexus audit <args>` (see `cliEntry`) with a throwaway HOME, its own temp directory and no operator
 * environment but `env`. `leftovers`: what the command left in that temp directory (the export's private copy would be one).
 */
export function runAudit(args: string[], env: Record<string, string> = {}): Promise<AuditCliRun> {
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_)/.test(key) || key === "NODE_TEST_CONTEXT" || key === "FORCE_COLOR" || key === "NO_COLOR") delete base[key];
  const home = env.HOME ?? makeHome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-audit-test-tmp-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...cliEntry(), "audit", ...args], {
      cwd: CLI_DIR,
      env: { ...base, HOME: home, TMPDIR: tmp, NO_COLOR: "1", XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"), ...env },
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
      if (env.HOME === undefined) fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, leftovers });
    });
  });
}
