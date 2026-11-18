/**
 * CS-11: the volatile-text normaliser measured against a labelled corpus (test/fixtures/volatile_text_corpus.json).
 * A pair is "merged" when outcomeIdentity gives both outputs the same identity, "told apart" when it does not.
 *   same-failure pair told apart      = the gap (a loop with a changing counter looks like progress)
 *   different-failure pair merged     = a bug (a genuinely changed failure would be taken for a repeat): must be 0
 * KNOWN_GAP lists the same-failure pairs that are still told apart; the test fails if the set changes either way,
 * so a pattern that starts or stops working is always a conscious edit here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOutcomeText, outcomeIdentity } from "../src/core/execution_tracking.js";

interface Pair { id: string; label: "same-failure" | "different-failure"; tool: string; note: string; a: string; b: string }
const dir = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = [path.join(dir, "fixtures", "volatile_text_corpus.json"), path.join(dir, "..", "..", "test", "fixtures", "volatile_text_corpus.json")].find((p) => fs.existsSync(p))!;
const pairs: Pair[] = JSON.parse(fs.readFileSync(corpusPath, "utf8")).pairs;

// Baseline on unmodified main was 32 of 38 told apart. Residual: the four pairs whose volatile token has no context word to anchor on (S35-S38).
const KNOWN_GAP: string[] = ["S17", "S19", "S35", "S36", "S37", "S38"];

const merged = (p: Pair): boolean => outcomeIdentity(false, p.a) === outcomeIdentity(false, p.b);
const same = pairs.filter((p) => p.label === "same-failure");
const different = pairs.filter((p) => p.label === "different-failure");
const gap = same.filter((p) => !merged(p));
const wronglyMerged = different.filter(merged);

describe("CS-11 volatile-text corpus", () => {
  test("the corpus is large and balanced enough to mean something", () => {
    assert.ok(pairs.length >= 60, `${pairs.length} pairs`);
    assert.ok(same.length >= 30 && different.length >= 30);
    assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length, "ids are unique");
    for (const tool of ["tsc", "node test", "pytest", "go test", "cargo", "npm", "curl"]) assert.ok(pairs.some((p) => p.tool === tool), `covers ${tool}`);
  });

  test("confusion table", () => {
    const row = (label: string, total: number, told: number, mergedN: number) => `${label.padEnd(18)} total ${String(total).padStart(3)}  merged ${String(mergedN).padStart(3)}  told apart ${String(told).padStart(3)}`;
    const lines = [
      row("same-failure", same.length, gap.length, same.length - gap.length),
      row("different-failure", different.length, different.length - wronglyMerged.length, wronglyMerged.length),
      `gap (same-failure told apart): ${gap.map((p) => p.id).join(" ") || "none"}`,
      `wrongly merged (must be none): ${wronglyMerged.map((p) => p.id).join(" ") || "none"}`,
    ];
    console.log(lines.join("\n"));
    assert.deepEqual(wronglyMerged.map((p) => `${p.id} ${p.note}`), [], "a genuinely different failure was merged");
    assert.deepEqual(gap.map((p) => p.id), KNOWN_GAP, "the gap changed: update KNOWN_GAP (and docs/LOOP_PATTERNS.md) deliberately");
  });

  test("success and failure never share an identity, whatever the text", () => {
    for (const p of pairs) assert.notEqual(outcomeIdentity(true, p.a), outcomeIdentity(false, p.a), p.id);
  });

  test("normalisation is idempotent and never empties real output", () => {
    for (const p of pairs) for (const t of [p.a, p.b]) {
      const once = normalizeOutcomeText(t);
      assert.equal(normalizeOutcomeText(once), once, `${p.id} idempotent`);
      assert.ok(once.length > 0);
    }
  });
});
