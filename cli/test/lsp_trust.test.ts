import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LspBridgeManager, buildLspEnvironment } from "../src/lsp.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake_lsp_server.mjs");

function setup(files: Record<string, string>, gate?: () => string | null) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-trust-out-"));
  const pidfile = path.join(out, "pids");
  const envfile = path.join(out, "env.json");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-trust-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const mgr = new LspBridgeManager(dir, {
    servers: { ".ts": { cmd: process.execPath, args: [FAKE], languageId: "typescript", env: { FAKE_PIDFILE: pidfile, FAKE_ENVFILE: envfile } } },
    gate,
  });
  return { dir, mgr, pidfile, envfile };
}

test("a gated manager starts no server and every query says why", async () => {
  const { mgr, pidfile } = setup({ "a.ts": "fine" }, () => "workspace not trusted; language server not started");
  try {
    const d = await mgr.diagnostics("a.ts", 500);
    assert.deepEqual(d, { status: "unavailable", reason: "workspace not trusted; language server not started" });
    const h = await mgr.hover("a.ts", 1, 1);
    assert.equal(h.found, false);
    assert.match(h.error ?? "", /workspace not trusted/);
    const g = await mgr.definition("a.ts", 1, 1);
    assert.match(g.error ?? "", /workspace not trusted/);
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    mgr.shutdownAll();
  }
});

test("an ungated (trusted) manager starts the server", async () => {
  const { mgr, pidfile } = setup({ "a.ts": "fine" }, () => null);
  try {
    assert.equal((await mgr.diagnostics("a.ts", 3000)).status, "ok");
    assert.equal(fs.readFileSync(pidfile, "utf-8").trim().split("\n").length, 1);
  } finally {
    mgr.shutdownAll();
  }
});

test("the lsp tools through the executor refuse in an untrusted workspace with success:false", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-home-"));
  const saved = { HOME: process.env.HOME, T: process.env.NEXUS_TRUST_WORKSPACE };
  process.env.HOME = home;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  const { RustCoreBridge } = await import("../src/tools.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-tool-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "x");
  const bridge = new RustCoreBridge(dir);
  try {
    for (const [tool, args] of [["lsp_diagnostics", { path: "a.ts" }], ["lsp_hover", { path: "a.ts", line: 1, character: 1 }], ["lsp_definition", { path: "a.ts", line: 1, character: 1 }]] as const) {
      const res = await bridge.executeTool(tool, { ...args });
      assert.equal(res.success, false, tool);
      assert.match(res.error ?? "", /workspace not trusted; language server not started/, tool);
    }
  } finally {
    bridge.shutdown();
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.T !== undefined) process.env.NEXUS_TRUST_WORKSPACE = saved.T;
  }
});

test("a read-only bridge refuses even when the workspace is trusted", async () => {
  const saved = process.env.NEXUS_TRUST_WORKSPACE;
  process.env.NEXUS_TRUST_WORKSPACE = "1";
  const { RustCoreBridge } = await import("../src/tools.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-ro-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "x");
  const bridge = new RustCoreBridge(dir, "bash", undefined, false, true);
  try {
    const res = await bridge.executeTool("lsp_hover", { path: "a.ts", line: 1, character: 1 });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /read-only mode; language server not started/);
  } finally {
    bridge.shutdown();
    if (saved === undefined) delete process.env.NEXUS_TRUST_WORKSPACE; else process.env.NEXUS_TRUST_WORKSPACE = saved;
  }
});

test("a required sandbox refuses a trusted workspace rather than starting an unsandboxed server", async () => {
  const saved = process.env.NEXUS_TRUST_WORKSPACE;
  process.env.NEXUS_TRUST_WORKSPACE = "1";
  const { RustCoreBridge } = await import("../src/tools.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-sbx-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "x");
  const bridge = new RustCoreBridge(dir, "bash", undefined, false, false, false, true);
  try {
    const res = await bridge.executeTool("lsp_diagnostics", { path: "a.ts" });
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /sandbox/);
  } finally {
    bridge.shutdown();
    if (saved === undefined) delete process.env.NEXUS_TRUST_WORKSPACE; else process.env.NEXUS_TRUST_WORKSPACE = saved;
  }
});

test("the server environment carries PATH but none of the process secrets", async () => {
  const canaries = { FAKE_SECRET_TOKEN: "c1", NEXUS_API_KEY: "c2", LOCAL_LLM_API_KEY: "c3", OPENAI_API_KEY: "c4", AWS_SECRET_ACCESS_KEY: "c5", DB_PASSWORD: "c6" };
  Object.assign(process.env, canaries);
  const { mgr, envfile } = setup({ "a.ts": "fine" });
  try {
    assert.equal((await mgr.diagnostics("a.ts", 3000)).status, "ok");
    const env = JSON.parse(fs.readFileSync(envfile, "utf-8"));
    assert.ok(env.PATH);
    for (const k of Object.keys(canaries)) assert.equal(env[k], undefined, k);
    assert.equal(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|^NEXUS_|^LOCAL_LLM_/.test(k)).length, 0);
  } finally {
    mgr.shutdownAll();
    for (const k of Object.keys(canaries)) delete process.env[k];
  }
});

test("PATH drops relative and workspace-local entries; toolchain homes pass through", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-path-"));
  const savedPath = process.env.PATH;
  const savedCargo = process.env.CARGO_HOME;
  process.env.PATH = ["/usr/bin", ".", "node_modules/.bin", path.join(ws, "node_modules", ".bin"), "/bin"].join(path.delimiter);
  process.env.CARGO_HOME = "/opt/cargo";
  try {
    const env = buildLspEnvironment(ws);
    assert.equal(env.PATH, ["/usr/bin", "/bin"].join(path.delimiter));
    assert.equal(env.CARGO_HOME, "/opt/cargo");
  } finally {
    process.env.PATH = savedPath;
    if (savedCargo === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = savedCargo;
  }
});

test("a stderr flood does not hang a query", async () => {
  const { mgr } = setup({ "n.noisy.ts": "fine" });
  try {
    const t0 = Date.now();
    assert.equal((await mgr.diagnostics("n.noisy.ts", 5000)).status, "ok");
    assert.ok(Date.now() - t0 < 4000);
  } finally {
    mgr.shutdownAll();
  }
});

test("an oversized message drops the connection and the result is unavailable", async () => {
  const { mgr } = setup({ "h.huge.ts": "fine" });
  try {
    const res = await mgr.diagnostics("h.huge.ts", 5000);
    assert.equal(res.status, "unavailable");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(mgr.serverPids().filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } }), []);
  } finally {
    mgr.shutdownAll();
  }
});
