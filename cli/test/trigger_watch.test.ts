/** BG-3: the file watcher with real inotify watches in a throwaway directory: bounded, quiet about its own excluded paths, loud about its errors. */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirBudget, FileTriggerWatcher, type WatchBatch } from "../src/core/trigger_watch.js";

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-watch-")));
  for (const d of ["src", ".git", ".nexus/worktrees/op-1", "other"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}
const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

/** Drains until `until` accepts what has been collected, or the time is up. */
async function collect(w: FileTriggerWatcher, until: (all: WatchBatch[]) => boolean, ms = 4_000): Promise<WatchBatch[]> {
  const all: WatchBatch[] = [];
  for (const end = Date.now() + ms; Date.now() < end && !until(all);) {
    w.reconcile();
    const batch = w.drain(Date.now());
    if (batch) all.push(batch);
    await new Promise((r) => setTimeout(r, 30));
  }
  return all;
}
const paths = (all: WatchBatch[]) => [...new Set(all.flatMap((b) => b.paths))].sort();
const make = (dir: string, globs: string[], extra: Partial<ConstructorParameters<typeof FileTriggerWatcher>[0]> = {}) =>
  new FileTriggerWatcher({ workspace: dir, globs, budget: new DirBudget(), debounceMs: 50, ...extra });

test("a change under a watched glob is one coalesced batch of workspace-relative paths", async () => {
  const dir = repo();
  const w = make(dir, ["src/**/*.ts"]);
  try {
    w.reconcile();
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "1");
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "1");
    fs.writeFileSync(path.join(dir, "src", "c.md"), "1");
    fs.writeFileSync(path.join(dir, "other", "d.ts"), "1");
    const all = await collect(w, (b) => paths(b).length >= 2);
    assert.deepEqual(paths(all), ["src/a.ts", "src/b.ts"]);
    assert.equal(all.length, 1, "inside one window it is one batch, not one fire per file");
  } finally { w.close(); rm(dir); }
});

test("a directory created later is watched too", async () => {
  const dir = repo();
  const w = make(dir, ["src/**/*.ts"]);
  try {
    w.reconcile();
    fs.mkdirSync(path.join(dir, "src", "deep", "er"), { recursive: true });
    await collect(w, () => false, 400);
    fs.writeFileSync(path.join(dir, "src", "deep", "er", "n.ts"), "1");
    const all = await collect(w, (b) => paths(b).includes("src/deep/er/n.ts"));
    assert.ok(paths(all).includes("src/deep/er/n.ts"), JSON.stringify(all));
  } finally { w.close(); rm(dir); }
});

test(".git and .nexus never produce an event and are not even watched, whatever the glob", async () => {
  const dir = repo();
  const w = make(dir, ["**"]);
  try {
    w.reconcile();
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "x");
    fs.writeFileSync(path.join(dir, ".nexus", "triggers.json"), "{}");
    fs.writeFileSync(path.join(dir, ".nexus", "worktrees", "op-1", "job-write.ts"), "x");
    fs.writeFileSync(path.join(dir, "trigger_trust.json"), "{}");
    fs.writeFileSync(path.join(dir, "real.txt"), "x");
    const all = await collect(w, (b) => paths(b).length >= 1);
    await collect(w, () => false, 300);
    assert.deepEqual(paths(all), ["real.txt"]);
    assert.ok(w.dirs <= 3, `${w.dirs} directories watched (root, src, other)`);
  } finally { w.close(); rm(dir); }
});

test("an event path that is a symlink out of the workspace is dropped and counted", async () => {
  const dir = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-watch-out-"));
  const w = make(dir, ["src/**"]);
  try {
    w.reconcile();
    fs.writeFileSync(path.join(outside, "x.ts"), "x");
    fs.symlinkSync(path.join(outside, "x.ts"), path.join(dir, "src", "evil.ts"));
    fs.symlinkSync(outside, path.join(dir, "src", "evildir"));
    const all = await collect(w, (b) => b.some((x) => x.droppedEscape > 0));
    assert.ok(all.reduce((n, b) => n + b.droppedEscape, 0) >= 1);
    assert.deepEqual(paths(all), []);
    await collect(w, () => false, 200);
    w.reconcile();
    assert.ok(![...((w as any).watchers.keys() as Iterable<string>)].some((d) => d.includes("evildir")), "a symlinked directory is never walked");
  } finally { w.close(); rm(dir); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("pending events are bounded: a storm keeps at most maxPending paths and counts the rest", async () => {
  const dir = repo();
  const w = make(dir, ["src/**"], { maxPending: 20, debounceMs: 60_000 });
  try {
    w.reconcile();
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, "src", `f${i}.txt`), "x");
    await collect(w, () => false, 400);
    assert.ok(w.pendingCount() <= 20, `${w.pendingCount()} pending`);
    const batch = w.drain(Date.now() + 120_000)!;
    assert.ok(batch.paths.length <= 20);
    assert.ok(batch.droppedPending >= 100, `${batch.droppedPending} dropped`);
    assert.equal(w.drain(Date.now() + 240_000), undefined, "and the window is reset: nothing is replayed");
  } finally { w.close(); rm(dir); }
});

test("directories watched are bounded, by the watcher and by the shared budget, and the limit is reported", () => {
  const dir = repo();
  for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(dir, "src", `d${i}`));
  const own = make(dir, ["src/**"], { maxDirs: 4 });
  const budget = new DirBudget(6);
  const a = make(dir, ["src/**"], { budget });
  const b = make(dir, ["other/**"], { budget });
  try {
    own.reconcile();
    assert.equal(own.dirs, 4);
    assert.equal(own.truncated, true);
    assert.match(own.errors.join(), /limit 4/);
    a.reconcile();
    b.reconcile();
    assert.ok(a.dirs + b.dirs <= 6, `${a.dirs + b.dirs} directories across two watchers sharing a budget of 6`);
    assert.equal(b.dirs, 0, "the second watcher got none and says so");
    assert.match(b.errors.join(), /shared limit 6/);
    a.close();
    assert.equal(budget.take(), true, "closing returns the directories to the budget");
  } finally { own.close(); a.close(); b.close(); rm(dir); }
});

test("a watcher error (inotify limits) is kept and shown, not swallowed", () => {
  const dir = repo();
  const w = make(dir, ["src/**"], { watch: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } });
  try {
    w.reconcile();
    assert.equal(w.dirs, 0);
    assert.match(w.errors.join(), /ENOSPC/);
  } finally { w.close(); rm(dir); }
});

test("close() closes every watch: later changes produce nothing and the budget is whole again", async () => {
  const dir = repo();
  const budget = new DirBudget(10);
  const w = make(dir, ["src/**"], { budget });
  try {
    w.reconcile();
    assert.ok(w.dirs >= 1);
    w.close();
    assert.equal(w.dirs, 0);
    fs.writeFileSync(path.join(dir, "src", "late.ts"), "x");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(w.drain(Date.now() + 10_000), undefined);
    for (let i = 0; i < 10; i++) assert.equal(budget.take(), true);
  } finally { rm(dir); }
});

test("close() calls close on every underlying watch (no inotify watch is left open)", () => {
  const dir = repo();
  const opened: Array<{ dir: string; closed: boolean }> = [];
  const w = make(dir, ["src/**"], { watch: (d) => { const rec = { dir: d, closed: false }; opened.push(rec); return { close: () => { rec.closed = true; }, on: () => undefined } as any; } });
  try {
    w.reconcile();
    assert.ok(opened.length >= 1);
    w.close();
    assert.deepEqual(opened.filter((o) => !o.closed), []);
  } finally { rm(dir); }
});
