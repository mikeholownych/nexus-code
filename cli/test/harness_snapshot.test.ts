import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotHarnessFromPath } from "../src/core/harness/snapshot.js";
import { HarnessStore } from "../src/core/harness/store.js";

describe("harness snapshot", () => {
  it("snapshots a fixture directory into immutable base manifest", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-snap-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(path.join(base, "skills"), { recursive: true });
    fs.writeFileSync(path.join(base, "SYSTEM.md"), "system");
    fs.writeFileSync(path.join(base, "skills", "a.md"), "skill");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const manifest = await snapshotHarnessFromPath({ sourcePath: base, store, id: "harn_test", sourceKind: "path", sourceRef: base });
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.id, "harn_test");
    assert.ok(manifest.components.some((c) => c.path === "SYSTEM.md"));
    assert.ok(manifest.components.some((c) => c.path === "skills/a.md"));
    const loaded = store.loadBaseManifest("harn_test");
    assert.equal(loaded.id, "harn_test");
    // immutable tree copy exists
    assert.equal(fs.readFileSync(path.join(store.baseDir("harn_test"), "tree", "SYSTEM.md"), "utf8"), "system");
  });

  it("rejects symlink escaping base tree", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-snap-"));
    const base = path.join(tmp, "base");
    const outside = path.join(tmp, "outside.txt");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(base, "leak.txt"));
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    await assert.rejects(() => snapshotHarnessFromPath({ sourcePath: base, store, id: "harn_bad", sourceKind: "path", sourceRef: base }), /symlink|escape|outside/i);
  });
});
