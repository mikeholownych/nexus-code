/**
 * The steering-judgment research dataset (docs/research/steering-judgment) is well formed: unique ids, known splits and
 * labels, a label for each of the three requirements, and a held-out split that is not empty. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/research/steering-judgment");
const rows = fs.readFileSync(path.join(dir, "dataset.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const LABELS = new Set(["withdraws", "defers", "changes", "none"]);

test("the steering-judgment dataset is well formed", () => {
  assert.ok(rows.length >= 20);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "ids are unique");
  for (const row of rows) {
    assert.ok(row.split === "tune" || row.split === "heldout", `row ${row.id} has a known split`);
    assert.ok(typeof row.steering === "string" && row.steering.trim().length > 0, `row ${row.id} has a steering message`);
    assert.deepEqual(Object.keys(row.expected).sort(), ["R1", "R2", "R3"], `row ${row.id} labels all three requirements`);
    for (const label of Object.values(row.expected)) assert.ok(LABELS.has(label as string), `row ${row.id} uses a known label`);
  }
  assert.ok(rows.some((r) => r.split === "heldout"), "a held-out split exists");
  assert.ok(rows.some((r) => Object.values(r.expected).includes("withdraws")), "withdrawals are present");
  assert.ok(rows.some((r) => Object.values(r.expected).every((l) => l === "none")), "hard negatives are present");
});

test("the shared question module yields one withdraws, defers and changes question per requirement", async () => {
  const { questionsFor, REQUIREMENTS } = await import(path.join(dir, "questions.mjs"));
  const questions = questionsFor();
  assert.equal(Object.keys(questions).length, REQUIREMENTS.length * 3);
  for (const requirement of REQUIREMENTS) for (const kind of ["withdraws", "defers", "changes"]) {
    const question = questions[`r${requirement.number}.${kind}`];
    assert.equal(question.type, "noul");
    assert.ok(question.instructions.includes("`steering.text`"), "the question names the state path it reads");
    assert.ok(question.instructions.includes(requirement.text), "the question names its requirement");
  }
});
