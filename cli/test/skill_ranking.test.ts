/**
 * WP-1308: skills are matched to the operator's words by a local lexical ranker; a match advertises a description
 * and nothing else. Untrusted workspace skills are never scored.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager, formatSkillNote, findCatalogSpan, skillNoteBudget, SKILL_NOTE_PREFIX, SKILL_CATALOG_HEADING } from "../src/skills.js";

let home = "";
const saved = { HOME: process.env.HOME };
const write = (root: string, name: string, description: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBODY-OF-${name}\n`);
};
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-skill-rank-"));
  process.env.HOME = home;
  const root = path.join(home, ".agents", "skills");
  for (let i = 0; i < 300; i++) write(root, `filler-${i}`, `Filler skill ${i} for a generic engineering workflow, its tooling, its tests and the review checklist that goes with it.`);
  write(root, "postgres-tuning", "Diagnose slow PostgreSQL queries, read EXPLAIN plans, add indexes and tune vacuum settings.");
  write(root, "kubernetes-deploy", "Deploy services to Kubernetes clusters with Helm charts, rollouts and readiness probes.");
  write(root, "pdf-forms", "Fill, merge and split PDF forms and extract tables from PDF documents.");
});
after(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("findSkills", () => {
  test("a prompt naming a skill's domain ranks that skill first, among 300+ skills", () => {
    const mgr = new SkillManager(home, { trusted: true });
    assert.ok(mgr.listSkills().length >= 303);
    const hit = mgr.findSkills("my postgres queries are slow, can you look at the explain output and add an index?");
    assert.equal(hit[0]?.name, "postgres-tuning");
    assert.ok(hit.length <= 5);
    assert.deepEqual(mgr.findSkills("deploy this service with helm to the kubernetes cluster").map((s) => s.name).slice(0, 1), ["kubernetes-deploy"]);
  });

  test("an unrelated prompt matches nothing, and neither do words every skill shares", () => {
    const mgr = new SkillManager(home, { trusted: true });
    assert.deepEqual(mgr.findSkills("say hello and tell me a joke about cats"), []);
    assert.deepEqual(mgr.findSkills("engineering workflow tooling tests review checklist"), []);
    assert.deepEqual(mgr.findSkills(""), []);
  });

  test("untrusted workspace skills are never scored", () => {
    const ws = path.join(home, "ws");
    write(path.join(ws, ".nexus", "skills"), "zebra-grooming", "Groom zebras with the stripe brush and hoof polish.");
    const untrusted = new SkillManager(ws, { trusted: false });
    assert.equal(untrusted.getUntrustedSkill("zebra-grooming")?.name, "zebra-grooming");
    assert.deepEqual(untrusted.findSkills("groom the zebra with a stripe brush"), []);
    const trusted = new SkillManager(ws, { trusted: true });
    assert.equal(trusted.findSkills("groom the zebra with a stripe brush")[0]?.name, "zebra-grooming");
  });
});

describe("formatSkillNote", () => {
  test("lists descriptions under the budget, says nothing is activated, and leaves bodies out", () => {
    const mgr = new SkillManager(home, { trusted: true });
    const hit = mgr.findSkills("postgres explain index vacuum");
    const note = formatSkillNote(hit, skillNoteBudget(65_536));
    assert.ok(note.startsWith(SKILL_NOTE_PREFIX));
    assert.match(note, /\*\*postgres-tuning\*\*: Diagnose slow PostgreSQL queries/);
    assert.doesNotMatch(note, /BODY-OF/);
    assert.match(note, /nothing is activated/i);
    assert.ok(note.length <= skillNoteBudget(65_536));
  });

  test("the note stays within a tiny budget by shortening descriptions, then dropping skills; no room means no note", () => {
    const mgr = new SkillManager(home, { trusted: true });
    const hit = mgr.findSkills("postgres kubernetes pdf");
    for (const budget of [400, 300, 250]) {
      const note = formatSkillNote(hit, budget);
      assert.ok(note.length <= budget, `${note.length} > ${budget}`);
    }
    assert.equal(formatSkillNote(hit, 10), "");
    assert.equal(formatSkillNote([], 5000), "");
  });
});

describe("findCatalogSpan", () => {
  test("recognises a catalog of any release by its heading, ending at the next section", () => {
    const catalog = `${SKILL_CATALOG_HEADING}\nintro\n\n- **a** [source: /x] [trust: trusted]: first\n- **b** [source: /y] [trust: trusted]: second\n`;
    const prompt = `rules\n${catalog}\n### Runtime Identity\nid`;
    const span = findCatalogSpan(prompt)!;
    assert.equal(prompt.slice(span.start, span.end), catalog);
    const tail = `rules\n${catalog}`;
    const span2 = findCatalogSpan(tail)!;
    assert.equal(tail.slice(span2.start, span2.end), catalog);
    assert.equal(findCatalogSpan("no skills here"), null);
  });
});
