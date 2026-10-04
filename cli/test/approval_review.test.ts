import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvalReview, MAX_REVIEW_TEXT } from "../src/approval_review.js";

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-"));
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  return dir;
}

describe("approvalReview", () => {
  test("edit_file reviews the replaced snippet against the replacement", () => {
    const ws = workspace();
    assert.deepEqual(approvalReview("edit_file", { path: "a.ts", old_content: "let a = 1;", new_content: "let a = 2;" }, ws), {
      kind: "change",
      path: "a.ts",
      before: "let a = 1;",
      after: "let a = 2;",
      created: false,
      truncated: false,
    });
  });

  test("write_file to a new path is a created file with no current content", () => {
    const ws = workspace();
    assert.deepEqual(approvalReview("write_file", { path: "new.txt", content: "hi\n" }, ws), {
      kind: "change",
      path: "new.txt",
      before: null,
      after: "hi\n",
      created: true,
      truncated: false,
    });
  });

  test("write_file over an existing file reviews against its current content", () => {
    const ws = workspace();
    const review = approvalReview("write_file", { path: "base.txt", content: "changed\n" }, ws);
    assert.deepEqual(review, { kind: "change", path: "base.txt", before: "base\n", after: "changed\n", created: false, truncated: false });
  });

  test("current content outside the workspace is never read", () => {
    const ws = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "do not show\n");
    const rel = path.relative(ws, path.join(outside, "secret.txt"));
    const review = approvalReview("write_file", { path: rel, content: "x" }, ws);
    assert.equal(review.kind, "change");
    assert.equal((review as any).before, null);
    assert.equal((review as any).created, false);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.txt"));
    const viaLink = approvalReview("write_file", { path: "link.txt", content: "x" }, ws);
    assert.equal((viaLink as any).before, null);
    assert.equal(JSON.stringify(viaLink).includes("do not show"), false);
  });

  test("secrets are redacted and oversized text is capped", () => {
    const ws = workspace();
    const review = approvalReview("write_file", { path: "n.txt", content: `token=supersecretvalue1\n${"x".repeat(MAX_REVIEW_TEXT)}` }, ws) as any;
    assert.equal(JSON.stringify(review).includes("supersecretvalue1"), false);
    assert.equal(review.truncated, true);
    assert.equal(review.after.length, MAX_REVIEW_TEXT);
  });

  test("patch_file, run_command and other tools", () => {
    const ws = workspace();
    assert.deepEqual(approvalReview("patch_file", { path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }, ws), {
      kind: "patch",
      path: "a.ts",
      patch: "@@ -1 +1 @@\n-a\n+b",
      truncated: false,
    });
    assert.deepEqual(approvalReview("run_command", { command: "npm test -- --token=abcdefghijklmnop" }, ws), {
      kind: "command",
      command: "npm test -- --token=[REDACTED]",
    });
    assert.deepEqual(approvalReview("fetch_web", { url: "https://example.com" }, ws), {
      kind: "args",
      text: '{\n  "url": "https://example.com"\n}',
      truncated: false,
    });
  });
});
