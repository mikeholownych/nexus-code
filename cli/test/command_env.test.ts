/**
 * Hardening slice 1: run_command must not inherit the operator's credentials.
 * config.env is loaded into process.env with override, so before this fix `env` printed every provider key, with or
 * without a sandbox. These tests run the real tool path (the persistent engine, the one-shot fallback and the
 * write-mode bwrap sandbox) against a throwaway HOME whose config.env holds sentinel secrets.
 */
import "./helpers/leak_guard.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RustCoreBridge, resolveCoreBinary } from "../src/tools.js";
import { loadEnvironment } from "../src/config.js";
import { buildCommandEnvironment, isCredentialName } from "../src/command_env.js";

const SENTINEL = "sk-sentinel-123";
const GATEWAY_SENTINEL = "gw-sentinel-456";
const PROJECT_SENTINEL = "project-sentinel-789";

function hasBwrap(): boolean {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const savedEnv = { ...process.env };
let home: string;
let repo: string;
const bridges: RustCoreBridge[] = [];

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cmdenv-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cmdenv-repo-"));
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "nexus", "config.env"),
    [
      `ANTHROPIC_API_KEY=${SENTINEL}`,
      `OPENAI_API_KEY=${SENTINEL}-openai`,
      `LOCAL_LLM_API_KEY=${SENTINEL}-local`,
      `NEXUS_GATEWAY_TOKEN=${GATEWAY_SENTINEL}`,
      `NEXUS_GATEWAY_TOKEN_FILE=${home}/.config/nexus/gateway-token`,
      `NEXUS_ONLY_IN_CONFIG_ENV=${SENTINEL}-config-only`,
      "NEXUS_COMMAND_ENV_PASSTHROUGH=NEXUS_TEST_PASSTHROUGH,GH_TOKEN",
      "",
    ].join("\n"),
  );
  // A repository-controlled .env: it may not opt itself into the passthrough, and its own values are not operator secrets.
  fs.writeFileSync(path.join(repo, ".env"), `NEXUS_COMMAND_ENV_PASSTHROUGH=PROJECT_TOKEN\nPROJECT_TOKEN=${PROJECT_SENTINEL}\n`);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_TEST_PASSTHROUGH = "passthrough-visible-42";
  process.env.GH_TOKEN = "gh-sentinel-passthrough";
  process.env.PROJECT_TOKEN = PROJECT_SENTINEL;
  process.env.COMMAND_ENV_ORDINARY = "ordinary-visible";
  process.env.AWS_SECRET_ACCESS_KEY = `${SENTINEL}-aws`;
  process.env.GITHUB_TOKEN = `${SENTINEL}-github`;
  loadEnvironment();
});

after(() => {
  for (const b of bridges) b.shutdown();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function bridge(sandbox: boolean | string = false): RustCoreBridge {
  const b = new RustCoreBridge(repo, "bash", undefined, false, false, sandbox);
  bridges.push(b);
  return b;
}

/** The engine returns a JSON document with the command's stdout; fall back to the raw text for anything else. */
function stdoutOf(output: string): string {
  try {
    const parsed = JSON.parse(output);
    return typeof parsed.stdout === "string" ? parsed.stdout + "\n" + (parsed.stderr ?? "") : output;
  } catch {
    return output;
  }
}

function assertScrubbed(raw: string): void {
  const output = stdoutOf(raw);
  for (const secret of [SENTINEL, GATEWAY_SENTINEL, `${SENTINEL}-openai`, `${SENTINEL}-local`, `${SENTINEL}-config-only`, `${SENTINEL}-aws`, `${SENTINEL}-github`]) {
    assert.ok(!output.includes(secret), `a credential reached the command environment: ${secret}`);
  }
  assert.ok(!/ANTHROPIC_API_KEY|NEXUS_GATEWAY_TOKEN|AWS_SECRET_ACCESS_KEY/.test(output), "a credential variable name is still set in the command environment");
  assert.ok(output.includes("COMMAND_ENV_ORDINARY=ordinary-visible"), "an ordinary variable was lost");
  assert.ok(/^PATH=/m.test(output) && /^HOME=/m.test(output), "PATH/HOME must survive");
  // The operator's passthrough works, including for a name that would otherwise be scrubbed.
  assert.ok(output.includes("NEXUS_TEST_PASSTHROUGH=passthrough-visible-42"), "the operator passthrough variable is missing");
  assert.ok(output.includes("GH_TOKEN=gh-sentinel-passthrough"), "a passthrough name that looks like a credential is missing");
  // A project .env cannot extend the passthrough: PROJECT_TOKEN matches the credential rule and was not opted in by the operator.
  assert.ok(!output.includes(PROJECT_SENTINEL), "a project .env opted a credential into the command environment");
}

describe("run_command environment", { skip: resolveCoreBinary() ? false : "harness-core is not built" }, () => {
  test("unsandboxed command through the persistent engine", async () => {
    const res = await bridge().executeTool("run_command", { command: "env", shell: "bash" });
    assert.equal(res.success, true, res.error);
    assertScrubbed(res.output);
  });

  test("one-shot fallback uses the same environment", async () => {
    const res = await (bridge() as any).executeViaSpawn("run_command", { command: "env", shell: "bash" });
    assert.equal(res.success, true, res.error);
    assertScrubbed(res.output);
  });

  test("write-mode bwrap sandbox", { skip: hasBwrap() ? false : "bwrap is not installed" }, async () => {
    const res = await bridge("bwrap").executeTool("run_command", { command: "env", shell: "bash" });
    assert.equal(res.success, true, res.error);
    assertScrubbed(res.output);
  });
});

describe("buildCommandEnvironment", () => {
  test("drops credential names and config.env keys, keeps the toolchain", () => {
    for (const name of ["ANTHROPIC_API_KEY", "FOO_TOKEN", "DB_PASSWORD", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "NEXUS_GATEWAY_TOKEN_FILE", "NPM_TOKEN", "CARGO_REGISTRY_TOKEN", "SERVICE_SECRET"]) {
      assert.ok(isCredentialName(name), name);
    }
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "TMPDIR", "CARGO_HOME", "GOPATH", "MAX_TOKENS"]) {
      assert.ok(!isCredentialName(name), name);
    }
    const env = buildCommandEnvironment({
      PATH: "/usr/bin", HOME: "/h", LANG: "C", ANTHROPIC_API_KEY: "x", NEXUS_ONLY_IN_CONFIG_ENV: "y", CARGO_HOME: "/c",
      https_proxy: "http://user:pw@proxy:3128", NEXUS_COMMAND_ENV_PASSTHROUGH: "ANTHROPIC_API_KEY",
    });
    for (const kept of ["PATH", "HOME", "LANG", "CARGO_HOME"]) assert.ok(kept in env, `${kept} must be kept`);
    for (const gone of ["ANTHROPIC_API_KEY", "https_proxy"]) assert.ok(!(gone in env), `${gone} must be dropped`);
    // A passthrough value found in the process environment (possibly from a project .env) is not trusted as the opt-in.
    assert.ok(!("NEXUS_COMMAND_ENV_PASSTHROUGH" in env) || env.NEXUS_COMMAND_ENV_PASSTHROUGH !== "ANTHROPIC_API_KEY");
    assert.ok(!("NEXUS_ONLY_IN_CONFIG_ENV" in env), "a config.env key must be dropped");
  });
});
