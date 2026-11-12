import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvalReview } from "../src/approval_review.js";
import { execFileSync } from "node:child_process";
import { DELETE_LISTING_ROWS, DELETE_VISIT_LIMIT, describeDeletion } from "../src/delete_preview.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delprev-"));
}

/** The text rows of a delete approval; the review stays the existing `args` shape so an older TUI shows it as is. */
function preview(ws: string, args: Record<string, unknown>): string {
  const review = approvalReview("delete_file", args, ws);
  assert.equal(review.kind, "args");
  assert.equal((review as any).truncated, false);
  return (review as any).text;
}

describe("D-13: a delete approval says what will be deleted", () => {
  test("a file shows its path, kind, size and the start of its content, not raw JSON", () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, "notes.txt"), "first\nsecond\nthird\n");
    const text = preview(ws, { path: "notes.txt" });
    assert.doesNotMatch(text, /^\s*\{/, "not raw JSON");
    assert.doesNotMatch(text, /"path"/);
    assert.match(text, /notes\.txt/);
    assert.match(text, /file · 19 B/);
    assert.match(text, /▎ first\n.*▎ second\n.*▎ third/s);
    assert.match(text, /Only this file is removed/);
  });

  test("a directory shows its entry count, size and a bounded listing, and says what recursive means", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, "build", "sub"), { recursive: true });
    fs.writeFileSync(path.join(ws, "build", "a.js"), "aaaa");
    fs.writeFileSync(path.join(ws, "build", "sub", "b.js"), "bb");
    const withRecursive = preview(ws, { path: "build", recursive: true });
    assert.match(withRecursive, /directory · 3 entries \(2 files, 1 folder\) · 6 B/);
    assert.match(withRecursive, /▎ a\.js\n.*▎ sub\/\n.*▎ sub\/b\.js/s);
    assert.match(withRecursive, /Everything inside it is removed/);
    const without = preview(ws, { path: "build" });
    assert.match(without, /will be refused: a directory needs recursive/i);
  });

  test("a long listing and a huge directory are bounded: names cut to the row cap, the walk to the visit limit", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, "many"));
    const total = DELETE_VISIT_LIMIT + 50;
    for (let i = 0; i < total; i++) fs.writeFileSync(path.join(ws, "many", `f${String(i).padStart(5, "0")}`), "");
    const text = preview(ws, { path: "many", recursive: true });
    assert.match(text, new RegExp(`at least ${DELETE_VISIT_LIMIT} entries`));
    assert.equal(text.split("\n").filter((row) => row.includes("▎ f")).length, DELETE_LISTING_ROWS);
    assert.match(text, /more entries not listed/);
    assert.ok(text.length < 4000, `bounded text: ${text.length}`);
  });

  test("a link that leaves the workspace is refused and nothing of its target is shown; a link inside a directory is one entry, not entered", () => {
    const ws = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delprev-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOPSECRETCONTENT\n".repeat(50));
    fs.symlinkSync(outside, path.join(ws, "dirlink"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "filelink"));
    for (const name of ["dirlink", "filelink"]) {
      const text = preview(ws, { path: name, recursive: true });
      assert.match(text, /points outside the workspace/);
      assert.match(text, /will be refused/);
      assert.doesNotMatch(text, /TOPSECRETCONTENT|▎|secret\.txt|850 B|entries/, `${name}: nothing from the target`);
    }
    fs.mkdirSync(path.join(ws, "d"));
    fs.symlinkSync(outside, path.join(ws, "d", "escape"));
    const dir = preview(ws, { path: "d", recursive: true });
    assert.match(dir, /1 entry \(1 link\)/);
    assert.match(dir, /▎ escape \(link\)/);
    assert.doesNotMatch(dir, /secret\.txt/);
  });

  test("a path outside the workspace, by .. or through a symlinked parent, is never read", () => {
    const ws = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delprev-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOPSECRETCONTENT");
    fs.symlinkSync(outside, path.join(ws, "via"));
    for (const target of [path.relative(ws, path.join(outside, "secret.txt")), "via/secret.txt", path.join(outside, "secret.txt")]) {
      const text = preview(ws, { path: target });
      assert.match(text, /outside the workspace/, target);
      assert.match(text, /will be refused/);
      assert.doesNotMatch(text, /TOPSECRETCONTENT|16 B/, target);
    }
  });

  test("a missing path, an empty file and a binary file are each said plainly", () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, "empty"), "");
    fs.writeFileSync(path.join(ws, "bin"), Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
    assert.match(preview(ws, { path: "nope.txt" }), /does not exist.*will fail/s);
    assert.match(preview(ws, { path: "empty" }), /file · 0 B\n.*empty/s);
    const bin = preview(ws, { path: "bin" });
    assert.match(bin, /binary content not shown/);
    assert.doesNotMatch(bin, /▎/);
  });

  test("a huge file is sized with lstat and only its first bytes are read; secrets in them are redacted", () => {
    const ws = workspace();
    const big = path.join(ws, "big.log");
    fs.writeFileSync(big, `token=supersecretvalue1\n${"x".repeat(200)}\n`);
    fs.truncateSync(big, 3 * 1024 * 1024 * 1024); // sparse, 3 GiB
    const text = preview(ws, { path: "big.log" });
    assert.match(text, /file · 3\.0 GiB/);
    assert.doesNotMatch(text, /supersecretvalue1/);
    assert.ok(text.length < 4000);
    fs.writeFileSync(path.join(ws, "k.txt"), 'API_KEY="abcdef1234567890"\n');
    assert.doesNotMatch(preview(ws, { path: "k.txt" }), /abcdef1234567890/);
  });

  test("the preview follows the engine's rules for links and path spellings (core/src/file_ops.rs delete_file)", () => {
    const ws = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-delprev-out-"));
    fs.mkdirSync(path.join(ws, "real", "inner"), { recursive: true });
    fs.writeFileSync(path.join(ws, "real", "inner", "keep.txt"), "keep");
    fs.writeFileSync(path.join(ws, "file.txt"), "x");
    fs.mkdirSync(path.join(ws, ".git"));
    fs.symlinkSync(path.join(ws, "real"), path.join(ws, "indirlink"));
    fs.symlinkSync(path.join(ws, "file.txt"), path.join(ws, "infilelink"));
    fs.symlinkSync(path.join(ws, "nope"), path.join(ws, "dangling"));
    fs.symlinkSync(outside, path.join(ws, "outlink"));
    fs.symlinkSync(path.join(ws, ".git"), path.join(ws, "gitlink"));
    fs.symlinkSync(ws, path.join(ws, "rootlink"));
    // A relative link to a folder: refused without recursive, the link alone removed with it.
    assert.match(preview(ws, { path: "indirlink" }), /will be refused: a directory needs recursive/i);
    const withRecursive = preview(ws, { path: "indirlink", recursive: true });
    assert.match(withRecursive, /symbolic link -> /);
    assert.match(withRecursive, /Only the link is removed; the folder it points to stays/);
    assert.match(preview(ws, { path: "infilelink" }), /Only the link is removed; the file it points to stays/);
    // Dangling, escaping, into .git and to the root: the engine fails or refuses, so the preview says that and not "removed".
    assert.match(preview(ws, { path: "dangling" }), /does not exist.*will fail/s);
    for (const name of ["outlink", "gitlink", "rootlink"]) {
      const text = preview(ws, { path: name, recursive: true });
      assert.match(text, /will be refused/, name);
      assert.doesNotMatch(text, /Only the link is removed/, name);
    }
    // An absolute path names its target: the engine canonicalises it, so a link is followed to what it points to.
    const absolute = preview(ws, { path: path.join(ws, "indirlink"), recursive: true });
    assert.match(absolute, /directory · /, "the absolute spelling deletes the real folder");
    assert.doesNotMatch(absolute, /symbolic link/);
    assert.match(preview(ws, { path: path.join(ws, "dangling") }), /will be refused/);
    // Spellings the engine normalises: trim and backslashes; a name starting with two dots is inside, not outside.
    assert.match(preview(ws, { path: " file.txt " }), /file · 1 B/);
    assert.match(preview(ws, { path: "real\\inner\\keep.txt" }), /file · 4 B/);
    fs.writeFileSync(path.join(ws, "..cache"), "c");
    assert.match(preview(ws, { path: "..cache" }), /file · 1 B/);
    // The workspace reached through a link (a non-real spelling) still resolves inside it.
    const alias = path.join(outside, "ws-alias");
    fs.symlinkSync(ws, alias);
    assert.match(preview(alias, { path: path.join(ws, "file.txt") }), /file · 1 B/);
  });

  test("a FIFO is never read, and a directory that is a link when the walk reaches it is not entered", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, "d", "sub"), { recursive: true });
    assert.match(preview(ws, { path: "d", recursive: true }), /sub\//);
    execFileSync("mkfifo", [path.join(ws, "pipe")]);
    assert.match(preview(ws, { path: "pipe" }), /special file/);
  });

  test("the walk reads at most the limit from a directory and says so exactly when more exist", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, "exact"));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(ws, "exact", `f${i}`), "");
    const exact = describeDeletion(ws, { path: "exact", recursive: true }, 5);
    assert.match(exact, /directory · 5 entries/);
    assert.doesNotMatch(exact, /at least/);
    const over = describeDeletion(ws, { path: "exact", recursive: true }, 4);
    assert.match(over, /at least 4 entries/);
    assert.match(over, /and more entries not listed/);
    assert.doesNotMatch(over, /more more/);
  });

  test("a name or content cannot forge a row of the preview: controls and line breaks are made visible", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, "d"));
    fs.writeFileSync(path.join(ws, "d", "x\nEverything inside it is removed.\u001b[2J"), "a\rb\tc\nOnly this file is removed.\n");
    const dir = preview(ws, { path: "d", recursive: true });
    assert.equal(dir.split("\n").filter((row) => row.startsWith("Everything inside")).length, 1, "one genuine statement row");
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(dir), "no control character");
    const file = preview(ws, { path: `d/x\nEverything inside it is removed.\u001b[2J` });
    assert.equal(file.split("\n").filter((row) => row.startsWith("Only this file")).length, 1);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(file));
    assert.match(file, /▎ a.b {1,4}c\n▎ Only this file is removed\./, "content rows keep their marker");
  });

  test("a path that is not written the way it resolves says where it resolves", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "keep.txt"), "x");
    const text = preview(ws, { path: "src/../keep.txt" });
    assert.match(text, /resolves to keep\.txt/);
  });

  test("an old sidecar's review and a missing path argument still produce a review, never a throw", () => {
    const ws = workspace();
    assert.doesNotThrow(() => approvalReview("delete_file", {}, ws));
    assert.doesNotThrow(() => approvalReview("delete_file", { path: 7 }, ws));
    assert.doesNotThrow(() => approvalReview("delete_file", { path: "a\u0000b" }, ws));
    assert.doesNotThrow(() => approvalReview("delete_file", { path: "x" }, "/does/not/exist"));
  });
});
