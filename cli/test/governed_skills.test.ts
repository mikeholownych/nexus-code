/**
 * Governed skills (WP-GS-01..05): activation identity, digest, optional constraints,
 * workspace confirm flag, watcher root alignment.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  SkillActivationRegistry,
  skillContentDigest,
  skillActivationIdsEnabled,
  skillConstraintsEnabled,
  parseSkillConstraints,
  resolveSkillToolAllowed,
  discoverySkillDirs,
  watcherSkillDirs,
} from "../src/core/skill_activation.js";
import { SkillManager } from "../src/skills.js";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

const savedEnv = { ...process.env };

function withHome<T>(fn: (home: string, ws: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gs-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gs-ws-"));
  const prev = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, STATE: process.env.NEXUS_STATE_DIR };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
  fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k === "XDG" ? "XDG_CONFIG_HOME" : k === "STATE" ? "NEXUS_STATE_DIR" : k];
      else process.env[k === "XDG" ? "XDG_CONFIG_HOME" : k === "STATE" ? "NEXUS_STATE_DIR" : k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  };
  try {
    const result = fn(home, ws) as T | Promise<T>;
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore) as T;
    }
    restore();
    return result as T;
  } catch (err) {
    restore();
    throw err;
  }
}

function writeSkill(root: string, name: string, front: string, body = "BODY") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = path.join(dir, "SKILL.md");
  fs.writeFileSync(skillPath, `---\n${front}\n---\n\n${body}\n`);
  return skillPath;
}

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("WP-GS-01/02 skill activation registry", () => {
  test("digest is sha256 of body bytes", () => {
    const body = "hello skill";
    assert.equal(skillContentDigest(body), createHash("sha256").update(body, "utf8").digest("hex"));
  });

  test("activate records id, name, digest; current points at it; deactivate clears", () => {
    delete process.env.NEXUS_SKILL_ACTIVATION_IDS;
    const reg = new SkillActivationRegistry();
    const act = reg.activate({
      skillName: "demo",
      sourcePath: "/tmp/demo/SKILL.md",
      sourceClass: "global",
      content: "VERSION_A",
      taskId: "task-1",
    });
    assert.ok(act.activationId.length >= 8);
    assert.equal(act.skillName, "demo");
    assert.equal(act.contentDigest, skillContentDigest("VERSION_A"));
    assert.equal(act.status, "active");
    assert.equal(reg.current()?.activationId, act.activationId);
    assert.deepEqual(reg.attribution(), {
      skillActivationId: act.activationId,
      skillName: "demo",
      skillContentDigest: act.contentDigest,
    });
    reg.deactivate(act.activationId);
    assert.equal(reg.current(), undefined);
    assert.deepEqual(reg.attribution(), {});
    assert.equal(reg.get(act.activationId)?.status, "revoked");
  });

  test("NEXUS_SKILL_ACTIVATION_IDS=0 disables attribution fields", () => {
    process.env.NEXUS_SKILL_ACTIVATION_IDS = "0";
    assert.equal(skillActivationIdsEnabled(), false);
    const reg = new SkillActivationRegistry();
    reg.activate({
      skillName: "demo",
      sourcePath: "/x",
      sourceClass: "global",
      content: "c",
      taskId: "t",
    });
    assert.deepEqual(reg.attribution(), {});
    delete process.env.NEXUS_SKILL_ACTIVATION_IDS;
  });

  test("live integrity detects content drift", () => {
    const reg = new SkillActivationRegistry();
    const act = reg.activate({
      skillName: "mutable",
      sourcePath: "/tmp/m/SKILL.md",
      sourceClass: "global",
      content: "A",
      taskId: "t",
    });
    assert.equal(reg.contentMatches(act.activationId, "A"), true);
    assert.equal(reg.contentMatches(act.activationId, "B"), false);
  });
});

describe("WP-GS-03 skill constraints (opt-in)", () => {
  test("absent constraints mean unconstrained", () => {
    assert.deepEqual(parseSkillConstraints({}), { kind: "unconstrained" });
    assert.equal(resolveSkillToolAllowed("run_command", parseSkillConstraints({})), true);
  });

  test("allowedCapabilities intersect; never expand", () => {
    process.env.NEXUS_SKILL_CONSTRAINTS = "1";
    assert.equal(skillConstraintsEnabled(), true);
    const c = parseSkillConstraints({ "allowed-capabilities": "read_file, search_code" });
    assert.equal(c.kind, "constrained");
    if (c.kind !== "constrained") return;
    assert.equal(resolveSkillToolAllowed("read_file", c), true);
    assert.equal(resolveSkillToolAllowed("run_command", c), false);
    delete process.env.NEXUS_SKILL_CONSTRAINTS;
  });

  test("deniedCapabilities block listed tools", () => {
    const c = parseSkillConstraints({ "denied-capabilities": "run_command" });
    assert.equal(resolveSkillToolAllowed("run_command", c), false);
    assert.equal(resolveSkillToolAllowed("read_file", c), true);
  });
});

describe("WP-GS-05 watcher roots cover discovery", () => {
  test("every discovery skill dir is watched", () => {
    withHome((home, ws) => {
      const discovery = discoverySkillDirs(ws, home);
      const watched = watcherSkillDirs(ws, home);
      for (const dir of discovery) {
        assert.ok(watched.includes(dir), `missing watcher for ${dir}`);
      }
    });
  });
});

describe("WP-GS-01 activate_skill wires receipts", () => {
  const quiet = (agent: AutonomousAgent) => {
    (agent as any).ui = new Proxy({}, { get: () => () => {} });
    return agent;
  };
  const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
    endpoint,
    model: "m",
    maxSteps: 5,
    temperature: 0,
    workspace,
    shell: "bash",
    continuation: { ...DEFAULT_CONTINUATION },
    approvalMode: "auto",
    fullAccess: true,
  });

  test("activate_skill then read_file receipt carries skillActivationId and digest", { timeout: 60_000 }, async () => {
    delete process.env.NEXUS_SKILL_ACTIVATION_IDS;
    await withHome(async (home, _ws) => {
      writeSkill(path.join(home, ".agents", "skills"), "pdf-forms", "name: pdf-forms\ndescription: Fill PDF forms", "PDF_BODY");
      const repo = makeRepo();
      const body = "PDF_BODY";
      const expectedDigest = skillContentDigest(body);
      const gw = await startGateway((n) => {
        if (n === 1) {
          return { kind: "tools", calls: [{ name: "activate_skill", args: { name: "pdf-forms" } }] } as Reply;
        }
        if (n === 2) {
          return { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }] } as Reply;
        }
        return { kind: "text", content: "done" } as Reply;
      });
      const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
      try {
        await agent.runTurn("use pdf skill then read readme");
        const reg = agent.skillActivations;
        assert.ok(reg, "agent exposes skillActivations registry");
        const current = reg.current();
        assert.ok(current, "activation remains current after activate");
        assert.equal(current!.skillName, "pdf-forms");
        assert.equal(current!.contentDigest, expectedDigest);
        const attr = reg.attribution();
        assert.equal(attr.skillActivationId, current!.activationId);
        assert.equal(attr.skillContentDigest, expectedDigest);
        const last = agent.lastToolReceipts;
        assert.ok(last && last.length >= 2, `dispatch records receipts for inspection, got ${last?.length ?? 0}`);
        const activateRc = last.find((r) => r.toolName === "activate_skill");
        const readRc = last.find((r) => r.toolName === "read_file");
        assert.ok(activateRc?.skillActivationId);
        assert.equal(activateRc!.skillName, "pdf-forms");
        assert.equal(activateRc!.skillContentDigest, expectedDigest);
        assert.equal(readRc?.skillActivationId, activateRc!.skillActivationId);
      } finally {
        agent.shutdown();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test("constrained skill denies run_command when NEXUS_SKILL_CONSTRAINTS=1", { timeout: 60_000 }, async () => {
    process.env.NEXUS_SKILL_CONSTRAINTS = "1";
    await withHome(async (home) => {
      writeSkill(
        path.join(home, ".agents", "skills"),
        "reader",
        "name: reader\ndescription: Read only helper\nallowed-capabilities: read_file",
        "Only read files."
      );
      const repo = makeRepo();
      const gw = await startGateway((n) => {
        if (n === 1) {
          return { kind: "tools", calls: [{ name: "activate_skill", args: { name: "reader" } }] } as Reply;
        }
        if (n === 2) {
          return { kind: "tools", calls: [{ name: "run_command", args: { command: "echo hi" } }] } as Reply;
        }
        return { kind: "text", content: "done" } as Reply;
      });
      const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
      try {
        await agent.runTurn("activate reader then shell");
        const last = agent.lastToolReceipts;
        const shellRc = last?.find((r) => r.toolName === "run_command");
        assert.ok(shellRc, `expected run_command receipt, got ${JSON.stringify(last?.map((r) => r.toolName))}`);
        assert.equal(shellRc!.success, false);
        assert.match(String(shellRc!.error || shellRc!.denialReason || ""), /skill constraint|not permitted|denied/i);
      } finally {
        agent.shutdown();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
        delete process.env.NEXUS_SKILL_CONSTRAINTS;
      }
    });
  });
});

describe("frontmatter constraint fields on SkillManager", () => {
  test("allowed-capabilities is retained on Skill when present", () => {
    withHome((home, ws) => {
      writeSkill(
        path.join(home, ".agents", "skills"),
        "capped",
        "name: capped\ndescription: capped\nallowed-capabilities: read_file\ndenied-capabilities: run_command"
      );
      const sm = new SkillManager(ws, { trusted: true });
      const skill = sm.getSkill("capped");
      assert.ok(skill);
      assert.equal(skill.allowedCapabilities, "read_file");
      assert.equal(skill.deniedCapabilities, "run_command");
    });
  });
});

describe("WP-GS-05 local lifecycle revoke", () => {
  test("revoked skill cannot activate", async () => {
    const { revokeSkill, isSkillRevoked, recordSkillActivationLifecycle } = await import("../src/core/skills_lifecycle.js");
    await withHome(async (home) => {
      recordSkillActivationLifecycle({ name: "gone", contentDigest: "abc", sourcePath: "/x" });
      assert.equal(isSkillRevoked("gone"), false);
      revokeSkill("gone");
      assert.equal(isSkillRevoked("gone"), true);
      writeSkill(path.join(home, ".agents", "skills"), "gone", "name: gone\ndescription: revoked skill", "BODY");
      const repo = makeRepo();
      const gw = await startGateway((n) =>
        n === 1
          ? ({ kind: "tools", calls: [{ name: "activate_skill", args: { name: "gone" } }] } as Reply)
          : ({ kind: "text", content: "done" } as Reply)
      );
      const agent = ((a: AutonomousAgent) => {
        (a as any).ui = new Proxy({}, { get: () => () => {} });
        return a;
      })(
        new AutonomousAgent({
          endpoint: gw.url,
          model: "m",
          maxSteps: 3,
          temperature: 0,
          workspace: repo,
          shell: "bash",
          continuation: { ...DEFAULT_CONTINUATION },
          approvalMode: "auto",
          fullAccess: true,
        })
      );
      try {
        await agent.runTurn("activate gone");
        const rc = agent.lastToolReceipts.find((r) => r.toolName === "activate_skill");
        assert.ok(rc);
        assert.equal(rc!.success, false);
        assert.match(String(rc!.error || ""), /revoked/i);
      } finally {
        agent.shutdown();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
