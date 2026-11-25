/**
 * WP-131-08 / #800: `relative.startsWith("..")` treats a first segment like `..hid` as an escape.
 * Regression coverage for the shared helper and each call-site module that used the unsafe form.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { isPathStrictlyWithin, isPathWithin, pathEscapesRoot } from "../src/path_within.js";
import { ancestryProblem } from "../src/safe_fs.js";
import { isWorkspaceFile } from "../src/workspace_trust.js";
import { normalizeWorkspacePath, shellReadRequest } from "../src/core/observation_identity.js";
import { resolveWorktreePath, WorktreePathError } from "../src/worktrunk/paths.js";

function throwawayWorkspace(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-path-contain-"));
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("path_within helper (#800)", () => {
  test("..hid sibling-looking first segment is inside the root", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const hid = path.join(root, "..hid");
      assert.equal(isPathWithin(hid, root), true);
      assert.equal(isPathWithin(path.join(hid, "nexus", "x"), root), true);
      assert.equal(isPathStrictlyWithin(hid, root), true);
      assert.equal(pathEscapesRoot(hid, root), false);
    } finally {
      cleanup();
    }
  });

  test("real parent escape and absolute relative are outside", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      assert.equal(isPathWithin(root, root), true);
      assert.equal(isPathStrictlyWithin(root, root), false);
      assert.equal(isPathWithin(path.dirname(root), root), false);
      assert.equal(isPathWithin(path.join(root, "..", "other"), root), false);
      assert.equal(isPathWithin(`${root}-sibling`, root), false);
      assert.equal(pathEscapesRoot(path.join(root, "..", "other"), root), true);
    } finally {
      cleanup();
    }
  });
});

describe("safe_fs ancestryProblem (#800)", () => {
  test("..hid under root is accepted as inside (not 'is not inside')", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const target = path.join(root, "..hid", "token");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "x");
      assert.equal(ancestryProblem(root, target), undefined);
    } finally {
      cleanup();
    }
  });

  test("real escape still reported", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const outside = path.join(path.dirname(root), "outside-file");
      const msg = ancestryProblem(root, outside);
      assert.ok(msg && msg.includes("is not inside"));
    } finally {
      cleanup();
    }
  });
});

describe("workspace_trust isWorkspaceFile (#800)", () => {
  test("..hid path under workspace counts as a workspace file", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const file = path.join(root, "..hid", "mcp.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
      assert.equal(isWorkspaceFile(root, file), true);
    } finally {
      cleanup();
    }
  });

  test("sibling outside workspace is not a workspace file", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const sibling = `${root}-sibling`;
      fs.mkdirSync(sibling);
      const file = path.join(sibling, "mcp.json");
      fs.writeFileSync(file, "{}");
      assert.equal(isWorkspaceFile(root, file), false);
    } finally {
      cleanup();
    }
  });
});

describe("observation_identity normalizeWorkspacePath (#800)", () => {
  test("..hid/file normalizes instead of being treated as outside", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const rel = normalizeWorkspacePath(root, path.join(root, "..hid", "a.ts"));
      assert.equal(rel, "..hid/a.ts");
    } finally {
      cleanup();
    }
  });

  test("cd into ..hid still classifies a cat read", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      const dir = path.join(root, "..hid");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "hi\n");
      const req = shellReadRequest("cd ..hid && cat f.txt", root, root);
      assert.ok(req);
      assert.equal(req!.path, "..hid/f.txt");
      assert.equal(req!.form, "cat");
    } finally {
      cleanup();
    }
  });
});

describe("worktrunk resolveWorktreePath (#800)", () => {
  test("template path with ..hid segment under nexus layout is inside (not refused as escape)", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      // Simulate a repo with .nexus/worktrees; branch name that yields ..hid is unusual —
      // use an explicit template that places the worktree under allowedRoot/..hid/...
      const repoPath = root;
      fs.mkdirSync(path.join(repoPath, ".nexus", "worktrees"), { recursive: true });
      const resolved = resolveWorktreePath({
        repoPath,
        repo: "repo",
        owner: "owner",
        branch: "feature",
        layout: "nexus",
        template: path.join(repoPath, ".nexus", "worktrees", "..hid", "{branch}"),
      });
      assert.ok(resolved.path.includes(`${path.sep}..hid${path.sep}`));
    } finally {
      cleanup();
    }
  });

  test("path outside allowed root still refused", () => {
    const { root, cleanup } = throwawayWorkspace();
    try {
      fs.mkdirSync(path.join(root, ".nexus", "worktrees"), { recursive: true });
      assert.throws(
        () =>
          resolveWorktreePath({
            repoPath: root,
            repo: "repo",
            owner: "owner",
            branch: "feature",
            layout: "nexus",
            template: path.join(path.dirname(root), "outside-{branch}"),
          }),
        (err: unknown) => err instanceof WorktreePathError && /outside/.test(String(err)),
      );
    } finally {
      cleanup();
    }
  });
});
