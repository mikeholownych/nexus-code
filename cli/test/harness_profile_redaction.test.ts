import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessStore } from "../src/core/harness/store.js";
import { snapshotHarnessFromProfile } from "../src/core/harness/profile_snapshot.js";

describe("harness profile snapshot redaction", () => {
  it("redacts secret-like files and preserves non-secret files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-prof-redact-"));
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "SYSTEM.md"), "safe");
    fs.writeFileSync(path.join(profile, "config.env"), "NEXUS_GATEWAY_TOKEN=secret\n");
    fs.writeFileSync(path.join(profile, "notes.txt"), "api=sk-abcdefghijklmnopqrstuvwxyz1234567890");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const manifest = await snapshotHarnessFromProfile({ profilePath: profile, store, id: "harn_prof_redact" });
    const tree = path.join(store.baseDir(manifest.id), "tree");
    assert.equal(fs.readFileSync(path.join(tree, "SYSTEM.md"), "utf8"), "safe");
    assert.match(fs.readFileSync(path.join(tree, "config.env"), "utf8"), /REDACTED/);
    assert.match(fs.readFileSync(path.join(tree, "notes.txt"), "utf8"), /REDACTED/);
  });
});
