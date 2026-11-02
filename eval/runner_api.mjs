// Candidate invocation construction is shared with tests so boundary assertions exercise the payload the runner uses.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { candidateAgentPath } from "./isolate.mjs";
import { nexusContextLimitArgs } from "./validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function serializeAgentLaunchPayload(payload) {
  const serialized = JSON.stringify(payload);
  return payload.protocol ? `${serialized}\n` : serialized;
}

export function createAgentLaunchPayload({ task, config, agentIdentity, home, budget, localToken }) {
  const sampling = config.sampling ?? { temperature: 0.2 };
  const limits = config.limits ?? { context: 65536, output: 8192 };
  const forbiddenEnv = Object.keys(config.env ?? {}).find((key) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key));
  if (forbiddenEnv) throw new Error(`candidate configuration may not contain credential-like environment key ${forbiddenEnv}`);
  const ep = "http://127.0.0.1:40127/v1";
  const env = {
    PATH: candidateAgentPath(config.env?.PATH), LANG: config.env?.LANG ?? "C.UTF-8", LC_ALL: config.env?.LC_ALL ?? "C.UTF-8",
    TERM: config.env?.TERM ?? "dumb", HOME: "/home/eval", PWD: "/workspace", CI: "1",
    LOCAL_LLM_API_KEY: localToken, OPENAI_API_KEY: localToken, GW_KEY: localToken,
    XDG_CONFIG_HOME: "/home/eval/.config", XDG_DATA_HOME: "/home/eval/.local/share", XDG_STATE_HOME: "/home/eval/.local/state",
  };
  const agent = config.agent ?? "nexus";
  if (agent === "nexus") {
    if (task.t4Fixture) env.NEXUS_EVAL_TOOL_RECEIPTS = "1";
    env.LOCAL_LLM_ENDPOINT = ep;
    const contextArgs = nexusContextLimitArgs(config, limits.context);
    if (task.tier === "T3") {
      // T3 drives the sidecar, the operator channel that carries steering, with the same model, budgets and limits.
      const checkout = agentIdentity.argsPrefix[0] === path.join(ROOT, "cli/dist/index.js");
      // An installed package is <package>/bin/nexus with the sidecar at <package>/lib/cli/dist/sidecar.js.
      const packageDir = checkout ? null : path.dirname(path.dirname(fs.realpathSync(agentIdentity.command)));
      const sidecar = checkout ? path.join(ROOT, "cli/dist/sidecar.js") : path.join(packageDir, "lib/cli/dist/sidecar.js");
      if (!fs.existsSync(sidecar)) throw new Error(`T3 needs the Nexus sidecar at ${sidecar}`);
      if (packageDir) {
        // The launcher is bypassed, so the package itself must be mounted: it has to sit under sandboxRuntimeRoots.
        const roots = (config.sandboxRuntimeRoots ?? []).flatMap((root) => { try { return [fs.realpathSync(root)]; } catch { return []; } });
        if (!roots.some((root) => packageDir === root || packageDir.startsWith(`${root}${path.sep}`))) throw new Error(`T3 runs the sidecar from ${packageDir}, which must be under sandboxRuntimeRoots`);
        env.NEXUS_HOME = packageDir;
      }
      const sidecarArgs = [sidecar, "--yes", "-w", "/workspace", "-e", ep, "-m", config.model, "-t", String(sampling.temperature), "-s", "30", "--max-total-steps", String(budget.steps), "--max-turn-minutes", String(budget.minutes), ...contextArgs, ...(config.args ?? [])];
      return checkout ? { command: process.execPath, argv: sidecarArgs, env, protocol: true } : { command: "/usr/bin/env", argv: ["node", ...sidecarArgs], env, protocol: true };
    }
    return { command: agentIdentity.command, argv: [...agentIdentity.argsPrefix, "run", "--yes", "--json", "-w", "/workspace", "-e", ep, "-m", config.model, "-t", String(sampling.temperature), "-s", "30", "--max-total-steps", String(budget.steps), "--max-turn-minutes", String(budget.minutes), ...contextArgs, ...(config.args ?? []), task.objective], env };
  }
  if (agent === "aider") {
    return { command: agentIdentity.command, argv: ["--model", `openai/${config.model}`, "--openai-api-base", ep, "--yes-always", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore", "--no-show-model-warnings", "--no-check-update", "--analytics-disable", "--no-pretty", "--no-fancy-input", ...(config.args ?? []), "--message", task.objective], env };
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
    return { command: agentIdentity.command, argv: ["run", "--agent", "nexus-eval", "--model", `gw/${config.model}`, ...(config.args ?? []), task.objective], env };
  }
  if (agent === "goose") {
    const u = new URL(ep);
    Object.assign(env, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: config.model, OPENAI_HOST: u.origin, OPENAI_BASE_PATH: `${u.pathname.replace(/^\/|\/$/g, "")}/chat/completions`, GOOSE_MODE: "auto", GOOSE_DISABLE_KEYRING: "1", GOOSE_CONTEXT_LIMIT: String(limits.context), GOOSE_MAX_TOKENS: String(limits.output), GOOSE_MAX_TURNS: String(budget.steps), GOOSE_TEMPERATURE: String(sampling.temperature) });
    return { command: agentIdentity.command, argv: ["run", "--no-session", "--with-builtin", "developer", "--max-turns", String(budget.steps), ...(config.args ?? []), "-t", task.objective], env };
  }
  throw new Error(`agent ${agent} has no adapter`);
}

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(EVAL_DIR);
const RUNNER = path.join(EVAL_DIR, "run.mjs");
const SCORER = path.join(EVAL_DIR, "score.mjs");
const MAX_SCORE_OUTPUT_BYTES = 32 * 1024 * 1024;

function positiveInteger(value, name) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`${name} must be a positive whole number`);
  return Number(text);
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || !options.config || typeof options.config !== "object" || Array.isArray(options.config)) {
    throw new Error("runner API requires a config object");
  }
  if (options.config.agent && options.config.agent !== "nexus") throw new Error("runner API only accepts the Nexus agent");
  if (typeof options.nexusExecutable !== "string" || !path.isAbsolute(options.nexusExecutable)) {
    throw new Error("runner API requires an absolute installed Nexus executable path");
  }
  const nexusExecutable = fs.realpathSync(options.nexusExecutable);
  const executableStat = fs.statSync(nexusExecutable);
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) throw new Error("installed Nexus executable must be a regular executable file");
  let checkoutCli;
  try { checkoutCli = fs.realpathSync(path.join(REPO_ROOT, "cli/dist/index.js")); } catch {}
  if (checkoutCli === nexusExecutable) throw new Error("runner API must use the installed Nexus executable, not the checkout CLI");
  if (typeof options.dataset !== "string" || !options.dataset.trim()) throw new Error("runner API requires a versioned dataset path");
  const dataset = path.resolve(options.dataset);
  let datasetStat;
  try { datasetStat = fs.statSync(dataset); } catch { throw new Error("runner API dataset path does not exist"); }
  if (!datasetStat.isDirectory()) throw new Error("runner API dataset must be a versioned dataset directory");
  if (typeof options.outputDir !== "string" || !options.outputDir.trim()) throw new Error("runner API requires a new output directory");
  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) throw new Error("runner API output directory must not already exist");
  if (options.split !== undefined && !["regression", "benchmark"].includes(options.split)) throw new Error("split must be regression or benchmark");
  const runs = positiveInteger(options.runs ?? options.config.runs ?? 1, "runs");
  return { config: options.config, dataset, outputDir, nexusExecutable, runs, split: options.split };
}

function runProcess(script, args, { cwd, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: captureStdout ? ["ignore", "pipe", "ignore"] : "ignore",
      shell: false,
    });
    const chunks = [];
    let outputBytes = 0;
    let oversized = false;
    if (captureStdout) {
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_SCORE_OUTPUT_BYTES) {
          oversized = true;
          child.kill("SIGTERM");
          return;
        }
        chunks.push(chunk);
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (oversized) return reject(new Error("score output exceeded the runner API size limit"));
      if (code !== 0) return reject(new Error(`${path.basename(script)} failed (${code ?? signal ?? "unknown"})`));
      resolve(captureStdout ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
  });
}

function makeRunnerConfig(config, nexusExecutable, privateDir) {
  const result = { ...config, agent: "nexus", nexusExecutable };
  if (typeof result.apiKey === "string" && result.apiKey.length > 0) {
    if (/[\r\n]/.test(result.apiKey)) throw new Error("API key cannot contain newline characters");
    const apiKeyFile = path.join(privateDir, "api-key.env");
    fs.writeFileSync(apiKeyFile, `NEXUS_EVAL_API_KEY=${result.apiKey}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(apiKeyFile, 0o600);
    result.apiKey = { file: apiKeyFile, var: "NEXUS_EVAL_API_KEY" };
  }
  return result;
}

/** Runs a versioned dataset against an installed Nexus executable and scores after candidate completion. */
export async function runVersionedEvaluation(options, runtime = {}) {
  const normalized = validateOptions(options);
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-api-"));
  fs.chmodSync(privateDir, 0o700);
  const runnerConfigPath = path.join(privateDir, "config.json");
  try {
    const config = makeRunnerConfig(normalized.config, normalized.nexusExecutable, privateDir);
    fs.writeFileSync(runnerConfigPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(runnerConfigPath, 0o600);
    const runOptions = {
      runner: RUNNER,
      configPath: runnerConfigPath,
      dataset: normalized.dataset,
      outputDir: normalized.outputDir,
      runs: normalized.runs,
      split: normalized.split,
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
    };
    if (runtime.run) await runtime.run(runOptions);
    else {
      const args = ["--config", runnerConfigPath, "--out", normalized.outputDir, "--dataset", normalized.dataset, "--runs", String(normalized.runs)];
      if (normalized.split) args.push("--split", normalized.split);
      await runProcess(RUNNER, args, { cwd: runOptions.cwd });
    }

    const resultsFile = path.join(normalized.outputDir, "results.jsonl");
    const score = runtime.score
      ? await runtime.score(resultsFile)
      : JSON.parse(await runProcess(SCORER, [resultsFile, "--json"], { cwd: runOptions.cwd, captureStdout: true }));
    if (!score || typeof score !== "object" || Array.isArray(score)) throw new Error("score command must return a structured object");
    const scoreFile = path.join(normalized.outputDir, "score.json");
    fs.writeFileSync(scoreFile, `${JSON.stringify(score, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return {
      outputDir: normalized.outputDir,
      resultsFile,
      manifestFile: path.join(normalized.outputDir, "manifest.json"),
      scoreFile,
      score,
    };
  } finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}
