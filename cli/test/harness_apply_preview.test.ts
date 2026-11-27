import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessOrchestrator } from "../src/core/harness/orchestrator.js";
import { HarnessStore } from "../src/core/harness/store.js";
import { buildApplyPreview } from "../src/core/harness/apply_preview.js";

describe("harness apply preview", () => {
  it("writes review-only preview artifacts without mutating live harness", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-preview-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "SYSTEM.md"), "base\n");
    const cand = path.join(tmp, "cand"); fs.mkdirSync(cand, { recursive: true });
    fs.writeFileSync(path.join(cand, "SYSTEM.md"), "improved\n");
    const suite = path.join(tmp, "suite.json");
    fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "s", cases: [{ id: "c1", description: "d", prompt: "p", expected: { artifactPath: "SYSTEM.md" } }] }));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const orch = new HarnessOrchestrator(store);
    const run = await orch.init({ taskSuitePath: suite, basePath: base, store });
    const done = await orch.run(run.id, { store, mock: true, candidatePaths: [cand] });
    const preview = buildApplyPreview(store, done.id);
    assert.ok(fs.existsSync(path.join(preview.previewDir, "preview.json")));
    assert.ok(fs.existsSync(path.join(preview.previewDir, "preview.md")));
    assert.match(fs.readFileSync(path.join(preview.previewDir, "preview.md"), "utf8"), /review-only/i);
  });
});
