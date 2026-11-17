/**
 * CS-2: in verificationPaths mode "block" a shell command may not change verification files. Detection is by file
 * contents before and after the command, so it does not depend on recognising the command. Other modes stay record-only.
 */
import "./helpers/leak_guard.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RustCoreBridge } from "../src/tools.js";
import { diffVerificationSnapshots, VERIFICATION_CONFIG_PROTECTED, type VerificationFileState } from "../src/security.js";

let repo = "";
let bridges: RustCoreBridge[] = [];

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");

function bridge(mode: string): RustCoreBridge {
  write(".nexus-security.json", JSON.stringify({ verificationPaths: { mode } }));
  const b = new RustCoreBridge(repo);
  bridges.push(b);
  return b;
}
const run = (b: RustCoreBridge, command: string) => b.executeTool("run_command", { command });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shellguard-"));
  write("Makefile", "test:\n\tnode --test\n");
  write("package.json", JSON.stringify({ name: "x", scripts: { test: "node --test" }, dependencies: {} }, null, 2));
  write("src/app.js", "exports.x = 1;\n");
});
afterEach(async () => {
  for (const b of bridges.splice(0)) b.shutdown?.();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("mode block: a shell command cannot change how work is verified", () => {
  test("`sed -i` on the Makefile is reverted and refused, with the diff", async () => {
    const r = await run(bridge("block"), "sed -i 's/node --test/true/' Makefile");
    assert.equal(r.success, false);
    assert.equal(r.denialReason, VERIFICATION_CONFIG_PROTECTED);
    assert.match(r.error ?? "", /Makefile \(build\) modified, restored/);
    assert.match(r.error ?? "", /- \t?node --test/);
    assert.match(r.error ?? "", /\+ \t?true/);
    assert.equal(read("Makefile"), "test:\n\tnode --test\n", "the file is back as it was");
  });

  test("a command the parser would not recognise is caught too (a script rewriting package.json scripts)", async () => {
    const r = await run(bridge("block"), `node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.scripts.test='true';require('fs').writeFileSync(f,JSON.stringify(p))"`);
    assert.equal(r.denialReason, VERIFICATION_CONFIG_PROTECTED, r.error);
    assert.match(r.error ?? "", /package\.json \(package_scripts\) modified, restored/);
    assert.equal(JSON.parse(read("package.json")).scripts.test, "node --test");
  });

  test("a new CI file is removed and refused; a new runnable test file is free", async () => {
    const b = bridge("block");
    const ci = await run(b, "mkdir -p .github/workflows && echo 'on: push' > .github/workflows/ci.yml");
    assert.equal(ci.denialReason, VERIFICATION_CONFIG_PROTECTED);
    assert.match(ci.error ?? "", /\.github\/workflows\/ci\.yml \(ci\) added, restored/);
    assert.equal(fs.existsSync(path.join(repo, ".github/workflows/ci.yml")), false);
    const test = await run(b, "mkdir -p test && echo \"require('node:test')('a', () => {});\" > test/new.test.js");
    assert.equal(test.success, true, test.error);
    assert.equal(fs.existsSync(path.join(repo, "test/new.test.js")), true);
  });

  test("ordinary commands are unaffected, including a dependency bump in package.json (not a verification key)", async () => {
    const b = bridge("block");
    const plain = await run(b, "echo hello > src/out.txt && echo done");
    assert.equal(plain.success, true, plain.error);
    assert.match(plain.output, /done/);
    const dep = await run(b, `node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.dependencies.left='1.0.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"`);
    assert.equal(dep.success, true, dep.error);
    assert.equal(JSON.parse(read("package.json")).dependencies.left, "1.0.0");
  });

  test("a command that touches nothing returns exactly what it returns with the guard off (a non-zero exit included)", async () => {
    const guarded = await run(bridge("block"), "echo before; exit 3");
    const unguarded = await run(bridge("off"), "echo before; exit 3");
    assert.deepEqual({ success: guarded.success, error: guarded.error, denialReason: guarded.denialReason }, { success: unguarded.success, error: unguarded.error, denialReason: unguarded.denialReason });
    assert.match(guarded.output, /before/);
    assert.notEqual(guarded.denialReason, VERIFICATION_CONFIG_PROTECTED);
  });
});

describe("other modes stay record-only (decision D2): the command is not blocked and nothing is reverted", () => {
  for (const mode of ["approve", "record", "off"]) {
    test(`mode ${mode}: sed -i on the Makefile goes through`, async () => {
      const r = await run(bridge(mode), "sed -i 's/node --test/true/' Makefile");
      assert.equal(r.success, true, r.error);
      assert.match(read("Makefile"), /true/);
      assert.notEqual(r.denialReason, VERIFICATION_CONFIG_PROTECTED);
    });
  }
});

describe("the snapshot diff", () => {
  const state = (hash: string, text?: string): VerificationFileState => ({ hash, raw: text === undefined ? undefined : Buffer.from(text) });
  const classOf = (rel: string) => (rel.endsWith(".test.js") ? ("test_file" as const) : rel === "Makefile" ? ("build" as const) : undefined);

  test("modified, removed and added files are reported; unchanged and unclassified files are not; new test files are free", () => {
    const before = new Map([["Makefile", state("a", "x\n")], ["old.test.js", state("b", "t\n")], ["notes.md", state("c")]]);
    const after = new Map([["Makefile", state("z", "y\n")], ["new.test.js", state("d", "n\n")], ["notes.md", state("changed")]]);
    const changes = diffVerificationSnapshots(before, after, classOf);
    assert.deepEqual(changes.map((c) => [c.path, c.kind]), [["Makefile", "modified"], ["old.test.js", "removed"]]);
    assert.deepEqual(changes[0].diff, ["- x", "+ y"]);
  });

  test("a long change is summarised, not dumped", () => {
    const big = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const [change] = diffVerificationSnapshots(new Map([["Makefile", state("a", big)]]), new Map([["Makefile", state("b", `${big}\nextra`.replace(/line/g, "LINE"))]]), classOf);
    assert.ok(change.diff.length <= 25 && change.diff.at(-1)!.startsWith("... ("), change.diff.join("|"));
  });
});
