import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getProjectRules } from "../src/git.js";
import { MAX_IMPORT_DEPTH } from "../src/project_rules.js";

function ws(files: Record<string, string>): { dir: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));
  const dir = path.join(base, "ws");
  const outside = path.join(base, "outside");
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return { dir, outside };
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

test("an import of AGENTS.md from CLAUDE.md loads the content once and lists the file", () => {
  // AGENTS.md is blank, so CLAUDE.md is the file loaded; it imports AGENTS.md twice.
  const { dir } = ws({ "AGENTS.md": "   \n", "CLAUDE.md": "Head\n@AGENTS.md\nmid @AGENTS.md\n" });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "   \n");
  const rules = getProjectRules(dir, { trusted: true }) ?? "";
  assert.match(rules, /loaded from CLAUDE\.md; imports: AGENTS\.md\)/);
  assert.equal(count(rules, "@AGENTS.md"), 0);
});

test("a shared import is read once", () => {
  const { dir } = ws({ "AGENTS.md": "@docs/a.md and @docs/a.md again", "docs/a.md": "UNIQUE-MARK" });
  const rules = getProjectRules(dir, { trusted: true }) ?? "";
  assert.equal(count(rules, "UNIQUE-MARK"), 1);
  assert.match(rules, /imports: docs\/a\.md\)/);
});

test("an import outside the workspace is not read, by path or by symlink", () => {
  const { dir, outside } = ws({ "AGENTS.md": "@../outside/secret.md\n@link.md\n" });
  fs.writeFileSync(path.join(outside, "secret.md"), "SECRET-OUT");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "link.md"));
  const rules = getProjectRules(dir, { trusted: true }) ?? "";
  assert.doesNotMatch(rules, /SECRET-OUT/);
  assert.match(rules, /@\.\.\/outside\/secret\.md/);
  assert.doesNotMatch(rules, /imports:/);
});

test("an untrusted workspace expands nothing", () => {
  const { dir } = ws({ "AGENTS.md": "@docs/a.md", "docs/a.md": "UNIQUE-MARK" });
  const rules = getProjectRules(dir, { trusted: false }) ?? "";
  assert.doesNotMatch(rules, /UNIQUE-MARK/);
  assert.match(rules, /@docs\/a\.md/);
});

test("a cycle terminates with each file once", () => {
  const { dir } = ws({ "AGENTS.md": "root @a.md", "a.md": "A @b.md", "b.md": "B @a.md @AGENTS.md" });
  const rules = getProjectRules(dir, { trusted: true }) ?? "";
  assert.match(rules, /\nroot A B$/);
  assert.match(rules, /imports: a\.md, b\.md\)/);
});

test("imports stop at the depth bound", () => {
  const files: Record<string, string> = { "AGENTS.md": "L0 @f1.md" };
  for (let i = 1; i <= MAX_IMPORT_DEPTH + 2; i++) files[`f${i}.md`] = `L${i} @f${i + 1}.md`;
  const { dir } = ws(files);
  const rules = getProjectRules(dir, { trusted: true }) ?? "";
  assert.match(rules, new RegExp(`L${MAX_IMPORT_DEPTH}\\b`));
  assert.doesNotMatch(rules, new RegExp(`L${MAX_IMPORT_DEPTH + 1}\\b`));
  assert.match(rules, new RegExp(`@f${MAX_IMPORT_DEPTH + 1}\\.md`));
});

test("code spans and fences are not imports; @mentions and missing files stay literal", () => {
  const { dir } = ws({ "AGENTS.md": "use `@a.md` and @someone and @nope.md\n```\n@a.md\n```\n", "a.md": "UNIQUE-MARK" });
  const rules = getProjectRules(dir, { trusted: true }) ?? "";
  assert.doesNotMatch(rules, /UNIQUE-MARK/);
  assert.match(rules, /@someone and @nope\.md/);
});

test("a long run of @ characters is handled in linear time", () => {
  const { dir } = ws({ "AGENTS.md": "@".repeat(200000) + "\n" + "@a".repeat(50000) });
  const t = Date.now();
  getProjectRules(dir, { trusted: true });
  assert.ok(Date.now() - t < 2000);
});
