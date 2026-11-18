/**
 * A staged language server (rust-analyzer) publishes an empty list before it has analysed anything. With `awaitProgress`
 * the client waits for the server's own progress to end before trusting a list; without it the first publish is returned.
 * The client also answers the server's own requests (window/workDoneProgress/create), or such a server never proceeds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LspBridgeManager } from "../src/lsp.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake_lsp_server.mjs");

function setup(awaitProgress: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-progress-"));
  fs.writeFileSync(path.join(dir, "a.stages.ts"), "BAD code");
  fs.writeFileSync(path.join(dir, "b.stages.ts"), "fine");
  const mgr = new LspBridgeManager(dir, { servers: { ".ts": { cmd: process.execPath, args: [FAKE], languageId: "typescript", awaitProgress } } });
  return { dir, mgr };
}

test("with awaitProgress, the error that arrives after the first (empty) publish is returned", async () => {
  const { dir, mgr } = setup(true);
  try {
    const res = await mgr.diagnostics("a.stages.ts", 10_000);
    assert.equal(res.status, "ok");
    assert.equal(res.status === "ok" && res.diagnostics.length, 1, JSON.stringify(res));
    assert.match(res.status === "ok" ? res.diagnostics[0].message : "", /after analysis/);
  } finally {
    mgr.shutdownAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without awaitProgress the first publish is what is returned (the contrast: the empty list)", async () => {
  const { dir, mgr } = setup(false);
  try {
    const res = await mgr.diagnostics("a.stages.ts", 10_000);
    assert.equal(res.status, "ok");
    assert.equal(res.status === "ok" && res.diagnostics.length, 0, "the server's empty first publish, not the later error");
  } finally {
    mgr.shutdownAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean file is still a real empty report after the wait, and the wait stays within the caller's timeout", async () => {
  const { dir, mgr } = setup(true);
  try {
    const started = Date.now();
    const res = await mgr.diagnostics("b.stages.ts", 10_000);
    assert.equal(res.status, "ok");
    assert.equal(res.status === "ok" && res.diagnostics.length, 0);
    assert.ok(Date.now() - started < 9_000, `waited ${Date.now() - started} ms`);
  } finally {
    mgr.shutdownAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that never ends its progress cannot hold the call past its timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lsp-progress-"));
  fs.writeFileSync(path.join(dir, "a.stages.ts"), "BAD code");
  // Kill the end-of-progress by timing out first: a 1.5 s budget is shorter than the fake's 0.7 s analysis plus the 1.5 s quiet period.
  const mgr = new LspBridgeManager(dir, { servers: { ".ts": { cmd: process.execPath, args: [FAKE], languageId: "typescript", awaitProgress: true } } });
  try {
    const started = Date.now();
    const res = await mgr.diagnostics("a.stages.ts", 1500);
    assert.ok(Date.now() - started < 3_000, `returned after ${Date.now() - started} ms, within the budget plus scheduling`);
    assert.equal(res.status, "ok");
  } finally {
    mgr.shutdownAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
