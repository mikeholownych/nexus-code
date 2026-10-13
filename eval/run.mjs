#!/usr/bin/env node
// Runs evaluation tasks against an agent configuration and appends one JSON line per run (see eval/README.md).
// Each run gets a fresh workspace (the task's repository at its pinned commit, or its fixture), the agent runs with the
// task's budgets and a wall-clock timeout, then the task's hidden tests (never present while the agent runs) and its
// regression command are run in that workspace. Nothing is scored here: eval/score.mjs reads the JSON lines.
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.out) args.out = path.resolve(args.out); // agents run elsewhere: paths handed to them must be absolute
if (!args.config || !args.out) {
  console.error("usage: eval/run.mjs --config eval/configs/<name>.json --out <dir> [--tasks eval/tasks] [--only id,id] [--runs N]");
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
const tasksDir = path.resolve(args.tasks ?? path.join(ROOT, "eval/tasks"));
const runs = Number(args.runs ?? config.runs ?? 1);
const only = args.only ? new Set(String(args.only).split(",")) : null;
// --pairs "task run,task run": rerun exactly these (runs that failed on infrastructure; see eval/infra.mjs).
const pairs = args.pairs ? String(args.pairs).split(",").filter(Boolean).map((p) => p.trim().split(/\s+/)) : null;
fs.mkdirSync(args.out, { recursive: true });
const resultsFile = path.join(args.out, "results.jsonl");

const identity = harnessIdentity();
const tasks = fs.readdirSync(tasksDir).filter((d) => fs.existsSync(path.join(tasksDir, d, "task.json")) && (!only || only.has(d))).sort();
fs.writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), harness: identity, config: redactConfig(config), runs, tasks, host: os.hostname(), node: process.version }, null, 2) + "\n");

// Run-major order (every task once, then again): a pass cut short still has the same number of runs per task.
const apiKey = readApiKey(config.apiKey);
const caFile = config.caFile ? expandHome(config.caFile) : null;
const caBundle = caFile ? writeCaBundle(caFile) : null;
for (let run = 1; run <= runs; run++) {
  for (const id of tasks) {
    if (pairs && !pairs.some(([t, r]) => t === id && Number(r) === run)) continue;
    const task = { ...JSON.parse(fs.readFileSync(path.join(tasksDir, id, "task.json"), "utf8")), dir: path.join(tasksDir, id) };
    const record = await runOnce(task, run);
    fs.appendFileSync(resultsFile, JSON.stringify(record) + "\n");
    console.log(`${new Date().toISOString()} ${config.name} ${id} run ${run}: ${record.turn?.outcome ?? record.error ?? `exit ${record.exitCode}`} hidden=${record.hiddenPass} regression=${record.regressionPass} ${Math.round(record.wallMs / 1000)}s`);
  }
}

async function runOnce(task, run) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-eval-${task.id}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-home-"));
  const base = { task: task.id, tier: task.tier, config: config.name, agent: config.agent ?? "nexus", run, harness: identity.string, model: config.model, startedAt: new Date().toISOString() };
  try {
    prepareWorkspace(task, ws);
    const sourceBefore = treeDigest(task.dir);
    const started = Date.now();
    const agent = await runAgent(task, ws, home);
    const wallMs = Date.now() - started;
    // Agents run as the operator's user, so the task sources (hidden tests included) are readable; a run that changed
    // them or names their path is marked contaminated rather than silently scored.
    const contaminated = treeDigest(task.dir) !== sourceBefore || `${agent.stdout}${agent.stderr}`.includes(tasksDir);
    const hidden = runCheck(task, ws, task.hidden, true);
    const regression = task.regression ? runCheck(task, ws, task.regression, false) : null;
    const turn = agent.json?.turn ?? null;
    // Nexus reports a structured outcome; for the other agents a clean exit within the budget is their completion claim.
    const claimedComplete = turn
      ? turn.execution === "COMPLETED" && ["VERIFIED", "REGRESSION_FREE", "UNVERIFIED", "NOT_REQUIRED"].includes(turn.outcome)
      : agent.code === 0 && !agent.timedOut;
    return {
      ...base,
      wallMs,
      exitCode: agent.code,
      timedOut: agent.timedOut,
      turn: turn && { execution: turn.execution, outcome: turn.outcome, reason: turn.reason ?? null, steps: turn.steps ?? null, contextNotRetained: turn.contextNotRetained ?? 0 },
      claimedComplete,
      claimedVerified: turn?.outcome === "VERIFIED",
      hiddenPass: hidden.pass,
      regressionPass: regression ? regression.pass : null,
      falseVerified: turn?.outcome === "VERIFIED" && !hidden.pass,
      contaminated,
      tokens: agent.json?.tokenStats ?? null,
      logs: saveLogs(task, run, agent, hidden, regression),
    };
  } catch (err) {
    return { ...base, wallMs: 0, error: String(err?.message ?? err), hiddenPass: false, regressionPass: null, falseVerified: false, claimedComplete: false, claimedVerified: false };
  } finally {
    if (!args.keep) {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

function prepareWorkspace(task, ws) {
  if (task.fixture) {
    fs.cpSync(path.join(task.dir, task.fixture), ws, { recursive: true });
    sh("git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture", ws);
  } else if (task.repo) {
    const cache = path.join(ROOT, "eval/.cache", createHash("sha256").update(task.repo.url).digest("hex").slice(0, 16));
    if (!fs.existsSync(cache)) sh(`git clone -q --no-checkout ${shellQuote(task.repo.url)} ${shellQuote(cache)}`, ROOT);
    sh(`git -C ${shellQuote(cache)} cat-file -e ${task.repo.commit}^{commit} || git -C ${shellQuote(cache)} fetch -q origin ${task.repo.commit}`, ROOT);
    sh(`git clone -q --shared ${shellQuote(cache)} ${shellQuote(ws)} && git -C ${shellQuote(ws)} checkout -q ${task.repo.commit}`, ROOT);
  } else throw new Error(`task ${task.id} has neither fixture nor repo`);
  for (const cmd of task.setup ?? []) sh(cmd, ws);
}

/**
 * The command line and environment for one agent run. Each agent gets a fresh HOME holding only its gateway settings
 * (no operator plugins, extensions or memory), the same endpoint and model, and the key through its environment.
 */
function agentCommand(task, ws, home, budget) {
  const ep = config.endpoint;
  const keyEnv = apiKey ? { LOCAL_LLM_API_KEY: apiKey, OPENAI_API_KEY: apiKey, GW_KEY: apiKey } : {};
  const caEnv = caBundle ? { NODE_EXTRA_CA_CERTS: caFile, SSL_CERT_FILE: caBundle, REQUESTS_CA_BUNDLE: caBundle } : {};
  // PWD too: some agents take the project from $PWD rather than the process's working directory.
  const env = { ...process.env, ...(config.env ?? {}), ...keyEnv, ...caEnv, HOME: home, PWD: ws, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state") };
  const agent = config.agent ?? "nexus";
  if (agent === "nexus") {
    env.LOCAL_LLM_ENDPOINT = ep;
    return { cmd: process.execPath, argv: [path.join(ROOT, "cli/dist/index.js"), "run", "--json", "-w", ws, "-e", ep, "-m", config.model, "-s", "30", "--max-total-steps", String(budget.steps), "--max-turn-minutes", String(budget.minutes), ...(config.args ?? []), task.objective], env };
  }
  if (agent === "aider") {
    return { cmd: "aider", argv: ["--model", `openai/${config.model}`, "--openai-api-base", ep, "--yes-always", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--no-show-model-warnings", "--no-check-update", "--analytics-disable", "--no-pretty", "--no-fancy-input", ...(config.args ?? []), "--message", task.objective], env };
  }
  if (agent === "opencode") {
    const dir = path.join(home, ".config/opencode");
    fs.mkdirSync(dir, { recursive: true });
    const limits = config.limits ?? { context: 65536, output: 8192 };
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      permission: { edit: "allow", bash: "allow", webfetch: "deny" },
      provider: { gw: { npm: "@ai-sdk/openai-compatible", name: "gateway", options: { baseURL: ep, apiKey: "{env:GW_KEY}" }, models: { [config.model]: { name: config.model, limit: limits } } } },
      model: `gw/${config.model}`,
    }, null, 2));
    // Provider packages are cached across runs (not per run): the cache holds code, not state.
    env.XDG_CACHE_HOME = path.join(ROOT, "eval/.cache/xdg-cache");
    return { cmd: "opencode", argv: ["run", "--model", `gw/${config.model}`, ...(config.args ?? []), task.objective], env };
  }
  if (agent === "goose") {
    const u = new URL(ep);
    Object.assign(env, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: config.model, OPENAI_HOST: u.origin, OPENAI_BASE_PATH: `${u.pathname.replace(/^\/|\/$/g, "")}/chat/completions`, GOOSE_MODE: "auto", GOOSE_DISABLE_KEYRING: "1", GOOSE_CONTEXT_LIMIT: String(config.limits?.context ?? 65536) });
    return { cmd: "goose", argv: ["run", "--no-session", "--with-builtin", "developer", ...(config.args ?? []), "-t", task.objective], env };
  }
  throw new Error(`agent ${agent} has no adapter`);
}

function runAgent(task, ws, home) {
  const budget = { steps: task.steps ?? config.steps ?? 300, minutes: task.minutes ?? config.minutes ?? 120 };
  const { cmd, argv, env } = agentCommand(task, ws, home, budget);
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let timedOut = false;
    // The whole process group: agents start helpers (servers, shells) that must not outlive the run.
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, (budget.minutes + 5) * 60_000);
    child.on("error", (err) => (stderr += `spawn error: ${err.message}\n`));
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup("SIGKILL");
      resolve({ code, timedOut, stdout, stderr, json: lastJson(stdout) });
    });
  });
}

function runCheck(task, ws, check, hidden) {
  if (hidden && check.dir) fs.cpSync(path.join(task.dir, check.dir), path.join(ws, check.into ?? check.dir), { recursive: true });
  const r = spawnSync("bash", ["-c", check.command], { cwd: ws, encoding: "utf8", timeout: (check.timeoutSec ?? 300) * 1000, env: { ...process.env, CI: "1" } });
  return { pass: r.status === 0, status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-20_000) };
}

function saveLogs(task, run, agent, hidden, regression) {
  const dir = path.join(args.out, "logs", `${task.id}-${run}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.stdout.json"), agent.stdout);
  fs.writeFileSync(path.join(dir, "agent.stderr.log"), agent.stderr.slice(-200_000));
  fs.writeFileSync(path.join(dir, "hidden.log"), hidden.output);
  if (regression) fs.writeFileSync(path.join(dir, "regression.log"), regression.output);
  return path.relative(args.out, dir);
}

function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      hash.update(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
      else hash.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function lastJson(text) {
  const start = text.indexOf("{");
  for (let i = start; i >= 0 && i < text.length; i = text.indexOf("{", i + 1)) {
    try {
      return JSON.parse(text.slice(i));
    } catch {}
  }
  return null;
}

function harnessIdentity() {
  const git = (...a) => spawnSync("git", a, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const commit = git("rev-parse", "--short=12", "HEAD");
  const dirty = Boolean(git("status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)cli/dist"));
  return { commit, dirty, string: `${commit}${dirty ? "-dirty" : ""}` };
}

/** `{ file, var }`: the key is read from a KEY=value file (e.g. ~/.config/nexus/config.env); never logged. */
function readApiKey(spec) {
  if (!spec) return null;
  const file = expandHome(spec.file);
  const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${spec.var}=`));
  if (!line) throw new Error(`${spec.var} not found in ${spec.file}`);
  return line.slice(spec.var.length + 1).trim();
}

/** System CAs plus the gateway's CA, for agents that read SSL_CERT_FILE / REQUESTS_CA_BUNDLE (Python, Rust). */
function writeCaBundle(caFile) {
  const system = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find((f) => fs.existsSync(f));
  const bundle = path.join(args.out, "ca-bundle.pem");
  fs.writeFileSync(bundle, (system ? fs.readFileSync(system, "utf8") : "") + "\n" + fs.readFileSync(caFile, "utf8"));
  return bundle;
}

function redactConfig(c) {
  const env = Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, /KEY|TOKEN|SECRET|PASSWORD/i.test(k) ? "***" : v]));
  return { ...c, env };
}

function expandHome(f) {
  return f.replace(/^~(?=\/)/, os.homedir());
}

function sh(cmd, cwd) {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, "");
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
