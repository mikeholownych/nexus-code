import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessStore } from "../src/core/harness/store.js";
import { retrieveRelevantLibraryEntries } from "../src/core/harness/library.js";

describe("harness library retrieval", () => {
  it("prefers accepted/base-matching entries for advisory proposal context", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-lib-"));
    const store = new HarnessStore({ rootDir: tmp });
    const now = new Date().toISOString();
    store.saveLibraryEntry({ schemaVersion: 1, id: "hlesson_a", runId: "hrun_1", createdAt: now, updatedAt: now, status: "accepted", scope: { baseHarnessId: "hbase_1" }, statement: "A", evidenceIds: [], confidence: "high", recommendation: "review" } as any);
    store.saveLibraryEntry({ schemaVersion: 1, id: "hlesson_b", runId: "hrun_2", createdAt: now, updatedAt: now, status: "draft", scope: { baseHarnessId: "hbase_other" }, statement: "B", evidenceIds: [], confidence: "low", recommendation: "review" } as any);
    const got = retrieveRelevantLibraryEntries(store, { baseHarnessId: "hbase_1", limit: 5 });
    assert.equal(got[0].id, "hlesson_a");
  });
});
