#!/usr/bin/env node
// Runs evaluation tasks against an agent configuration and appends one JSON line per run (see eval/README.md).
// Each run gets a fresh workspace (the task's repository at its pinned commit, or its fixture), the agent runs with the
// task's budgets and a wall-clock timeout, then the task's hidden tests (never present while the agent runs) and its
// regression command are run in that workspace. Nothing is scored here: eval/score.mjs reads the JSON lines.
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startModelProxy } from "./model_proxy.mjs";
import { asUser, corpusManifestProblem, corpusTaskRows, fetchModelEntry, hiddenTestIsolationProblem, modelFingerprint, nexusLimitsProblem, qualificationBudgetProblem, taskTreeDigest, validateTask } from "./validate.mjs";
import { agentSandboxArgv, assertNoSymlinks, confinedPath, grantRunAsAccess, isolatedProcessArgv, runIsolated, runIsolatedProcess, sandboxAvailable } from "./isolate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.out) args.out = path.resolve(args.out); // agents run elsewhere: paths handed to them must be absolute
if (!args.config || !args.out) {
  console.error("usage: eval/run.mjs --config eval/configs/<name>.json --out <dir> [--tasks eval/tasks] [--only id,id] [--runs N]");
  process.exit(2);
}
const configBytes = fs.readFileSync(args.config);
const configSha256 = createHash("sha256").update(configBytes).digest("hex");
const config = JSON.parse(configBytes.toString("utf8"));
const tasksDir = path.resolve(args.tasks ?? path.join(ROOT, "eval/tasks"));
const runs = Number(args.runs ?? config.runs ?? 1);
const only = args.only ? new Set(String(args.only).split(",")) : null;
// --pairs "task run,task run": rerun exactly these (runs that failed on infrastructure; see eval/infra.mjs).
const pairs = args.pairs ? String(args.pairs).split(",").filter(Boolean).map((p) => p.trim().split(/\s+/)) : null;
fs.mkdirSync(path.dirname(args.out), { recursive: true });
try {
  fs.mkdirSync(args.out, { mode: 0o700 });
  fs.chmodSync(args.out, 0o700);
} catch (error) {
  if (error.code === "EEXIST") {
    console.error("eval/run.mjs: output directory must be new; refusing to overwrite or append to prior evidence");
    process.exit(2);
  }
  throw error;
}
const resultsFile = path.join(args.out, "results.jsonl");

const identity = harnessIdentity();
const availableTaskIds = fs.readdirSync(tasksDir).filter((d) => {
  const entry = path.join(tasksDir, d);
  try { return fs.lstatSync(entry).isDirectory() && fs.existsSync(path.join(entry, "task.json")); }
  catch { return false; }
}).sort();
const tasks = availableTaskIds.filter((d) => !only || only.has(d));
const taskSnapshots = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-task-snapshot-"));
fs.chmodSync(taskSnapshots, 0o700);
process.on("exit", () => fs.rmSync(taskSnapshots, { recursive: true, force: true }));
const taskRecords = [];
for (const id of tasks) {
  const source = confinedPath(tasksDir, id);
  assertNoSymlinks(source);
  const before = taskTreeDigest(source);
  const snapshot = path.join(taskSnapshots, id);
  fs.cpSync(source, snapshot, { recursive: true, verbatimSymlinks: true });
  if (taskTreeDigest(snapshot) !== before) throw new Error(`task ${id} changed while the runner froze its input`);
  const taskFile = confinedPath(snapshot, "task.json");
  taskRecords.push({ id, dir: snapshot, treeSha256: before, task: JSON.parse(fs.readFileSync(taskFile, "utf8")) });
}
if (config.qualification === true && only) {
  console.error("eval/run.mjs: qualification task subsets are forbidden; use a frozen corpus run or an explicitly recorded infrastructure-pair rerun");
  process.exit(2);
}
if (config.qualification === true && config.proxy === false) {
  console.error("eval/run.mjs: qualification requires the authenticated per-run model proxy");
  process.exit(2);
}
if (!sandboxAvailable()) {
  console.error("eval/run.mjs: Bubblewrap unavailable; refusing to execute task-controlled setup and validators");
  process.exit(2);
}
const apiKey = readApiKey(config.apiKey);
const caFile = config.caFile ? expandHome(config.caFile) : null;
const caBundle = caFile ? writeCaBundle(caFile) : null;

// A run is valid only with well-formed tasks, hidden tests the agent cannot read, and (for qualification) a model
// identified beyond its alias. Any problem stops the run before an agent starts (eval/validate.mjs).
const problems = taskRecords.flatMap(({ id, dir, task }) => {
  return validateTask(task, dir, { qualification: config.qualification === true }).map((p) => `${id}: ${p}`);
});
const isolation = hiddenTestIsolationProblem(config, tasksDir);
if (isolation) problems.push(isolation);
if (config.qualification === true) {
  const corpusProblem = corpusManifestProblem(config, tasksDir, tasks, corpusTaskRows(taskSnapshots, tasks));
  if (corpusProblem) problems.push(corpusProblem);
}
if (config.qualification === true && config.sampling?.temperature !== 0) {
  problems.push("qualification adapters require sampling.temperature=0 so the matched Nexus, Goose and OpenCode runs use the same deterministic setting");
}
if (config.qualification === true) {
  const budgetProblem = qualificationBudgetProblem(config);
  if (budgetProblem) problems.push(budgetProblem);
}
const agentIdentity = problems.length ? { record: null, problem: null } : await resolveAgentIdentity(config);
if (agentIdentity.problem) problems.push(agentIdentity.problem);
let fingerprint = null;
if (!problems.length) {
  const probe = config.proxy === false ? null : await startModelProxy({ upstream: config.endpoint, caFile });
  try {
    const entry = await fetchModelEntry(probe?.url ?? config.endpoint, config.model, apiKey);
    const fp = modelFingerprint(config, entry);
    fingerprint = fp.fingerprint;
    problems.push(...fp.missing.map((m) => `model fingerprint: ${m}`));
    if (config.qualification === true && (config.agent ?? "nexus") === "nexus") {
      const limitsProblem = nexusLimitsProblem(config, entry);
      if (limitsProblem) problems.push(limitsProblem);
    }
  } finally {
    await probe?.close();
  }
}
if (problems.length) {
  console.error(`eval/run.mjs: not starting; ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(2);
}
const frozenTaskRows = taskRecords.map(({ id }) => corpusTaskRows(taskSnapshots, [id])[0]);
fs.writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify({
  createdAt: new Date().toISOString(),
  harness: identity,
  config: redactConfig(config),
  configSha256,
  qualificationCorpus: config.qualification === true ? { manifestSha256: config.corpusManifestSha256, tasks: frozenTaskRows } : null,
  fingerprint,
  agentVersion: agentIdentity.record,
  budget: effectiveBudget({}, config),
  runs,
  tasks: frozenTaskRows,
  host: os.hostname(),
  node: process.version,
}, null, 2) + "\n");

// Run-major order (every task once, then again): a pass cut short still has the same number of runs per task.
for (let run = 1; run <= runs; run++) {
  for (const { id, dir, treeSha256, task: taskData } of taskRecords) {
    if (pairs && !pairs.some(([t, r]) => t === id && Number(r) === run)) continue;
    if (taskTreeDigest(dir) !== treeSha256) throw new Error(`frozen task ${id} changed after manifest creation`);
    const task = { ...taskData, dir };
    const record = await runOnce(task, run);
    fs.appendFileSync(resultsFile, JSON.stringify(record) + "\n");
    console.log(`${new Date().toISOString()} ${config.name} ${id} run ${run}: ${record.turn?.outcome ?? record.error ?? `exit ${record.exitCode}`} hidden=${record.hiddenPass} regression=${record.regressionPass} ${Math.round(record.wallMs / 1000)}s`);
  }
}

async function runOnce(task, run) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-eval-${task.id}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-home-"));
  const budget = effectiveBudget(task, config);
  const base = { task: task.id, tier: task.tier, config: config.name, agent: config.agent ?? "nexus", agentVersion: agentIdentity.record, budget, run, harness: identity.string, model: config.model, startedAt: new Date().toISOString() };
  try {
    await prepareWorkspace(task, ws);
    const sourceBefore = treeDigest(task.dir);
    // Every agent reaches the model through a per-run forwarder, so whether the model was reachable is observed by the
    // harness, the same way for every agent (eval/infra.mjs). `config.proxy: false` connects agents directly.
    // T4: a task (or the config) may schedule faults for the proxy to inject; they are recorded with the run.
    const faults = task.faults ?? config.faults ?? [];
    if (faults.length && config.proxy === false) throw new Error("fault injection needs the model proxy (proxy: false is set)");
    // A standalone profile (DEC-16) shows agents a plain server; the proxy then holds the real key, agents get none.
    if (config.serverProfile && config.proxy === false) throw new Error("serverProfile needs the model proxy (proxy: false is set)");
    const proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-proxy-"));
    fs.chmodSync(proxyDir, 0o700);
    const socketPath = path.join(proxyDir, "proxy.sock");
    const localToken = randomBytes(32).toString("hex");
    const proxy = await startModelProxy({
      upstream: config.endpoint,
      caFile,
      faults,
      profile: config.serverProfile,
      authToken: apiKey ?? undefined,
      clientToken: localToken,
      socketPath,
      maxRequests: config.limits?.requests ?? 1_000,
      maxCompletionTokens: config.limits?.output,
      maxTotalCompletionTokens: config.limits?.totalOutput,
    });
    const started = Date.now();
    let agent;
    try {
      agent = await runAgent(task, ws, home, budget, agentIdentity, proxyDir, localToken);
    } finally {
      await proxy?.close();
      fs.rmSync(proxyDir, { recursive: true, force: true });
    }
    const wallMs = Date.now() - started;
    const model = proxy ? proxy.stats() : null;
    const contaminated = treeDigest(task.dir) !== sourceBefore || `${agent.stdout}${agent.stderr}`.includes(tasksDir);
    const hidden = await runCheck(task, ws, task.hidden, true);
    const regression = task.regression ? await runCheck(task, ws, task.regression, false) : null;
    const turn = agent.json?.turn ?? null;
    // Nexus reports a structured outcome; for the other agents a clean exit within the budget is their completion claim.
    const claimedComplete = turn
      ? turn.execution === "COMPLETED" && ["VERIFIED", "REGRESSION_FREE", "UNVERIFIED", "NOT_REQUIRED"].includes(turn.outcome)
      : agent.code === 0 && !agent.timedOut && !agent.outputExceeded;
    return {
      ...base,
      wallMs,
      exitCode: agent.code,
      timedOut: agent.timedOut,
      outputExceeded: agent.outputExceeded,
      turn: turn && { execution: turn.execution, outcome: turn.outcome, reason: turn.reason ?? null, steps: turn.steps ?? null, contextNotRetained: turn.contextNotRetained ?? 0 },
      claimedComplete,
      claimedVerified: turn?.outcome === "VERIFIED",
      hiddenPass: hidden.pass,
      regressionPass: regression ? regression.pass : null,
      falseVerified: turn?.outcome === "VERIFIED" && !hidden.pass,
      contaminated,
      tokens: agent.json?.tokenStats ?? null,
      model,
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

async function prepareWorkspace(task, ws) {
  if (task.fixture) {
    const fixture = confinedPath(task.dir, task.fixture);
    assertNoSymlinks(fixture);
    fs.cpSync(fixture, ws, { recursive: true, verbatimSymlinks: true });
    sh("git", ["init", "-q"], ws);
    sh("git", ["add", "-A"], ws);
    sh("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-qm", "fixture"], ws);
  } else if (task.repo) {
    const cache = path.join(ROOT, "eval/.cache", createHash("sha256").update(task.repo.url).digest("hex").slice(0, 16));
    if (!fs.existsSync(cache)) sh("git", ["clone", "-q", "--no-checkout", task.repo.url, cache], ROOT);
    const object = `${task.repo.commit}^{commit}`;
    if (sh("git", ["-C", cache, "cat-file", "-e", object], ROOT, true) !== 0) sh("git", ["-C", cache, "fetch", "-q", "origin", task.repo.commit], ROOT);
    sh("git", ["clone", "-q", "--shared", cache, ws], ROOT);
    sh("git", ["-C", ws, "checkout", "-q", task.repo.commit], ROOT);
  } else throw new Error(`task ${task.id} has neither fixture nor repo`);
  for (const cmd of task.setup ?? []) {
    const result = await runIsolated(cmd, { cwd: ws, home: true, timeoutSec: task.setupTimeoutSec ?? 300 });
    if (result.status !== 0 || result.timedOut || result.overflow) throw new Error(`isolated setup failed for ${task.id}: ${result.timedOut ? "timeout" : result.overflow ? "output limit" : `exit ${result.status}`}`);
  }
}

/**
 * The command line and environment for one agent run. Each agent gets a fresh HOME holding only its gateway settings
 * (no operator plugins, extensions or memory), the same endpoint and model, and the key through its environment.
 */
function effectiveBudget(task, config) {
  return { steps: task.steps ?? config.steps ?? 300, minutes: task.minutes ?? config.minutes ?? 120 };
}

async function resolveAgentIdentity(config) {
  const agent = config.agent ?? "nexus";
  let command;
  let argsPrefix = [];
  if (agent === "nexus") {
    if (config.qualification === true) {
      if (typeof config.nexusExecutable !== "string" || !path.isAbsolute(config.nexusExecutable)) {
        return { record: null, problem: "qualification requires nexusExecutable to be the absolute path of the installed RC" };
      }
      if (typeof config.expectedAgentVersion !== "string" || !config.expectedAgentVersion.trim()) {
        return { record: null, problem: "qualification requires expectedAgentVersion to pin the installed RC" };
      }
      if (!/^[0-9a-f]{64}$/.test(config.nexusPackageSha256 ?? "")) {
        return { record: null, problem: "qualification requires nexusPackageSha256 from the installed RC release asset" };
      }
      command = path.resolve(config.nexusExecutable);
      try {
        if (fs.realpathSync(command) === fs.realpathSync(path.join(ROOT, "cli/dist/index.js"))) {
          return { record: null, problem: "qualification must use the installed RC, not the checkout cli/dist/index.js" };
        }
      } catch {}
    } else {
      command = process.execPath;
      argsPrefix = [path.join(ROOT, "cli/dist/index.js")];
    }
  } else if (["goose", "opencode", "aider"].includes(agent)) {
    command = resolvePathExecutable(agent, { ...process.env, ...(config.env ?? {}) }) ?? agent;
  } else {
    return { record: null, problem: `eval agent '${agent}' has no versioned adapter` };
  }

  const required = config.qualification === true || config.expectedAgentVersion !== undefined;
  let candidatePath;
  try { candidatePath = fs.realpathSync(command); }
  catch (error) { return { record: null, problem: required ? `could not identify ${agent} executable (${error.message})` : null, command, argsPrefix }; }
  argsPrefix = argsPrefix.map((item) => path.isAbsolute(item) ? fs.realpathSync(item) : item);
  const probeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-version-workspace-"));
  let probe;
  try {
    const runtimePaths = [candidatePath, ...argsPrefix.filter((item) => path.isAbsolute(item)).map((item) => fs.realpathSync(item))];
    const isCheckoutNexus = agent === "nexus" && argsPrefix[0] === path.join(ROOT, "cli/dist/index.js");
    if (isCheckoutNexus) {
      runtimePaths.push(path.join(ROOT, "cli/dist"));
      const modules = path.join(ROOT, "cli/node_modules");
      if (fs.existsSync(modules)) {
        for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== ".bin") runtimePaths.push(path.join(modules, entry.name));
        }
      }
      const coreBinary = path.join(ROOT, "core/target/release/harness-core");
      if (fs.existsSync(coreBinary)) runtimePaths.push(coreBinary);
    }
    const allowedRoots = [...new Set([...(config.sandboxRuntimeRoots ?? []), ...(isCheckoutNexus ? [ROOT] : [])])];
    const spec = isolatedProcessArgv({
      cwd: probeWorkspace,
      command: candidatePath,
      argv: [...argsPrefix, "--version"],
      readOnlyPaths: [...new Set(runtimePaths)],
      allowedRoots,
      allowedFiles: [candidatePath, ...argsPrefix.filter((item) => path.isAbsolute(item))],
      timeoutMs: 5000,
    });
    const wrapped = config.runAs ? asUser(config.runAs, spec.cmd, spec.argv, {}) : spec;
    probe = await runIsolatedProcess(wrapped, { outputLimit: 4096 });
  } finally {
    fs.rmSync(probeWorkspace, { recursive: true, force: true });
  }
  const output = `${probe?.stdout ?? ""}${probe?.stderr ?? ""}`.trim();
  const version = output.split(/\r?\n/, 1)[0]?.trim().slice(0, 200) || null;
  if (probe?.error || probe?.status !== 0 || probe?.timedOut || probe?.overflow || !version) {
    const reason = probe?.error ?? (probe?.timedOut ? "timeout" : probe?.overflow ? "output limit exceeded" : `exit ${probe?.status ?? "unknown"}`);
    return { record: null, problem: required ? `could not identify ${agent} version (${reason})` : null, command, argsPrefix };
  }

  const versionMatch = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\b)/.exec(version);
  const expected = typeof config.expectedAgentVersion === "string" ? config.expectedAgentVersion.replace(/^v/, "") : null;
  if (expected && versionMatch?.[1] !== expected) {
    const label = agent === "nexus" ? "installed Nexus" : agent;
    const kind = agent === "nexus" ? "expected RC" : "expected version";
    return { record: null, problem: `${label} version ${versionMatch?.[1] ?? version} does not match ${kind} ${expected}`, command, argsPrefix };
  }

  let executablePath;
  let executableSha256;
  try {
    executablePath = agent === "nexus" && argsPrefix.length ? fs.realpathSync(argsPrefix[0]) : fs.realpathSync(command);
    executableSha256 = await sha256File(executablePath);
  } catch (err) {
    if (required) return { record: null, problem: `could not hash ${agent} executable (${err.message})`, command, argsPrefix };
  }
  return {
    record: {
      agent,
      version,
      ...(executablePath ? { executablePath } : {}),
      ...(executableSha256 ? { executableSha256 } : {}),
      ...(agent === "nexus" && config.qualification === true ? { packageSha256: config.nexusPackageSha256 } : {}),
    },
    command,
    argsPrefix,
  };
}

function resolvePathExecutable(command, env) {
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {}
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function agentCommand(task, ws, home, budget, agentIdentity, localToken) {
  const sampling = config.sampling ?? { temperature: 0.2 };
  const limits = config.limits ?? { context: 65536, output: 8192 };
  const forbiddenEnv = Object.keys(config.env ?? {}).find((key) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key));
  if (forbiddenEnv) throw new Error(`candidate configuration may not contain credential-like environment key ${forbiddenEnv}`);
  const ep = "http://127.0.0.1:40127/v1";
  const env = {
    PATH: config.env?.PATH ?? "/usr/bin:/bin", LANG: config.env?.LANG ?? "C.UTF-8", LC_ALL: config.env?.LC_ALL ?? "C.UTF-8",
    TERM: config.env?.TERM ?? "dumb", HOME: "/home/eval", PWD: "/workspace", CI: "1",
    LOCAL_LLM_API_KEY: localToken, OPENAI_API_KEY: localToken, GW_KEY: localToken,
    XDG_CONFIG_HOME: "/home/eval/.config", XDG_DATA_HOME: "/home/eval/.local/share", XDG_STATE_HOME: "/home/eval/.local/state",
  };
  const agent = config.agent ?? "nexus";
  if (agent === "nexus") {
    env.LOCAL_LLM_ENDPOINT = ep;
    const contextArgs = limits.context ? ["--context-limit", String(limits.context)] : [];
    return { cmd: agentIdentity.command, argv: [...agentIdentity.argsPrefix, "run", "--yes", "--json", "-w", "/workspace", "-e", ep, "-m", config.model, "-t", String(sampling.temperature), "-s", "30", "--max-total-steps", String(budget.steps), "--max-turn-minutes", String(budget.minutes), ...contextArgs, ...(config.args ?? []), task.objective], env };
  }
  if (agent === "aider") {
    return { cmd: agentIdentity.command, argv: ["--model", `openai/${config.model}`, "--openai-api-base", ep, "--yes-always", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--no-show-model-warnings", "--no-check-update", "--analytics-disable", "--no-pretty", "--no-fancy-input", ...(config.args ?? []), "--message", task.objective], env };
  }
  if (agent === "opencode") {
    const dir = path.join(home, ".config/opencode");
    fs.mkdirSync(dir, { recursive: true });
    const modelOptions = { temperature: sampling.temperature, ...(sampling.seed !== undefined ? { seed: sampling.seed } : {}) };
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      permission: { edit: "allow", bash: "allow", webfetch: "deny" },
      agent: { "nexus-eval": { mode: "primary", steps: budget.steps } },
      provider: { gw: { npm: "@ai-sdk/openai-compatible", name: "gateway", options: { baseURL: ep, apiKey: "{env:GW_KEY}" }, models: { [config.model]: { name: config.model, limit: limits, options: modelOptions } } } },
      model: `gw/${config.model}`,
    }, null, 2));
    // Provider packages are cached across runs (not per run): the cache holds code, not state.
    env.XDG_CACHE_HOME = path.join(home, ".cache");
    return { cmd: agentIdentity.command, argv: ["run", "--agent", "nexus-eval", "--model", `gw/${config.model}`, ...(config.args ?? []), task.objective], env };
  }
  if (agent === "goose") {
    const u = new URL(ep);
    Object.assign(env, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: config.model, OPENAI_HOST: u.origin, OPENAI_BASE_PATH: `${u.pathname.replace(/^\/|\/$/g, "")}/chat/completions`, GOOSE_MODE: "auto", GOOSE_DISABLE_KEYRING: "1", GOOSE_CONTEXT_LIMIT: String(limits.context), GOOSE_MAX_TOKENS: String(limits.output), GOOSE_MAX_TURNS: String(budget.steps), GOOSE_TEMPERATURE: String(sampling.temperature) });
    return { cmd: agentIdentity.command, argv: ["run", "--no-session", "--with-builtin", "developer", "--max-turns", String(budget.steps), ...(config.args ?? []), "-t", task.objective], env };
  }
  throw new Error(`agent ${agent} has no adapter`);
}

function runAgent(task, ws, home, budget, agentIdentity, proxyDirectory, localToken) {
  const { cmd, argv, env } = agentCommand(task, ws, home, budget, agentIdentity, localToken);
  if (config.qualification === true && !config.runAs) throw new Error("qualification candidate execution requires the dedicated evaluator account");
  if (config.runAs) grantRunAsAccess(config.runAs, [ws, home, proxyDirectory]);
  const runtimePaths = [fs.realpathSync(cmd), ...agentIdentity.argsPrefix.filter((item) => path.isAbsolute(item)), ...(config.sandboxRuntimePaths ?? [])];
  if ((config.agent ?? "nexus") === "nexus" && agentIdentity.argsPrefix[0] === path.join(ROOT, "cli/dist/index.js")) {
    runtimePaths.push(path.join(ROOT, "cli/dist"));
    const modules = path.join(ROOT, "cli/node_modules");
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== ".bin") runtimePaths.push(path.join(modules, entry.name));
    }
    const coreBinary = path.join(ROOT, "core/target/release/harness-core");
    if (fs.existsSync(coreBinary)) runtimePaths.push(coreBinary);
  }
  const sandboxRuntimePaths = [...new Set(runtimePaths)];
  const allowedRuntimeRoots = [...new Set([...(config.sandboxRuntimeRoots ?? []), ...((config.agent ?? "nexus") === "nexus" && agentIdentity.argsPrefix[0] === path.join(ROOT, "cli/dist/index.js") ? [ROOT] : [])])];
  const sandbox = agentSandboxArgv({ cwd: ws, home, proxyDirectory, readOnlyPaths: sandboxRuntimePaths, allowedRuntimeRoots, runtimeExecutablePaths: [cmd, ...agentIdentity.argsPrefix], supervisorPath: path.join(ROOT, "eval/agent_sandbox.mjs") });
  const wrapped = config.runAs ? asUser(config.runAs, sandbox.cmd, sandbox.argv, {}) : sandbox;
  return new Promise((resolve) => {
    const child = spawn(wrapped.cmd, wrapped.argv, { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdin.end(JSON.stringify({ command: cmd, argv, env }));
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputExceeded = false;
    let outputBytes = 0;
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 2_000_000) {
        outputExceeded = true;
        killGroup("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.removeAllListeners("data");
    child.stderr.removeAllListeners("data");
    child.stdout.on("data", (c) => collect("stdout", c));
    child.stderr.on("data", (c) => collect("stderr", c));
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
      resolve({ code, timedOut, outputExceeded, stdout, stderr, json: lastJson(stdout) });
    });
  });
}

function runCheck(task, ws, check, hidden) {
  if (hidden && check.dir) {
    const source = confinedPath(task.dir, check.dir);
    assertNoSymlinks(source);
    const relativeTarget = check.into ?? check.dir;
    const destination = confinedPath(ws, relativeTarget, { allowMissingLeaf: true });
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
  return runIsolated(check.command, { cwd: ws, home: true, timeoutSec: check.timeoutSec ?? 300, outputLimit: 1_000_000 })
    .then((r) => ({ pass: r.status === 0 && !r.timedOut && !r.overflow, status: r.status, timedOut: r.timedOut, overflow: r.overflow, output: `${r.stdout}${r.stderr}`.slice(-20_000) }));
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
  return taskTreeDigest(dir);
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
  const commit = git("rev-parse", "HEAD");
  const dirty = Boolean(git("status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)cli/dist"));
  const sourceFiles = ["eval/run.mjs", "eval/validate.mjs", "eval/isolate.mjs", "eval/agent_sandbox.mjs", "eval/model_proxy.mjs", "eval/score.mjs", "eval/infra.mjs"];
  const sourceDigests = sourceFiles.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex") }));
  const sourceSha256 = createHash("sha256").update(JSON.stringify(sourceDigests)).digest("hex");
  return { commit, dirty, sourceDigests, sourceSha256, string: `${commit.slice(0, 12)}${dirty ? "-dirty" : ""}` };
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

function sh(command, argv, cwd, allowFailure = false) {
  const r = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" },
  });
  if (r.status !== 0 && !allowFailure) throw new Error(`${path.basename(command)} failed (${r.status ?? "signal"}): ${(r.stderr || r.stdout || "").slice(-2000)}`);
  return r.status;
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
