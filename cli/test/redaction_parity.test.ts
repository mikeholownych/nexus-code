/**
 * MT-3: one pattern table, two redactors. cli/src/redaction_patterns.json is the source of the TypeScript redactor and is
 * mirrored by core/src/bin/nexus_tui/redact.rs. These tests fail when either side adds, drops or edits a pattern without
 * the other, and run the same corpus through TypeScript here and through Rust (`cargo test`, same corpus file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecretPatterns } from "../src/ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => fs.readFileSync(path.resolve(here, ...p), "utf8");

interface Rule { name: string; scope: "all" | "multiline"; pattern: string; flags: string; replacement: string }
const table = JSON.parse(read("../src/redaction_patterns.json")) as { rules: Rule[] };
const corpus = JSON.parse(read("fixtures/redaction_corpus.json")) as { cases: Array<{ name: string; input: string; expected: string; multiline?: boolean }> };
const RUST = read("../../core/src/bin/nexus_tui/redact.rs");

interface Shape { pattern: string; flags: string; replacement: string }

/** The `(pattern, replacement)` pairs of Rust's `PATTERNS`, normalised to the table's spelling. Fails if any `Regex::new` in the block is not understood, so a pattern cannot hide behind unusual formatting. */
function rustPatterns(source: string): Shape[] {
  const start = source.indexOf("static PATTERNS");
  const end = source.indexOf("/// Redacts stderr", start);
  assert.ok(start >= 0 && end > start, "redact.rs still defines PATTERNS before StderrRedactor");
  const block = source.slice(start, end);
  const out: Shape[] = [];
  const re = /Regex::new\(\s*r(#*)"((?:(?!"\1)[\s\S])*)"\1\s*\)\s*\.unwrap\(\)\s*,\s*"([^"]*)"\s*,?\s*\)/g;
  for (const m of block.matchAll(re)) {
    const insensitive = m[2].startsWith("(?i)");
    out.push({ pattern: insensitive ? m[2].slice(4) : m[2], flags: insensitive ? "i" : "", replacement: m[3].replace(/\$\{(\d+)\}/g, "$$$1") });
  }
  const declared = (block.match(/Regex::new\(/g) ?? []).length;
  assert.equal(out.length, declared, `redact.rs has ${declared} Regex::new calls in PATTERNS but ${out.length} were understood: use the (Regex::new(r"..").unwrap(), "replacement") shape`);
  return out;
}

/** Differences between the table's `all`-scope rules and a Rust source, as readable lines (none when in step). */
function drift(rules: Rule[], rustSource: string): string[] {
  const shared = rules.filter((r) => r.scope === "all").map(({ pattern, flags, replacement }) => ({ pattern, flags, replacement }));
  const rust = rustPatterns(rustSource);
  const problems: string[] = [];
  if (shared.length !== rust.length) problems.push(`the table has ${shared.length} shared patterns, redact.rs has ${rust.length}`);
  for (let i = 0; i < Math.min(shared.length, rust.length); i++) {
    for (const key of ["pattern", "flags", "replacement"] as const) {
      if (shared[i][key] !== rust[i][key]) problems.push(`pattern ${i + 1} ${key}: table ${JSON.stringify(shared[i][key])} vs redact.rs ${JSON.stringify(rust[i][key])}`);
    }
  }
  return problems;
}

test("the table is well formed: unique names, known scopes, patterns that compile", () => {
  const names = table.rules.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const r of table.rules) {
    assert.ok(["all", "multiline"].includes(r.scope), r.name);
    assert.doesNotThrow(() => new RegExp(r.pattern, `${r.flags}g`), r.name);
    assert.match(r.flags, /^i?$/, `${r.name}: only the i flag is meaningful on both sides`);
  }
});

test("redact.rs mirrors the table's shared patterns exactly, in order", () => {
  assert.deepEqual(drift(table.rules, RUST), []);
});

test("the parity check is not vacuous: it names a pattern added, removed or edited on either side", () => {
  const extraRule: Rule = { name: "extra", scope: "all", pattern: "xyz[0-9]{9}", flags: "", replacement: "[REDACTED_X]" };
  assert.match(drift([...table.rules, extraRule], RUST).join("\n"), /table has 5 shared patterns, redact.rs has 4/, "added to the table only");
  const head = "static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {\n    vec![";
  const rustWithExtra = RUST.replace(head, `${head}\n        (Regex::new(r"xyz[0-9]{9}").unwrap(), "[REDACTED_X]"),`);
  assert.notEqual(rustWithExtra, RUST, "the mutation applied");
  assert.match(drift(table.rules, rustWithExtra).join("\n"), /table has 4 shared patterns, redact.rs has 5/, "added to Rust only");
  assert.match(drift(table.rules, RUST.replace("{16,}", "{17,}")).join("\n"), /pattern \d pattern: table/, "edited in Rust only");
  const unparseable = RUST.replace(head, `${head}\n        (Regex::new(&format!("x{}", 1)).unwrap(), "[REDACTED_X]"),`);
  assert.throws(() => drift(table.rules, unparseable), /Regex::new calls in PATTERNS but \d were understood/, "a pattern the parser cannot read fails loudly");
  assert.match(drift(table.rules.map((r) => (r.name === "bearer-token" ? { ...r, replacement: "Bearer [X]" } : r)), RUST).join("\n"), /replacement/, "edited in the table only");
});

const expand = (text: string) => text.replaceAll("⟦⟧", "");

for (const c of corpus.cases) {
  test(`corpus (TypeScript): ${c.name}`, () => {
    assert.equal(redactSecretPatterns(expand(c.input)), expand(c.expected));
  });
}

test("the corpus carries no key-shaped literal (a join marker splits each prefix from its body)", () => {
  const text = fs.readFileSync(path.resolve(here, "fixtures/redaction_corpus.json"), "utf8");
  assert.doesNotMatch(text, /(?:sk-|ghp_|gho_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_-]{16,}/);
});
