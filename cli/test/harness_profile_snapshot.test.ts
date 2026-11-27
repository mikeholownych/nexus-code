import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessStore } from "../src/core/harness/store.js";
import { snapshotHarnessFromProfile } from "../src/core/harness/profile_snapshot.js";

describe("harness profile snapshot", () => {
  it("snapshots an explicit profile directory without mutating source", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-prof-"));
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "SYSTEM.md"), "profile system");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const manifest = await snapshotHarnessFromProfile({ profilePath: profile, store, id: "harn_profile" });
    assert.equal(manifest.source.kind, "profile");
    assert.equal(fs.readFileSync(path.join(profile, "SYSTEM.md"), "utf8"), "profile system");
    assert.ok(fs.existsSync(path.join(store.baseDir("harn_profile"), "tree", "SYSTEM.md")));
  });
});
