/**
 * GV-2: `nexus audit export` and `nexus audit verify` as commands (src/audit_cli.ts), run through the real CLI entry
 * with a throwaway HOME and NEXUS_STATE_DIR: the round trip an auditor makes, the exit codes, the JSON documents, and
 * that `nexus audit` itself still prints the tool audit log and no longer accepts a mistyped subcommand. What an export
 * collects is tested in this process in test/audit_export.test.ts; each case here costs a process start, so they are few
 * and run side by side.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { AUDIT_EXIT_CODES } from "../src/audit_contract.js";
import { AUDIT_STANDARD_REDACTION_NOTE } from "../src/audit_export.js";
import { AUDIT_UNSIGNED_CAVEAT } from "../src/core/audit_bundle.js";
import { ATTEMPTS_PATH, AUDIT_VERIFY_SCHEMA, CLI_DIR, FLIGHT_PATH, assertManifestValid, cleanTemp, fixtureInput, flipByte, readManifest, runAudit, savedSubject, snapshot, tempDir, writeFixture, type AuditCliRun, type SubjectFixture } from "./helpers/audit_fixture.js";
import { validate } from "./helpers/json_schema.js";

after(cleanTemp);

const MANUAL = path.resolve(CLI_DIR, "..", "docs", "USER_MANUAL.md");
const stateEnv = (subject: SubjectFixture): Record<string, string> => ({ NEXUS_STATE_DIR: path.join(subject.root, "state") });

/** Keep the real-CLI subprocess fan-out bounded on slower CI workers. */
async function runAuditBatch(calls: Array<() => Promise<AuditCliRun>>, concurrency = 2): Promise<AuditCliRun[]> {
  const results: AuditCliRun[] = [];
  for (let start = 0; start < calls.length; start += concurrency) {
    results.push(...await Promise.all(calls.slice(start, start + concurrency).map((call) => call())));
  }
  return results;
}

/** What a consumer does with `--json`: stdout is exactly one document of the published schema, and `exitCode` is the process's. */
function consume(run: AuditCliRun): any {
  let document: any;
  try {
    document = JSON.parse(run.stdout);
  } catch {
    assert.fail(`stdout is not one JSON document: ${run.stdout.slice(0, 200)}\nstderr: ${run.stderr.slice(0, 400)}`);
  }
  assert.equal(run.stdout, `${JSON.stringify(document, null, 2)}\n`, "nothing but the document on stdout");
  assert.deepEqual(validate(document, AUDIT_VERIFY_SCHEMA, AUDIT_VERIFY_SCHEMA), [], "the document validates against docs/protocol/audit-verify-result schema");
  assert.equal(Object.keys(document)[0], "schema_version");
  assert.equal(document.exitCode, run.code, "exitCode repeats the process exit code");
  assert.deepEqual(run.leftovers, [], "nothing is left in the temp directory");
  return document;
}

test("the manual's audit exit-code table is the exported table, and points at docs/AUDIT.md", () => {
  const manual = fs.readFileSync(MANUAL, "utf8");
  const start = manual.indexOf("#### Exit codes of `nexus audit export` and `nexus audit verify`");
  assert.ok(start >= 0, "the manual has the section");
  const rows = manual.slice(start).split("\n").slice(1);
  const first = rows.findIndex((line) => line.startsWith("|"));
  const table: string[] = [];
  for (let i = first; i < rows.length && rows[i].startsWith("|"); i++) table.push(rows[i]);
  const cells = table.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.deepEqual(cells[0], ["Code", "Name", "When"]);
  assert.match(cells[1].join(""), /^[-: ]+$/);
  assert.deepEqual(
    cells.slice(2).map(([code, name, when]) => ({ code: Number(code), name: name.replace(/`/g, ""), when })),
    AUDIT_EXIT_CODES.map((row) => ({ ...row })),
  );
  const section = manual.slice(manual.indexOf("### `nexus audit export` / `nexus audit verify`"), start);
  assert.match(section, /\[`docs\/AUDIT\.md`\]\(AUDIT\.md\)/);
  assert.ok(fs.existsSync(path.resolve(CLI_DIR, "..", "docs", "AUDIT.md")));
  // The two documents state the unsigned limit in the library's own words, and the redaction limit.
  const guide = fs.readFileSync(path.resolve(CLI_DIR, "..", "docs", "AUDIT.md"), "utf8");
  for (const text of [guide, section]) {
    assert.ok(text.includes(AUDIT_UNSIGNED_CAVEAT), "the unsigned caveat, word for word");
    assert.match(text, /secret-redacted, not confidential/);
  }
  for (const row of AUDIT_EXIT_CODES) assert.ok(guide.includes(`\`${row.name}\``), `docs/AUDIT.md names the exit ${row.name}`);
});

test("the round trip through the commands: export a saved task, verify it, alter one byte of each kind of payload", async () => {
  const subject = savedSubject();
  const receipt = path.join(subject.root, "verify-receipt.json");
  fs.writeFileSync(receipt, `${JSON.stringify({ schema_version: 1, verdict: "VERIFIED", exitCode: 0 }, null, 2)}\n`);
  const before = snapshot(path.join(subject.root, "state"));
  const dir = subject.out("exported");
  const exported = await runAudit(["export", subject.id, "--out", dir, "--receipt-file", receipt], stateEnv(subject));
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(exported.stderr, "");
  assert.deepEqual(exported.leftovers, [], "the private copy the loader ran on is gone");
  assert.deepEqual(snapshot(path.join(subject.root, "state")), before, "the command left the store as it was");
  const manifest = readManifest(dir);
  assertManifestValid(manifest);
  const hash = /^manifest sha256: ([0-9a-f]{64})$/m.exec(exported.stdout)?.[1];
  assert.ok(hash, exported.stdout);
  assert.ok(exported.stdout.startsWith(`Audit bundle written: ${dir}\n`));
  assert.match(exported.stdout, /files: 12 \(\d+ bytes\) and manifest\.json/);
  assert.match(exported.stdout, /Left out of the bundle:\n  - traces\/trace\.jsonl: local traces \(timings only\) are not exported by this version\n/);
  assert.match(exported.stdout, /Record this value somewhere the bundle's holder cannot change it/);
  assert.ok(exported.stdout.includes(AUDIT_UNSIGNED_CAVEAT));
  assert.ok(exported.stdout.includes(AUDIT_STANDARD_REDACTION_NOTE));
  assert.match(exported.stdout, /candidate binding: partial \(see receipts\/candidate-binding\.json; not a verifier or acceptance result\)/);
  assert.match(exported.stdout, /WARNING: Some persisted validation receipts could not be bound to the current workspace candidate or the report was truncated; see receipts\/candidate-binding\.json\./);
  assert.ok(!exported.stdout.includes("The subject was not at rest"), "a subject at rest has no at-rest warning");

  const altered = manifest.files.map((file) => {
    const copy = subject.out();
    fs.cpSync(dir, copy, { recursive: true });
    flipByte(path.join(copy, file.path));
    return { file, copy };
  });
  assert.equal(new Set(manifest.files.map((file) => file.role)).size, 11, "one file of each kind");
  const [text, json, expected, unexpected, ...flipped] = await runAuditBatch([
    () => runAudit(["verify", dir]),
    () => runAudit(["verify", dir, "--json"]),
    () => runAudit(["verify", dir, "--expect-manifest-sha256", hash!.toUpperCase()]),
    () => runAudit(["verify", dir, "--json", "--expect-manifest-sha256", "0".repeat(64)]),
    ...altered.map(({ copy }) => () => runAudit(["verify", copy, "--json"])),
  ]);

  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stderr, "");
  assert.ok(text.stdout.startsWith(`INTACT BY HASH ONLY: all 11 files match the manifest. ${AUDIT_UNSIGNED_CAVEAT} To rule that out, compare the manifest hash ${hash} with one recorded at export.\n`), text.stdout);
  const document = consume(json);
  assert.deepEqual([json.code, document.result, document.manifest_sha256, document.signature, document.files], [0, "intact_unsigned", hash, "absent", { listed: 11, matched: 11 }]);
  assert.equal(expected.code, 0);
  assert.match(expected.stdout, /The manifest hash [0-9a-f]{64} is the one you expected/);
  assert.deepEqual([unexpected.code, consume(unexpected).findings.map((finding: any) => finding.kind)], [1, ["manifest_sha256_mismatch"]]);

  for (const [index, run] of flipped.entries()) {
    const { file } = altered[index];
    const result = consume(run);
    assert.deepEqual([run.code, result.result], [1, "tampered"], file.path);
    assert.deepEqual([...new Set(result.findings.map((finding: any) => finding.path))], [file.path], "exactly the altered file is named");
    const finding = result.findings.find((entry: any) => entry.kind === "file_altered");
    assert.deepEqual([finding.expected_sha256, finding.expected_bytes], [file.sha256, file.bytes]);
    assert.equal(result.files.matched, 10);
  }
  // And as a person sees it.
  const seen = await runAudit(["verify", altered[0].copy]);
  assert.equal(seen.code, 1);
  assert.match(seen.stdout, new RegExp(`^NOT INTACT: \\d+ problems? found\\..*\\n  file_altered ${altered[0].file.path}: `));
});

test("`nexus audit verify` fails when a bundled source log was already broken at export", async () => {
  const input = fixtureInput();
  const attempts = input.artefacts.find((entry) => entry.path === ATTEMPTS_PATH)!;
  attempts.bytes = Buffer.from(Buffer.from(attempts.bytes).toString("utf8").replace("blocked", "rewritten"));
  const bundle = writeFixture(input);

  const run = await runAudit(["verify", bundle.dir, "--json"]);
  const result = consume(run);
  assert.deepEqual([run.code, result.result, result.findings.map((finding: any) => [finding.kind, finding.path])], [
    1,
    "tampered",
    [["log_not_intact_at_export", ATTEMPTS_PATH]],
  ]);
});

test("`nexus audit verify` fails when the first flight record is a durable recording-gap marker", async () => {
  const input = fixtureInput();
  const flight = input.artefacts.find((entry) => entry.path === FLIGHT_PATH)!;
  flight.bytes = Buffer.from(`${JSON.stringify({ type: "recording_gap", payload: { recordingSkipped: true, reason: "sanitization_failed" } })}\n`);
  const bundle = writeFixture(input);

  const run = await runAudit(["verify", bundle.dir, "--json"]);
  const result = consume(run);
  assert.deepEqual([run.code, result.result, result.findings.map((finding: any) => [finding.kind, finding.path])], [
    1,
    "tampered",
    [["log_recording_gap_at_export", FLIGHT_PATH]],
  ]);
});

test("`nexus audit` still prints the tool audit log, byte for byte, and refuses anything that is not a subcommand", async () => {
  // The output of `nexus audit` and `nexus audit --limit 5` for this log, captured from the code before the subcommands existed.
  const records: string[] = [];
  for (let i = 1; i <= 7; i++) {
    records.push(JSON.stringify({ timestamp: `2026-11-22T10:00:0${i}.000Z`, tool: i % 3 === 0 ? "run_command" : "read_file", success: i !== 4, duration_ms: i * 11, ...(i === 4 ? { error: `boom ${i}` } : {}) }));
    if (i === 2) records.push("{not json");
  }
  const row = (i: number): string => `2026-11-22 10:00:0${i} | ${i === 4 ? "FAIL" : "PASS"} | ${(i % 3 === 0 ? "run_command" : "read_file").padEnd(16)} | ${`${i * 11}ms`.padStart(6)}\n${i === 4 ? "  └─ Error: boom 4\n" : ""}`;
  const all = `\n=== Nexus Code Tool Execution Audit Log (7 entries) ===\n\n${[1, 2, 3, 4, 5, 6, 7].map(row).join("")}\n`;
  const lastFive = `\n=== Nexus Code Tool Execution Audit Log (5 entries) ===\n\n${[3, 4, 5, 6, 7].map(row).join("")}\n`;
  assert.equal(all, "\n=== Nexus Code Tool Execution Audit Log (7 entries) ===\n\n2026-11-22 10:00:01 | PASS | read_file        |   11ms\n2026-11-22 10:00:02 | PASS | read_file        |   22ms\n2026-11-22 10:00:03 | PASS | run_command      |   33ms\n2026-11-22 10:00:04 | FAIL | read_file        |   44ms\n  └─ Error: boom 4\n2026-11-22 10:00:05 | PASS | read_file        |   55ms\n2026-11-22 10:00:06 | PASS | run_command      |   66ms\n2026-11-22 10:00:07 | PASS | read_file        |   77ms\n\n");

  const home = tempDir();
  fs.mkdirSync(path.join(home, ".nexus"));
  fs.writeFileSync(path.join(home, ".nexus", "audit.log"), `${records.join("\n")}\n`);
  const bundle = path.join(home, "some-bundle");
  const env = { HOME: home };
  const [plain, limited, errors, bogus, typo, typoWithOption] = await runAuditBatch([
    () => runAudit([], env),
    () => runAudit(["--limit", "5"], env),
    () => runAudit(["--errors", "-n", "3"], env),
    () => runAudit(["bogus", "x"], env),
    () => runAudit(["verfy", bundle], env),
    () => runAudit(["--limit", "5", "exprot", "task-1"], env),
  ]);
  assert.deepEqual([plain.code, plain.stdout, plain.stderr], [0, all, ""]);
  assert.deepEqual([limited.code, limited.stdout, limited.stderr], [0, lastFive, ""]);
  assert.deepEqual([errors.code, errors.stdout], [0, `\n=== Nexus Code Tool Execution Audit Log (1 entries) ===\n\n${row(4)}\n`]);
  // Before: each of these printed the log and exited 0, which reads as a verification that passed.
  for (const [run, name] of [[bogus, "bogus"], [typo, "verfy"], [typoWithOption, "exprot"]] as const) {
    assert.equal(run.code, 2, run.stderr);
    assert.equal(run.stdout, "", "the audit log is not printed");
    assert.match(run.stderr, new RegExp(`^error: unknown audit subcommand '${name}'\\. The subcommands are \`export\` and \`verify\``));
  }
});

test("the CLI signs with an operator key, verifies against the public key, and never copies the private key", async () => {
  const subject = savedSubject({ flight: false, diff: false });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePath = path.join(subject.root, "operator-private.pem");
  const publicPath = path.join(subject.root, "operator-public.pem");
  const wrongPublicPath = path.join(subject.root, "wrong-public.pem");
  fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(wrongPublicPath, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
  const out = subject.out("signed-bundle");
  const env = stateEnv(subject);
  const exported = await runAudit(["export", subject.id, "--out", out, "--sign-key", privatePath, "--json"], env);
  const exportedDoc = consume(exported);
  assert.deepEqual([exported.code, exportedDoc.result, exportedDoc.signed], [0, "exported", true]);
  assert.equal(fs.existsSync(path.join(out, "manifest.sig.json")), true);
  assert.equal(fs.readdirSync(out).some((name) => name.includes("private")), false);
  const checked = await runAudit(["verify", out, "--public-key", publicPath, "--json"]);
  assert.deepEqual([checked.code, consume(checked).result, consume(checked).signature], [0, "intact_signed", "valid"]);
  const mismatched = await runAudit(["verify", out, "--public-key", wrongPublicPath, "--json"]);
  assert.deepEqual([mismatched.code, consume(mismatched).result, consume(mismatched).findings[0].kind], [1, "tampered", "signature_key_mismatch"]);
  const unchecked = await runAudit(["verify", out, "--json"]);
  assert.deepEqual([unchecked.code, consume(unchecked).result], [2, "signature_unchecked"]);
});

test("an unknown option, a missing argument or an extra one is a parse error, not ignored", async () => {
  const subject = savedSubject({ flight: false, diff: false });
  const env = stateEnv(subject);
  const out = subject.out("never");
  const runs = await runAuditBatch([
    () => runAudit(["export", subject.id, "--out", out, "--private-key", "k.pem"], env),
    // `--errors` and `--tool` are options of `nexus audit` itself: after a subcommand they are not silently taken by it.
    () => runAudit(["export", subject.id, "--out", out, "--errors"], env),
    () => runAudit(["verify", subject.root, "--verify-key", "k.pem"], env),
    () => runAudit(["verify", subject.root, "--tool", "x"], env),
    () => runAudit(["export", "--out", out], env),
    () => runAudit(["export", subject.id, "extra", "--out", out], env),
    () => runAudit(["verify"], env),
    () => runAudit(["verify", subject.root, "extra"], env),
  ]);
  const messages = [/unknown option '--private-key'/, /unknown option '--errors'/, /unknown option '--verify-key'/, /unknown option '--tool'/, /missing required argument 'id'/, /too many arguments/, /missing required argument 'bundle-dir'/, /too many arguments/];
  for (const [index, run] of runs.entries()) {
    assert.equal(run.code, 1, `${index}: ${run.stderr}`);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, messages[index]);
  }
  assert.equal(fs.existsSync(out), false, "nothing was exported");
  assert.equal(AUDIT_EXIT_CODES.find((row) => row.name === "option_parse")!.code, 1);
});

test("`--json` prints one document of the published schema for every outcome, with the exit code of the table", async () => {
  const subject = savedSubject({ status: "in_progress" });
  const env = stateEnv(subject);
  const out = subject.out("json");
  const taken = subject.out("taken");
  fs.mkdirSync(taken);
  fs.writeFileSync(path.join(taken, "keep.txt"), "mine");
  const takenBefore = snapshot(taken);
  const aFile = path.join(subject.root, "a-file");
  fs.writeFileSync(aFile, "x");
  const [written, unknown, prefix, traversal, absolute, empty, exists, strict, noDir, notDir, unknownText] = await runAuditBatch([
    () => runAudit(["export", subject.id, "--json", "--out", out], env),
    () => runAudit(["export", "no-such-task", "--json"], env),
    () => runAudit(["export", subject.id.slice(0, -1), "--json"], env),
    () => runAudit(["export", "../x", "--json"], env),
    () => runAudit(["export", path.join(subject.tasks, subject.id), "--json"], env),
    () => runAudit(["export", "", "--json"], env),
    () => runAudit(["export", subject.id, "--json", "--out", taken], env),
    () => runAudit(["export", subject.id, "--json", "--redact", "strict", "--out", subject.out("strict")], env),
    () => runAudit(["verify", path.join(subject.root, "no-such-bundle"), "--json"]),
    () => runAudit(["verify", aFile, "--json"]),
    () => runAudit(["export", "no-such-task"], env),
  ]);

  const document = consume(written);
  assert.equal(written.stderr, "");
  assert.deepEqual([written.code, document.result, document.bundle_dir, document.signed, document.redaction, document.at_rest, document.file_count], [0, "exported", out, false, "standard", false, 11]);
  assert.match(document.warnings.join("\n"), /The subject was not at rest \(status in_progress\)/);
  assert.equal(document.manifest_sha256, consume(await runAudit(["verify", out, "--json"])).manifest_sha256);
  assertManifestValid(readManifest(out));

  const failed = (run: AuditCliRun, code: number, message: RegExp): void => {
    const error = consume(run);
    assert.deepEqual([run.code, Object.keys(error)], [code, ["schema_version", "error", "exitCode"]]);
    assert.match(error.error, message);
    assert.match(run.stderr, /^error: /);
  };
  failed(unknown, 2, /no task or session has the id no-such-task \(the id must be exact; a prefix is not accepted\)/);
  failed(prefix, 2, /no task or session has the id/);
  failed(traversal, 2, /is not a task or session id/);
  failed(absolute, 2, /is not a task or session id/);
  failed(empty, 2, /the id is missing/);
  failed(exists, 2, /already exists; an audit bundle is never written over anything/);
  assert.deepEqual(snapshot(taken), takenBefore, "an existing --out is left untouched");
  failed(strict, 2, /--redact strict is not available in this version/);
  assert.equal(fs.existsSync(subject.out("strict")), false);
  failed(noDir, 2, /there is no bundle directory at that path; nothing was checked/);
  failed(notDir, 2, /an audit bundle is a directory; that path is not one/);
  assert.deepEqual([unknownText.code, unknownText.stdout], [2, ""]);
  assert.match(unknownText.stderr, /^error: no task or session has the id no-such-task/);
  assert.deepEqual(fs.readdirSync(path.join(subject.root, "out")).sort(), ["json", "taken"], "no failed export left a bundle or a partial one");
});
