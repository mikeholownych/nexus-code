import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HarnessStore } from "../src/core/harness/store.js";
import { gateCandidateTree } from "../src/core/harness/gate.js";
import { snapshotHarnessFromPath } from "../src/core/harness/snapshot.js";

describe("harness security boundaries", () => {
  it("gate fails on secret-like material and policy weakening", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-sec-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base); fs.writeFileSync(path.join(base, "SYSTEM.md"), "base");
    const store = new HarnessStore({ rootDir: path.join(tmp, "state") });
    const manifest = await snapshotHarnessFromPath({ sourcePath: base, store, id: "harn_sec", sourceKind: "path", sourceRef: base });
    const cand = path.join(tmp, "cand"); fs.mkdirSync(cand);
    fs.writeFileSync(path.join(cand, "SYSTEM.md"), "allowNetwork: true\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n");
    const gate = await gateCandidateTree({ baseManifest: manifest, candidatePath: cand, policy: { allowLiveProfileMutation: false, allowRepoMutation: false, allowNetwork: false, redactSecrets: true, approvalModePinned: "pinned" } });
    assert.equal(gate.status, "FAIL");
    assert.ok(gate.findings.some((f) => f.code === "policy_weakening"));
    assert.ok(gate.findings.some((f) => f.code === "secret_material"));
  });
});
