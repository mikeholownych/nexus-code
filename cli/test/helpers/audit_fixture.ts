/**
 * What the audit-bundle tests share (GV-2): a fixture with one artefact of every kind, the schema checks every manifest
 * and result document goes through, a helper that re-seals a manifest the way someone rewriting a bundle would, and a
 * spy that records every path handed to `node:fs`.
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
