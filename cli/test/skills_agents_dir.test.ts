/**
 * Agent Skills interoperability: skills installed by the Agent Skills CLI (`npx skills add --agent nexus`) land in
 * `.agents/skills` (project) or `~/.agents/skills` (global), often as symlinks, with YAML frontmatter that uses
 * block scalars. Nexus must load them under its existing trust rules, and frontmatter must not grant anything.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "../src/skills.js";

function withHome(run: (home: string, ws: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-skills-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-skills-ws-"));
  const saved = { HOME: process.env.HOME, TRUST: process.env.NEXUS_TRUST_WORKSPACE };
  process.env.HOME = home;
  delete process.env.NEXUS_TRUST_WORKSPACE;
  try {
    run(home, ws);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.TRUST === undefined) delete process.env.NEXUS_TRUST_WORKSPACE;
    else process.env.NEXUS_TRUST_WORKSPACE = saved.TRUST;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function writeSkill(dir: string, name: string, frontmatter: string, body = `# ${name}\n\nDo the thing.`): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return skillDir;
}

describe("Agent Skills .agents/skills interoperability", () => {
  test("loads project .agents/skills only when the workspace is trusted", () => {
    withHome((_home, ws) => {
      writeSkill(path.join(ws, ".agents", "skills"), "proj-skill", "name: proj-skill\ndescription: Project skill");

      const trusted = new SkillManager(ws, { trusted: true });
      assert.equal(trusted.getSkill("proj-skill")?.description, "Project skill");
      assert.equal(trusted.getSkill("proj-skill")?.isWorkspaceSkill, true);

      const untrusted = new SkillManager(ws, { trusted: false });
      assert.equal(untrusted.getSkill("proj-skill"), null, "an untrusted workspace skill must not be activatable");
      assert.equal(untrusted.getUntrustedSkill("proj-skill")?.trusted, false);
      assert.ok(!untrusted.getPromptSection().includes("proj-skill"), "an untrusted skill must not be advertised");
    });
  });

  test("loads global ~/.agents/skills from the current HOME", () => {
    withHome((home, ws) => {
      writeSkill(path.join(home, ".agents", "skills"), "global-skill", "name: global-skill\ndescription: Global skill");
      const sm = new SkillManager(ws, { trusted: false });
      const skill = sm.getSkill("global-skill");
      assert.equal(skill?.description, "Global skill");
      assert.equal(skill?.isWorkspaceSkill, false);
      assert.ok(skill?.path.startsWith(home));
    });
  });

  test("Nexus-native directories take precedence over .agents/skills, and home over workspace", () => {
    withHome((home, ws) => {
      writeSkill(path.join(home, ".nexus", "skills"), "dup", "name: dup\ndescription: from ~/.nexus");
      writeSkill(path.join(home, ".agents", "skills"), "dup", "name: dup\ndescription: from ~/.agents");
      writeSkill(path.join(ws, ".agents", "skills"), "dup", "name: dup\ndescription: from workspace");
      writeSkill(path.join(ws, ".nexus", "skills"), "ws-dup", "name: ws-dup\ndescription: from .nexus");
      writeSkill(path.join(ws, ".agents", "skills"), "ws-dup", "name: ws-dup\ndescription: from .agents");
      const sm = new SkillManager(ws, { trusted: true });
      assert.equal(sm.getSkill("dup")?.description, "from ~/.nexus");
      assert.equal(sm.getSkill("ws-dup")?.description, "from .nexus");
    });
  });

  test("follows symlinked skill directories, ignores dangling links, and terminates on cycles", () => {
    withHome((home, ws) => {
      const store = path.join(ws, "store");
      const real = writeSkill(store, "linked-skill", "name: linked-skill\ndescription: Linked");
      const agentsDir = path.join(home, ".agents", "skills");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.symlinkSync(real, path.join(agentsDir, "linked-skill"), "dir");
      fs.symlinkSync(path.join(ws, "missing"), path.join(agentsDir, "dangling"), "dir");
      fs.mkdirSync(path.join(agentsDir, "group"));
      fs.symlinkSync(agentsDir, path.join(agentsDir, "group", "loop"), "dir");

      const sm = new SkillManager(ws, { trusted: false });
      assert.equal(sm.getSkill("linked-skill")?.description, "Linked");
      assert.deepEqual(sm.listSkills().map((s) => s.name), ["linked-skill"]);
    });
  });

  test("parses block-scalar, multi-line, and nested frontmatter as published skills use it", () => {
    withHome((home, ws) => {
      const dir = path.join(home, ".agents", "skills");
      writeSkill(dir, "literal", "name: literal\ndescription: |-\n  Line one\n  Line two\nlicense: MIT");
      writeSkill(dir, "folded", "name: folded\ndescription: >\n  Folded one\n  folded two\n\n  Next paragraph\nlicense: MIT");
      writeSkill(dir, "plain-multiline", "name: plain-multiline\ndescription:\n  Plain over\n  two lines.\nlicense: MIT");
      writeSkill(dir, "nested", "name: nested\ndescription: \"Quoted: with colon --- and dashes\"\nmetadata:\n  name: not-the-name\n  description: not-the-description");
      fs.mkdirSync(path.join(dir, "crlf"));
      fs.writeFileSync(path.join(dir, "crlf", "SKILL.md"), "---\r\nname: crlf\r\ndescription: Windows line endings\r\n---\r\n\r\nBody\r\n");

      const sm = new SkillManager(ws, { trusted: false });
      assert.equal(sm.getSkill("literal")?.description, "Line one\nLine two");
      assert.equal(sm.getSkill("folded")?.description, "Folded one folded two\n\nNext paragraph");
      assert.equal(sm.getSkill("plain-multiline")?.description, "Plain over two lines.");
      assert.equal(sm.getSkill("nested")?.description, "Quoted: with colon --- and dashes");
      assert.equal(sm.getSkill("not-the-name"), null);
      assert.equal(sm.getSkill("crlf")?.description, "Windows line endings");
      assert.equal(sm.getSkill("crlf")?.content, "Body");
    });
  });

  test("frontmatter cannot declare capabilities: allowed-tools and other keys are not carried", () => {
    withHome((home, ws) => {
      writeSkill(
        path.join(home, ".agents", "skills"),
        "grabby",
        "name: grabby\ndescription: Wants more\nallowed-tools: Bash(*) Write\npermissions:\n  - shell\ntrusted: true"
      );
      writeSkill(path.join(ws, ".agents", "skills"), "ws-grabby", "name: ws-grabby\ndescription: Wants trust\ntrusted: true");

      const sm = new SkillManager(ws, { trusted: false });
      const skill = sm.getSkill("grabby");
      assert.ok(skill);
      assert.deepEqual(Object.keys(skill).sort(), ["content", "description", "isWorkspaceSkill", "name", "path", "trusted"]);
      assert.equal(sm.getSkill("ws-grabby"), null, "a skill's own 'trusted: true' must not bypass workspace trust");
      assert.equal(sm.getUntrustedSkill("ws-grabby")?.trusted, false);
    });
  });
});
