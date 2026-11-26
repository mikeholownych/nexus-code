import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import { setLibraryEntryStatus } from "../src/core/harness/library.js";

describe("harness library", () => {
  it("drafts entries from report and supports accept/reject without live mutation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-lib-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "SYSTEM.md"), "base"); fs.writeFileSync(path.join(base, "artifact.txt"), "ok");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "artifact.txt" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    await orch.run(run.id, { store, mock: true });
    const entries = store.listLibraryEntries();
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].status, "draft");
    const accepted = setLibraryEntryStatus(store, entries[0].id, "accepted");
    assert.equal(accepted.status, "accepted");
    const rejected = setLibraryEntryStatus(store, entries[0].id, "rejected");
    assert.equal(rejected.status, "rejected");
    // no live mutation: base still same
    assert.equal(fs.readFileSync(path.join(base, "SYSTEM.md"), "utf8"), "base");
  });
});
