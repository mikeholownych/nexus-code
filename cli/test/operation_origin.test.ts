/**
 * BG-1 / G-4 (the unattended flag): an operation driven by a detached job carries `origin`, and the operation
 * document version is 8. Older records are upgraded as before without inventing an origin, and a damaged stamp is
 * refused.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newOperation, type DurableOperationState } from "../src/core/operation.js";
import { OperationStore } from "../src/core/operation_runner_persistence.js";
import { CURRENT_OPERATION_SCHEMA_VERSION, InvalidOperationStateError, migrateOperationState, UnsupportedOperationSchemaError, validateOperationState } from "../src/core/operation_schema.js";

const state = (): DurableOperationState => newOperation("op-origin", "objective", [{ id: "u", title: "u", prompt: "p" }], [], Date.parse("2026-11-24T10:00:00.000Z"));

test("the operation document is version 11 and an attended operation has no origin", () => {
  assert.equal(CURRENT_OPERATION_SCHEMA_VERSION, 11);
  const attended = state();
  assert.equal(attended.schemaVersion, 11);
  assert.equal("origin" in attended, false);
  assert.doesNotThrow(() => validateOperationState(attended));
});

test("a job origin survives a save and load, and a damaged one is refused", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-op-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const store = new OperationStore(workspace, path.join(root, "state"), root);
  const job = state();
  job.origin = { kind: "job", jobId: "job-0123456789ab", unattended: true };
  store.save(job);
  assert.deepEqual(store.load("op-origin").origin, { kind: "job", jobId: "job-0123456789ab", unattended: true });
  const scheduled = { ...state(), origin: { kind: "job" as const, jobId: "job-0123456789ab", scheduleId: "nightly-lint", unattended: true as const } };
  assert.doesNotThrow(() => validateOperationState(scheduled));

  for (const bad of [
    { kind: "job", jobId: "job-0123456789ab", unattended: false },
    { kind: "job", jobId: "job-0123456789ab" },
    { kind: "cli", jobId: "job-0123456789ab", unattended: true },
    { kind: "job", jobId: "", unattended: true },
    { kind: "job", jobId: "job-0123456789ab", unattended: true, approved: "always" },
    { kind: "job", jobId: "job-0123456789ab", unattended: true, scheduleId: 7 },
    "job",
    null,
    [],
  ]) {
    assert.throws(() => validateOperationState({ ...state(), origin: bad as any }), (e) => e instanceof InvalidOperationStateError && /origin is not a valid job origin/.test(e.message), JSON.stringify(bad));
  }
});

test("a version 4 record is migrated to the current schema, and a record from a newer build is refused, not read", () => {
  const v4 = { ...state(), schemaVersion: 4 };
  const migrated = migrateOperationState(JSON.parse(JSON.stringify(v4)));
  assert.equal(migrated.schemaVersion, CURRENT_OPERATION_SCHEMA_VERSION);
  assert.deepEqual({ ...migrated, schemaVersion: 4 }, JSON.parse(JSON.stringify(v4)), "the migration preserves existing fields");
  assert.equal(migrated.origin, undefined, "an older record is never stamped after the fact");
  // A build at the previous supported version refuses this record instead of rewriting it.
  assert.throws(() => migrateOperationState({ ...state(), schemaVersion: CURRENT_OPERATION_SCHEMA_VERSION + 1 }), UnsupportedOperationSchemaError);
});
