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
if (!args.config || !args.out) {
  console.error("usage: eval/run.mjs --config eval/configs/<name>.json --out <dir> [--tasks eval/tasks] [--only id,id] [--runs N]");
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
const tasksDir = path.resolve(args.tasks ?? path.join(ROOT, "eval/tasks"));
const runs = Number(args.runs ?? config.runs ?? 1);
const only = args.only ? new Set(String(args.only).split(",")) : null;
fs.mkdirSync(args.out, { recursive: true });
const resultsFile = path.join(args.out, "results.jsonl");

const identity = harnessIdentity();
const tasks = fs.readdirSync(tasksDir).filter((d) => fs.existsSync(path.join(tasksDir, d, "task.json")) && (!only || only.has(d))).sort();
fs.writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), harness: identity, config: redactConfig(config), runs, tasks, host: os.hostname(), node: process.version }, null, 2) + "\n");

for (const id of tasks) {
  const task = { ...JSON.parse(fs.readFileSync(path.join(tasksDir, id, "task.json"), "utf8")), dir: path.join(tasksDir, id) };
  for (let run = 1; run <= runs; run++) {
    const record = await runOnce(task, run);
    fs.appendFileSync(resultsFile, JSON.stringify(record) + "\n");
    console.log(`${id} run ${run}: ${record.turn?.outcome ?? record.error ?? "?"} hidden=${record.hiddenPass} regression=${record.regressionPass} ${Math.round(record.wallMs / 1000)}s`);
  }
}

async function runOnce(task, run) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-eval-${task.id}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-home-"));
  const base = { task: task.id, tier: task.tier, config: config.name, agent: config.agent ?? "nexus", run, harness: identity.string, model: config.model, startedAt: new Date().toISOString() };
  try {
    prepareWorkspace(task, ws);
    const started = Date.now();
    const agent = await runAgent(task, ws, home);
    const wallMs = Date.now() - started;
    const hidden = runCheck(task, ws, task.hidden, true);
    const regression = task.regression ? runCheck(task, ws, task.regression, false) : null;
    const turn = agent.json?.turn ?? null;
    const claimedComplete = turn?.execution === "COMPLETED" && ["VERIFIED", "REGRESSION_FREE", "UNVERIFIED", "NOT_REQUIRED"].includes(turn?.outcome);
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

function runAgent(task, ws, home) {
  const budget = { steps: task.steps ?? config.steps ?? 300, minutes: task.minutes ?? config.minutes ?? 120 };
  const argv =
    (config.agent ?? "nexus") === "nexus"
      ? [path.join(ROOT, "cli/dist/index.js"), "run", "--json", "-w", ws, "-e", config.endpoint, "-m", config.model, "-s", "30", "--max-total-steps", String(budget.steps), "--max-turn-minutes", String(budget.minutes), ...(config.args ?? []), task.objective]
      : null;
  if (!argv) throw new Error(`agent ${config.agent} has no adapter yet`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ws, env: { ...process.env, ...(config.env ?? {}), HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, (budget.minutes + 5) * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
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

function redactConfig(c) {
  const env = Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, /KEY|TOKEN|SECRET|PASSWORD/i.test(k) ? "***" : v]));
  return { ...c, env };
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
