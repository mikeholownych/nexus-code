/**
 * GV-2: what `nexus audit export` collects (src/audit_export.ts), exercised in this process against saved task and
 * session state: which artefacts a bundle holds, how the subject is found, that the operator's store is left exactly
 * as it was, that nothing classified as a credential reaches a bundle, the snapshot rule, and what an export refuses.
 * No model, no network, no git. The commands themselves are test/audit_command.test.ts.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AUDIT_FILE_ROLES, auditExitCode } from "../src/audit_contract.js";
import { AUDIT_STANDARD_REDACTION_NOTE, AuditExportError, auditIdProblem, exportAuditBundle, renderAuditExportText, type AuditExportRequest } from "../src/audit_export.js";
import { AUDIT_UNSIGNED_CAVEAT, auditWorkspaceSha256, readChainedLogRecords } from "../src/core/audit_bundle.js";
import { verifyChain } from "../src/core/hash_chain.js";
import { computeCandidateIdentitySync } from "../src/core/candidate.js";
import { DurableStateManager } from "../src/core/state.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { FlightRecorder } from "../src/flight.js";
import { sandboxDenialEvent } from "../src/sandbox_events.js";
import {
  FIXED_NOW,
  bundleTexts,
  chainedLines,
  check,
  cleanTemp,
  configAttempts,
  exportChecked,
  flipByte,
  readManifest,
  recordFlight,
  reseal,
  savedSubject,
  sha256,
  snapshot,
  spyFs,
  type SubjectFixture,
} from "./helpers/audit_fixture.js";

after(cleanTemp);

/** The export is refused with this exit-code row; nothing is at the destination afterwards. */
function refused(request: AuditExportRequest, exit: "usage" | "subject_not_found" | "error", message?: RegExp): AuditExportError {
  let caught: unknown;
  try {
    exportAuditBundle(request);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof AuditExportError, `expected the export to be refused, got ${caught === undefined ? "a bundle" : String(caught)}`);
  assert.equal(caught.exit, exit, caught.message);
  if (message) assert.match(caught.message, message);
  return caught;
}

const stateOf = (subject: SubjectFixture) => snapshot(path.join(subject.root, "state"));
const FLIGHT = "flights/flight-in-window.flightlog";
const ATTEMPTS = "verification/config-attempts.jsonl";

function setReceiptCandidateId(subject: SubjectFixture, candidateId: string): void {
  const file = path.join(subject.storeDir, `${subject.id}.json`);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.validationReceipts[0].candidateId = candidateId;
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

test("a saved task exports every artefact with its role, and the bundle verifies as intact by hash only", () => {
  const subject = savedSubject();
  const receipt = path.join(subject.root, "verify-receipt.json");
  // VR-3: a named verify receipt carries typed sandbox denials. GV-2 copies it byte for byte, so they reach the bundle.
  const sandboxEvents = [{ kind: "unavailable", engine: "bwrap", profile: "default", operation: "verify", category: "engine", reason: "Bubblewrap could not confine the run", at: FIXED_NOW().toISOString() }];
  fs.writeFileSync(receipt, `${JSON.stringify({ schema_version: 2, verdict: "BLOCKED", exitCode: 3, sandboxEvents }, null, 2)}\n`);
  const exported = exportChecked(subject.request({ receiptFiles: [receipt] }));
  const manifest = readManifest(exported.written.dir);

  assert.deepEqual(Object.fromEntries(manifest.files.map((file) => [file.path, file.role])), {
    "evidence/diffs/op-1.diff": "diff",
    "evidence/findings.json": "evidence_findings",
    "evidence/provenance.json": "evidence_provenance",
    [FLIGHT]: "flight_log",
    "receipts/last-turn.json": "last_turn",
    "receipts/candidate-binding.json": "validation_receipts",
    "receipts/validation-receipts.json": "validation_receipts",
    "receipts/verify-1.json": "verify_receipt",
    "session/export.json": "session_export",
    "session/export.md": "session_export_markdown",
    "verification/attempts.json": "verification_attempts",
    [ATTEMPTS]: "verification_config_attempts",
  });
  // Every role but `trace` (not exported by this version, and listed as left out).
  assert.deepEqual([...new Set(manifest.files.map((file) => file.role))].sort(), AUDIT_FILE_ROLES.filter((role) => role !== "trace").sort());
  assert.deepEqual(manifest.omitted, [{ artefact: "traces/trace.jsonl", reason: "local traces (timings only) are not exported by this version" }]);

  const files = bundleTexts(exported.written.dir);
  const exportJson = JSON.parse(files["session/export.json"]);
  assert.equal(exportJson.export.format, "nexus-session-export/2");
  assert.equal(exportJson.export.exportedAt, FIXED_NOW().toISOString());
  assert.deepEqual(exportJson.messages.map((message: any) => message.content), ["do the thing", "done: the thing is in src/thing.ts"]);
  assert.equal(exportJson.workspacePath, subject.workspace, "the workspace path is the record's, not the stand-in the loader saw");
  assert.equal(exportJson.workspace, subject.workspace);
  assert.match(files["session/export.md"], new RegExp(`- \\*\\*Workspace:\\*\\* \`${subject.workspace}\``));
  assert.ok(!Object.values(files).some((text) => text.includes("NEXUS_AUDIT_")), "no stand-in is left in any file");
  assert.equal(JSON.parse(files["receipts/validation-receipts.json"])[0].receiptId, "r1");
  const binding = JSON.parse(files["receipts/candidate-binding.json"]);
  assert.equal(binding.status, process.platform === "linux" ? "partial" : "unavailable", "a legacy or malformed candidate id is not treated as a match");
  assert.equal(binding.receipts[0].relation, "unverifiable");
  assert.equal(binding.meaning, "Candidate identity relation sampled separately from bundle collection; it is not an atomic workspace snapshot and does not indicate verifier success or task acceptance.");
  assert.equal(exported.candidateBinding.status, binding.status);
  assert.ok(renderAuditExportText(exported).includes("candidate binding: " + binding.status + " (see receipts/candidate-binding.json; not a verifier or acceptance result)"));
  assert.equal(JSON.parse(files["receipts/last-turn.json"]).outcome, "VERIFIED");
  assert.deepEqual(JSON.parse(files["verification/attempts.json"]).map((attempt: any) => [attempt.n, attempt.status]), [[1, "PASSED"]]);
  assert.deepEqual(JSON.parse(files["evidence/provenance.json"]), [{ requirement: "R1", evidence: "npm test", source: "tool" }]);
  assert.deepEqual(JSON.parse(files["evidence/findings.json"]), ["src/thing.ts exports thing()"]);
  assert.equal(files["receipts/verify-1.json"], fs.readFileSync(receipt, "utf8"), "a named receipt is copied byte for byte");
  assert.deepEqual(JSON.parse(files["receipts/verify-1.json"]).sandboxEvents, sandboxEvents, "VR-3 denials reach the audit bundle with their receipt");
  assert.deepEqual(exported.receipts, [{ path: "receipts/verify-1.json", source: receipt }]);
  assert.equal(files["evidence/diffs/op-1.diff"], fs.readFileSync(path.join(subject.storeDir, `${subject.id}.diffs`, "op-1.diff"), "utf8"));
  assert.equal(files[FLIGHT], fs.readFileSync(path.join(subject.workspace, ".nexus", "flights", "flight-in-window.flightlog"), "utf8"));
  // One stored attempt per line, exactly as the record holds it.
  const stored = JSON.parse(fs.readFileSync(path.join(subject.storeDir, `${subject.id}.json`), "utf8"));
  assert.equal(files[ATTEMPTS], stored.verificationConfigAttempts.map((attempt: unknown) => `${JSON.stringify(attempt)}\n`).join(""));

  assert.deepEqual(manifest.subject, {
    kind: "task",
    task_id: subject.id,
    session_id: subject.id,
    store: "tasks",
    workspace_path: subject.workspace,
    workspace_sha256: sha256(subject.workspace),
    status: "completed",
    updated_at: stored.updatedAt,
    at_rest: true,
  });
  assert.equal(manifest.redaction, "standard");
  assert.deepEqual(manifest.nexus, { version: "1.3.0", commit: "0123abc", dirty: false });

  const verified = check(exported.written.dir);
  assert.equal(verified.exit, "intact_unsigned");
  assert.equal(verified.result.files.matched, 12);
  assert.ok(verified.text.includes(AUDIT_UNSIGNED_CAVEAT));
  assert.equal(verified.result.manifest_sha256, exported.document.manifest_sha256);

  assert.deepEqual(
    { ...exported.document, file_bytes: 0 },
    { schema_version: 1, result: "exported", exitCode: 0, bundle_dir: exported.written.dir, bundle_id: manifest.bundle_id, manifest_sha256: exported.written.manifestSha256, signed: false, redaction: "standard", at_rest: true, file_count: 12, file_bytes: 0, omitted: manifest.omitted, warnings: process.platform === "linux"
      ? ["Some persisted validation receipts could not be bound to the current workspace candidate or the report was truncated; see receipts/candidate-binding.json."]
      : ["Current workspace candidate identity could not be computed; validation receipt bindings are inconclusive."] },
  );
  assert.equal(exported.document.file_bytes, manifest.files.reduce((sum, file) => sum + file.bytes, 0));
});

test("candidate binding distinguishes current receipts from stale and unavailable identities", { skip: process.platform !== "linux" }, () => {
  const matched = savedSubject({ flight: false });
  const matchedId = computeCandidateIdentitySync(matched.workspace).candidateId;
  setReceiptCandidateId(matched, matchedId);
  const matchedExport = exportChecked(matched.request({ out: path.join(matched.root, "out", "matched") }));
  const matchedBinding = JSON.parse(bundleTexts(matchedExport.written.dir)["receipts/candidate-binding.json"]);
  assert.equal(matchedBinding.status, "matched");
  assert.equal(matchedBinding.current_candidate_id, matchedId);
  assert.deepEqual(matchedBinding.receipts.map((receipt: any) => [receipt.receipt_id, receipt.receipt_status, receipt.relation]), [["r1", "PASSED", "match"]]);

  const capped = savedSubject({ flight: false });
  const cappedId = computeCandidateIdentitySync(capped.workspace).candidateId;
  const cappedStateFile = path.join(capped.storeDir, `${capped.id}.json`);
  const cappedState = JSON.parse(fs.readFileSync(cappedStateFile, "utf8"));
  cappedState.validationReceipts = Array.from({ length: 10_001 }, (_, index) => ({
    ...cappedState.validationReceipts[0], receiptId: `receipt-${index}`, candidateId: cappedId,
  }));
  fs.writeFileSync(cappedStateFile, `${JSON.stringify(cappedState, null, 2)}\n`);
  const cappedExport = exportChecked(capped.request({ out: path.join(capped.root, "out", "capped") }));
  const cappedBinding = JSON.parse(bundleTexts(cappedExport.written.dir)["receipts/candidate-binding.json"]);
  assert.equal(cappedBinding.status, "partial");
  assert.equal(cappedBinding.receipt_count, 10_001);
  assert.equal(cappedBinding.receipts.length, 10_000);
  assert.equal(cappedBinding.receipts_omitted, 1);
  assert.ok(cappedExport.document.warnings.some((warning) => warning.includes("report was truncated")));

  const stale = savedSubject({ flight: false });
  const validatedId = computeCandidateIdentitySync(stale.workspace).candidateId;
  setReceiptCandidateId(stale, validatedId);
  fs.writeFileSync(path.join(stale.workspace, "changed-after-validation.txt"), "modified\n");
  const staleExport = exportChecked(stale.request({ out: path.join(stale.root, "out", "stale") }));
  const staleBinding = JSON.parse(bundleTexts(staleExport.written.dir)["receipts/candidate-binding.json"]);
  assert.equal(staleBinding.status, "mismatch");
  assert.notEqual(staleBinding.current_candidate_id, validatedId);
  assert.equal(staleBinding.receipts[0].relation, "mismatch");
  assert.ok(staleExport.document.warnings.some((warning) => warning.includes("different workspace candidate")));

  const unavailable = savedSubject({ flight: false });
  const stateFile = path.join(unavailable.storeDir, `${unavailable.id}.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.workspacePath = path.join(unavailable.root, "missing-workspace");
  state.workspace = state.workspacePath;
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const unavailableExport = exportChecked(unavailable.request({ out: path.join(unavailable.root, "out", "unavailable") }));
  const unavailableBinding = JSON.parse(bundleTexts(unavailableExport.written.dir)["receipts/candidate-binding.json"]);
  assert.equal(unavailableBinding.status, "unavailable");
  assert.equal(unavailableBinding.current_candidate_id, null);
  assert.equal(unavailableBinding.unavailable_reason, "workspace_missing");
  assert.equal(unavailableBinding.receipts[0].relation, "unverifiable");
  assert.ok(unavailableExport.document.warnings.some((warning) => warning.includes("candidate identity could not be computed")));
});

test("VR-3 sandbox denial flight events reach the bundle with the chained flight log", () => {
  const subject = savedSubject({ flight: false });
  const flight = new FlightRecorder(subject.workspace, "flight-vr3");
  flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1", taskPrompt: "try to write outside" });
  flight.recordSandboxDenial(1, sandboxDenialEvent({
    kind: "violation",
    engine: "bwrap",
    operation: "run_command",
    category: "filesystem",
    reason: "command operands escaped the pinned workspace",
  }));
  flight.recordSessionEnd("blocked", false);

  const exported = exportChecked(subject.request({ flights: ["flight-vr3"] }));
  const files = bundleTexts(exported.written.dir);
  const copied = files["flights/flight-vr3.flightlog"];
  assert.match(copied, /"type":"sandbox_violation"/);
  const denial = copied.trim().split("\n").map((line) => JSON.parse(line)).find((entry: any) => entry.type === "sandbox_violation");
  assert.equal(denial.payload.engine, "bwrap");
  assert.equal(denial.payload.profile, "default");
  assert.equal(denial.payload.category, "filesystem");
  assert.match(denial.payload.reason, /pinned workspace/);
  assert.ok(!("verdict" in denial.payload), "a copied flight denial is evidence, never a verdict");
  const manifest = readManifest(exported.written.dir);
  assert.deepEqual(manifest.chained_logs.filter((log) => log.path.startsWith("flights/")).map((log) => [log.path, log.status]), [["flights/flight-vr3.flightlog", "intact"]]);
});

test("the chained logs' heads in the manifest are the heads of the logs, and the flight's source facts are the log's", () => {
  const subject = savedSubject();
  const exported = exportChecked(subject.request());
  const manifest = readManifest(exported.written.dir);
  assert.deepEqual(manifest.chained_logs.map((log) => [log.path, log.kind, log.status, log.records]), [[FLIGHT, "flight", "intact", 5], [ATTEMPTS, "verification_config_attempts", "intact", 2]]);
  for (const log of manifest.chained_logs) {
    const bytes = fs.readFileSync(path.join(exported.written.dir, log.path));
    const verdict = verifyChain(readChainedLogRecords(bytes).records);
    assert.ok(verdict.status === "intact" && verdict.head);
    assert.deepEqual(log.head, { seq: verdict.head.seq, hash: verdict.head.hash });
    assert.equal(JSON.parse(bytes.toString("utf8").trimEnd().split("\n").at(-1)!).chain.hash, log.head!.hash);
  }
  const flight = manifest.chained_logs[0];
  const source = fs.readFileSync(path.join(subject.workspace, ".nexus", "flights", "flight-in-window.flightlog"));
  assert.deepEqual(flight.source, { records: 5, head: flight.head, closed: true, bytes: source.length, sha256: sha256(source), complete: true });
  assert.deepEqual([flight.closed, flight.selection], [true, "time_window"]);
  assert.equal(manifest.chained_logs[1].closed, undefined);
});

test("altering one byte of any payload file is found, and exactly that file is named", () => {
  const subject = savedSubject();
  const exported = exportChecked(subject.request());
  for (const file of readManifest(exported.written.dir).files) {
    const copy = subject.out();
    fs.cpSync(exported.written.dir, copy, { recursive: true });
    flipByte(path.join(copy, file.path));
    const verified = check(copy);
    assert.equal(verified.exit, "tampered", file.path);
    assert.deepEqual([...new Set(verified.result.findings.map((finding) => finding.path))], [file.path]);
    assert.ok(verified.kinds.includes("file_altered"));
    assert.equal(verified.result.findings.find((finding) => finding.kind === "file_altered")!.expected_sha256, file.sha256);
  }
});

test("the subject is found by its exact id only", () => {
  const subject = savedSubject();
  // A prefix of an id is not the id, in either direction.
  for (const id of ["task-audit", "task-audit-", "task-audit-1x", "TASK-AUDIT-1", "index"]) {
    refused(subject.request({ id }), "subject_not_found", /must be exact; a prefix is not accepted/);
  }
  refused(subject.request({ store: "sessions" }), "subject_not_found", /in the sessions store/);
  assert.equal(exportChecked(subject.request({ store: "tasks" })).written.manifest.subject.store, "tasks");

  // The same id in both stores is an explicit ambiguity, and --store settles it.
  const session = savedSubject({ beside: subject, store: "sessions", diff: false, state: { title: "the session" } });
  refused(subject.request(), "usage", /both a task and a session; say which with --store/);
  const asSession = exportChecked(session.request({ store: "sessions" }));
  assert.deepEqual([asSession.written.manifest.subject.kind, asSession.written.manifest.subject.store], ["session", "sessions"]);
  assert.equal(JSON.parse(bundleTexts(asSession.written.dir)["session/export.json"]).title, "the session");
  assert.equal(JSON.parse(bundleTexts(exportChecked(subject.request({ store: "tasks" })).written.dir)["session/export.json"]).title, "audit fixture");
  assert.equal(auditExitCode("subject_not_found"), 2);
  assert.equal(auditExitCode("usage"), 2);
});

test("an id that is not a persistence name is a usage error, and no path is built from it", () => {
  const subject = savedSubject();
  fs.writeFileSync(path.join(subject.root, "state", "x.json"), fs.readFileSync(path.join(subject.storeDir, `${subject.id}.json`)));
  for (const id of ["../x", "..", ".", "/etc/passwd", path.join(subject.storeDir, subject.id), "", "a/b", "a\\b", "a\0b", `${subject.id}\0`, " ", "a b", `${subject.id}.json`, "x".repeat(161), "é"]) {
    const spied = spyFs(() => refused(subject.request({ id }), "usage", /is not a task or session id|the id is missing/));
    assert.deepEqual(spied.paths, [], `${JSON.stringify(id)}: the file system was touched before the id was refused`);
    assert.ok(!/[^\x20-\x7e]/.test(spied.value.message), "the message is printable");
    assert.notEqual(auditIdProblem(id), undefined);
  }
  for (const id of [undefined, null, 7, {}, ["a"]]) refused(subject.request({ id: id as any }), "usage", /the id is missing/);
  assert.equal(auditIdProblem("task-1.A_b"), undefined);
});

test("nothing classified as a credential reaches a bundle, and exporting leaves the store exactly as it was (a record the loader would rewrite)", () => {
  const key = `${["sk", "ant", "api03"].join("-")}-${"Ab12".repeat(8)}`;
  const envValue = "audit-env-credential-fixture-value";
  const subject = savedSubject({ id: "seed", flight: false, diff: false });
  const id = "legacy-task";
  const dir = path.join(subject.root, "legacy", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  const at = (offset: number): string => new Date(Date.now() + offset).toISOString();
  // A record as an older Nexus wrote it: schema 1, the conversation inline, nothing redacted, and no guard file in the store.
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      schemaVersion: 1, taskId: id, sessionId: id, id, title: "legacy", workspacePath: subject.workspace, workspace: subject.workspace, model: "m",
      createdAt: at(-60_000), updatedAt: at(60_000), status: "completed", activePlan: [], milestones: [], validationReceipts: [],
      messages: [{ role: "user", content: `deploy with ${key} and ${envValue}` }, { role: "assistant", content: "ok" }],
      findings: [`the key is ${key}`],
      verificationConfigAttempts: configAttempts(["package.json", `test/${key}.test.ts`]),
    }),
  );
  const diffs = path.join(dir, `${id}.diffs`);
  fs.mkdirSync(diffs);
  fs.writeFileSync(path.join(diffs, "clean.diff"), "@@ -1 +1 @@\n-a\n+b\n");
  fs.writeFileSync(path.join(diffs, "leak.diff"), `@@ -1 +1 @@\n-KEY=\n+KEY=${key}\n`);
  fs.writeFileSync(path.join(diffs, "env.diff"), `@@ -1 +1 @@\n-x\n+${envValue}\n`);
  const flights = path.join(subject.workspace, ".nexus", "flights");
  fs.mkdirSync(flights, { recursive: true });
  fs.writeFileSync(
    path.join(flights, "flight-leak.flightlog"),
    `${chainedLines([{ type: "session_start", payload: { flightId: "flight-leak", recordedAt: at(0), taskPrompt: `use ${key}` } }, { type: "session_end", payload: {} }]).join("\n")}\n`,
  );
  const receipt = path.join(subject.root, "receipt.json");
  fs.writeFileSync(receipt, JSON.stringify({ verdict: "VERIFIED", verifier: { command: `TOKEN=${envValue} npm test` } }));

  const before = snapshot(path.join(subject.root, "legacy"));
  const workspaceBefore = snapshot(subject.workspace);
  assert.ok(Object.values(before.files).some((hex) => Buffer.from(hex, "hex").includes(key)), "the store holds the key in the clear");
  process.env.NEXUS_AUDIT_FIXTURE_API_KEY = envValue;
  let exported;
  try {
    exported = exportChecked(subject.request({ id, tasksDir: dir, sessionsDir: path.join(subject.root, "legacy", "sessions"), receiptFiles: [receipt] }));
  } finally {
    delete process.env.NEXUS_AUDIT_FIXTURE_API_KEY;
  }
  assert.deepEqual(snapshot(path.join(subject.root, "legacy")), before, "the store is byte for byte and mode for mode what it was; not even a guard file was added");
  assert.deepEqual(snapshot(subject.workspace), workspaceBefore);

  const files = bundleTexts(exported.written.dir);
  for (const [name, text] of Object.entries(files)) {
    assert.ok(!text.includes(key), `${name} holds the planted provider key`);
    assert.ok(!text.includes(envValue), `${name} holds the planted environment credential`);
  }
  // Generated files are redacted and kept; files that cannot be rewritten are left out whole and listed.
  assert.match(JSON.parse(files["session/export.json"]).messages[0].content, /^deploy with \[REDACTED:[A-Z_]+\] and \[REDACTED:[A-Z_]+\]$/);
  assert.match(files["session/export.md"], /deploy with \[REDACTED:/);
  assert.match(JSON.parse(files["evidence/findings.json"])[0], /^the key is \[REDACTED:/);
  assert.equal(files["evidence/diffs/clean.diff"], "@@ -1 +1 @@\n-a\n+b\n");
  const scanned = /^the scan classified part of its content as a credential/;
  const leftOut = Object.fromEntries(exported.document.omitted.map((entry) => [entry.artefact, entry.reason]));
  for (const artefact of ["receipts/verify-1.json", ATTEMPTS, "evidence/diffs/env.diff", "evidence/diffs/leak.diff", "flights/flight-leak.flightlog"]) {
    assert.match(leftOut[artefact] ?? "", scanned, artefact);
    assert.equal(files[artefact], undefined);
  }
  assert.deepEqual(Object.keys(leftOut).sort(), ["evidence/diffs/env.diff", "evidence/diffs/leak.diff", "flights/flight-leak.flightlog", "receipts/verify-1.json", "traces/trace.jsonl", ATTEMPTS].sort());
  assert.deepEqual(exported.written.manifest.chained_logs, []);
  assert.match(exported.document.warnings.join("\n"), /Loading the record changed it.*the record in the store was not changed/);
  const text = renderAuditExportText(exported);
  for (const artefact of Object.keys(leftOut)) assert.ok(text.includes(`  - ${artefact}: ${leftOut[artefact]}`), "the command prints everything that was left out, with the reason");
  assert.ok(!text.includes(key) && !text.includes(envValue));
  assert.equal(check(exported.written.dir).exit, "intact_unsigned");
});

test("exporting does not modify the operator's stores or the workspace, and leaves no scratch copy behind", () => {
  const subject = savedSubject();
  const session = savedSubject({ beside: subject, id: "session-1", store: "sessions" });
  const before = stateOf(subject);
  const workspaceBefore = snapshot(subject.workspace);
  const tmpBefore = fs.readdirSync(path.dirname(subject.root)).filter((name) => name.startsWith("nexus-audit-export-"));
  const times = (dir: string): number[] => fs.readdirSync(dir).sort().map((name) => fs.statSync(path.join(dir, name)).mtimeMs);
  const timesBefore = [times(subject.tasks), times(subject.sessions)];
  exportChecked(subject.request());
  exportChecked(session.request());
  refused(subject.request({ id: "nope" }), "subject_not_found");
  assert.deepEqual(stateOf(subject), before);
  assert.deepEqual([times(subject.tasks), times(subject.sessions)], timesBefore, "no file of either store was rewritten");
  assert.deepEqual(snapshot(subject.workspace), workspaceBefore);
  assert.deepEqual(fs.readdirSync(path.dirname(subject.root)).filter((name) => name.startsWith("nexus-audit-export-")), tmpBefore);
});

test("the snapshot rule: every source file is opened once, and a log is cut at its last complete line", () => {
  const subject = savedSubject({ flight: false });
  const log = recordFlight(subject.workspace, "flight-live", false);
  // A writer is in the middle of a record.
  fs.appendFileSync(log, '{"eventId":"evt-torn","type":"tool_ca');
  new DurableStateManager({ baseDir: subject.storeDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(subject.workspace)] }).recordProgress(subject.id, {});
  const complete = fs.readFileSync(log).subarray(0, fs.readFileSync(log).lastIndexOf(10) + 1);

  const spied = spyFs(() => exportChecked(subject.request()));
  const exported = spied.value;
  const sources = [log, path.join(subject.storeDir, `${subject.id}.json`), path.join(subject.storeDir, `${subject.id}.messages.jsonl`), path.join(subject.storeDir, `${subject.id}.diffs`, "op-1.diff")];
  for (const source of sources) {
    assert.deepEqual(spied.events.filter((event) => event.path === source && /^(open|readFile|createReadStream|copyFile|cp)/.test(event.fn)).map((event) => event.fn), ["openSync"], `${source} is opened once and never read another way`);
  }
  const flight = exported.written.manifest.chained_logs.find((entry) => entry.kind === "flight")!;
  assert.equal(bundleTexts(exported.written.dir)["flights/flight-live.flightlog"], complete.toString("utf8"));
  assert.deepEqual([flight.records, flight.status, flight.closed], [4, "intact", false]);
  assert.deepEqual(flight.source, { records: 4, head: flight.head, closed: false, bytes: complete.length, sha256: sha256(complete), complete: true });
  assert.match(exported.document.warnings.join("\n"), /flight-live\.flightlog: the source log ended in an incomplete line/);

  // The flight goes on after the export: the bundle still verifies, and says the log was not closed.
  fs.writeFileSync(log, complete);
  new FlightRecorder(subject.workspace, "flight-live").recordSessionEnd("done", true);
  assert.notEqual(sha256(fs.readFileSync(log)), flight.source!.sha256);
  const verified = check(exported.written.dir);
  assert.equal(verified.exit, "intact_unsigned");
  assert.match(verified.result.notes.join("\n"), /flights\/flight-live\.flightlog was not closed when it was exported/);
  assert.match(renderAuditExportText(exported), /flight-live\.flightlog: chain intact, 4 records, NOT closed/);
});

test("a subject that is not at rest is exported with at_rest false and a warning", () => {
  const subject = savedSubject({ status: "in_progress" });
  const exported = exportChecked(subject.request());
  assert.equal(exported.written.manifest.subject.at_rest, false);
  assert.equal(exported.document.at_rest, false);
  assert.match(renderAuditExportText(exported), /WARNING: The subject was not at rest \(status in_progress\)/);
  const inFlight = savedSubject({ id: "busy", state: { currentOperation: { invocationId: "i1", toolName: "run_command", startedAt: "2026-11-22T09:00:00.000Z", status: "in_flight" } } });
  assert.equal(exportChecked(inFlight.request()).document.at_rest, false, "a finished status with an operation still in flight is not at rest");
  assert.equal(exportChecked(savedSubject({ id: "stopped", status: "interrupted" }).request()).document.at_rest, true);
});

test("flights: the time window chooses, --flight names, a log is never followed through a link, and a large log is a bounded prefix", () => {
  const subject = savedSubject();
  const flights = path.join(subject.workspace, ".nexus", "flights");
  const old = [{ type: "session_start", payload: { flightId: "flight-old", recordedAt: "2020-01-01T00:00:00.000Z" } }, { type: "session_end", payload: {} }];
  fs.writeFileSync(path.join(flights, "flight-old.flightlog"), `${chainedLines(old).join("\n")}\n`);
  const outside = path.join(subject.root, "outside.flightlog");
  fs.copyFileSync(path.join(flights, "flight-in-window.flightlog"), outside);
  fs.symlinkSync(outside, path.join(flights, "flight-link.flightlog"));

  const byWindow = exportChecked(subject.request());
  assert.deepEqual(byWindow.written.manifest.chained_logs.filter((log) => log.kind === "flight").map((log) => [log.path, log.selection]), [[FLIGHT, "time_window"]]);
  assert.deepEqual(byWindow.document.omitted.filter((entry) => entry.artefact === "flights"), [{ artefact: "flights", reason: "a flight log of the workspace was not read (it is a symbolic link), so whether it belongs to this subject is not known" }]);
  assert.match(renderAuditExportText(byWindow), /chosen by time window \(a heuristic: it can pick up another task's flight in the same workspace\)/);

  const named = exportChecked(subject.request({ flights: ["flight-old", "flight-old"] }));
  assert.deepEqual(named.written.manifest.chained_logs.filter((log) => log.kind === "flight").map((log) => [log.path, log.selection, log.records]), [["flights/flight-old.flightlog", "explicit", 2]]);
  refused(subject.request({ flights: ["flight-nope"] }), "usage", /--flight flight-nope: there is no such flight log/);
  refused(subject.request({ flights: ["flight-link"] }), "usage", /it is a symbolic link/);
  refused(subject.request({ flights: ["../flight-old"] }), "usage", /is not a flight id/);

  // Above the copy limit the bundle holds the longest prefix of complete records; the manifest keeps the whole log's facts.
  const source = fs.readFileSync(path.join(flights, "flight-in-window.flightlog"));
  const lines = source.toString("utf8").trimEnd().split("\n");
  const limit = Buffer.byteLength(`${lines.slice(0, 3).join("\n")}\n`) + 5;
  const bounded = exportChecked(subject.request({ flightCopyBytes: limit }));
  const log = bounded.written.manifest.chained_logs.find((entry) => entry.kind === "flight")!;
  assert.equal(bundleTexts(bounded.written.dir)[FLIGHT], `${lines.slice(0, 3).join("\n")}\n`);
  assert.deepEqual([log.records, log.status, log.closed, log.head!.seq], [3, "intact", false, 2]);
  assert.deepEqual(log.source, { records: 5, head: byWindow.written.manifest.chained_logs[0].head, closed: true, bytes: source.length, sha256: sha256(source), complete: false });
  const verified = check(bounded.written.dir);
  assert.equal(verified.exit, "intact_unsigned");
  assert.match(verified.result.notes.join("\n"), /is a bounded excerpt: the first 3 records of a source log of 5/);
  assert.match(renderAuditExportText(bounded), /a bounded excerpt: the first 3 of 5 records/);
  const tiny = exportChecked(subject.request({ flightCopyBytes: 10 }));
  assert.match(tiny.document.omitted.find((entry) => entry.artefact === FLIGHT)?.reason ?? "", /its first record alone is larger than the 10 bytes/);

  // No flight in the window, no workspace, and -w.
  const none = savedSubject({ id: "no-flight", flight: false });
  assert.match(exportChecked(none.request()).document.omitted.find((entry) => entry.artefact === "flights")?.reason ?? "", /the workspace has no \.nexus\/flights directory/);
  const elsewhere = exportChecked(none.request({ workspace: subject.workspace, flights: ["flight-old"] }));
  assert.deepEqual(elsewhere.written.manifest.chained_logs.filter((entry) => entry.kind === "flight").map((entry) => entry.path), ["flights/flight-old.flightlog"]);
  assert.equal(elsewhere.written.manifest.subject.workspace_path, none.workspace, "-w says where to look for flights; the subject's workspace is the record's");
  refused(none.request({ workspace: path.join(none.root, "missing") }), "usage", /-w does not name a directory/);
});

test("--receipt-file takes `nexus verify` result documents only", () => {
  const subject = savedSubject();
  const notJson = path.join(subject.root, "notes.txt");
  fs.writeFileSync(notJson, "not a receipt\n");
  const noVerdict = path.join(subject.root, "other.json");
  fs.writeFileSync(noVerdict, JSON.stringify({ schema_version: 1, error: "x" }));
  refused(subject.request({ receiptFiles: [notJson] }), "usage", /is not a `nexus verify` result document/);
  refused(subject.request({ receiptFiles: [noVerdict] }), "usage", /is not a `nexus verify` result document/);
  refused(subject.request({ receiptFiles: [path.join(subject.root, "missing.json")] }), "usage", /it does not exist/);
  refused(subject.request({ receiptFiles: [subject.root] }), "usage", /it is not a regular file/);
  assert.match(exportChecked(subject.request()).document.omitted.find((entry) => entry.artefact === "receipts/verify-<n>.json")?.reason ?? "", /no `nexus verify` receipt was named/);
});

test("an export never writes over anything, and never reports a bundle that is not in place", { skip: process.getuid?.() === 0 }, () => {
  const subject = savedSubject();
  const existing = subject.out("taken");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "keep.txt"), "mine");
  const before = snapshot(existing);
  refused(subject.request({ out: existing }), "usage", /already exists; an audit bundle is never written over anything/);
  assert.deepEqual(snapshot(existing), before);
  const file = subject.out("a-file");
  fs.writeFileSync(file, "x");
  refused(subject.request({ out: file }), "usage", /already exists/);
  refused(subject.request({ out: path.join(subject.root, "no-such-parent", "bundle") }), "usage", /the parent directory of --out does not exist/);

  // The bundle cannot be written: the export fails as `error`, and there is no bundle and no partial directory.
  const locked = path.join(subject.root, "locked");
  fs.mkdirSync(locked, { mode: 0o500 });
  try {
    const error = refused(subject.request({ out: path.join(locked, "bundle") }), "error", /the audit bundle was not written/);
    assert.equal(auditExitCode(error.exit as "error"), 1);
    assert.deepEqual(fs.readdirSync(locked), []);
  } finally {
    fs.chmodSync(locked, 0o700);
  }

  // Written: everything the result names is there, and nothing else is beside it.
  const exported = exportChecked(subject.request({ out: path.join(locked, "bundle") }));
  assert.deepEqual(fs.readdirSync(locked), ["bundle"]);
  assert.equal(exported.document.bundle_dir, path.join(locked, "bundle"));
  assert.equal(check(exported.document.bundle_dir).exit, "intact_unsigned");

  // Without --out the bundle goes beside the caller, named after the subject and the time.
  const beside = exportChecked({ ...subject.request({ cwd: locked }), out: undefined });
  assert.equal(beside.document.bundle_dir, path.join(locked, `nexus-audit-${subject.id}-20261122T100000Z`));
});

test("an export is deterministic for a fixed subject, clock and id, and its files are private", () => {
  const subject = savedSubject();
  const first = snapshot(exportChecked(subject.request()).written.dir);
  const second = snapshot(exportChecked(subject.request()).written.dir);
  assert.deepEqual(second, first);
  for (const [entry, mode] of Object.entries(first.modes)) assert.equal(mode, entry in first.files ? 0o600 : 0o700, entry);
  assert.equal(Object.keys(first.files).length, 12);
  const other = exportChecked(subject.request({ bundleId: "cd".repeat(16) }));
  assert.notEqual(other.document.manifest_sha256, sha256(Buffer.from(first.files["manifest.json"], "hex")));
});

test("only standard redaction exists, and the options an export cannot honour are refused", () => {
  const subject = savedSubject();
  refused(subject.request({ redact: "strict" }), "usage", /--redact strict is not available in this version/);
  refused(subject.request({ redact: "none" }), "usage", /--redact takes "standard"/);
  refused(subject.request({ store: "operations" }), "usage", /--store is "tasks" or "sessions"/);
  const text = renderAuditExportText(exportChecked(subject.request({ redact: "standard" })));
  assert.ok(text.includes(AUDIT_UNSIGNED_CAVEAT), "every export states the unsigned limit");
  assert.ok(text.includes(AUDIT_STANDARD_REDACTION_NOTE), "every export states the redaction limit");
  assert.match(AUDIT_STANDARD_REDACTION_NOTE, /does NOT remove prompts, model replies, tool output, source code in diffs, absolute paths, the model name or the endpoint: the bundle is secret-redacted, not confidential/);
  assert.match(text, /manifest sha256: [0-9a-f]{64}\nRecord this value somewhere the bundle's holder cannot change it/);
});

test("a session's compaction archive and its record under another session id are the subject's", () => {
  const subject = savedSubject({ id: "session-2", store: "sessions" });
  const manager = new DurableStateManager({ baseDir: subject.storeDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(subject.workspace)] });
  manager.appendArchive(subject.id, "compaction-1", [{ role: "user", content: "an earlier message" } as any]);
  // Another session's archive and diffs sit beside it and are not the subject's.
  manager.appendArchive("session-20", "compaction-9", [{ role: "user", content: "someone else's message" } as any]);
  fs.mkdirSync(path.join(subject.storeDir, "session-20.diffs"));
  fs.writeFileSync(path.join(subject.storeDir, "session-20.diffs", "other.diff"), "+other\n");
  const exported = exportChecked(subject.request());
  const files = bundleTexts(exported.written.dir);
  assert.deepEqual(JSON.parse(files["session/export.json"]).archivedHistory.map((message: any) => message.content), ["an earlier message"]);
  assert.ok(!Object.values(files).some((text) => text.includes("someone else's message") || text.includes("+other")));
  assert.deepEqual(Object.keys(files).filter((name) => name.startsWith("evidence/diffs/")), ["evidence/diffs/op-1.diff"]);
  assert.equal(exported.written.manifest.subject.kind, "session");
});

test("the workspace hash is the SHA-256 of the recorded path's bytes, and a bundle where the two disagree does not verify", () => {
  assert.equal(auditWorkspaceSha256("/work/repo"), sha256("/work/repo"));
  assert.notEqual(auditWorkspaceSha256("/work/repo/"), auditWorkspaceSha256("/work/repo"), "no normalisation");
  const subject = savedSubject();
  const exported = exportChecked(subject.request());
  assert.equal(exported.written.manifest.subject.workspace_sha256, sha256(Buffer.from(subject.workspace, "utf8")));
  // A manifest rewritten to name another workspace under the old hash is refused, however consistent its hashes are.
  const manifest = readManifest(exported.written.dir) as Record<string, any>;
  manifest.subject.workspace_path = `${subject.workspace}-other`;
  reseal(exported.written.dir, manifest);
  const verified = check(exported.written.dir);
  assert.equal(verified.exit, "tampered");
  assert.deepEqual(verified.result.findings.map((finding) => [finding.kind, finding.message]), [["manifest_malformed", "subject.workspace_sha256 is not the SHA-256 of subject.workspace_path"]]);
  // With the path withheld (as a later redaction mode does) the hash stands alone.
  manifest.subject.workspace_path = null;
  reseal(exported.written.dir, manifest);
  assert.equal(check(exported.written.dir).exit, "intact_unsigned");
});

/**
 * Characterisation of an open risk in the code that records verification-configuration attempts (not this module's):
 * an attempt is linked into its chain before the state is redacted for saving. When redaction changes an attempt, the
 * stored record no longer matches its own hash, and the log reads as edited after a save and a load although nobody
 * edited it. This pins when that happens and what an export then says.
 */
test("characterisation: redaction at save can break the chain of the verification-configuration attempts, and the export records the log as broken", () => {
  const key = `${["sk", "ant", "api03"].join("-")}-${"Cd34".repeat(8)}`;
  const ordinary = "packages/web-app/src/features/checkout/CheckoutFlow.integration.test.tsx";
  const load = (subject: SubjectFixture) => new DurableStateManager({ baseDir: subject.storeDir, workspacePaths: [WorkspacePath.fromSelectedWorkspace(subject.workspace)] }).loadTaskState(subject.id);

  // An ordinary path, however long, is stored as it was linked: the chain holds.
  const fine = savedSubject({ id: "ordinary", flight: false, state: { verificationConfigAttempts: configAttempts(["package.json", ordinary]) } });
  assert.equal(verifyChain(load(fine).verificationConfigAttempts!).status, "intact");

  // A path the classifier takes for a credential is replaced when the state is saved; the link was made before that.
  const attempts = configAttempts(["package.json", `test/${key}.test.ts`, "Makefile"]);
  assert.equal(verifyChain(attempts).status, "intact", "the chain was intact when the attempts were recorded");
  const subject = savedSubject({ id: "redacted-attempt", flight: false, state: { verificationConfigAttempts: attempts } });
  const loaded = load(subject).verificationConfigAttempts!;
  assert.match(loaded[1].path, /^test\/\[REDACTED:[A-Z_]+\]\.test\.ts$/);
  assert.deepEqual(verifyChain(loaded), { status: "broken", records: 3, at: 1, problem: "edited", detail: "record 1 was changed after it was written" });

  // The export does not repair or hide it: the stored records go in as they are, and the manifest records the chain as broken.
  const exported = exportChecked(subject.request());
  const log = exported.written.manifest.chained_logs.find((entry) => entry.path === ATTEMPTS)!;
  assert.deepEqual([log.status, log.records, log.head], ["broken", 3, undefined]);
  assert.match(exported.document.warnings.join("\n"), /config-attempts\.jsonl does not read as an intact chain; the manifest records it as broken/);
  assert.ok(!Object.values(bundleTexts(exported.written.dir)).some((text) => text.includes(key)));
  const verified = check(exported.written.dir);
  assert.equal(verified.exit, "tampered", "a faithfully bundled but already broken source log cannot be accepted as intact");
  assert.deepEqual(verified.result.findings.map((finding) => [finding.kind, finding.path]), [["log_not_intact_at_export", ATTEMPTS]]);
  assert.deepEqual(verified.result.notes, []);
});

test("a repository whose own Git configuration names a program is not hashed: the binding is unavailable and nothing runs", { skip: process.platform !== "linux" }, () => {
  // Each case is a way a checkout can make Git run a command while it hashes a changed file. The marker file is the proof.
  const cases: Array<[string, (workspace: string, command: string) => void]> = [
    ["a clean filter", (workspace, command) => {
      fs.writeFileSync(path.join(workspace, ".gitattributes"), "* filter=planted\n");
      git(workspace, "config", "filter.planted.clean", command);
    }],
    ["a filter named only in .git/info/attributes", (workspace, command) => {
      fs.mkdirSync(path.join(workspace, ".git", "info"), { recursive: true });
      fs.writeFileSync(path.join(workspace, ".git", "info", "attributes"), "* filter=planted\n");
      git(workspace, "config", "filter.planted.clean", command);
    }],
    ["a filter defined in an included file", (workspace, command) => {
      fs.writeFileSync(path.join(workspace, ".gitattributes"), "* filter=planted\n");
      const included = path.join(workspace, ".git", "planted.inc");
      fs.writeFileSync(included, `[filter "planted"]\n\tclean = ${command}\n`);
      git(workspace, "config", "include.path", included);
    }],
    ["a file-system monitor", (workspace, command) => git(workspace, "config", "core.fsmonitor", command)],
    ["an attributes file named by the repository", (workspace, command) => {
      const attributes = path.join(workspace, ".git", "planted.attributes");
      fs.writeFileSync(attributes, "* filter=planted\n");
      git(workspace, "config", "core.attributesFile", attributes);
      git(workspace, "config", "filter.planted.clean", command);
    }],
  ];
  for (const [name, plant] of cases) {
    const subject = savedSubject({ flight: false });
    if (!fs.existsSync(path.join(subject.workspace, ".git"))) git(subject.workspace, "init", "-q");
    fs.writeFileSync(path.join(subject.workspace, "tracked.txt"), "tracked\n");
    git(subject.workspace, "add", "-A");
    git(subject.workspace, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
    setReceiptCandidateId(subject, "0".repeat(64));
    // The tracked file keeps its content and size and gets a new modification time: Git cannot tell whether it changed
    // without hashing it again, and hashing is what runs a content filter. (A file whose size changed is known to be
    // modified without being read.) Done before the plant: the test's own Git commands would otherwise run the
    // planted program themselves.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(subject.workspace, "tracked.txt"), later, later);
    const marker = path.join(subject.root, "ran");
    plant(subject.workspace, `sh -c 'echo ran > ${marker}; cat'`);
    assert.equal(fs.existsSync(marker), false, `${name}: planting ran the command`);

    const exported = exportChecked(subject.request({ out: path.join(subject.root, "out", "hostile") }));
    const binding = JSON.parse(bundleTexts(exported.written.dir)["receipts/candidate-binding.json"]);
    assert.equal(fs.existsSync(marker), false, `${name}: the configured command ran`);
    assert.equal(binding.status, "unavailable", name);
    assert.equal(binding.unavailable_reason, "workspace_configures_git_programs", name);
    assert.equal(binding.current_candidate_id, null, name);
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
