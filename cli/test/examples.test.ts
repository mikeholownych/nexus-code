/**
 * DH-3 / RD-4: every example under examples/ and the action/ wrapper is exercised, so they stay true to the product.
 * Scripts run through a shim of the real CLI against a scripted gateway; nothing contacts a live service.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway, type Reply } from "./helpers/fixtures.js";
import { OperationSpecError, validateOperationSpec } from "../src/operation_cli.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(CLI_DIR, "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ------------------------------------------------------------------ operation spec

test("examples/operation/isolate.json is a valid spec, and the isolation it declares is what allows its concurrency", () => {
  const spec = JSON.parse(read("examples", "operation", "isolate.json"));
  assert.doesNotThrow(() => validateOperationSpec(spec));
  assert.equal(spec.git.isolate, true);
  assert.ok(spec.policy.maxConcurrentUnits > 1);
  assert.ok(spec.policy.executionBudget.cpuMilli >= spec.units.reduce((sum: number, unit: any) => sum + unit.executionResources.cpuMilli, 0));
  assert.ok(spec.policy.executionBudget.memoryBytes >= spec.units.reduce((sum: number, unit: any) => sum + unit.executionResources.memoryBytes, 0));
  const without = { ...spec, git: undefined };
  assert.throws(() => validateOperationSpec(without), (e: Error) => e instanceof OperationSpecError && /git\.isolate/.test(e.message));
});

// ------------------------------------------------------------------ the action

/** The bodies of every `run: |` block in a workflow-style YAML file (the file has no other multi-line constructs we need). */
function runBlocks(yaml: string): string[] {
  const lines = yaml.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j].slice(indent + 2));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

test("action.yml: scripts hold no ${{ }} expressions (inputs arrive as env vars), parse as bash, and no credential is an input", () => {
  const yaml = read("action", "action.yml");
  const blocks = runBlocks(yaml);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.equal(block.includes("${{"), false, "an expression inside a run script would let an input be interpreted as shell");
    const check = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
  assert.match(yaml, /NEXUS_ACTION_PROMPT: \$\{\{ inputs\.prompt \}\}/);
  assert.doesNotMatch(yaml.split("\nruns:")[0], /^\s{2}(api-key|token|secret|password)[a-z-]*:/im, "credentials are passed through env, not inputs");
  assert.match(yaml, /--json/);
  assert.match(yaml, /exit "\$code"/);
});

// ------------------------------------------------------------------ running the scripts

interface Run { code: number | null; out: string; err: string }

async function runScript(script: string, env: Record<string, string>, gatewayReplies: Reply[], cwd = ROOT, endpointFromEnv = false): Promise<Run & { gatewayRequests: number }> {
  const gateway = await startGateway((n) => gatewayReplies[Math.min(n, gatewayReplies.length) - 1]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-example-home-"));
  const shim = path.join(home, "nexus");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${TSX}" "${path.join(CLI_DIR, "src", "index.ts")}" "$@"\n`, { mode: 0o755 });
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete clean[key];
  // Under `node --test` this variable turns a nested `node --test` (the examples' verifier) into a run of zero tests.
  delete clean.NODE_TEST_CONTEXT;
  try {
    const result = await new Promise<Run>((resolve) => {
      const child = spawn("bash", [script], {
        cwd,
        env: {
          ...clean,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_STATE_HOME: path.join(home, ".local", "state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
          NEXUS: shim,
          // The examples take options through NEXUS_ARGS; the action, like any CI job, reads the endpoint from the environment.
          ...(endpointFromEnv ? { LOCAL_LLM_ENDPOINT: gateway.url } : { NEXUS_ARGS: `-e ${gateway.url} -m m` }),
          ...env,
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    return { ...result, gatewayRequests: gateway.requests.length };
  } finally {
    await gateway.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const FIX = "printf 'exports.add = (a, b) => a + b;\\n' > add.js";
const fixAndComplete: Reply[] = [
  { kind: "tools", calls: [{ name: "run_command", args: { command: FIX } }] },
  { kind: "tools", calls: [{ name: "run_command", args: { command: "node --test" } }] },
  { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed add()" } }] },
  { kind: "text", content: "Done." },
];
const claimWithoutFixing: Reply[] = [
  { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed add() (it was not)" } }] },
  { kind: "text", content: "Done." },
];

test("examples/verified-completion: a real fix exits 0; a completion claim the verifier rejects does not", async () => {
  const good = await runScript(path.join(ROOT, "examples", "verified-completion", "run.sh"), {}, fixAndComplete);
  assert.equal(good.code, 0, `${good.out}\n${good.err}`.slice(-1500));
  assert.match(good.out, /nexus exit status: 0/);

  const bad = await runScript(path.join(ROOT, "examples", "verified-completion", "run.sh"), {}, claimWithoutFixing);
  assert.notEqual(bad.code, 0, "the verifier is the gate: claiming completion is not completing");
  assert.match(bad.out, /nexus exit status: [1-9]/);
});

test("examples/worktree: the task runs on its own branch and the starting branch is left alone", async () => {
  const run = await runScript(path.join(ROOT, "examples", "worktree", "run.sh"), {}, fixAndComplete);
  assert.equal(run.code, 0, `${run.out}\n${run.err}`.slice(-1500));
  assert.match(run.out, /branch fix-add holds the result; main is unchanged/);
});

/** The action's "Run Nexus" script, executed as GitHub would with its inputs as environment variables. */
async function runAction(env: Record<string, string>, replies: Reply[]): Promise<Run & { outputs: Record<string, string>; summary: string }> {
  const script = runBlocks(read("action", "action.yml"))[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-action-"));
  const file = path.join(dir, "run.sh");
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace);
  fs.cpSync(path.join(ROOT, "examples", "verified-completion", "project"), workspace, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: workspace });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "add", "-A"], { cwd: workspace });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "start"], { cwd: workspace });
  fs.writeFileSync(file, script);
  const outputs = path.join(dir, "outputs");
  const summary = path.join(dir, "summary");
  try {
    const result = await runScript(file, {
      NEXUS_ACTION_WORKSPACE: workspace,
      NEXUS_ACTION_TEMP: dir,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    }, replies, ROOT, true);
    const parsed = Object.fromEntries((fs.existsSync(outputs) ? fs.readFileSync(outputs, "utf8") : "").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    return { ...result, outputs: parsed, summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("action: a verified task sets success outputs and exits 0; a rejected one exits non-zero with success=false", async () => {
  const ok = await runAction({
    NEXUS_ACTION_PROMPT: "Fix add() in add.js so the test passes.",
    NEXUS_ACTION_VERIFIER: "node --test",
    NEXUS_ACTION_DELIVERABLES: "add.js\n",
    NEXUS_ACTION_MODEL: "m",
    NEXUS_ACTION_EXTRA_ARGS: "",
  }, fixAndComplete);
  assert.equal(ok.code, 0, `${ok.out}\n${ok.err}`.slice(-1500));
  assert.equal(ok.outputs.success, "true");
  assert.equal(ok.outputs["exit-code"], "0");
  assert.ok(ok.outputs["task-id"], "task id is reported");
  assert.match(ok.summary, /### Nexus: /);

  const bad = await runAction({
    NEXUS_ACTION_PROMPT: "Fix add() in add.js so the test passes.",
    NEXUS_ACTION_VERIFIER: "node --test",
    NEXUS_ACTION_DELIVERABLES: "add.js",
    NEXUS_ACTION_MODEL: "m",
  }, claimWithoutFixing);
  assert.notEqual(bad.code, 0);
  assert.notEqual(bad.outputs["exit-code"], "0");
  assert.notEqual(bad.outputs.success, "true");
});

test("action: a hostile prompt and option values are data, never shell", async () => {
  const marker = path.join(os.tmpdir(), `nexus-injected-${process.pid}`);
  fs.rmSync(marker, { force: true });
  const run = await runAction({
    NEXUS_ACTION_PROMPT: `"; touch ${marker}; echo "`,
    NEXUS_ACTION_VERIFIER: "node --test",
    NEXUS_ACTION_MODEL: `m"; touch ${marker}; echo "`,
  }, claimWithoutFixing);
  assert.equal(fs.existsSync(marker), false, `${run.out}\n${run.err}`.slice(-600));
});

// ------------------------------------------------------------------ sandbox profiles (SB-1)

test("examples/sandbox-profiles: the doctor shows each named profile and the refusal of a conflicting network flag, with no model", { timeout: 280_000 }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sb1-example-"));
  try {
    const shim = path.join(scratch, "nexus");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${TSX}" "${path.join(CLI_DIR, "src", "index.ts")}" "$@"\n`, { mode: 0o755 });
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(clean)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete clean[key];
    delete clean.NODE_TEST_CONTEXT;
    // HOME is replaced by the script itself; this one only keeps anything it reads before that away from the real one.
    const run = spawnSync("bash", [path.join(ROOT, "examples", "sandbox-profiles", "run.sh")], { encoding: "utf8", env: { ...clean, HOME: scratch, NEXUS: shim, NO_COLOR: "1" }, timeout: 260_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-1500));
    assert.match(run.stdout, /--- nexus --sandbox :workspace doctor\nprofile: :workspace \(--sandbox :workspace\)\nsandbox: :workspace \(auto, network off, --sandbox :workspace\)/);
    assert.match(run.stdout, /--- nexus --sandbox :read-only doctor\nprofile: :read-only \(--sandbox :read-only\)\nsandbox: :read-only \(bwrap, network off, --sandbox :read-only\)/);
    assert.match(run.stdout, /--- nexus --sandbox :network doctor\nprofile: :network \(--sandbox :network\)\nsandbox: :network \(auto, network on, --sandbox :network\)/);
    assert.match(run.stdout, /--- no profile named[^\n]*\nprofile: unconfined \(default \(no sandbox requested\)\)\nsandbox: off/);
    assert.match(run.stdout, /refused: --sandbox-network conflicts with --sandbox :workspace: this profile has no network\. Use --sandbox :network\./);
    assert.deepEqual(fs.readdirSync(scratch), ["nexus"], "the script wrote nothing into the HOME it was started with");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ attach (PF-3)

test("examples/attach: a second client attaches to a running session, a wrong token is refused, the observer sees the turn", async () => {
  const gateway = await startGateway(() => ({ kind: "text", content: "Hello." }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-attach-home-"));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-attach-run-"));
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete clean[key];
  delete clean.NODE_TEST_CONTEXT;
  try {
    const child = spawn(process.execPath, [path.join(ROOT, "examples", "attach", "attach.mjs")], {
      cwd: CLI_DIR, // `--import tsx` resolves from here
      env: { ...clean, HOME: home, XDG_RUNTIME_DIR: runtime, NEXUS_SIDECAR: path.join(CLI_DIR, "src", "sidecar.ts"), NEXUS_NODE_ARGS: "--import tsx", NEXUS_ARGS: `-e ${gateway.url} -m m` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    assert.equal(code, 0, `${out}\n${err}`.slice(-1500));
    assert.match(out, /wrong token: UNAUTHORIZED/);
    assert.match(out, /observer command: NOT_CONTROLLER/);
    assert.match(out, /observer saw turn t1: COMPLETED/);
    assert.deepEqual(fs.readdirSync(path.join(runtime, "nexus")), [], "the socket and descriptor were removed on exit");
  } finally {
    await gateway.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
