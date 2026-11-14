import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LspBridgeManager } from "../src/lsp.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake_lsp_server.mjs");

function setup(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const mgr = new LspBridgeManager(dir, {
    servers: { ".ts": { cmd: process.execPath, args: [FAKE], languageId: "typescript" } },
  });
  return { dir, mgr };
}

test("diagnostics for a file with a type error are non-empty and ok", async () => {
  const { mgr } = setup({ "a.ts": "BAD code" });
  try {
    const res = await mgr.diagnostics("a.ts", 3000);
    assert.equal(res.status, "ok");
    assert.equal(res.status === "ok" && res.diagnostics.length, 1);
    assert.equal(res.status === "ok" && res.diagnostics[0].severity, "error");
  } finally {
    mgr.shutdownAll();
  }
});

test("a clean file is ok with an empty list (published, not assumed)", async () => {
  const { mgr } = setup({ "a.ts": "fine" });
  try {
    const res = await mgr.diagnostics("a.ts", 3000);
    assert.deepEqual(res, { status: "ok", diagnostics: [] });
  } finally {
    mgr.shutdownAll();
  }
});

test("a server that never publishes yields unavailable, never an empty ok", async () => {
  const { mgr } = setup({ "x.silent.ts": "BAD" });
  try {
    const res = await mgr.diagnostics("x.silent.ts", 400);
    assert.equal(res.status, "unavailable");
  } finally {
    mgr.shutdownAll();
  }
});

test("no server for the extension, or a missing file, is unavailable", async () => {
  const { mgr } = setup({ "n.txt": "x" });
  try {
    assert.equal((await mgr.diagnostics("n.txt", 300)).status, "unavailable");
    assert.equal((await mgr.diagnostics("missing.ts", 300)).status, "unavailable");
  } finally {
    mgr.shutdownAll();
  }
});

test("edits after the first query produce fresh diagnostics (didChange)", async () => {
  const { dir, mgr } = setup({ "a.ts": "fine" });
  try {
    assert.deepEqual(await mgr.diagnostics("a.ts", 3000), { status: "ok", diagnostics: [] });
    fs.writeFileSync(path.join(dir, "a.ts"), "BAD now");
    const res = await mgr.diagnostics("a.ts", 3000);
    assert.equal(res.status === "ok" && res.diagnostics.length, 1);
  } finally {
    mgr.shutdownAll();
  }
});

test("paths outside the workspace are refused", async () => {
  const { mgr } = setup({ "a.ts": "fine" });
  try {
    const res = await mgr.diagnostics("../../etc/passwd.ts", 300);
    assert.equal(res.status, "unavailable");
  } finally {
    mgr.shutdownAll();
  }
});

test("hover sends didOpen first and shutdownAll leaves no server running", async () => {
  const { mgr } = setup({ "a.ts": "fine" });
  const h = await mgr.hover("a.ts", 1, 1);
  assert.equal(h.found, true);
  const pids = mgr.serverPids();
  assert.equal(pids.length, 1);
  mgr.shutdownAll();
  await new Promise((r) => setTimeout(r, 300));
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  }
});

test("lsp_diagnostics through the tool executor says unavailable, not success with []", async () => {
  const { RustCoreBridge } = await import("../src/tools.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-tool-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  const bridge = new RustCoreBridge(dir);
  try {
    const res = await bridge.executeTool("lsp_diagnostics", { path: "notes.txt" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /unavailable/);
    assert.match(res.error ?? "", /not evidence the file is free of errors/);
  } finally {
    bridge.shutdown();
  }
});
