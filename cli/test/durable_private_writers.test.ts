import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { setCredentialAuthority } from "../src/client.js";
import { saveCredential, credentialsPath } from "../src/credentials.js";
import { getTrustStorePath, setWorkspaceTrusted } from "../src/workspace_trust.js";

function withFsyncCount<T>(run: () => T): { result: T; fsyncs: number } {
  const original = fs.fsyncSync;
  let fsyncs = 0;
  (fs as any).fsyncSync = (...args: Parameters<typeof fs.fsyncSync>) => {
    fsyncs++;
    return original(...args);
  };
  syncBuiltinESMExports();
  try { return { result: run(), fsyncs }; }
  finally { (fs as any).fsyncSync = original; syncBuiltinESMExports(); }
}

test("credential store writes are private, atomic and synced", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-credential-durable-"));
  setCredentialAuthority({}, home);
  try {
    const { fsyncs } = withFsyncCount(() => saveCredential("openrouter", { type: "api", key: "test-key", savedAt: "test" }));
    const file = credentialsPath();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fsyncs >= 2, "credential content and containing directory are synced");
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).providers.openrouter, {
      type: "api", key: "test-key", savedAt: "test",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("workspace trust writes are private, atomic and synced", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trust-durable-"));
  const file = getTrustStorePath();
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  const previousMode = previous ? fs.statSync(file).mode & 0o777 : undefined;
  try {
    const { fsyncs } = withFsyncCount(() => setWorkspaceTrusted(workspace, true));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fsyncs >= 2, "trust content and containing directory are synced");
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), []);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).trustedPaths.includes(fs.realpathSync(workspace)));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (previous) {
      fs.writeFileSync(file, previous, { mode: previousMode });
      fs.chmodSync(file, previousMode!);
    } else {
      fs.rmSync(file, { force: true });
    }
  }
});
