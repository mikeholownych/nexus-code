import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createOperationAccountIdentity, AccountIdentityError } from "../src/core/account_identity.js";
import { newOperation } from "../src/core/operation.js";
import { OperationStore, resourcesFromConfig } from "../src/core/operation_runner.js";

function withTemp<T>(fn: (root: string, home: string, workspace: string, stateDir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-account-identity-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  try {
    return fn(root, home, workspace, stateDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withTempAsync<T>(fn: (root: string, home: string, workspace: string, stateDir: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-account-identity-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  try {
    return await fn(root, home, workspace, stateDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("operation account IDs are opaque, same-account within one operation, and unlinkable across operations", () => {
  withTemp((_root, home) => {
    const first = createOperationAccountIdentity(home);
    const second = createOperationAccountIdentity(home);
    const token = randomBytes(48).toString("base64url");
    const a = first.fingerprint(token)!;
    assert.equal(first.fingerprint(token), a);
    assert.notEqual(second.fingerprint(token), a);
    assert.match(a, /^acct:credential:v1:[0-9a-f]{64}$/);
    assert.notEqual(a, createHash("sha256").update(token).digest("hex").slice(0, 12));
    assert.equal(first.fingerprint("local"), undefined);
    assert.equal(first.fingerprint("not-needed"), undefined);
    assert.equal(first.fingerprint(undefined), undefined);

    const key = path.join(home, ".config", "nexus", "account-identities", "hmac-key");
    assert.equal(fs.statSync(key).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(key)).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(key).length, 32);
  });
});

test("configured primary, fallback, planner, and coder share IDs only for matching credentials in one operation", () => {
  withTemp((_root, home, workspace) => {
    const token = randomBytes(48).toString("base64url");
    const config: any = {
      endpoint: "https://provider.example/v1", model: "main", apiKey: token, workspace,
      fallbackEndpoints: ["https://fallback.example/v1"], plannerModel: "planner", plannerApiKey: token,
      coderModel: "coder", coderApiKey: "synthetic-other-token", maxSteps: 1, temperature: 0, shell: "bash",
    };
    const resources = resourcesFromConfig(config, createOperationAccountIdentity(home));
    assert.equal(resources[0].account, resources[1].account);
    assert.equal(resources[0].account, resources.find((r) => r.id === "planner")?.account);
    assert.notEqual(resources[0].account, resources.find((r) => r.id === "coder")?.account);
    assert.notEqual(resources[0].account, resourcesFromConfig(config, createOperationAccountIdentity(home))[0].account);
  });
});

test("legacy operation JSON migration preserves account condition scope and is durable across restart", () => {
  withTemp((_root, home, workspace, stateDir) => {
    const old = createHash("sha256").update(randomBytes(48)).digest("hex").slice(0, 12);
    const op = newOperation("op-legacy-migration", "account identity migration", [{ id: "unit", prompt: "test" }], [
      { id: "primary", provider: "provider", endpoint: "https://provider.example/v1", model: "m1", capabilities: ["tools"], account: old },
      { id: "fallback", provider: "provider", endpoint: "https://fallback.example/v1", model: "m2", capabilities: ["tools"], account: old },
    ], Date.now());
    op.conditions.push({
      scope: "account", key: `provider|account|${old}`, condition: "AUTH_FAILED", temporary: false,
      source: "probe", confidence: "authoritative", reason: "synthetic test condition", observedAt: new Date().toISOString(),
      failures: 1, resourceId: "primary",
    });

    const store = new OperationStore(workspace, stateDir, home);
    store.save(op);
    const persistedBefore = store.manager.loadTaskState(op.id);
    assert.ok(persistedBefore.operation);
    for (const resource of persistedBefore.operation.resources) resource.account = old;
    persistedBefore.operation.conditions[0].key = `provider|account|${old}`;
    store.manager.saveTaskState(persistedBefore);

    const exported = store.loadForInspection(op.id);
    const account = exported.resources[0].account!;
    assert.match(account, /^acct:legacy:v1:[0-9a-f]{64}$/);
    assert.equal(exported.resources[1].account, account);
    assert.equal(exported.conditions[0].scope, "account");
    assert.equal(exported.conditions[0].key, `provider|account|${account}`);
    assert.ok(!JSON.stringify(exported).includes(old), "JSON export omits the legacy fingerprint");

    const restarted = new OperationStore(workspace, stateDir, home).loadForInspection(op.id);
    assert.equal(restarted.resources[0].account, account);
    assert.equal(restarted.conditions[0].key, `provider|account|${account}`);
    assert.ok(!JSON.stringify(store.manager.loadTaskState(op.id)).includes(old), "inspection persisted the migration");

    const tampered = store.manager.loadTaskState(op.id);
    assert.ok(tampered.operation);
    tampered.operation.resources.forEach((resource) => { resource.account = old; });
    tampered.operation.conditions[0].key = `provider|account|${old}`;
    store.manager.saveTaskState(tampered);
    const key = path.join(home, ".config", "nexus", "account-identities", "hmac-key");
    fs.chmodSync(key, 0o644);
    assert.throws(() => store.loadForInspection(op.id), (error) => error instanceof AccountIdentityError);
    const unchanged = store.manager.loadTaskState(op.id);
    assert.equal(unchanged.operation?.resources[0].account, old, "unsafe key access does not rewrite or broaden legacy scope");
    assert.equal(unchanged.operation?.conditions[0].scope, "account");
  });
});

test("keyed state remains resumable after key loss, but unsafe key permissions fail closed", () => {
  withTemp((_root, home, workspace, stateDir) => {
    const store = new OperationStore(workspace, stateDir, home);
    const token = randomBytes(48).toString("base64url");
    const account = createOperationAccountIdentity(home).fingerprint(token)!;
    const op = newOperation("op-key-loss", "account identity key loss", [{ id: "unit", prompt: "test" }], [
      { id: "primary", provider: "provider", endpoint: "https://provider.example/v1", model: "m", capabilities: ["tools"], account },
    ], Date.now());
    op.conditions.push({
      scope: "account", key: `provider|account|${account}`, condition: "AUTH_FAILED", temporary: false,
      source: "probe", confidence: "authoritative", reason: "synthetic test condition", observedAt: new Date().toISOString(),
      failures: 1, resourceId: "primary",
    });
    store.save(op);
    const key = path.join(home, ".config", "nexus", "account-identities", "hmac-key");
    fs.rmSync(key);
    const resumed = new OperationStore(workspace, stateDir, home).loadForInspection(op.id);
    assert.equal(resumed.resources[0].account, account);
    assert.equal(resumed.conditions[0].key, `provider|account|${account}`);
    assert.notEqual(createOperationAccountIdentity(home).fingerprint(token), account);

    fs.chmodSync(key, 0o644);
    assert.throws(
      () => createOperationAccountIdentity(home).fingerprint(token),
      (error) => error instanceof AccountIdentityError,
    );
  });
});

test("symlinked account identity directory is rejected without following it", () => {
  withTemp((_root, home) => {
    const configDir = path.join(home, ".config");
    fs.mkdirSync(configDir, { mode: 0o700 });
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(configDir, "nexus"));
    assert.throws(
      () => createOperationAccountIdentity(home).fingerprint(randomBytes(48).toString("base64url")),
      (error) => error instanceof AccountIdentityError,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

test("a FIFO at the account identity key path is rejected without blocking or migrating state", (t) => {
  withTemp((_root, home, workspace, stateDir) => {
    const privateDir = path.join(home, ".config", "nexus", "account-identities");
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const key = path.join(privateDir, "hmac-key");
    const fifo = spawnSync("mkfifo", [key], { encoding: "utf8" });
    if (fifo.error || fifo.status !== 0) {
      t.skip("mkfifo is unavailable on this platform");
      return;
    }

    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const script = `
      import { AccountIdentityError } from "./src/core/account_identity.ts";
      import { newOperation } from "./src/core/operation.ts";
      import { OperationStore } from "./src/core/operation_runner.ts";
      const store = new OperationStore(process.env.NEXUS_TEST_WORKSPACE, process.env.NEXUS_TEST_STATE, process.env.HOME);
      const operation = newOperation("op-fifo", "fifo must not migrate", [{ id: "unit", prompt: "test" }], [
        { id: "primary", provider: "provider", endpoint: "https://provider.example/v1", model: "m", capabilities: ["tools"] },
      ], Date.now());
      store.save(operation);
      const prior = store.manager.loadTaskState(operation.id);
      prior.operation.resources[0].account = "012345abcdef";
      prior.operation.conditions.push({ scope: "account", key: "provider|account|012345abcdef", condition: "AUTH_FAILED", temporary: false, source: "probe", confidence: "authoritative", reason: "synthetic", observedAt: new Date().toISOString(), failures: 1, resourceId: "primary" });
      store.manager.saveTaskState(prior);
      try {
        store.loadForInspection(operation.id);
        process.exitCode = 2;
      } catch (error) {
        const after = store.manager.loadTaskState(operation.id).operation;
        process.exitCode = error instanceof AccountIdentityError && after.resources[0].account === "012345abcdef" && after.conditions[0].key === "provider|account|012345abcdef" ? 0 : 3;
        if (process.exitCode === 0) console.log("state-unchanged");
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: cliRoot,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), NEXUS_TEST_WORKSPACE: workspace, NEXUS_TEST_STATE: stateDir },
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.error?.name, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /state-unchanged/);
  });
});

test("explicit short labels are preserved and unmarked legacy-looking IDs migrate stably", () => {
  withTemp((_root, home, workspace, stateDir) => {
    const explicit = "012345abcdef";
    const legacy = "fedcba654321";
    const op = newOperation("op-explicit-account", "preserve explicit account labels", [{ id: "unit", prompt: "test" }], [
      { id: "custom", provider: "provider", endpoint: "https://provider.example/v1", model: "m1", capabilities: ["tools"], account: explicit, accountIdentitySource: "explicit" },
      { id: "legacy", provider: "provider", endpoint: "https://legacy.example/v1", model: "m2", capabilities: ["tools"], account: legacy },
    ], Date.now());
    const store = new OperationStore(workspace, stateDir, home);
    store.save(op);
    const loaded = store.loadForInspection(op.id);
    assert.equal(loaded.resources[0].account, explicit);
    assert.match(loaded.resources[1].account!, /^acct:legacy:v1:[0-9a-f]{64}$/);
    assert.notEqual(loaded.resources[1].account, legacy);
    const restarted = new OperationStore(workspace, stateDir, home).loadForInspection(op.id);
    assert.equal(restarted.resources[0].account, explicit);
    assert.equal(restarted.resources[1].account, loaded.resources[1].account);
  });
});

test("account identity store repairs a fully written key left linked by an interrupted creator", () => {
  withTemp((_root, home) => {
    const identity = createOperationAccountIdentity(home);
    const secret = randomBytes(48).toString("base64url");
    identity.fingerprint(secret);
    const key = path.join(home, ".config", "nexus", "account-identities", "hmac-key");
    const originalKey = fs.readFileSync(key);
    const interruptedLink = `${key}.tmp.999999.${randomBytes(8).toString("hex")}`;
    fs.linkSync(key, interruptedLink);
    assert.equal(fs.statSync(key).nlink, 2);
    assert.match(createOperationAccountIdentity(home).fingerprint(secret)!, /^acct:credential:v1:[0-9a-f]{64}$/);
    assert.deepEqual(fs.readFileSync(key), originalKey, "recovery keeps the established key bytes");
    assert.equal(fs.existsSync(interruptedLink), false);
    assert.equal(fs.statSync(key).nlink, 1);
  });
});

test("concurrent first use converges on one private key without leaking the key", async () => {
  await withTempAsync(async (root, home) => {
    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const script = `
      import { createOperationAccountIdentity } from "./src/core/account_identity.ts";
      console.log(createOperationAccountIdentity(process.env.HOME).migrateLegacy("legacy-value", "shared-operation"));
    `;
    const outputs = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: cliRoot,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("concurrent key creator timed out"));
      }, 10_000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr || `key creator exited ${code}`));
        else resolve(stdout.trim());
      });
    })));
    assert.ok(outputs.every((value) => value === outputs[0]), "all creators use the same persisted key");
    assert.match(outputs[0]!, /^acct:legacy:v1:[0-9a-f]{64}$/);
    const key = path.join(home, ".config", "nexus", "account-identities", "hmac-key");
    assert.equal(fs.statSync(key).nlink, 1);
    assert.equal(fs.statSync(key).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(key)).filter((name) => name.startsWith("hmac-key.tmp.")).length, 0);
  });
});

test("key setup and write failures remove temporary files and never publish a key", () => {
  for (const failurePoint of ["random", "write", "fsync", "close"] as const) {
    withTemp((_root, home) => {
      const privateDir = path.join(home, ".config", "nexus", "account-identities");
      fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
      const property = failurePoint === "random"
        ? "randomBytes"
        : failurePoint === "write" ? "writeFileSync" : failurePoint === "fsync" ? "fsyncSync" : "closeSync";
      const target = failurePoint === "random" ? crypto : fs;
      const original = (target as any)[property];
      let calls = 0;
      (target as any)[property] = (...args: any[]) => {
        calls++;
        if (failurePoint === "random" && calls === 1) return original(...args); // operation salt succeeds; key generation fails before open
        if (failurePoint === "close") {
          original(...args);
          throw new Error("injected close failure");
        }
        throw new Error(`injected ${failurePoint} failure`);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => createOperationAccountIdentity(home).fingerprint("synthetic-token"), /injected/);
      } finally {
        (target as any)[property] = original;
        syncBuiltinESMExports();
      }
      assert.equal(fs.existsSync(path.join(privateDir, "hmac-key")), false);
      assert.deepEqual(fs.readdirSync(privateDir), [], "failed key creation leaves no temporary or published key");
    });
  }
});

test("stale unlinked temporary keys are removed before a new key is created", () => {
  withTemp((_root, home) => {
    const privateDir = path.join(home, ".config", "nexus", "account-identities");
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const hostId = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
    const stale = path.join(privateDir, `hmac-key.tmp.${hostId}.2147483647.0123456789abcdef01234567`);
    fs.writeFileSync(stale, randomBytes(32), { mode: 0o600 });
    fs.utimesSync(stale, new Date(0), new Date(0));
    assert.throws(() => process.kill(2147483647, 0), { code: "ESRCH" });
    createOperationAccountIdentity(home).fingerprint("synthetic-token");
    assert.equal(fs.existsSync(stale), false);
  });
});

test("account identity repair tolerates another reader removing the same interrupted link", () => {
  withTemp((_root, home) => {
    const keyIdentity = createOperationAccountIdentity(home);
    keyIdentity.fingerprint(randomBytes(48).toString("base64url"));
    const key = path.join(home, ".config", "nexus", "account-identities", "hmac-key");
    const interruptedLink = `${key}.tmp.999999.${randomBytes(8).toString("hex")}`;
    fs.linkSync(key, interruptedLink);
    const originalLstat = fs.lstatSync.bind(fs);
    let raced = false;
    const wrappedLstat = ((candidate: fs.PathLike, ...args: any[]) => {
      if (!raced && String(candidate) === interruptedLink) {
        raced = true;
        fs.unlinkSync(interruptedLink);
        throw Object.assign(new Error("concurrent cleanup"), { code: "ENOENT" });
      }
      return (originalLstat as any)(candidate, ...args);
    }) as typeof fs.lstatSync;
    (fs as any).lstatSync = wrappedLstat;
    syncBuiltinESMExports();

    try {
      assert.doesNotThrow(() => createOperationAccountIdentity(home).fingerprint(randomBytes(48).toString("base64url")));
      assert.equal(raced, true);
      assert.equal(fs.existsSync(interruptedLink), false);
      assert.equal(fs.statSync(key).nlink, 1);
    } finally {
      (fs as any).lstatSync = originalLstat;
      syncBuiltinESMExports();
    }
  });
});

test("group- or world-writable credential homes fail closed", () => {
  withTemp((_root, home) => {
    fs.chmodSync(home, 0o777);
    assert.throws(
      () => createOperationAccountIdentity(home).fingerprint(randomBytes(48).toString("base64url")),
      (error) => error instanceof AccountIdentityError,
    );
  });
});
