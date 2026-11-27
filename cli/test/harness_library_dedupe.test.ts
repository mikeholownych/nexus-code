import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessStore } from "../src/core/harness/store.js";
import { draftLibraryEntriesFromReport, retrieveRelevantLibraryEntries } from "../src/core/harness/library.js";

describe("harness library dedupe", () => {
  it("does not draft duplicate statements and retrieval dedupes normalized statements", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-lib-dedupe-"));
    const store = new HarnessStore({ rootDir: tmp });
    const report = {
      schemaVersion: 1, id: "hrep_1", runId: "hrun_1", baseHarnessId: "hbase_1", status: "READY_FOR_REVIEW", createdAt: new Date().toISOString(),
      changes: [{ componentPath: "SYSTEM.md", changeType: "modify", recommendation: "review", evidenceIds: ["e1"], risks: ["r1"] }],
      scorecard: [], applyInstructions: [], nonPromotable: [], noApplyWarning: "no", recommendedCandidateId: "hcand_1",
    } as any;
    const a = draftLibraryEntriesFromReport(store, report);
    const b = draftLibraryEntriesFromReport(store, report);
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    const now = new Date().toISOString();
    store.saveLibraryEntry({ schemaVersion: 1, id: "hlesson_dup", runId: "hrun_x", createdAt: now, updatedAt: now, status: "accepted", scope: { baseHarnessId: "hbase_1" }, statement: a[0].statement.toUpperCase(), evidenceIds: [], confidence: "high", recommendation: "review" } as any);
    const got = retrieveRelevantLibraryEntries(store, { baseHarnessId: "hbase_1", limit: 10 });
    const norms = got.map((e) => e.statement.toLowerCase().replace(/\s+/g, " ").trim());
    assert.equal(new Set(norms).size, norms.length);
  });
});
