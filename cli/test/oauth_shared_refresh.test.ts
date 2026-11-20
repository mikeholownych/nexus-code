import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { refreshStoredSignIn } from "../src/oauth_shared_refresh.js";

const credential = (access: string, refresh: string, expiresAt: number) => ({
  type: "oauth" as const, access, refresh, expiresAt, label: "test", savedAt: "test",
});

test("a refreshed stored credential is reused after waiting for the cross-process guard", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shared-refresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guardPath = path.join(dir, "credentials.json.refresh.lock");
  fs.writeFileSync(guardPath, "", { mode: 0o600 });
  const storePath = path.join(dir, "store.json");
  fs.writeFileSync(storePath, JSON.stringify(credential("old", "r0", 1)));
  const published = JSON.stringify(credential("fresh", "r1", Date.now() + 3_600_000));
  const holder = spawn("/usr/bin/flock", ["-x", guardPath, "-c", `echo ready; sleep 0.2; printf '%s' '${published}' > '${storePath}'`], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("error", reject);
  });

  let refreshes = 0;
  const result = await refreshStoredSignIn("chatgpt", credential("old", "r0", 1), "old", {
    guardPath,
    waitMs: 2_000,
    readStored: () => JSON.parse(fs.readFileSync(storePath, "utf8")),
    refresh: async () => { refreshes++; throw new Error("must not reuse a consumed refresh token"); },
    save: () => { throw new Error("already-refreshed credentials must not be rewritten"); },
  });
  assert.equal(result.access, "fresh");
  assert.equal(refreshes, 0);
});

test("lock contention fails closed without sending the rotating refresh token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shared-refresh-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guardPath = path.join(dir, "credentials.json.refresh.lock");
  fs.writeFileSync(guardPath, "", { mode: 0o600 });
  const holder = spawn("/usr/bin/flock", ["-x", guardPath, "-c", "echo ready; sleep 2"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("error", reject);
  });

  let refreshes = 0;
  await assert.rejects(refreshStoredSignIn("chatgpt", credential("old", "r0", 1), "old", {
    guardPath,
    waitMs: 25,
    readStored: () => credential("old", "r0", 1),
    refresh: async () => { refreshes++; return credential("new", "r1", Date.now() + 3_600_000); },
    save: () => {},
  }), /being refreshed by another Nexus process/);
  assert.equal(refreshes, 0);
});
