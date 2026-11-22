/**
 * GV-2 (gate G-5): the audit bundle as a library. A bundle is written from artefacts in memory and verified; one
 * altered byte fails and names the file. What an unsigned bundle cannot show (a rewrite of the files together with the
 * manifest) is asserted too, so the limit stays stated by the tool rather than assumed away. Every manifest written
 * and every result document produced here is validated against the published schemas (helpers/audit_fixture.ts).
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_LIMITS } from "../src/audit_contract.js";
import { AUDIT_UNSIGNED_CAVEAT, AuditBundleError, auditManifestBytes, auditPathProblem, buildAuditManifest, renderAuditVerifyText, verifyAuditBundle, writeAuditBundle } from "../src/core/audit_bundle.js";
import { canonicalJson, verifyChain } from "../src/core/hash_chain.js";
import { FlightPlayer, FlightRecorder } from "../src/flight.js";
import {
  ATTEMPTS_PATH,
  FIXED_ID,
  FIXED_NOW,
  FLIGHT_EVENTS,
  FLIGHT_PATH,
  assertManifestValid,
  chainedLines,
  check,
  cleanTemp,
  fixtureInput,
  flipByte,
  manifestFile,
  readManifest,
  readManifestText,
  reseal,
  rewritePayload,
  sha256,
  snapshot,
  spyFs,
  tempDir,
  writeFixture,
} from "./helpers/audit_fixture.js";

after(cleanTemp);

const PAYLOADS = fixtureInput().artefacts.map((artefact) => artefact.path).sort();
const SECRET = "TOP-SECRET-OUTSIDE-THE-BUNDLE";
/** Everything a caller could print: the JSON document and the text. */
const output = (checked: { document: unknown; text: string }): string => `${JSON.stringify(checked.document)}\n${checked.text}`;
const inside = (dir: string, p: string): boolean => path.resolve(p) === dir || path.resolve(p).startsWith(dir + path.sep);

describe("writing a bundle", () => {
  test("the manifest lists every file with its size, SHA-256 and a link to the entry before it; manifest.json is its canonical form, written with modes 0600 and 0700", () => {
    const input = fixtureInput();
    const { dir, manifest, manifestSha256, parent } = writeFixture(input);
    assert.deepEqual(fs.readdirSync(parent), ["bundle"], "nothing but the bundle is left beside it");
    assert.deepEqual(Object.keys(manifest).sort(), ["bundle_id", "chained_logs", "created_at", "files", "files_head", "format", "nexus", "omitted", "redaction", "root_sha256", "schema_version", "subject"]);
    assert.deepEqual([manifest.schema_version, manifest.format, manifest.bundle_id, manifest.created_at], [1, "nexus-audit-bundle/1", FIXED_ID, "2026-11-22T10:00:00.000Z"]);

    assert.deepEqual(manifest.files.map((entry) => entry.path), PAYLOADS);
    for (const entry of manifest.files) {
      const artefact = input.artefacts.find((candidate) => candidate.path === entry.path)!;
      assert.deepEqual([entry.bytes, entry.sha256, entry.role], [artefact.bytes.length, sha256(artefact.bytes), artefact.role]);
      assert.deepEqual(fs.readFileSync(path.join(dir, entry.path)), Buffer.from(artefact.bytes));
    }
    const chain = verifyChain(manifest.files);
    assert.equal(chain.status, "intact");
    assert.deepEqual(manifest.files_head, { seq: manifest.files.length - 1, hash: manifest.files[manifest.files.length - 1].chain.hash });

    const onDisk = fs.readFileSync(manifestFile(dir));
    assert.equal(onDisk.toString("utf8"), `${canonicalJson(manifest)}\n`);
    assert.deepEqual(onDisk, auditManifestBytes(manifest));
    assert.equal(manifestSha256, sha256(onDisk));
    const { root_sha256: root, ...body } = manifest;
    assert.equal(root, sha256(canonicalJson(body)));

    assert.deepEqual(manifest.chained_logs, [
      { path: FLIGHT_PATH, kind: "flight", records: 5, status: "intact", head: { seq: 4, hash: JSON.parse(chainedLines(FLIGHT_EVENTS)[4]).chain.hash }, closed: true, selection: "explicit" },
      { path: ATTEMPTS_PATH, kind: "verification_config_attempts", records: 2, status: "intact", head: manifest.chained_logs[1].head },
    ]);
    assert.deepEqual(manifest.omitted, [{ artefact: "traces", reason: "not requested" }]);

    const { modes } = snapshot(dir);
    for (const [name, mode] of Object.entries(modes)) {
      const isDir = fs.lstatSync(path.join(dir, name)).isDirectory();
      assert.equal(mode, isDir ? 0o700 : 0o600, `${name} has mode ${mode.toString(8)}`);
    }
    assert.deepEqual(Object.keys(modes).sort(), [".", "evidence", "evidence/diffs", "flights", "manifest.json", "receipts", "session", "verification", ...PAYLOADS].sort());
  });

  test("two bundles written from the same input with the same clock and id are byte-identical; without them the id differs", () => {
    const a = writeFixture();
    const b = writeFixture();
    assert.deepEqual(snapshot(a.dir), snapshot(b.dir));
    assert.equal(a.manifestSha256, b.manifestSha256);
    // The order the artefacts are handed over does not matter either.
    const reversed = fixtureInput();
    const c = writeFixture({ ...reversed, artefacts: [...reversed.artefacts].reverse(), chainedLogs: [...reversed.chainedLogs!].reverse() });
    assert.deepEqual(snapshot(c.dir).files, snapshot(a.dir).files);

    const first = buildAuditManifest(fixtureInput());
    const second = buildAuditManifest(fixtureInput());
    assert.match(first.bundle_id, /^[0-9a-f]{32}$/);
    assert.notEqual(first.bundle_id, second.bundle_id);
    assertManifestValid(first);
  });

  test("an existing destination is refused and left as it was, even when it is a dangling link", () => {
    const parent = tempDir();
    const out = path.join(parent, "bundle");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "keep.txt"), "mine");
    assert.throws(() => writeAuditBundle(fixtureInput(), { out, durable: false }), (err: Error) => err instanceof AuditBundleError && /already exists/.test(err.message));
    assert.deepEqual(fs.readdirSync(parent), ["bundle"]);
    assert.deepEqual(fs.readdirSync(out), ["keep.txt"]);

    const link = path.join(parent, "link");
    fs.symlinkSync(path.join(parent, "nowhere"), link);
    assert.throws(() => writeAuditBundle(fixtureInput(), { out: link, durable: false }), /already exists/);
    assert.deepEqual(fs.readdirSync(parent).sort(), ["bundle", "link"]);
    assert.throws(() => writeAuditBundle(fixtureInput(), { out: path.join(parent, "no-such-parent", "bundle"), durable: false }), AuditBundleError);
  });

  test("when a write fails the partial directory is removed and the destination is never left half-written", () => {
    const failAt = (method: "openSync" | "renameSync" | "mkdirSync", match: (target: string) => boolean): void => {
      const parent = tempDir();
      const out = path.join(parent, "bundle");
      const original = (fs as any)[method];
      let failed = false;
      (fs as any)[method] = (...args: any[]) => {
        if (typeof args[0] === "string" && match(args[0])) {
          failed = true;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return original.apply(fs, args);
      };
      try {
        assert.throws(() => writeAuditBundle(fixtureInput(), { out, durable: false }), (err: Error) => err instanceof AuditBundleError && /was not written: ENOSPC/.test(err.message));
      } finally {
        (fs as any)[method] = original;
      }
      assert.ok(failed, `the ${method} failure was injected`);
      assert.deepEqual(fs.readdirSync(parent), [], `after a failed ${method}`);
    };
    failAt("openSync", (target) => target.endsWith(path.join("receipts", "last-turn.json")));
    failAt("openSync", (target) => target.endsWith("manifest.json"));
    failAt("mkdirSync", (target) => target.endsWith("verification"));
    failAt("renameSync", () => true);
  });

  test("by default the bundle is durable: every file, the manifest and every directory are fsynced before the rename, and the parent after it", () => {
    const parent = tempDir();
    const out = path.join(parent, "bundle");
    const { events } = spyFs(() => writeAuditBundle(fixtureInput(), { out, now: FIXED_NOW, bundleId: FIXED_ID }));
    const renameAt = events.findIndex((event) => event.fn === "renameSync");
    const partial = events[renameAt].path;
    assert.match(partial, /bundle\.partial-[0-9a-f]{16}$/);
    const synced = (target: string): number => events.findIndex((event) => event.fn === "fsyncSync" && event.path === target);
    for (const name of [...PAYLOADS, "manifest.json", "evidence", "evidence/diffs", "flights", "receipts", "session", "verification"]) {
      const at = synced(path.join(partial, name));
      assert.ok(at >= 0 && at < renameAt, `${name} was fsynced before the rename`);
    }
    assert.ok(synced(partial) >= 0 && synced(partial) < renameAt, "the bundle directory itself was fsynced before the rename");
    assert.ok(synced(path.join(partial, "manifest.json")) > Math.max(...PAYLOADS.map((name) => synced(path.join(partial, name)))), "the manifest is written and fsynced last of the files");
    assert.ok(synced(parent) > renameAt, "the parent directory was fsynced after the rename");
    assert.equal(events.filter((event) => event.fn === "fsyncSync").length, PAYLOADS.length + 1 + 6 + 1 + 1);
    assert.equal(check(out).exit, "intact_unsigned");
    assert.deepEqual(snapshot(out), snapshot(writeFixture().dir), "durable and not durable write the same bytes and modes");

    const fast = spyFs(() => writeAuditBundle(fixtureInput(), { out: path.join(parent, "fast"), durable: false }));
    assert.equal(fast.events.filter((event) => event.fn === "fsyncSync").length, 0);
  });

  test("an entry that appears at the destination after the first check is not replaced, not even an empty directory", () => {
    const parent = tempDir();
    const out = path.join(parent, "bundle");
    const original = fs.mkdirSync;
    // The moment the last payload directory is made, something else creates the destination as an empty directory.
    (fs as any).mkdirSync = (...args: any[]) => {
      if (typeof args[0] === "string" && args[0].endsWith("verification")) original(out);
      return original.apply(fs, args as any);
    };
    try {
      assert.throws(() => writeAuditBundle(fixtureInput(), { out, durable: false }), (err: Error) => err instanceof AuditBundleError && /was not written: EEXIST/.test(err.message));
    } finally {
      (fs as any).mkdirSync = original;
    }
    assert.deepEqual(fs.readdirSync(parent), ["bundle"]);
    assert.deepEqual(fs.readdirSync(out), [], "the directory that appeared is left as it was");
  });

  test("an artefact path that could leave the bundle, collide or shadow the manifest is refused before anything is written", () => {
    const base = fixtureInput();
    const refuse = (artefactPath: string, why: RegExp): void => {
      const parent = tempDir();
      assert.throws(
        () => writeAuditBundle({ ...base, artefacts: [...base.artefacts, { path: artefactPath, role: "diff", bytes: Buffer.from("x") }] }, { out: path.join(parent, "bundle"), durable: false }),
        (err: Error) => err instanceof AuditBundleError && why.test(err.message),
        artefactPath,
      );
      assert.deepEqual(fs.readdirSync(parent), []);
    };
    refuse("../x", /"\.\." segment/);
    refuse("/etc/passwd", /is absolute/);
    refuse("a//b", /empty segment/);
    refuse("a/./b", /"\." segment/);
    refuse("a/b/c/d/e", /more than 4 segments/);
    refuse("a b", /character outside/);
    refuse("a\\b", /character outside/);
    refuse(`${"n".repeat(161)}`, /longer than 160/);
    refuse("manifest.json", /reserved/);
    refuse("Manifest.Sig.JSON", /reserved/);
    refuse("session/export.json", /listed twice/);
    refuse("Session/export.json", /differ only by case/);
    refuse("SESSION/other.json", /directories SESSION and session differ only by case/);
    refuse("session/export.json/x", /is a file, and .* needs it to be a directory/);
    assert.equal(auditPathProblem("evidence/diffs/op-1.diff"), undefined);
    assert.equal(auditPathProblem(`a/b/c/${"n".repeat(160)}`), undefined);

    assert.throws(() => buildAuditManifest({ ...base, chainedLogs: [{ path: "flights/none.flightlog", kind: "flight" }] }), /is not one of the artefacts/);
    assert.throws(() => buildAuditManifest(base, { bundleId: "not-hex" }), /bundle_id/);
    assert.throws(() => buildAuditManifest({ ...base, subject: { ...base.subject, at_rest: "yes" as any } }), /subject/);
  });
});

describe("verifying an unsigned bundle (G-5)", () => {
  test("a bundle read back as written is intact by hash only, and says in every such result that it is not signed", () => {
    const { dir, manifestSha256 } = writeFixture();
    const checked = check(dir);
    assert.deepEqual([checked.exit, checked.code], ["intact_unsigned", 0]);
    assert.deepEqual(checked.result, {
      schema_version: 1,
      result: "intact_unsigned",
      exitCode: 0,
      bundle_id: FIXED_ID,
      manifest_sha256: manifestSha256,
      expected_manifest_sha256: null,
      signature: "absent",
      public_key_sha256: null,
      files: { listed: 10, matched: 10 },
      chained_logs: [
        { path: FLIGHT_PATH, kind: "flight", status: "intact", records: 5, matches_manifest: true },
        { path: ATTEMPTS_PATH, kind: "verification_config_attempts", status: "intact", records: 2, matches_manifest: true },
      ],
      findings: [],
      findings_total: 0,
      notes: [],
    });
    assert.equal(AUDIT_UNSIGNED_CAVEAT, "This bundle is NOT SIGNED: anyone able to write it could have replaced its files and the manifest together.");
    assert.equal(
      checked.text.split("\n")[0],
      `INTACT BY HASH ONLY: all 10 files match the manifest. This bundle is NOT SIGNED: anyone able to write it could have replaced its files and the manifest together. To rule that out, compare the manifest hash ${manifestSha256} with one recorded at export.`,
    );

    // The caveat does not go away when the caller's recorded hash matches: the bundle is still unsigned.
    const expected = check(dir, { expectManifestSha256: manifestSha256.toUpperCase() });
    assert.deepEqual([expected.exit, expected.code, expected.result.expected_manifest_sha256], ["intact_unsigned", 0, manifestSha256]);
    assert.ok(expected.text.includes(AUDIT_UNSIGNED_CAVEAT));
    assert.match(expected.text, /is the one you expected/);
  });

  test("one flipped bit in any payload file fails, and the finding names exactly that file with the recorded and the found hash", () => {
    const { dir, manifest } = writeFixture();
    for (const entry of manifest.files) {
      const file = path.join(dir, entry.path);
      const original = fs.readFileSync(file);
      flipByte(file);
      const checked = check(dir);
      assert.deepEqual([checked.exit, checked.code], ["tampered", 1], entry.path);
      const altered = checked.result.findings.filter((finding) => finding.kind === "file_altered");
      assert.deepEqual(altered, [
        {
          kind: "file_altered",
          path: entry.path,
          message: `the file is ${entry.bytes} bytes with SHA-256 ${sha256(fs.readFileSync(file))}; the manifest records ${entry.bytes} bytes with SHA-256 ${entry.sha256}`,
          expected_sha256: entry.sha256,
          found_sha256: sha256(fs.readFileSync(file)),
          expected_bytes: entry.bytes,
          found_bytes: entry.bytes,
        },
      ]);
      // Nothing else is blamed. A chained log whose byte changed is also reported as a broken chain, for the same file.
      assert.deepEqual([...new Set(checked.result.findings.map((finding) => finding.path))], [entry.path]);
      assert.deepEqual(checked.kinds, entry.path === FLIGHT_PATH || entry.path === ATTEMPTS_PATH ? ["file_altered", "log_chain_broken"] : ["file_altered"]);
      assert.equal(checked.result.files.matched, 9);
      assert.match(checked.text, /^NOT INTACT: /);
      assert.ok(checked.text.includes(`file_altered ${entry.path}: `) && !checked.text.includes("INTACT BY HASH"));
      fs.writeFileSync(file, original);
      assert.equal(check(dir).exit, "intact_unsigned", `${entry.path} restored`);
    }
  });

  test("every problem is reported, not only the first", () => {
    const { dir } = writeFixture();
    flipByte(path.join(dir, "session/export.md"));
    fs.appendFileSync(path.join(dir, "receipts/last-turn.json"), " ");
    fs.rmSync(path.join(dir, "evidence/findings.json"));
    fs.writeFileSync(path.join(dir, "evidence/extra.txt"), "x");
    const checked = check(dir);
    assert.equal(checked.exit, "tampered");
    assert.deepEqual(
      checked.result.findings.map((finding) => `${finding.kind} ${finding.path}`).sort(),
      ["file_altered receipts/last-turn.json", "file_altered session/export.md", "file_missing evidence/findings.json", "file_unexpected evidence/extra.txt"],
    );
    assert.deepEqual([checked.result.findings_total, checked.result.files], [4, { listed: 10, matched: 7 }]);
    assert.match(checked.text, /^NOT INTACT: 4 problems found\./);
  });

  test("findings are capped at 100 and the total is still counted", () => {
    const { dir } = writeFixture();
    for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(dir, `extra-${i}.txt`), "x");
    const checked = check(dir);
    assert.deepEqual([checked.exit, checked.result.findings.length, checked.result.findings_total], ["tampered", AUDIT_LIMITS.findings, 150]);
    assert.equal(AUDIT_LIMITS.findings, 100);
    assert.match(checked.text, /^NOT INTACT: 150 problems found\./);
    assert.match(checked.text, /\.\.\. and 50 more not listed\./);
  });

  test("a byte changed in the manifest is found: inside a file entry, in another member, as whitespace, or as broken JSON", () => {
    const { dir, manifest } = writeFixture();
    const original = readManifestText(dir);
    const withText = (changed: string | Buffer) => {
      assert.notEqual(changed, original);
      fs.writeFileSync(manifestFile(dir), changed);
      const checked = check(dir);
      fs.writeFileSync(manifestFile(dir), original);
      assert.deepEqual([checked.exit, checked.code], ["tampered", 1]);
      return checked;
    };

    // Inside a file entry: the entry no longer hashes to its link (and the root and the file disagree too).
    const digest = manifest.files[2].sha256;
    const entry = withText(original.replace(digest, `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`));
    assert.deepEqual(entry.kinds.sort(), ["file_altered", "manifest_chain_broken", "manifest_root_mismatch"]);
    assert.match(entry.result.findings.find((finding) => finding.kind === "manifest_chain_broken")!.message, /CHAIN BROKEN at position 3 of 10: record 2 was changed after it was written/);

    // A file entry's role, which no file's bytes depend on: only the manifest's own chain and root can show it.
    const role = withText(original.replace('"role":"diff"', '"role":"trace"'));
    assert.deepEqual(role.kinds.sort(), ["manifest_chain_broken", "manifest_root_mismatch"]);

    const created = withText(original.replace("2026-11-22T10:00:00.000Z", "2026-11-22T10:00:00.001Z"));
    assert.deepEqual(created.kinds, ["manifest_root_mismatch"]);
    assert.equal(created.result.files.matched, 10, "the files were still checked");

    for (const spaced of [original.replace(/\n$/, " \n"), `${original}\n`, original.replace(/\n$/, ""), original.replace('{"bundle_id"', '{ "bundle_id"'), `${JSON.stringify(JSON.parse(original), null, 2)}\n`]) {
      assert.deepEqual(withText(spaced).kinds, ["manifest_not_canonical"]);
    }
    // A repeated key parses (the last one wins) and is not the canonical form.
    assert.deepEqual(withText(original.replace('{"bundle_id"', `{"bundle_id":"${"0".repeat(32)}","bundle_id"`)).kinds, ["manifest_not_canonical"]);

    const broken = withText(original.replace(/\}\n$/, "\n"));
    assert.deepEqual(broken.kinds, ["manifest_malformed"]);
    assert.deepEqual([broken.result.files, broken.result.bundle_id], [{ listed: 0, matched: 0 }, null]);
    assert.deepEqual(withText("[]\n").kinds, ["manifest_malformed"]);
    assert.deepEqual(withText(Buffer.from([0xff, 0xfe, 0x7b, 0x7d])).result.findings.map((finding) => finding.message), ["manifest.json is not valid UTF-8"]);
    assert.deepEqual(withText(original.replace('"schema_version":1', '"schema_version":"1"')).kinds, ["manifest_malformed"]);

    // A member of the wrong type, sealed again so that only the shape is wrong.
    const bad = readManifest(dir) as Record<string, any>;
    bad.files[0].bytes = "12";
    bad.subject.at_rest = "yes";
    reseal(dir, bad);
    const shape = check(dir);
    fs.writeFileSync(manifestFile(dir), original);
    assert.deepEqual([shape.exit, shape.kinds], ["tampered", ["manifest_malformed", "manifest_malformed"]]);

    fs.rmSync(manifestFile(dir));
    const missing = check(dir);
    assert.deepEqual([missing.exit, missing.kinds, missing.result.manifest_sha256], ["tampered", ["manifest_missing"], null]);
  });

  test("a removed file, an added file and an added directory are each reported by name", () => {
    const { dir } = writeFixture();
    fs.rmSync(path.join(dir, "evidence/diffs/op-1.diff"));
    let checked = check(dir);
    assert.deepEqual(checked.result.findings.map((finding) => [finding.kind, finding.path]), [["file_missing", "evidence/diffs/op-1.diff"]]);
    assert.equal(checked.exit, "tampered");

    const added = writeFixture().dir;
    fs.writeFileSync(path.join(added, "session", "notes.txt"), "added later");
    fs.mkdirSync(path.join(added, "extra"));
    fs.writeFileSync(path.join(added, "extra", "inner.txt"), SECRET);
    fs.writeFileSync(path.join(added, "MANIFEST.JSON"), "{}");
    fs.writeFileSync(path.join(added, "bad\u001b[31mname\n"), "x");
    checked = check(added);
    assert.equal(checked.exit, "tampered");
    assert.deepEqual(
      checked.result.findings.map((finding) => [finding.kind, finding.path]).sort(),
      [
        ["file_unexpected", "MANIFEST.JSON"],
        ["file_unexpected", "bad\\u{1b}[31mname\\u{a}"],
        ["file_unexpected", "extra"],
        ["file_unexpected", "session/notes.txt"],
      ],
    );
    assert.ok(!checked.text.includes("\u001b"), "a file name cannot put control characters in the text");
    assert.equal(checked.result.files.matched, 10);
  });

  test("a symbolic link is reported and never followed: its target's content appears in no output", () => {
    const { dir, parent } = writeFixture();
    const outside = path.join(parent, "outside.json");
    const original = fs.readFileSync(path.join(dir, "receipts/last-turn.json"));
    fs.writeFileSync(outside, SECRET);

    // A listed file replaced by a link to a file outside.
    fs.rmSync(path.join(dir, "receipts/last-turn.json"));
    fs.symlinkSync(outside, path.join(dir, "receipts/last-turn.json"));
    let spied = spyFs(() => check(dir));
    assert.deepEqual(spied.value.result.findings.map((finding) => [finding.kind, finding.path, finding.message]), [["unsafe_entry", "receipts/last-turn.json", "a symbolic link; it was not followed or read"]]);
    assert.deepEqual([spied.value.exit, spied.value.result.files.matched], ["tampered", 9]);
    assert.ok(!output(spied.value).includes(SECRET));
    assert.ok(spied.paths.every((p) => inside(dir, p)), `opened outside the bundle: ${spied.paths.filter((p) => !inside(dir, p))}`);

    // Even a link to a file with exactly the recorded bytes is not accepted.
    fs.writeFileSync(outside, original);
    assert.deepEqual(check(dir).kinds, ["unsafe_entry"]);
    fs.rmSync(path.join(dir, "receipts/last-turn.json"));
    fs.writeFileSync(path.join(dir, "receipts/last-turn.json"), original);
    assert.equal(check(dir).exit, "intact_unsigned");

    // A whole directory replaced by a link to a copy of it outside: every byte would match if the link were followed.
    const copy = path.join(parent, "session-copy");
    fs.cpSync(path.join(dir, "session"), copy, { recursive: true });
    fs.rmSync(path.join(dir, "session"), { recursive: true });
    fs.symlinkSync(copy, path.join(dir, "session"));
    spied = spyFs(() => check(dir));
    assert.deepEqual(spied.value.result.findings.map((finding) => [finding.kind, finding.path]).sort(), [
      ["file_missing", "session/export.json"],
      ["file_missing", "session/export.md"],
      ["unsafe_entry", "session"],
    ]);
    assert.ok(spied.paths.every((p) => inside(dir, p)));

    // The manifest itself, and an extra entry that is not a file at all.
    const second = writeFixture();
    fs.renameSync(manifestFile(second.dir), path.join(second.parent, "manifest-outside.json"));
    fs.symlinkSync(path.join(second.parent, "manifest-outside.json"), manifestFile(second.dir));
    const linked = check(second.dir);
    assert.deepEqual([linked.exit, linked.kinds, linked.result.manifest_sha256], ["tampered", ["unsafe_entry"], null]);
    const third = writeFixture();
    fs.symlinkSync(path.join(third.parent, "nowhere"), path.join(third.dir, "dangling"));
    assert.deepEqual(check(third.dir).result.findings.map((finding) => [finding.kind, finding.path]), [["unsafe_entry", "dangling"]]);
  });

  test("a chained log cut at the end is found by its recorded head, although what is left is a consistent chain", () => {
    const { dir, manifest } = writeFixture();
    const lines = chainedLines(FLIGHT_EVENTS);
    const cut = `${lines.slice(0, -1).join("\n")}\n`;
    assert.equal(verifyChain(lines.slice(0, -1).map((line) => JSON.parse(line))).status, "intact", "the cut log is intact in itself");
    fs.writeFileSync(path.join(dir, FLIGHT_PATH), cut);
    const checked = check(dir);
    assert.deepEqual([checked.exit, checked.kinds], ["tampered", ["file_altered", "log_head_mismatch"]]);
    const head = JSON.parse(lines[3]).chain.hash;
    assert.deepEqual(checked.result.findings[1], {
      kind: "log_head_mismatch",
      path: FLIGHT_PATH,
      message: `its records end at record 3 (${head}); the manifest recorded 5 records ending at ${manifest.chained_logs[0].head!.hash}. Records are missing from the end, or the log was replaced.`,
    });
    assert.deepEqual(checked.result.chained_logs[0], { path: FLIGHT_PATH, kind: "flight", status: "intact", records: 4, matches_manifest: false });
    assert.match(checked.text, /chained log flights\/flight-1\.flightlog: intact, 4 records, NOT as the manifest recorded/);

    // The recorded head is checked on its own: with the file entry re-sealed to the cut log, only the head shows it.
    rewritePayload(dir, FLIGHT_PATH, cut);
    assert.deepEqual(check(dir).kinds, ["log_head_mismatch"]);
    // An emptied log, and a log replaced by a different consistent chain of the same length.
    rewritePayload(dir, FLIGHT_PATH, "");
    const emptied = check(dir);
    assert.deepEqual(emptied.kinds, ["log_head_mismatch"]);
    assert.match(emptied.result.findings[0].message, /^it reads as empty; the manifest recorded 5 records/);
    rewritePayload(dir, FLIGHT_PATH, `${chainedLines(FLIGHT_EVENTS.map((event) => ({ ...event, timestamp: 9 }))).join("\n")}\n`);
    assert.deepEqual(check(dir).kinds, ["log_head_mismatch"]);
    // A record edited in place, re-sealed: the log's own chain shows it.
    const edited = [...lines];
    edited[2] = edited[2].replace("read_file", "write_file");
    rewritePayload(dir, FLIGHT_PATH, `${edited.join("\n")}\n`);
    const broken = check(dir);
    assert.deepEqual(broken.kinds, ["log_chain_broken"]);
    assert.match(broken.result.findings[0].message, /CHAIN BROKEN at position 3 of 5: record 2 was changed after it was written; the manifest recorded an intact chain/);
    // The links stripped from every record.
    rewritePayload(dir, FLIGHT_PATH, `${FLIGHT_EVENTS.map((event) => JSON.stringify(event)).join("\n")}\n`);
    assert.deepEqual(check(dir).kinds, ["log_chain_broken"]);
    rewritePayload(dir, FLIGHT_PATH, `${lines.join("\n")}\n`);
    assert.equal(check(dir).exit, "intact_unsigned");
  });

  test("THE HONEST BOUNDARY: a payload rewritten together with every hash, link and the root verifies as intact, unsigned; only a hash recorded elsewhere shows it", () => {
    const { dir, manifestSha256: recordedAtExport } = writeFixture();
    const forgedSha = rewritePayload(dir, "receipts/validation-receipts.json", '[{"id":"r1","command":"npm test","passed":true,"note":"forged"}]\n');
    assert.notEqual(forgedSha, recordedAtExport);

    const unsigned = check(dir);
    assert.deepEqual([unsigned.exit, unsigned.code, unsigned.result.findings_total], ["intact_unsigned", 0, 0]);
    assert.ok(unsigned.text.includes(AUDIT_UNSIGNED_CAVEAT), "the tool states the limit of an unsigned result");
    assert.ok(unsigned.text.includes("NOT SIGNED"));
    assert.ok(unsigned.text.includes(`compare the manifest hash ${forgedSha} with one recorded at export`));

    const expected = check(dir, { expectManifestSha256: recordedAtExport });
    assert.deepEqual([expected.exit, expected.code, expected.kinds], ["tampered", 1, ["manifest_sha256_mismatch"]]);
    assert.equal(expected.result.findings[0].message, `the manifest's SHA-256 is ${forgedSha}; you expected ${recordedAtExport}. This is not the manifest that hash was taken from.`);
    assert.ok(!expected.text.includes("INTACT BY HASH"));
    assert.equal(expected.result.files.matched, 10, "the forged bundle is consistent in itself");
  });

  test("a bundle that carries manifest.sig.json is never reported as plainly intact: the signature is unchecked (exit 2), and file findings are still reported", () => {
    const { dir } = writeFixture();
    fs.writeFileSync(path.join(dir, "manifest.sig.json"), '{"schema_version":1}\n');
    const unchecked = check(dir);
    assert.deepEqual([unchecked.exit, unchecked.code, unchecked.result.signature, unchecked.result.findings_total], ["signature_unchecked", 2, "unchecked", 0]);
    assert.equal(unchecked.result.files.matched, 10);
    assert.match(unchecked.text, /^FILES MATCH, SIGNATURE NOT CHECKED: all 10 files match the manifest\. The bundle carries a signature \(manifest\.sig\.json\) that was NOT checked: no public key was given\. Until it is checked, treat the bundle as unsigned/);
    assert.ok(!unchecked.text.includes("INTACT"));

    flipByte(path.join(dir, "session/export.json"));
    const altered = check(dir);
    assert.deepEqual([altered.exit, altered.code, altered.result.signature], ["tampered", 1, "unchecked"]);
    assert.deepEqual(altered.result.findings.map((finding) => [finding.kind, finding.path]), [["file_altered", "session/export.json"]]);

    const linked = writeFixture();
    fs.symlinkSync(path.join(linked.parent, "nowhere"), path.join(linked.dir, "manifest.sig.json"));
    assert.deepEqual([check(linked.dir).exit, check(linked.dir).kinds], ["tampered", ["unsafe_entry"]]);

    // No public key is accepted before signing exists: asking for one is an error, not a silent "intact".
    const asked = verifyAuditBundle(writeFixture().dir, { publicKey: "key.pem" } as any);
    assert.deepEqual([asked.exit, asked.document], ["usage", { schema_version: 1, error: "unsupported verification option: publicKey", exitCode: 2 }]);
  });

  test("what the manifest says about a log that is not a failure is a note: not closed, a bounded excerpt, already broken at export", () => {
    const input = fixtureInput();
    const lines = chainedLines(FLIGHT_EVENTS);
    const brokenAtExport = [...lines];
    brokenAtExport[1] = brokenAtExport[1].replace("do the thing", "do another thing");
    const { dir, manifest } = writeFixture({
      ...input,
      artefacts: input.artefacts.map((artefact) =>
        artefact.path === FLIGHT_PATH ? { ...artefact, bytes: Buffer.from(`${lines.slice(0, 3).join("\n")}\n`) } : artefact.path === ATTEMPTS_PATH ? { ...artefact, bytes: Buffer.from(`${brokenAtExport.join("\n")}\n`) } : artefact,
      ),
      chainedLogs: [
        { path: FLIGHT_PATH, kind: "flight", closed: false, selection: "time_window", source: { records: 5, head: { seq: 4, hash: JSON.parse(lines[4]).chain.hash }, closed: true, bytes: 900, sha256: sha256("source"), complete: false } },
        { path: ATTEMPTS_PATH, kind: "verification_config_attempts" },
      ],
    });
    assert.deepEqual(manifest.chained_logs.map((log) => [log.status, log.records, log.head?.seq]), [["intact", 3, 2], ["broken", 5, undefined]]);
    const checked = check(dir);
    assert.deepEqual([checked.exit, checked.code, checked.kinds], ["intact_unsigned", 0, []]);
    assert.deepEqual(checked.result.notes, [
      `${FLIGHT_PATH} was not closed when it was exported: it has no end record (still recording, stopped early, or records were already missing from the end).`,
      `${FLIGHT_PATH} is a bounded excerpt: the first 3 records of a source log of 5.`,
      `${ATTEMPTS_PATH} was already broken when it was exported; its integrity before export cannot be shown.`,
    ]);
    assert.ok(checked.text.includes(`note: ${checked.result.notes[0]}`) && checked.text.includes(AUDIT_UNSIGNED_CAVEAT));
    // A log recorded as broken that now reads as a different log is still a finding.
    rewritePayload(dir, ATTEMPTS_PATH, `${lines.join("\n")}\n`);
    assert.deepEqual(check(dir).kinds, ["log_head_mismatch"]);
  });

  test("a log written by the real flight recorder reads here as the flight player reads it", () => {
    const workspace = tempDir();
    const flight = new FlightRecorder(workspace, "flight-real");
    flight.startSession({ model: "m", endpoint: "http://127.0.0.1:1/v1", taskPrompt: "do the thing" });
    flight.recordTurnStart(1, "do the thing");
    flight.recordToolCall(1, "c1", "read_file", { path: "a.ts" });
    flight.recordSessionEnd("done", true);
    const bytes = fs.readFileSync(flight.getLogPath());
    const { integrity } = FlightPlayer.loadFlight(workspace, "flight-real");
    assert.equal(integrity.chain.status, "intact");
    const input = fixtureInput();
    const manifest = buildAuditManifest({ ...input, artefacts: [...input.artefacts, { path: "flights/flight-real.flightlog", role: "flight_log", bytes }], chainedLogs: [{ path: "flights/flight-real.flightlog", kind: "flight", closed: integrity.closed }] });
    const head = integrity.chain.status === "intact" ? integrity.chain.head! : undefined;
    assert.deepEqual(manifest.chained_logs, [{ path: "flights/flight-real.flightlog", kind: "flight", records: integrity.chain.records, status: "intact", head: { seq: head!.seq, hash: head!.hash }, closed: true }]);
  });
});

describe("a hostile manifest", () => {
  test("a path that is not a plain relative path fails closed, and nothing outside the bundle directory is opened, listed or examined", () => {
    const control = writeFixture();
    const spiedControl = spyFs(() => check(control.dir));
    assert.equal(spiedControl.value.exit, "intact_unsigned");
    // The spy sees what the verifier touches: the manifest and every payload file, all inside the bundle.
    for (const name of ["manifest.json", ...PAYLOADS]) assert.ok(spiedControl.paths.includes(path.join(control.dir, name)), `${name} was opened`);
    assert.ok(spiedControl.paths.every((p) => inside(control.dir, p)));

    const cases: Array<{ name: string; paths: (parent: string) => string[]; why: RegExp }> = [
      { name: "../x", paths: () => ["../x"], why: /"\.\." segment/ },
      { name: "nested ..", paths: () => ["session/../../x"], why: /"\.\." segment/ },
      { name: "absolute", paths: (parent) => [path.join(parent, "x")], why: /is absolute/ },
      { name: "/etc/passwd", paths: () => ["/etc/passwd"], why: /is absolute/ },
      { name: "a//b", paths: () => ["a//b"], why: /empty segment/ },
      { name: "duplicate", paths: () => ["session/export.md"], why: /session\/export\.md is listed twice/ },
      { name: "case collision", paths: () => ["A.json", "a.json"], why: /A\.json and a\.json differ only by case/ },
      { name: "the manifest itself", paths: () => ["manifest.json"], why: /reserved/ },
      { name: "backslash", paths: () => ["..\\x"], why: /character outside/ },
    ];
    for (const { name, paths, why } of cases) {
      const { dir, parent } = writeFixture();
      // What the manifest points at exists outside the bundle and matches the entry: a verifier that opened the path
      // the manifest names would read it and find nothing wrong.
      fs.writeFileSync(path.join(parent, "x"), SECRET);
      const manifest = readManifest(dir) as Record<string, any>;
      for (const p of paths(parent)) manifest.files.push({ path: p, bytes: SECRET.length, sha256: sha256(SECRET), role: "diff" });
      manifest.files.sort((a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      reseal(dir, manifest);

      const { value: checked, paths: touched } = spyFs(() => check(dir));
      assert.deepEqual([checked.exit, checked.code], ["tampered", 1], name);
      assert.ok(checked.kinds.length > 0 && checked.kinds.every((kind) => kind === "manifest_malformed"), `${name}: ${checked.kinds}`);
      assert.ok(checked.result.findings.some((finding) => why.test(finding.message)), `${name}: ${JSON.stringify(checked.result.findings)}`);
      assert.equal(checked.result.files.matched, 0, name);
      const outside = touched.filter((p) => !inside(dir, p));
      assert.deepEqual(outside, [], `${name}: touched outside the bundle`);
      assert.ok(touched.includes(manifestFile(dir)), "the spy recorded the manifest being opened");
      assert.ok(!output(checked).includes(SECRET), name);
    }
  });

  test("a schema version this nexus does not read is not checked at all (exit 2)", () => {
    const { dir } = writeFixture();
    const manifest = readManifest(dir) as Record<string, any>;
    manifest.schema_version = 2;
    reseal(dir, manifest);
    flipByte(path.join(dir, "session/export.json"));
    const checked = check(dir);
    assert.deepEqual([checked.exit, checked.code, checked.kinds, checked.result.files], ["unsupported_version", 2, ["unsupported_version"], { listed: 0, matched: 0 }]);
    assert.equal(checked.result.findings[0].message, "this bundle declares schema_version 2; this nexus reads schema_version 1. Nothing in it was checked.");
    assert.match(checked.text, /^NOT CHECKED: this bundle's schema version is not one this nexus reads\. Nothing in it was verified\./);
    assert.ok(!checked.text.includes("INTACT"));
  });

  test("every limit is a named finding, never a crash and never a pass", () => {
    assert.deepEqual(AUDIT_LIMITS, {
      manifestBytes: 4 * 1024 * 1024,
      files: 10_000,
      fileBytes: 256 * 1024 * 1024,
      totalBytes: 2 * 1024 * 1024 * 1024,
      logRecords: 1_000_000,
      logLineBytes: 4 * 1024 * 1024,
      jsonDepth: 64,
      pathDepth: 4,
      pathSegmentChars: 160,
      findings: 100,
    });
    const limited = (dir: string, limits: Partial<typeof AUDIT_LIMITS>, at: string | undefined, why: RegExp) => {
      const checked = check(dir, { limits: limits as any });
      assert.deepEqual([checked.exit, checked.code], ["tampered", 1], String(why));
      assert.ok(checked.result.findings.some((finding) => finding.kind === "limit_exceeded" && finding.path === at && why.test(finding.message)), `${why}: ${JSON.stringify(checked.result.findings)}`);
      return checked;
    };
    const nested = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;

    // A chained-log record nested 65 deep (64 is accepted); the writer refuses to produce one.
    const deep = (levels: number): string => `${chainedLines([{ type: "deep", payload: JSON.parse(nested(levels - 1)) }]).join("\n")}\n`;
    const input = fixtureInput();
    const withFlight = (bytes: string) => ({ ...input, artefacts: input.artefacts.map((artefact) => (artefact.path === FLIGHT_PATH ? { ...artefact, bytes: Buffer.from(bytes) } : artefact)) });
    const { dir } = writeFixture(withFlight(deep(64)));
    assert.equal(check(dir).exit, "intact_unsigned");
    assert.throws(() => buildAuditManifest(withFlight(deep(65))), (err: Error) => err instanceof AuditBundleError && /record 0 nests deeper than 64 levels/.test(err.message));
    rewritePayload(dir, FLIGHT_PATH, deep(65));
    const deepLog = limited(dir, {}, FLIGHT_PATH, /the chained log was not checked: record 0 nests deeper than 64 levels/);
    assert.deepEqual(deepLog.result.chained_logs[0], { path: FLIGHT_PATH, kind: "flight", status: "not_checked", records: 0, matches_manifest: false });
    assert.match(deepLog.text, /chained log flights\/flight-1\.flightlog: NOT CHECKED/);

    // The manifest: too large (not read), and nested too deep (not parsed).
    const big = writeFixture().dir;
    fs.writeFileSync(manifestFile(big), Buffer.alloc(AUDIT_LIMITS.manifestBytes + 1, 0x20));
    const oversized = limited(big, {}, "manifest.json", /manifest\.json is larger than 4194304 bytes; it was not read/);
    assert.deepEqual([oversized.result.manifest_sha256, oversized.result.files], [null, { listed: 0, matched: 0 }]);
    // A limit can be tightened by the caller, never raised.
    limited(big, { manifestBytes: 1024 * 1024 * 1024 }, "manifest.json", /larger than 4194304 bytes/);
    fs.writeFileSync(manifestFile(big), `{"schema_version":1,"x":${nested(64)}}\n`);
    limited(big, {}, "manifest.json", /manifest\.json nests deeper than 64 levels; it was not parsed/);
    fs.writeFileSync(manifestFile(big), `${nested(200_000)}\n`);
    limited(big, {}, "manifest.json", /nests deeper than 64 levels/);

    // The remaining limits, tightened so that the fixture exceeds them.
    const plain = writeFixture().dir;
    limited(plain, { manifestBytes: 100 }, "manifest.json", /larger than 100 bytes/);
    limited(plain, { files: 9 }, "manifest.json", /the manifest lists 10 files; a bundle holds at most 9/);
    limited(plain, { fileBytes: 20 }, "manifest.json", /is recorded as \d+ bytes; a file holds at most 20/);
    limited(plain, { totalBytes: 100 }, "manifest.json", /a bundle holds at most 100/);
    limited(plain, { logRecords: 4 }, FLIGHT_PATH, /the chained log was not checked: it holds more than 4 records/);
    limited(plain, { logLineBytes: 50 }, FLIGHT_PATH, /the chained log was not checked: a line is longer than 50 bytes/);
    limited(plain, { jsonDepth: 2 }, "manifest.json", /nests deeper than 2 levels/);
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(plain, `extra-${i}`), "");
    limited(plain, { files: 10, pathDepth: 4 }, undefined, /the bundle holds more than 42 entries; the rest were not looked at/);

    // A file larger than the manifest says, and larger than the limit: reported without being read to the end.
    const grown = writeFixture().dir;
    fs.writeFileSync(path.join(grown, "session/export.md"), Buffer.alloc(5000, 0x61));
    const overFile = check(grown, { limits: { fileBytes: 4096 } });
    assert.deepEqual(overFile.result.findings.map((finding) => [finding.kind, finding.path, finding.message]), [["limit_exceeded", "session/export.md", "larger than 4096 bytes; it was not read"]]);
    assert.equal(overFile.exit, "tampered");
    // The total is counted from what is really read, not from what the manifest claims.
    const recorded = readManifest(grown).files.reduce((sum, entry) => sum + entry.bytes, 0);
    const overTotal = check(grown, { limits: { totalBytes: recorded + 100 } });
    assert.deepEqual(overTotal.result.findings.map((finding) => [finding.kind, finding.path]), [["limit_exceeded", "session/export.md"]]);
    assert.match(overTotal.result.findings[0].message, /this file and those after it were not read/);
    assert.deepEqual([overTotal.exit, overTotal.result.files.matched], ["tampered", 7]);
  });

  test("what cannot be verified at all is an error document, not a result", () => {
    const parent = tempDir();
    const missing = check(path.join(parent, "nothing-here"));
    assert.deepEqual([missing.exit, missing.document], ["error", { schema_version: 1, error: "there is no bundle directory at that path", exitCode: 1 }]);
    assert.equal(missing.text, "ERROR, NOTHING WAS CHECKED: there is no bundle directory at that path\n");
    fs.writeFileSync(path.join(parent, "file"), "x");
    assert.deepEqual([check(path.join(parent, "file")).exit, check(path.join(parent, "file")).code], ["error", 1]);
    assert.deepEqual([check(writeFixture().dir, { expectManifestSha256: "abc" }).exit, check(parent, { expectManifestSha256: "abc" }).code], ["usage", 2]);
    // An empty directory is examined: it has no manifest.
    fs.mkdirSync(path.join(parent, "empty"));
    assert.deepEqual([check(path.join(parent, "empty")).exit, check(path.join(parent, "empty")).kinds], ["tampered", ["manifest_missing"]]);

    // A read that fails inside the verifier is a finding, never a pass.
    const { dir } = writeFixture();
    const original = fs.readSync;
    (fs as any).readSync = () => {
      throw new Error("boom");
    };
    let failed;
    try {
      failed = verifyAuditBundle(dir);
    } finally {
      (fs as any).readSync = original;
    }
    assert.equal(failed.exit, "tampered");
    assert.ok("result" in failed.document && failed.document.findings.every((finding) => finding.kind === "unreadable_entry"));
    assert.ok(!renderAuditVerifyText(failed.document).includes("INTACT BY HASH"));
  });
});
