/**
 * Operation lifecycle entry is decided under the driver lock.
 *
 * - `run` over an id that already has a durable record is refused: it never overwrites that history.
 * - `resume`/`decide` re-read the record after the lock is held, so a snapshot loaded before another driver finished
 *   cannot be written back over that driver's COMPLETE result.
 *
 * Provenance: audit 2026-11-17 (operation_cli.ts loaded state, then driveOperation acquired the lock).
 */
import "./helpers/leak_guard.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newOperation } from "../src/core/operation.js";
import { driveOperation, OperationExistsError, OperationStore, type WorkUnitExecutor } from "../src/core/operation_runner.js";

const resource = { id: "r1", provider: "http://127.0.0.1:9", endpoint: "http://127.0.0.1:9/v1", model: "m", capabilities: ["tools"], rank: 0 };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-entry-"));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace);
  const store = new OperationStore(workspace, path.join(root, "state"), root);
  const ran: string[] = [];
  const executor: WorkUnitExecutor = {
    async run(unit) {
      ran.push(unit.id);
      return { kind: "completed", summary: "ok", outcome: "NOT_REQUIRED" };
    },
  };
  const fresh = (id: string) => newOperation(id, "objective", [{ id: "u1", title: "u1", prompt: "u1" }], [resource], Date.now(), {});
  return { root, store, executor, ran, fresh };
}

describe("operation entry under the driver lock", () => {
  test("starting over an existing id is refused and the stored record is untouched", async (t) => {
    const { root, store, executor, ran, fresh } = setup();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = await driveOperation(fresh("op-dup"), { store, executor, entry: "new" });
    assert.equal(first.status, "COMPLETE");
    const before = JSON.stringify(store.load("op-dup"));
    ran.length = 0;
    await assert.rejects(driveOperation(fresh("op-dup"), { store, executor, entry: "new" }), OperationExistsError);
    assert.deepEqual(ran, [], "no unit may run for a refused start");
    assert.equal(JSON.stringify(store.load("op-dup")), before);
  });

  test("a stale snapshot loaded before another driver finished is not written back over COMPLETE", async (t) => {
    const { root, store, executor, ran, fresh } = setup();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    store.save(fresh("op-stale"));
    const stale = store.load("op-stale"); // loaded while nothing is running yet
    await driveOperation(store.load("op-stale"), { store, executor, entry: "existing" }); // another driver finishes it
    assert.equal(store.load("op-stale").status, "COMPLETE");
    ran.length = 0;
    const out = await driveOperation(stale, { store, executor, entry: "existing" });
    assert.equal(out.status, "COMPLETE");
    assert.deepEqual(ran, [], "the finished unit must not run again from a stale snapshot");
    assert.equal(store.load("op-stale").status, "COMPLETE");
  });

  test("prepare runs on the fresh record", async (t) => {
    const { root, store, executor, fresh } = setup();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    store.save(fresh("op-prep"));
    let seen: string | undefined;
    await driveOperation(store.load("op-prep"), { store, executor, entry: "existing", prepare: (s) => { seen = s.status; } });
    assert.ok(seen, "prepare received the freshly loaded record");
  });
});
