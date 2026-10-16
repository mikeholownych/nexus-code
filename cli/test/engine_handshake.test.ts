import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { RustCoreBridge, CORE_PROTOCOL_VERSION } from "../src/tools.js";
import { getBuildIdentity } from "../src/build_identity.js";

function makeMockEngine(scriptBody: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mock-engine-"));
  const scriptPath = path.join(tmpDir, "mock-engine.cjs");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
  return scriptPath;
}

describe("RustCoreBridge hello handshake (REQ-REL-103)", () => {
  const activeBridges: RustCoreBridge[] = [];
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const b of activeBridges) {
      b.shutdown();
    }
    activeBridges.length = 0;
    for (const d of cleanupDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    cleanupDirs.length = 0;
  });

  test("handshake succeeds against real core engine and reports correct protocol and version", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handshake-real-"));
    cleanupDirs.push(ws);
    const bridge = new RustCoreBridge(ws);
    activeBridges.push(bridge);

    const info = await bridge.ensureHandshake();
    assert.equal(info.protocol, CORE_PROTOCOL_VERSION);
    assert.equal(info.version, getBuildIdentity().version);

    // Repeated call should return cached resolution without error
    const info2 = await bridge.ensureHandshake();
    assert.deepEqual(info2, info);
  });

  test("handshake fails actionably when protocol mismatches", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handshake-proto-"));
    cleanupDirs.push(ws);

    const mockScript = makeMockEngine(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: req.id, result: { version: '${getBuildIdentity().version}', protocol: 99 } }) + '\\n');
  }
});
`);
    cleanupDirs.push(path.dirname(mockScript));

    const bridge = new RustCoreBridge(ws, "bash", mockScript);
    activeBridges.push(bridge);

    await assert.rejects(
      async () => bridge.ensureHandshake(),
      (err: Error) => {
        assert.match(err.message, /Engine protocol mismatch: core engine reports protocol 99, but CLI expects 1\./);
        assert.match(err.message, /Run 'make build' to update\./);
        return true;
      }
    );

    // executeTool should not fall through to execution; it must return the actionable error
    const toolRes = await bridge.executeTool("read_file", { path: "nonexistent.txt" });
    assert.equal(toolRes.success, false);
    assert.match(toolRes.error || "", /Engine protocol mismatch: core engine reports protocol 99, but CLI expects 1\./);
  });

  test("handshake fails actionably when version mismatches", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handshake-ver-"));
    cleanupDirs.push(ws);

    const mockScript = makeMockEngine(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: req.id, result: { version: '0.99.0-wrong', protocol: ${CORE_PROTOCOL_VERSION} } }) + '\\n');
  }
});
`);
    cleanupDirs.push(path.dirname(mockScript));

    const bridge = new RustCoreBridge(ws, "bash", mockScript);
    activeBridges.push(bridge);

    await assert.rejects(
      async () => bridge.ensureHandshake(),
      (err: Error) => {
        assert.match(err.message, /Engine version mismatch: core engine reports version 0\.99\.0-wrong, but CLI is/);
        assert.match(err.message, /Run 'make build' to update\./);
        return true;
      }
    );

    const toolRes = await bridge.executeTool("write_file", { path: "foo.txt", content: "hello" });
    assert.equal(toolRes.success, false);
    assert.match(toolRes.error || "", /Engine version mismatch: core engine reports version 0\.99\.0-wrong/);
  });

  test("handshake fails when hello RPC returns an error", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handshake-err-"));
    cleanupDirs.push(ws);

    const mockScript = makeMockEngine(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: req.id, error: 'Internal initialization failure' }) + '\\n');
  }
});
`);
    cleanupDirs.push(path.dirname(mockScript));

    const bridge = new RustCoreBridge(ws, "bash", mockScript);
    activeBridges.push(bridge);

    await assert.rejects(
      async () => bridge.ensureHandshake(),
      (err: Error) => {
        assert.match(err.message, /Core engine handshake failed: Internal initialization failure/);
        return true;
      }
    );
  });

  test("handshake fails when hello RPC returns non-JSON", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handshake-nonjson-"));
    cleanupDirs.push(ws);

    const mockScript = makeMockEngine(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'hello') {
    process.stdout.write(JSON.stringify({ id: req.id, result: 'not-json-object' }) + '\\n');
  }
});
`);
    cleanupDirs.push(path.dirname(mockScript));

    const bridge = new RustCoreBridge(ws, "bash", mockScript);
    activeBridges.push(bridge);

    await assert.rejects(
      async () => bridge.ensureHandshake(),
      (err: Error) => {
        assert.match(err.message, /Invalid JSON in core engine hello handshake response/);
        return true;
      }
    );
  });
});
