/**
 * GV-1: the loader of the managed tiers (src/core/managed_policy_load.ts) fails closed. Every row of the fail-closed
 * table, for both tiers, through an in-memory file system and injected uids, asserting the error code and the exact
 * two-line message. The loader is never pointed at the machine's real system directory: where the production path
 * appears below, it is a key of the in-memory file system.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveVerificationMode } from "../src/core/managed_policy.js";
import { resolveProductionPolicyInputs } from "../src/core/managed_policy_inputs.js";
import { loadManagedPolicy, MANAGED_POLICY_EXIT_CODE, ManagedPolicyError, SYSTEM_POLICY_PATH, type LoadManagedPolicyInput, type ManagedPolicyErrorCode, type PolicyFs } from "../src/core/managed_policy_load.js";
import { FakeFs } from "./helpers/policy_fixture.js";

const SYSTEM_DIR = "/fake/etc/nexus";
const SYSTEM = `${SYSTEM_DIR}/policy.toml`;
const USER = "/fake/home/op/.config/nexus/policy.toml";
const WORKSPACE = "/fake/ws";
const STORE = "/fake/home/op/.config/nexus/policy_trust.json";
const UID = 1000;
const VALID = 'schema_version = 1\n\n[approval]\nstrict = true\n\n[mcp]\nallow = ["github"]\n';

function input(fake: PolicyFs, overrides: Partial<LoadManagedPolicyInput> = {}): LoadManagedPolicyInput {
  return { systemPath: SYSTEM, systemOwnerUid: 0, userPath: USER, userUid: UID, workspace: WORKSPACE, trust: { workspaceTrusted: false, envTrustRequested: false, storePath: STORE }, fs: fake, ...overrides };
}

/** The two lines the plan fixes, written out here so the test does not take them from the code under test. */
function expectedMessage(tier: "system" | "user", file: string, detail: string, line?: number): string {
  const first = `nexus: managed policy error (${tier} tier): ${file}: ${line === undefined ? "" : `line ${line}: `}${detail}.`;
  const second =
    tier === "system"
      ? "Nexus will not start without this policy. Fix the file (root-owned; ask your administrator) and run `nexus doctor`. No setting or environment variable bypasses it."
      : `Nexus will not start without this policy. Fix it, or move it aside: mv ${file} ${file}.bad`;
  return `${first}\n${second}`;
}

function refused(run: () => unknown, tier: "system" | "user", file: string, code: ManagedPolicyErrorCode, detail: string, line?: number): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ManagedPolicyError, `threw ${String(error)}`);
    assert.deepEqual([error.tier, error.file, error.code, error.line], [tier, file, code, line]);
    assert.equal(error.message, expectedMessage(tier, file, detail, line));
    return true;
  });
}

/** A file system with a sound system directory and no policy files. */
function base(): FakeFs {
  return new FakeFs().dir(SYSTEM_DIR);
}

test("the exact message of the plan, at the production path (in memory)", () => {
  const text = "schema_version = 1\n\n[approval]\nstrict = true\ndisable_auto = true\n\ndisable_yess = true\n";
  const fake = new FakeFs().dir(path.dirname(SYSTEM_POLICY_PATH)).put(SYSTEM_POLICY_PATH, text);
  assert.throws(
    () => loadManagedPolicy(input(fake, { systemPath: SYSTEM_POLICY_PATH })),
    (error: unknown) => {
      assert.ok(error instanceof ManagedPolicyError);
      assert.equal(
        error.message,
        "nexus: managed policy error (system tier): /etc/nexus/policy.toml: line 7: unknown key 'approval.disable_yess'.\n" +
          "Nexus will not start without this policy. Fix the file (root-owned; ask your administrator) and run `nexus doctor`. No setting or environment variable bypasses it.",
      );
      return true;
    },
  );
  // Only the in-memory file system was asked about that path.
  assert.deepEqual([...new Set(fake.touched)], ["/etc/nexus", "/etc/nexus/policy.toml"]);
  assert.equal(MANAGED_POLICY_EXIT_CODE, 2);
});

test("the user-tier message ends with the move-aside command, quoted when the path needs it", () => {
  const fake = base().put(USER, "schema_version = 1\nstrict = true\n", { uid: UID });
  assert.throws(
    () => loadManagedPolicy(input(fake)),
    (error: unknown) =>
      error instanceof ManagedPolicyError &&
      error.message ===
        "nexus: managed policy error (user tier): /fake/home/op/.config/nexus/policy.toml: line 2: unknown key 'strict'.\n" +
          "Nexus will not start without this policy. Fix it, or move it aside: mv /fake/home/op/.config/nexus/policy.toml /fake/home/op/.config/nexus/policy.toml.bad",
  );
  const spaced = "/fake/home/o p/it's/policy.toml";
  assert.throws(
    () => loadManagedPolicy(input(base().put(spaced, "", { uid: UID }), { userPath: spaced })),
    (error: unknown) => error instanceof ManagedPolicyError && error.message.endsWith("mv '/fake/home/o p/it'\\''s/policy.toml' '/fake/home/o p/it'\\''s/policy.toml.bad'"),
  );
});

test("row: file absent -> the tier is absent, for both tiers, and nothing is restricted", () => {
  for (const fake of [new FakeFs(), base()]) {
    const loaded = loadManagedPolicy(input(fake));
    assert.deepEqual([loaded.system, loaded.user, loaded.effective.tiers, loaded.notices], [undefined, undefined, [], []]);
    assert.equal(loaded.effective.approval.disable_yes.value, false);
    assert.equal(loaded.project.status, "ABSENT");
    assert.equal(fake.openCount, 0);
  }
});

test("a valid file in each tier is loaded, with the key lines, and both files are closed", () => {
  const fake = base().put(SYSTEM, VALID).put(USER, 'schema_version = 1\n[commands]\nforbid = ["git push"]\n', { uid: UID, mode: 0o100600 });
  const loaded = loadManagedPolicy(input(fake));
  assert.deepEqual(loaded.system?.document, { approval: { strict: true }, mcp: { allow: ["github"] } });
  assert.deepEqual([loaded.system?.file, loaded.system?.schemaVersion, loaded.user?.file], [SYSTEM, 1, USER]);
  assert.deepEqual(loaded.effective.tiers, ["system", "user"]);
  assert.deepEqual(loaded.effective.approval.disable_yes, { value: true, source: { tier: "system", file: SYSTEM, key: "approval.strict", line: 4 } });
  assert.deepEqual(loaded.effective.commands.forbid.items, [{ value: "git push", source: { tier: "user", file: USER, key: "commands.forbid", line: 3 } }]);
  assert.ok(Object.isFrozen(loaded.effective));
  assert.equal(fake.openCount, 0);
  // Opened without following links and without blocking.
  for (const flags of fake.openFlags) assert.equal(flags & (fake.constants.O_NOFOLLOW | fake.constants.O_NONBLOCK), fake.constants.O_NOFOLLOW | fake.constants.O_NONBLOCK);
  // The user file may also be owned by root.
  assert.ok(loadManagedPolicy(input(base().put(USER, VALID, { uid: 0 }))).user);
});

const DIRECTORY_ROWS: { name: string; setup: (fake: FakeFs) => void; detail: string }[] = [
  { name: "not owned by root", setup: (f) => f.dir(SYSTEM_DIR, { uid: UID }), detail: `the directory ${SYSTEM_DIR} is owned by uid 1000; it must be owned by root (uid 0)` },
  { name: "group-writable", setup: (f) => f.dir(SYSTEM_DIR, { mode: 0o040775 }), detail: `the directory ${SYSTEM_DIR} is writable by group or others (mode 775)` },
  { name: "world-writable", setup: (f) => f.dir(SYSTEM_DIR, { mode: 0o040757 }), detail: `the directory ${SYSTEM_DIR} is writable by group or others (mode 757)` },
  { name: "a symbolic link", setup: (f) => f.dir(SYSTEM_DIR, { kind: "symlink" }), detail: `the directory ${SYSTEM_DIR} is a symbolic link` },
  { name: "not a directory", setup: (f) => f.put(SYSTEM_DIR, "x"), detail: `${SYSTEM_DIR} is not a directory` },
  { name: "cannot be inspected", setup: (f) => f.failLstat.set(SYSTEM_DIR, "EACCES"), detail: `cannot inspect the directory ${SYSTEM_DIR} (EACCES)` },
];

for (const row of DIRECTORY_ROWS) {
  test(`row: the system directory is ${row.name} -> refuse (system tier)`, () => {
    // With a valid, root-owned policy file inside, and with none: the directory alone decides.
    for (const withFile of [true, false]) {
      const fake = new FakeFs();
      if (withFile) fake.put(SYSTEM, VALID);
      row.setup(fake);
      refused(() => loadManagedPolicy(input(fake)), "system", SYSTEM, "directory_unsafe", row.detail);
    }
  });
}

/** One row of the fail-closed table that applies to both tiers. `setup` gets a file system holding a valid file at `file`. */
const FILE_ROWS: { name: string; setup: (fake: FakeFs, file: string) => void; code: ManagedPolicyErrorCode; detail: string; line?: number }[] = [
  { name: "symlink (lstat)", setup: (f, file) => (f.nodes.get(file)!.kind = "symlink"), code: "symlink", detail: "the file is a symbolic link; it must be a regular file" },
  { name: "symlink (ELOOP at open)", setup: (f, file) => f.failOpen.set(file, "ELOOP"), code: "symlink", detail: "the file is a symbolic link; it must be a regular file" },
  { name: "not a regular file: a FIFO", setup: (f, file) => (f.nodes.get(file)!.kind = "fifo"), code: "not_regular", detail: "the path is not a regular file" },
  { name: "not a regular file: a directory", setup: (f, file) => (f.nodes.get(file)!.kind = "dir"), code: "not_regular", detail: "the path is not a regular file" },
  { name: "not a regular file once opened", setup: (f, file) => f.swapOnOpen.set(file, { kind: "fifo" }), code: "not_regular", detail: "the path is not a regular file" },
  { name: "EACCES at lstat", setup: (f, file) => f.failLstat.set(file, "EACCES"), code: "unreadable", detail: "cannot inspect the file (EACCES)" },
  { name: "ENOTDIR at lstat", setup: (f, file) => f.failLstat.set(file, "ENOTDIR"), code: "unreadable", detail: "cannot inspect the file (ENOTDIR)" },
  { name: "EACCES at open", setup: (f, file) => f.failOpen.set(file, "EACCES"), code: "unreadable", detail: "cannot open the file (EACCES)" },
  { name: "EMFILE at open", setup: (f, file) => f.failOpen.set(file, "EMFILE"), code: "unreadable", detail: "cannot open the file (EMFILE)" },
  { name: "removed between lstat and open", setup: (f, file) => f.failOpen.set(file, "ENOENT"), code: "changed", detail: "the file was removed while it was being read" },
  { name: "EIO at fstat", setup: (f, file) => f.failFstat.set(file, "EIO"), code: "unreadable", detail: "cannot read the file (EIO)" },
  { name: "EIO at read", setup: (f, file) => f.failRead.set(file, "EIO"), code: "unreadable", detail: "cannot read the file (EIO)" },
  { name: "over 64 KiB", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from(`schema_version = 1\n#${"x".repeat(64 * 1024)}`)), code: "too_large", detail: "the file is larger than 64 KiB" },
  { name: "over 64 KiB once read (it grew after fstat)", setup: (f, file) => f.growOnRead.set(file, Buffer.from(`schema_version = 1\n#${"x".repeat(64 * 1024)}`)), code: "too_large", detail: "the file is larger than 64 KiB" },
  { name: "mode: group-writable", setup: (f, file) => (f.nodes.get(file)!.mode = 0o100664), code: "mode", detail: "the file is writable by group or others (mode 664); run chmod go-w on it" },
  { name: "mode: world-writable", setup: (f, file) => (f.nodes.get(file)!.mode = 0o100646), code: "mode", detail: "the file is writable by group or others (mode 646); run chmod go-w on it" },
  { name: "fstat inode differs from lstat", setup: (f, file) => f.swapOnOpen.set(file, { ino: 999_999 }), code: "changed", detail: "the file was replaced while it was being read" },
  { name: "fstat device differs from lstat", setup: (f, file) => f.swapOnOpen.set(file, { dev: 77 }), code: "changed", detail: "the file was replaced while it was being read" },
  { name: "invalid UTF-8", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.concat([Buffer.from("schema_version = 1\n# "), Buffer.from([0xc3, 0x28])])), code: "invalid_utf8", detail: "the file is not valid UTF-8" },
  { name: "a truncated UTF-8 sequence", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.concat([Buffer.from("schema_version = 1\n# "), Buffer.from([0xe6, 0x9d])])), code: "invalid_utf8", detail: "the file is not valid UTF-8" },
  { name: "a byte-order mark", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VALID)])), code: "bom", detail: "the file starts with a byte-order mark; save it as UTF-8 without a BOM" },
  { name: "a NUL byte", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from(`${VALID}# \0\n`)), code: "nul", detail: "the file contains a NUL byte" },
  { name: "UTF-16 text", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from(VALID, "utf16le")), code: "nul", detail: "the file contains a NUL byte" },
  { name: "a syntax error", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[approval]\nstrict = yes\n")), code: "syntax", line: 3, detail: `unsupported value 'yes': expected a "string", true, false, a whole number or an array of strings` },
  { name: "an unsupported construct", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\napproval.strict = true\n")), code: "unsupported", line: 2, detail: "dotted keys are not supported; put the key under a [table] header" },
  { name: "a duplicate key", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[approval]\nstrict = true\nstrict = false\n")), code: "duplicate_key", line: 4, detail: "duplicate key 'approval.strict' (first set on line 3); a key may be set once" },
  { name: "a duplicate table", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[approval]\nstrict = true\n[approval]\n")), code: "duplicate_table", line: 4, detail: "duplicate table '[approval]' (first defined on line 2); merge the two into one" },
  { name: "an unknown table", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n\n[aproval]\nstrict = true\n")), code: "unknown_table", line: 3, detail: "unknown table '[aproval]'" },
  { name: "an unknown key", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[commands]\nallow = [\"ls\"]\n")), code: "unknown_key", line: 3, detail: "unknown key 'commands.allow'" },
  { name: "a wrong type", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[sandbox]\nrequired = \"yes\"\n")), code: "wrong_type", line: 3, detail: "key 'sandbox.required' must be true or false" },
  { name: "a bad enumeration value", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[verification]\nmode = \"off\"\n")), code: "bad_value", line: 3, detail: `key 'verification.mode' must be "approve" or "block" (found "off"); a policy can only raise this, never lower it` },
  { name: "a bad list item", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 1\n[mcp]\nallow = [\n  \"github\",\n  \"cmd:/x\",\n]\n")), code: "bad_value", line: 5, detail: `key 'mcp.allow', item 2 ("cmd:/x") must be a server name (letters, digits, '.', '_', '-'), "command:/absolute/path" or "url:https://origin"` },
  { name: "an empty file", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.alloc(0)), code: "empty", detail: "the file is empty; a policy file needs at least the line `schema_version = 1`" },
  { name: "a file of comments only", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("# nothing yet\n\n")), code: "empty", detail: "the file is empty; a policy file needs at least the line `schema_version = 1`" },
  { name: "a missing schema_version", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("[approval]\nstrict = true\n")), code: "schema_version_missing", detail: "schema_version is missing; add `schema_version = 1` as the first line" },
  { name: "a schema_version that is not a number", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from('schema_version = "1"\n')), code: "wrong_type", line: 1, detail: "key 'schema_version' must be a whole number" },
  { name: "schema_version above the supported one", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("# next\nschema_version = 2\n[approval]\nstrict = true\nfuture_key = 1\n")), code: "schema_version_unsupported", line: 2, detail: "schema_version 2 is not supported by this Nexus (supported: 1); upgrade Nexus before rolling out this policy" },
  { name: "schema_version zero", setup: (f, file) => (f.nodes.get(file)!.bytes = Buffer.from("schema_version = 0\n")), code: "schema_version_unsupported", line: 1, detail: "schema_version 0 is not supported by this Nexus (supported: 1); upgrade Nexus before rolling out this policy" },
];

for (const tier of ["system", "user"] as const) {
  const file = tier === "system" ? SYSTEM : USER;
  for (const row of FILE_ROWS) {
    test(`row: ${row.name} -> refuse (${tier} tier)`, () => {
      const fake = base().put(file, VALID, { uid: tier === "system" ? 0 : UID });
      row.setup(fake, file);
      refused(() => loadManagedPolicy(input(fake)), tier, file, row.code, row.detail, row.line);
      assert.equal(fake.openCount, 0, "no descriptor is left open");
    });
  }
}

test("row: owner -> the system file must be owned by uid 0", () => {
  for (const uid of [UID, 1, 65534]) {
    refused(() => loadManagedPolicy(input(base().put(SYSTEM, VALID, { uid }))), "system", SYSTEM, "owner", `the file is owned by uid ${uid}; it must be owned by root (uid 0)`);
  }
  // The owner is the injected uid, not a property of the process.
  const loaded = loadManagedPolicy(input(new FakeFs().dir(SYSTEM_DIR, { uid: 4242 }).put(SYSTEM, VALID, { uid: 4242 }), { systemOwnerUid: 4242 }));
  assert.equal(loaded.system?.document.approval?.strict, true);
  refused(() => loadManagedPolicy(input(new FakeFs().dir(SYSTEM_DIR, { uid: 4242 }).put(SYSTEM, VALID, { uid: 0 }), { systemOwnerUid: 4242 })), "system", SYSTEM, "owner", "the file is owned by uid 0; it must be owned by uid 4242");
});

test("row: owner -> the user file must be owned by the user or by root", () => {
  refused(() => loadManagedPolicy(input(base().put(USER, VALID, { uid: 1001 }))), "user", USER, "owner", "the file is owned by uid 1001; it must be owned by you (uid 1000) or root");
  assert.ok(loadManagedPolicy(input(base().put(USER, VALID, { uid: UID }))).user);
  assert.ok(loadManagedPolicy(input(base().put(USER, VALID, { uid: 0 }))).user);
});

test("the ownership checks use what fstat reports for the opened file, not what lstat saw", () => {
  refused(() => loadManagedPolicy(input(base().put(SYSTEM, VALID).swapOwner(SYSTEM, UID))), "system", SYSTEM, "owner", "the file is owned by uid 1000; it must be owned by root (uid 0)");
});

test("there is no partial result: a broken tier throws even when the other tier is sound, and the system tier is reported first", () => {
  const broken = "schema_version = 1\n[approval]\nstrict = maybe\n";
  refused(() => loadManagedPolicy(input(base().put(SYSTEM, VALID).put(USER, broken, { uid: UID }))), "user", USER, "syntax", `unsupported value 'maybe': expected a "string", true, false, a whole number or an array of strings`, 3);
  refused(() => loadManagedPolicy(input(base().put(SYSTEM, broken).put(USER, VALID, { uid: UID }))), "system", SYSTEM, "syntax", `unsupported value 'maybe': expected a "string", true, false, a whole number or an array of strings`, 3);
  assert.throws(() => loadManagedPolicy(input(base().put(SYSTEM, broken).put(USER, broken, { uid: UID }))), (error: unknown) => error instanceof ManagedPolicyError && error.tier === "system");
});

test("a file that parses but is cut short is still what it says: every truncation either throws or keeps every restriction it still contains", () => {
  // Fail closed is about a file that cannot be understood. A prefix that is itself a valid policy is a valid policy;
  // this pins that a prefix never yields a restriction the full file does not have, and never a value from thin air.
  const full = 'schema_version = 1\n[approval]\nstrict = true\n[sandbox]\nrequired = true\n[mcp]\nallow = ["github"]\n';
  let threw = 0;
  let loaded = 0;
  for (let cut = 0; cut <= full.length; cut++) {
    try {
      const policy = loadManagedPolicy(input(base().put(SYSTEM, full.slice(0, cut)))).effective;
      loaded++;
      assert.ok(cut >= "schema_version = 1".length, `a usable policy from ${cut} bytes`);
      if (policy.mcp.allow.restricted) assert.deepEqual(policy.mcp.allow.values, ["github"]);
    } catch (error) {
      assert.ok(error instanceof ManagedPolicyError, String(error));
      threw++;
    }
  }
  assert.ok(threw > 20 && loaded > 5, `${threw} refused, ${loaded} loaded`);
});

test("a platform without a system tier or POSIX owners: null inputs skip exactly those checks", () => {
  const fake = new FakeFs().put(SYSTEM, "this would not parse").put(USER, VALID, { uid: 31337, mode: 0o100666 });
  const loaded = loadManagedPolicy(input(fake, { systemPath: null, userUid: null }));
  assert.deepEqual([loaded.system, loaded.effective.tiers], [undefined, ["user"]]);
  assert.ok(!fake.touched.includes(SYSTEM) && !fake.touched.includes(SYSTEM_DIR));
  // The content checks still hold.
  refused(() => loadManagedPolicy(input(new FakeFs().put(USER, "x = 1", { uid: 31337 }), { systemPath: null, userUid: null })), "user", USER, "schema_version_missing", "schema_version is missing; add `schema_version = 1` as the first line");
});

test("the loader reads only the two managed files, the project file and the approval store", () => {
  const fake = base().put(SYSTEM, VALID).put(USER, VALID, { uid: UID });
  loadManagedPolicy(input(fake));
  assert.deepEqual([...new Set(fake.touched)].sort(), [SYSTEM_DIR, SYSTEM, USER, STORE, `${WORKSPACE}/.nexus-security.json`].sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// The same checks against a real file system, in a temporary directory (never the machine's own configuration).

test("on a real file system: a valid file loads; a symlink, a group-writable file, a directory and a loose directory are refused", (t) => {
  if (process.platform === "win32" || typeof process.geteuid !== "function") return t.skip("POSIX owners and modes are needed");
  const uid = process.geteuid();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-policy-load-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const etc = path.join(root, "etc", "nexus");
  const home = path.join(root, "home", ".config", "nexus");
  fs.mkdirSync(etc, { recursive: true, mode: 0o755 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(etc, 0o755);
  const systemPath = path.join(etc, "policy.toml");
  const userPath = path.join(home, "policy.toml");
  const real = (overrides: Partial<LoadManagedPolicyInput> = {}): LoadManagedPolicyInput => ({
    systemPath,
    systemOwnerUid: uid,
    userPath,
    userUid: uid,
    workspace: path.join(root, "ws"),
    trust: { workspaceTrusted: false, envTrustRequested: false, storePath: path.join(home, "policy_trust.json") },
    fs,
    ...overrides,
  });
  const write = (file: string, text: string, mode = 0o644): void => {
    fs.rmSync(file, { recursive: true, force: true });
    fs.writeFileSync(file, text, { mode });
    fs.chmodSync(file, mode);
  };
  const code = (run: () => unknown): string => {
    try {
      run();
      return "loaded";
    } catch (error) {
      assert.ok(error instanceof ManagedPolicyError, String(error));
      return `${error.tier}:${error.code}`;
    }
  };

  assert.deepEqual(loadManagedPolicy(real()).effective.tiers, []);
  write(systemPath, VALID);
  write(userPath, 'schema_version = 1\n[verification]\nmode = "block"\n', 0o600);
  const loaded = loadManagedPolicy(real());
  assert.deepEqual(loaded.effective.tiers, ["system", "user"]);
  assert.equal(effectiveVerificationMode(loaded.effective).value, "block");

  write(systemPath, VALID, 0o664);
  assert.equal(code(() => loadManagedPolicy(real())), "system:mode");
  write(systemPath, VALID, 0o644);
  fs.chmodSync(etc, 0o777);
  assert.equal(code(() => loadManagedPolicy(real())), "system:directory_unsafe");
  fs.chmodSync(etc, 0o755);
  assert.equal(code(() => loadManagedPolicy(real({ systemOwnerUid: uid + 1 }))), "system:directory_unsafe");

  const target = path.join(root, "elsewhere.toml");
  write(target, VALID);
  fs.rmSync(userPath);
  fs.symlinkSync(target, userPath);
  assert.equal(code(() => loadManagedPolicy(real())), "user:symlink");
  fs.rmSync(userPath);
  fs.mkdirSync(userPath);
  assert.equal(code(() => loadManagedPolicy(real())), "user:not_regular");
  fs.rmdirSync(userPath);
  write(userPath, `schema_version = 1\n#${"x".repeat(70_000)}\n`, 0o600);
  assert.equal(code(() => loadManagedPolicy(real())), "user:too_large");
  write(userPath, "schema_version = 1\n[approval]\nstrict = true\nstrict = true\n", 0o600);
  assert.equal(code(() => loadManagedPolicy(real())), "user:duplicate_key");
  write(userPath, VALID, 0o600);
  // Root may own the user file, so this row needs a caller that is not root.
  if (uid !== 0) assert.equal(code(() => loadManagedPolicy(real({ userUid: uid + 1 }))), "user:owner");
  assert.equal(code(() => loadManagedPolicy(real())), "loaded");
});

// ---------------------------------------------------------------------------------------------------------------------
// The guard: where the system path can come from.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test("guard: the system path is written in exactly one source file, which reads neither the environment nor the arguments", () => {
  const holders = sourceFiles(SRC).filter((file) => fs.readFileSync(file, "utf8").includes("/etc/nexus"));
  assert.deepEqual(holders.map((file) => path.relative(SRC, file)), [path.join("core", "managed_policy_load.ts")]);
  const text = fs.readFileSync(holders[0], "utf8");
  assert.equal(text.split("/etc/nexus").length - 1, 1, "written once, in the constant");
  assert.match(text, /^export const SYSTEM_POLICY_PATH = "\/etc\/nexus\/policy\.toml";$/m);
  assert.ok(!text.includes("process.env"), "process.env");
  assert.ok(!text.includes("process.argv"), "process.argv");
  assert.ok(!/\bprocess\s*\[/.test(text) && !/\benv\b\s*[.[]/.test(text) && !/\bargv\b/.test(text), "no indirect access either");
  assert.equal(SYSTEM_POLICY_PATH, "/etc/nexus/policy.toml");
});

test("guard: no policy module reads an environment variable that names a policy path, and the three library modules read none at all", () => {
  const modules = ["managed_policy.ts", "managed_policy_toml.ts", "managed_policy_load.ts"].map((name) => path.join(SRC, "core", name));
  for (const file of modules) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/NEXUS_.*POLICY.*PATH|NEXUS_SYSTEM_POLICY|NEXUS_POLICY_FILE/.test(text), path.basename(file));
    assert.ok(!text.includes("process.env") && !text.includes("process.argv") && !/\bprocess\s*\[/.test(text), `${path.basename(file)} reads the process environment or arguments`);
    // Nothing is exported that could replace the constant or the paths at run time.
    assert.ok(!/export\s+(?:let|var)\b/.test(text) && !/export function set[A-Z]/.test(text), `${path.basename(file)} exports something settable`);
  }
  // Across all of src: no such variable name is read anywhere.
  for (const file of sourceFiles(SRC)) {
    assert.ok(!/NEXUS_[A-Z_]*POLICY[A-Z_]*PATH|NEXUS_SYSTEM_POLICY|NEXUS_POLICY_FILE/.test(fs.readFileSync(file, "utf8")), path.relative(SRC, file));
  }
  const inputs = fs.readFileSync(path.join(SRC, "core", "managed_policy_inputs.ts"), "utf8");
  assert.ok(!inputs.includes("process.env") && !inputs.includes("process.argv"));
});

test("the production inputs: the constant, root, and files under the home configuration directory", (t) => {
  // HOME is a throwaway directory in this test run; nothing is read.
  const inputs = resolveProductionPolicyInputs();
  const config = path.join(os.homedir(), ".config", "nexus");
  assert.equal(inputs.userPath, path.join(config, "policy.toml"));
  assert.equal(inputs.trustStorePath, path.join(config, "policy_trust.json"));
  assert.equal(inputs.systemOwnerUid, 0);
  if (process.platform === "win32") return t.skip("no system tier on Windows");
  assert.equal(inputs.systemPath, SYSTEM_POLICY_PATH);
  assert.equal(inputs.userUid, process.geteuid!());
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NEXUS_SYSTEM_POLICY: "/tmp/x.toml", NEXUS_POLICY_FILE: "/tmp/x.toml", NEXUS_SYSTEM_POLICY_PATH: "/tmp/x.toml", NEXUS_POLICY_PATH: "/tmp/x.toml" });
    assert.equal(resolveProductionPolicyInputs().systemPath, "/etc/nexus/policy.toml");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  }
});
