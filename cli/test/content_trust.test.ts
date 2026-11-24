/**
 * HK-1: the content-hash approval store (`extension_trust.json`). An approval names exact bytes; a store that cannot
 * be believed approves nothing.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { approveExtension, extensionTrustStatus, extensionTrustStorePath, readExtensionTrust, revokeExtension, type ExtensionTrustEntry } from "../src/core/content_trust.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const entry = (over: Partial<ExtensionTrustEntry> = {}): ExtensionTrustEntry => ({ kind: "project-hooks", scope: "/work/repo", key: ".nexus/hooks.json", sha256: sha("v1"), approvedAt: "2026-11-24T00:00:00.000Z", summary: "1 pre-tool hook", ...over });

function withStore(run: (storePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-content-trust-"));
  try {
    run(path.join(dir, "nexus", "extension_trust.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the store lives in the operator's configuration directory", () => {
  assert.equal(extensionTrustStorePath(), path.join(os.homedir(), ".config", "nexus", "extension_trust.json"));
});

test("NEW, MATCH, MISMATCH, REMOVED and ABSENT", () => withStore((store) => {
  const id = { kind: "project-hooks" as const, scope: "/work/repo", key: ".nexus/hooks.json" };
  assert.deepEqual(readExtensionTrust(store), { entries: [] }, "a missing store is empty, without a problem");
  assert.equal(extensionTrustStatus([], id, undefined), "ABSENT");
  assert.equal(extensionTrustStatus([], id, sha("v1")), "NEW");

  approveExtension(entry(), store);
  const { entries, problem } = readExtensionTrust(store);
  assert.equal(problem, undefined);
  assert.deepEqual(entries, [entry()]);
  assert.equal(extensionTrustStatus(entries, id, sha("v1")), "MATCH");
  assert.equal(extensionTrustStatus(entries, id, sha("v2")), "MISMATCH", "one changed byte is a different content");
  assert.equal(extensionTrustStatus(entries, id, undefined), "REMOVED");
  // An approval is for one workspace and one file: the same bytes elsewhere are new.
  assert.equal(extensionTrustStatus(entries, { ...id, scope: "/work/repo-worktree" }, sha("v1")), "NEW");
  assert.equal(extensionTrustStatus(entries, { ...id, key: "other/hooks.json" }, sha("v1")), "NEW");
}));

test("the store is written private, and approving again replaces the earlier approval of the same item", () => withStore((store) => {
  approveExtension(entry(), store);
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(store)).mode & 0o777, 0o700);
  approveExtension(entry({ scope: "/work/other" }), store);
  approveExtension(entry({ sha256: sha("v2"), approvedAt: "2026-11-25T00:00:00.000Z" }), store);
  const { entries } = readExtensionTrust(store);
  assert.deepEqual(entries.map((e) => [e.scope, e.sha256]), [["/work/other", sha("v1")], ["/work/repo", sha("v2")]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(store, "utf8")).version, 1);

  assert.equal(revokeExtension({ kind: "project-hooks", scope: "/work/repo", key: ".nexus/hooks.json" }, store), true);
  assert.equal(revokeExtension({ kind: "project-hooks", scope: "/work/repo", key: ".nexus/hooks.json" }, store), false, "nothing left to revoke");
  assert.deepEqual(readExtensionTrust(store).entries.map((e) => e.scope), ["/work/other"]);
}));

test("an approval that is not a full SHA-256 is refused when recorded", () => withStore((store) => {
  assert.throws(() => approveExtension(entry({ sha256: "abc" }), store), /not a valid approval/);
  assert.throws(() => approveExtension(entry({ sha256: sha("v1").toUpperCase() }), store), /not a valid approval/);
  assert.throws(() => approveExtension(entry({ kind: "workspace-js" as any }), store), /not a valid approval/);
  assert.equal(fs.existsSync(store), false);
}));

test("a store that cannot be believed holds no approvals and says why", () => withStore((store) => {
  const id = { kind: "project-hooks" as const, scope: "/work/repo", key: ".nexus/hooks.json" };
  approveExtension(entry(), store);
  const good = fs.readFileSync(store, "utf8");
  const broken: Array<[string, string, RegExp]> = [
    ["truncated", good.slice(0, good.length - 10), /line \d+, column \d+/],
    ["not JSON", "approved: everything", /unexpected character/],
    ["another version", good.replace('"version": 1', '"version": 2'), /not a version 1 extension trust store/],
    ["entries is not a list", '{"version":1,"entries":{}}', /not a version 1 extension trust store/],
    ["a duplicate key", good.replace('"version": 1,', '"version": 1, "entries": [],'), /duplicate key "entries"/],
    ["a malformed entry among good ones", JSON.stringify({ version: 1, entries: [entry(), { ...entry({ scope: "/x" }), sha256: "short" }] }), /malformed entry/],
    ["an entry of an unknown kind", JSON.stringify({ version: 1, entries: [{ ...entry(), kind: "anything" }] }), /malformed entry/],
    ["oversize", `${good}${" ".repeat(256 * 1024)}`, /exceeds the 256 KiB size limit/],
  ];
  for (const [name, text, pattern] of broken) {
    fs.writeFileSync(store, text, { mode: 0o600 });
    const read = readExtensionTrust(store);
    assert.deepEqual(read.entries, [], name);
    assert.match(read.problem ?? "", pattern, name);
    assert.equal(extensionTrustStatus(read.entries, id, sha("v1")), "NEW", `${name}: the approved content is unapproved again`);
  }
}));

test("a store other users can read or write, or a symbolic link, is refused", () => withStore((store) => {
  approveExtension(entry(), store);
  for (const mode of [0o644, 0o640, 0o660, 0o606]) {
    fs.chmodSync(store, mode);
    const read = readExtensionTrust(store);
    assert.deepEqual(read.entries, [], mode.toString(8));
    assert.match(read.problem ?? "", /permissions are too open/, mode.toString(8));
  }
  fs.chmodSync(store, 0o600);
  assert.equal(readExtensionTrust(store).entries.length, 1);

  const real = `${store}.real`;
  fs.renameSync(store, real);
  fs.symlinkSync(real, store);
  const linked = readExtensionTrust(store);
  assert.deepEqual(linked.entries, []);
  assert.match(linked.problem ?? "", /symbolic link/);
}));

test("approving over an unreadable store replaces it", () => withStore((store) => {
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, "garbage", { mode: 0o600 });
  approveExtension(entry(), store);
  assert.deepEqual(readExtensionTrust(store), { entries: [entry()] });
}));
