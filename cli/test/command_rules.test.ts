/**
 * CS-9 operator command rules: prefix rules with an allow < prompt < forbidden lattice, examples checked at load, and a
 * record of which rule decided. See cli/src/core/command_rules.ts for what a rule can and cannot do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideCommand, parseCommandRules, readCommandRulesFile, NO_COMMAND_RULES } from "../src/core/command_rules.js";

const DOC = {
  version: 1,
  rules: [
    { prefix: ["git", ["status", "log", "diff"]], decision: "allow", justification: "read-only git", match: ["git status", "git diff --stat", "git log -n 3"], notMatch: ["git push", "git commit -m x"] },
    { prefix: ["git", "push"], decision: "prompt", match: ["git push origin main"], notMatch: ["git status"] },
    { prefix: ["rm", "-rf"], decision: "forbidden", justification: "never recursive-delete", match: ["rm -rf build"] },
    { prefix: ["npm", "test"], decision: "allow", match: ["npm test"] },
  ],
};
const rules = () => parseCommandRules(structuredClone(DOC));

test("a prefix rule allows `git status` and still prompts for `git push` (the CS-9 acceptance)", () => {
  const set = rules();
  assert.equal(decideCommand(set, "git status")?.decision, "allow");
  assert.equal(decideCommand(set, "git diff --stat HEAD~1")?.decision, "allow");
  assert.equal(decideCommand(set, "git push origin main")?.decision, "prompt");
  assert.equal(decideCommand(set, "git commit -m x"), null, "no rule: the normal approval policy decides");
  assert.equal(decideCommand(set, "rm -rf node_modules")?.decision, "forbidden");
});

test("the deciding rule is reported, with its justification", () => {
  const set = rules();
  const verdict = decideCommand(set, "git status")!;
  assert.equal(verdict.rule.index, 1);
  assert.equal(verdict.rule.justification, "read-only git");
  assert.equal(decideCommand(set, "rm -rf x")!.rule.index, 3);
});

test("chaining cannot dodge a prompt or a refusal, and one allowed part does not allow the chain", () => {
  const set = rules();
  assert.equal(decideCommand(set, "git status && git push origin main")?.decision, "prompt");
  assert.equal(decideCommand(set, "git status; rm -rf build")?.decision, "forbidden");
  assert.equal(decideCommand(set, "git status | cat")?.decision ?? null, null, "cat has no rule, so the pipe is not allowed as a whole");
  assert.equal(decideCommand(set, "git status && npm test")?.decision, "allow", "every part allowed");
  assert.deepEqual(decideCommand(set, "git status && npm test")!.rules.map((r) => r.index).sort(), [1, 4]);
});

test("a shell-active command is never allowed, whatever its words match (a heuristic never qualifies)", () => {
  const set = rules();
  for (const command of ["git status $(rm -rf x)", "git status `id`", "git status > /etc/x", "git status\nrm x", "git status *", "git status ~", "npm test (x)", "git status #", "git status \; id"]) {
    assert.equal(decideCommand(set, command)?.decision ?? null, null, command);
  }
  assert.equal(decideCommand(set, "git push $(echo origin)")?.decision, "prompt", "but a prompt still applies");
  assert.equal(decideCommand(set, "git diff HEAD~1 -- a#b")?.decision, "allow", "~ and # inside a word are ordinary characters");
});

test("matching is by whole words in order, never a substring", () => {
  const set = rules();
  assert.equal(decideCommand(set, "git status-extra"), null);
  assert.equal(decideCommand(set, "xgit status"), null);
  assert.equal(decideCommand(set, "git"), null);
  assert.equal(decideCommand(set, "echo git status"), null);
  assert.equal(decideCommand(set, ""), null);
  assert.equal(decideCommand(NO_COMMAND_RULES, "git status"), null);
});

test("an example the rules contradict fails the load, and names the rule and example", () => {
  const bad = structuredClone(DOC);
  bad.rules[0].match.push("git push origin main");
  assert.throws(() => parseCommandRules(bad), /rules\[1\]\.match\[3\]: "git push origin main" is prompt by rule 2, not allow by rule 1/);
  const bad2 = structuredClone(DOC);
  bad2.rules[1].notMatch.push("git push origin main");
  assert.throws(() => parseCommandRules(bad2), /rules\[2\]\.notMatch\[1\].*listed as not matching/);
  const bad3 = structuredClone(DOC);
  bad3.rules[0].match.push("git status $(id)");
  assert.throws(() => parseCommandRules(bad3), /decided by no rule/);
  const bad4 = structuredClone(DOC);
  bad4.rules[3].match.push("npm run build");
  assert.throws(() => parseCommandRules(bad4), /rules\[4\]\.match\[1\]/);
});

test("a stricter rule from another entry overrides an allow example", () => {
  const doc = { version: 1, rules: [
    { prefix: ["git"], decision: "allow", match: ["git status"] },
    { prefix: ["git", "status"], decision: "forbidden" },
  ] };
  assert.throws(() => parseCommandRules(doc), /rules\[1\]\.match\[0\]: "git status" is forbidden by rule 2/);
});

test("structural errors name the field", () => {
  const cases: [unknown, RegExp][] = [
    [null, /must be an object/],
    [{ version: 2, rules: [] }, /version: must be 1/],
    [{ version: 1, rules: [], extra: 1 }, /extra: unknown field/],
    [{ version: 1, rules: "x" }, /rules: must be an array/],
    [{ version: 1, rules: [{ prefix: ["a"], decision: "maybe" }] }, /rules\[1\]\.decision: must be one of allow, prompt, forbidden/],
    [{ version: 1, rules: [{ prefix: [], decision: "allow" }] }, /rules\[1\]\.prefix: must be a non-empty array/],
    [{ version: 1, rules: [{ prefix: ["a b"], decision: "allow" }] }, /rules\[1\]\.prefix\[0\]: must be a single word/],
    [{ version: 1, rules: [{ prefix: ["a"], decision: "allow", surprise: 1 }] }, /rules\[1\]\.surprise: unknown field/],
    [{ version: 1, rules: [{ prefix: ["a"], decision: "allow", justification: "" }] }, /rules\[1\]\.justification/],
    [{ version: 1, rules: [{ prefix: ["a"], decision: "allow", match: "a" }] }, /rules\[1\]\.match: must be an array/],
  ];
  for (const [doc, pattern] of cases) assert.throws(() => parseCommandRules(doc), pattern);
});

test("the file reader: missing is empty, malformed is an error, and the rules carry their source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rules-"));
  try {
    const file = path.join(dir, "command_rules.json");
    assert.deepEqual(readCommandRulesFile(file).rules, []);
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => readCommandRulesFile(file), /is not valid JSON/);
    fs.writeFileSync(file, JSON.stringify(DOC));
    const set = readCommandRulesFile(file);
    assert.equal(set.file, file);
    assert.equal(set.rules.length, 4);
    fs.writeFileSync(file, JSON.stringify({ version: 1, rules: [{ prefix: ["a"], decision: "allow", match: ["b"] }] }));
    assert.throws(() => readCommandRulesFile(file), /rules\[1\]\.match\[0\]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
