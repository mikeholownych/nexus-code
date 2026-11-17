/** VC-1 / SI-5: operator-declared boundary rules checked on a candidate diff by deterministic analysis. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BoundaryRulesError, checkBoundaries, describeBoundaryReport, importsOnLine, parseBoundaryRules, parseDiffFiles, resolveImportTarget, type BoundaryRules } from "../src/core/boundary_rules.js";

/** A unified diff for one file: `added`/`removed` are the changed lines, `context` the unchanged lines around them. */
function diffOf(file: string, change: { added?: string[]; removed?: string[]; context?: string[]; status?: "modified" | "added" | "deleted" }): string {
  const added = change.added ?? [];
  const removed = change.removed ?? [];
  const context = change.context ?? [];
  const status = change.status ?? "modified";
  const oldCount = removed.length + context.length;
  const newCount = added.length + context.length;
  const header = [`diff --git a/${file} b/${file}`, `--- ${status === "added" ? "/dev/null" : `a/${file}`}`, `+++ ${status === "deleted" ? "/dev/null" : `b/${file}`}`, `@@ -${status === "added" ? 0 : 1},${oldCount} +${status === "deleted" ? 0 : 1},${newCount} @@`];
  return [...header, ...context.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n") + "\n";
}

const LAYERS: BoundaryRules = { imports: [{ name: "ui-not-db", from: ["src/ui/**"], deny: ["src/db/**", "pg"] }] };

describe("declaring rules", () => {
  test("valid rules parse; every error names its field; unknown keys are refused", () => {
    const rules = parseBoundaryRules({ imports: [{ name: "ui-not-db", from: ["src/ui/**"], deny: ["src/db/**"] }], protected: ["src/api/public.ts"], interfaces: ["src/api/**"], schemas: ["**/*.proto"], acyclic: ["src/**"] });
    assert.equal(rules.imports![0].name, "ui-not-db");
    const bad: Array<[unknown, RegExp]> = [
      [null, /boundaries: must be an object/],
      [{}, /declares no rule/],
      [{ surprise: 1 }, /boundaries\.surprise: unknown field/],
      [{ imports: [] }, /boundaries\.imports: must be a non-empty list/],
      [{ imports: [{ name: "x", from: ["a/**"] }] }, /boundaries\.imports\[0\]: needs deny, allow or both/],
      [{ imports: [{ name: "x", deny: ["a"] }] }, /boundaries\.imports\[0\]\.from: required/],
      [{ imports: [{ name: "x", from: ["a"], deny: ["../etc"] }] }, /boundaries\.imports\[0\]\.deny: "..\/etc" is not a repository-relative glob/],
      [{ imports: [{ name: "x", from: ["a"], deny: ["b"], extra: 1 }] }, /boundaries\.imports\[0\]\.extra: unknown field/],
      [{ protected: ["/abs"] }, /boundaries\.protected/],
      [{ acyclic: "src" }, /boundaries\.acyclic: must be a non-empty list/],
    ];
    for (const [raw, re] of bad) assert.throws(() => parseBoundaryRules(raw), (e: Error) => e instanceof BoundaryRulesError && re.test(e.message), JSON.stringify(raw));
  });
});

describe("reading a diff", () => {
  test("per-file added and removed lines, with status; content that looks like a header is content", () => {
    const diff = diffOf("src/a.ts", { added: ["--- not a header", "+++ nor this", "import x from './b';"], removed: ["-- a SQL comment"], context: ["keep"] }) + diffOf("src/new.ts", { status: "added", added: ["export const n = 1;"] }) + diffOf("src/old.ts", { status: "deleted", removed: ["export const o = 1;"] });
    const { files, unparsed } = parseDiffFiles(diff);
    assert.deepEqual(unparsed, []);
    assert.deepEqual(files.map((f) => [f.path, f.status]), [["src/a.ts", "modified"], ["src/new.ts", "added"], ["src/old.ts", "deleted"]]);
    assert.deepEqual(files[0].added, ["--- not a header", "+++ nor this", "import x from './b';"]);
    assert.deepEqual(files[0].removed, ["-- a SQL comment"]);
  });
});

describe("imports", () => {
  test("each language's import forms are read from an added line", () => {
    assert.deepEqual(importsOnLine(`import { a } from "../db/client";`, "js").map((r) => r.spec), ["../db/client"]);
    assert.deepEqual(importsOnLine(`export * from './x'`, "js").map((r) => r.spec), ["./x"]);
    assert.deepEqual(importsOnLine(`const pg = require("pg"); const b = await import('./lazy.js');`, "js").map((r) => r.spec), ["pg", "./lazy.js"]);
    assert.deepEqual(importsOnLine("import(name)", "js"), [{ spec: "", computed: true }]);
    assert.deepEqual(importsOnLine("import os, sys", "py").map((r) => r.spec), ["os", "sys"]);
    assert.deepEqual(importsOnLine("from ..db import client", "py").map((r) => r.spec), ["..db"]);
    assert.deepEqual(importsOnLine("pub use crate::db::client;", "rs").map((r) => r.spec), ["crate::db::client"]);
    assert.deepEqual(importsOnLine(`import foo "example.com/x/db"`, "go").map((r) => r.spec), ["example.com/x/db"]);
    assert.deepEqual(importsOnLine("const x = 1; // import nothing", "js"), []);
  });

  test("a relative import is resolved against the importing file; a bare one is kept as written", () => {
    assert.equal(resolveImportTarget("src/ui/a.ts", "../db/client.js", "js"), "src/db/client");
    assert.equal(resolveImportTarget("src/ui/a.ts", "./widgets/index", "js"), "src/ui/widgets");
    assert.equal(resolveImportTarget("src/ui/a.ts", "pg", "js"), "pg");
    assert.equal(resolveImportTarget("src/ui/a.py", "..db", "py"), "src/db");
  });
});

describe("the check", () => {
  test("rules absent means no check at all", () => {
    assert.equal(checkBoundaries(diffOf("src/ui/a.ts", { added: ["import x from '../db/c';"] }), undefined), undefined);
  });

  test("a denied import added by the diff is a violation, by relative path or by package", () => {
    const diff = diffOf("src/ui/a.ts", { added: ["import c from '../db/client';", "import pg from 'pg';", "import ok from './local';"] });
    const report = checkBoundaries(diff, LAYERS)!;
    assert.deepEqual(report.violations.map((v) => [v.rule, v.path, v.detail]), [
      ["ui-not-db", "src/ui/a.ts", "imports src/db/client, which this rule denies"],
      ["ui-not-db", "src/ui/a.ts", "imports pg, which this rule denies"],
    ]);
    assert.equal(report.advisories.length, 0);
  });

  test("only added lines count: a denied import in context, or one the diff removes, is not a violation; another layer's file is not subject to the rule", () => {
    const quiet = diffOf("src/ui/a.ts", { context: ["import c from '../db/client';"], removed: ["import pg from 'pg';"], added: ["const x = 1;"] }) + diffOf("src/server/b.ts", { added: ["import c from '../db/client';"] });
    assert.deepEqual(checkBoundaries(quiet, LAYERS)!.violations, []);
  });

  test("an allow-list makes an import outside it an advisory, not a rejection; Node built-ins are always fine", () => {
    const rules: BoundaryRules = { imports: [{ name: "ui-deps", from: ["src/ui/**"], allow: ["src/ui/**", "react"] }] };
    const report = checkBoundaries(diffOf("src/ui/a.ts", { added: ["import r from 'react';", "import l from 'left-pad';", "import f from 'node:fs';", "import s from './sibling';"] }), rules)!;
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.advisories.map((a) => a.detail), ["imports left-pad, outside the declared allow-list (an undeclared dependency)"]);
  });

  test("a protected public file needs the operator's authorisation", () => {
    const rules: BoundaryRules = { protected: ["src/api/public.ts", "docs/openapi.yaml"] };
    const diff = diffOf("src/api/public.ts", { added: ["export const v = 2;"] }) + diffOf("src/other.ts", { added: ["x"] });
    assert.deepEqual(checkBoundaries(diff, rules)!.violations.map((v) => [v.rule, v.path]), [["protected", "src/api/public.ts"]]);
    assert.deepEqual(checkBoundaries(diff, rules, { authorizedScope: ["src/api"] })!.violations, []);
    assert.deepEqual(checkBoundaries(diff, rules, { authorizedScope: ["src/other.ts"] })!.violations.length, 1, "authorising another path does not authorise this one");
  });

  test("changes that are each fine but together close an import cycle are found in the cumulative diff, and in neither alone", () => {
    const rules: BoundaryRules = { acyclic: ["src/**"] };
    const first = diffOf("src/a.ts", { added: ["import { b } from './b';"] });
    const second = diffOf("src/b.ts", { added: ["import { a } from './a';"] });
    assert.deepEqual(checkBoundaries(first, rules)!.violations, []);
    assert.deepEqual(checkBoundaries(second, rules)!.violations, []);
    const together = checkBoundaries(first + second, rules)!;
    assert.deepEqual(together.violations.map((v) => [v.rule, v.detail]), [["acyclic", "import cycle among the diff's imports: src/a -> src/b -> src/a"]]);
  });

  test("a hostile diff cannot hide an import: a removed line that reads like a header does not end the file", () => {
    const hostile = ["diff --git a/src/ui/a.ts b/src/ui/a.ts", "--- a/src/ui/a.ts", "+++ b/src/ui/a.ts", "@@ -1,2 +1,2 @@", "--- a/src/ui/fake.ts", "+++ b/src/ui/fake.ts", "+import c from '../db/client';", ""].join("\n");
    assert.equal(checkBoundaries(hostile, LAYERS)!.violations.length, 1);
  });
});

describe("classifying interface and schema changes", () => {
  const rules: BoundaryRules = { interfaces: ["src/api/**"], schemas: ["schema/**", "migrations/**"] };
  const one = (file: string, change: Parameters<typeof diffOf>[1]) => checkBoundaries(diffOf(file, change), rules)!;

  test("a removed or changed export is potentially breaking; an added one is compatible", () => {
    const removed = one("src/api/a.ts", { removed: ["export function parse(a: string): number {"], added: [] });
    assert.deepEqual(removed.classifications.map((c) => c.class), ["potentially_breaking"]);
    assert.match(removed.advisories[0].detail, /public declaration\(s\) removed: parse/);
    const changed = one("src/api/a.ts", { removed: ["export function parse(a: string): number {"], added: ["export function parse(a: string, b: number): number {"] });
    assert.match(changed.advisories[0].detail, /public declaration\(s\) changed: parse/);
    const added = one("src/api/a.ts", { added: ["export function extra(): void {}"] });
    assert.equal(added.classifications[0].class, "compatible");
    assert.deepEqual(added.advisories, []);
  });

  test("the same reading for Rust, Go and Python public declarations", () => {
    assert.equal(one("src/api/a.rs", { removed: ["pub fn old() {}"] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("src/api/a.go", { removed: ["func Old() {}"] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("src/api/a.py", { removed: ["def old():"] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("src/api/a.py", { removed: ["def _private():"] }).classifications[0].class, "compatible", "a leading underscore is not public");
  });

  test("deleting an interface or schema file is potentially breaking", () => {
    assert.equal(one("src/api/a.ts", { status: "deleted", removed: ["export const a = 1;"] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("schema/user.json", { status: "deleted", removed: ["{}"] }).classifications[0].class, "potentially_breaking");
  });

  test("schemas: a removed key, a dropped column or a removed proto field is potentially breaking; additions are compatible; unreadable changes are unknown, never guessed", () => {
    assert.equal(one("schema/user.json", { removed: ['  "email": { "type": "string" },'] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("schema/user.json", { added: ['  "nick": { "type": "string" },'] }).classifications[0].class, "compatible");
    assert.equal(one("migrations/002.sql", { added: ["ALTER TABLE users DROP COLUMN email;"] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("migrations/003.sql", { added: ["ALTER TABLE users ADD COLUMN nick text;"] }).classifications[0].class, "compatible");
    assert.equal(one("schema/user.proto", { removed: ["  string email = 2;"] }).classifications[0].class, "potentially_breaking");
    assert.equal(one("schema/user.proto", { added: ["  string nick = 3;"] }).classifications[0].class, "compatible");
    const unknown = one("schema/data.bin", { removed: ["x"] });
    assert.equal(unknown.classifications[0].class, "unknown");
    assert.match(unknown.advisories[0].detail, /could not be classified/);
  });
});

describe("coverage is always reported", () => {
  test("the standing limits are in every report; skipped files, hidden sections and computed imports are named", () => {
    const diff = diffOf("README.md", { added: ["x"] }) + diffOf("src/ui/a.ts", { added: ["const m = import(name);"] }) + "[2 protected file section(s) omitted]\n";
    const report = checkBoundaries(diff, LAYERS)!;
    assert.equal(report.coverage.filesInDiff, 2);
    assert.deepEqual(report.coverage.skipped, [{ path: "README.md", reason: "file type is not analysed for imports" }]);
    assert.ok(report.coverage.limits.some((l) => /path aliases, re-exports and computed imports are not resolved/.test(l)));
    assert.ok(report.coverage.limits.some((l) => /Not analysed \(hidden from this diff\): 2 protected file section\(s\) omitted/.test(l)));
    assert.ok(report.coverage.limits.some((l) => /Computed dynamic imports \(not resolvable\) in: src\/ui\/a\.ts/.test(l)));
    assert.ok(checkBoundaries(diffOf("src/x.ts", { added: ["x"] }), LAYERS)!.coverage.limits.length >= 5);
  });

  test("a file header the check cannot read is a violation: it cannot vouch for what it cannot see", () => {
    const report = checkBoundaries('diff --git "a/bad\n--- a/x\n+++ b/x\n', LAYERS)!;
    assert.ok(report.violations.some((v) => v.rule === "diff"), JSON.stringify(report.violations));
  });

  test("findings render one per line, violations first", () => {
    const report = checkBoundaries(diffOf("src/ui/a.ts", { added: ["import c from '../db/client';"] }), { ...LAYERS, interfaces: ["src/ui/**"] })!;
    const lines = describeBoundaryReport(report);
    assert.match(lines[0], /^VIOLATION \[ui-not-db\] src\/ui\/a\.ts:/);
  });
});
