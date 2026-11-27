import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessStore } from "../src/core/harness/store.js";
import { snapshotHarnessFromPath } from "../src/core/harness/snapshot.js";
import { gateCandidateTree } from "../src/core/harness/gate.js";

describe("harness gate", () => {
  it("fails policy weakening and secret material", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-gate-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base); fs.writeFileSync(path.join(base, "SYSTEM.md"), "safe");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const baseManifest = await snapshotHarnessFromPath({ sourcePath: base, store, id: "harn_base", sourceKind: "path", sourceRef: base });
    const cand = path.join(tmp, "cand");
    fs.mkdirSync(cand);
    fs.writeFileSync(path.join(cand, "SYSTEM.md"), "allowLiveProfileMutation: true\nNEXUS_GATEWAY_TOKEN=abc123\n");
    const result = await gateCandidateTree({ baseManifest, candidatePath: cand, policy: { allowLiveProfileMutation: false, allowRepoMutation: false, allowNetwork: false, redactSecrets: true, approvalModePinned: "pinned" } });
    assert.equal(result.status, "FAIL");
    assert.ok(result.findings.some((f) => f.code === "policy_weakening"));
    assert.ok(result.findings.some((f) => f.code === "secret_material"));
  });

  it("fails symlink escape", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-gate-"));
    const base = path.join(tmp, "base");
    fs.mkdirSync(base); fs.writeFileSync(path.join(base, "SYSTEM.md"), "safe");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const baseManifest = await snapshotHarnessFromPath({ sourcePath: base, store, id: "harn_base2", sourceKind: "path", sourceRef: base });
    const cand = path.join(tmp, "cand");
    const outside = path.join(tmp, "outside.txt");
    fs.mkdirSync(cand);
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(cand, "leak.txt"));
    const result = await gateCandidateTree({ baseManifest, candidatePath: cand, policy: { allowLiveProfileMutation: false, allowRepoMutation: false, allowNetwork: false, redactSecrets: true, approvalModePinned: "pinned" } });
    assert.equal(result.status, "FAIL");
    assert.ok(result.findings.some((f) => f.code === "symlink_escape"));
  });
});
