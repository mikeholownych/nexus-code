import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "./types.js";

export interface VersionedEvalCommandOptions {
  dataset?: string;
  output?: string;
  runs?: string | number;
  limit?: string | number;
  maxMinutes?: string | number;
  split?: "regression" | "benchmark";
  workspace?: string;
  maxSteps?: string | number;
  temperature?: string | number;
}

export interface VersionedEvalRuntimeResolver {
  packageRoot: string;
  nexusExecutable: string;
  runnerApiPath: string;
}

export interface VersionedEvalRunnerResult {
  outputDir: string;
  resultsFile: string;
  manifestFile: string;
  scoreFile: string;
  score: Record<string, unknown>;
}

function positiveInteger(value: string | number | undefined, option: string, fallback: number): number {
  if (value === undefined) return fallback;
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${option} must be a positive whole number`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} exceeds the supported integer range`);
  return parsed;
}

export function resolveInstalledEvalRuntime(env: NodeJS.ProcessEnv = process.env): VersionedEvalRuntimeResolver {
  if (!env.NEXUS_HOME || !path.isAbsolute(env.NEXUS_HOME)) {
    throw new Error("versioned evaluation requires the installed Nexus launcher (NEXUS_HOME is unavailable)");
  }
  const packageRoot = fs.realpathSync(env.NEXUS_HOME);
  const isWithinPackage = (candidate: string) => candidate === packageRoot || candidate.startsWith(`${packageRoot}${path.sep}`);
  const nexusExecutable = fs.realpathSync(path.join(packageRoot, "bin", "nexus"));
  if (!isWithinPackage(nexusExecutable)) throw new Error("installed Nexus launcher resolves outside NEXUS_HOME");
  const executableStat = fs.statSync(nexusExecutable);
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
    throw new Error("installed Nexus launcher is not executable");
  }
  const runnerApiPath = fs.realpathSync(path.join(packageRoot, "eval", "runner_api.mjs"));
  if (!isWithinPackage(runnerApiPath) || !fs.statSync(runnerApiPath).isFile()) {
    throw new Error("installed evaluator runtime is incomplete or resolves outside NEXUS_HOME");
  }
  return { packageRoot, nexusExecutable, runnerApiPath };
}

/** Global options that consume the next token (`<value>`); the program enables positional options, so these can only precede the subcommand. */
export const GLOBAL_VALUE_OPTIONS = new Set([
  "-e", "--endpoint", "-m", "--model", "-w", "--workspace", "-s", "--max-steps", "--max-total-steps", "--max-turn-minutes",
  "--stagnation-steps", "-t", "--temperature", "--mode", "--shell", "--fallback", "--context-limit", "--authoritative-verifier",
  "--deliverable-file", "--planner-model", "--planner-endpoint", "--coder-model", "--coder-endpoint", "--provider", "--base-url",
  "--planner-provider", "--coder-provider",
]);
/** Global options whose value is optional: Commander takes the next token as the value unless it starts with `-`. */
export const GLOBAL_OPTIONAL_VALUE_OPTIONS = new Set(["-r", "--resume", "--sandbox"]);

/** The subcommand token: the first argument that is neither a global option nor that option's value. */
export function firstCommandToken(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // After `--` every token is an operand of the default command, never a subcommand.
    if (arg === "--") return undefined;
    if (!arg.startsWith("-")) return arg;
    if (arg.includes("=")) continue;
    const takesNext = (flag: string) => args[i + 1] !== undefined && (GLOBAL_VALUE_OPTIONS.has(flag) || (GLOBAL_OPTIONAL_VALUE_OPTIONS.has(flag) && !args[i + 1].startsWith("-")));
    if (/^-[^-]{2,}$/.test(arg)) {
      // Clustered short flags (-yw /x): the first flag that takes a value ends the cluster, attached text being its value.
      for (let c = 1; c < arg.length; c++) {
        const flag = `-${arg[c]}`;
        if (!GLOBAL_VALUE_OPTIONS.has(flag) && !GLOBAL_OPTIONAL_VALUE_OPTIONS.has(flag)) continue;
        if (c === arg.length - 1 && takesNext(flag)) i++;
        break;
      }
      continue;
    }
    if (takesNext(arg)) i++;
  }
  return undefined;
}

/** Isolate startup state before the launcher loads environment or operator configuration. */
export function isolateEvalCommandHome(args: readonly string[]): (() => void) | undefined {
  if (!args.includes("--isolated-home")) return undefined;
  if (firstCommandToken(args) !== "eval") {
    throw new Error("--isolated-home is available only with the eval command (nexus [options] eval --isolated-home ...)");
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-eval-cli-home-"));
  fs.chmodSync(home, 0o700);
  const isolatedEnvironment: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  const previousEnvironment = new Map(Object.keys(isolatedEnvironment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnvironment);
  return () => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  };
}

export async function runVersionedEvalCommand(
  options: VersionedEvalCommandOptions,
  config: HarnessConfig,
  resolver: () => VersionedEvalRuntimeResolver = resolveInstalledEvalRuntime,
): Promise<{ output: string; runner: VersionedEvalRunnerResult }> {
  if (!options.dataset?.trim()) throw new Error("--dataset is required");
  if (options.limit !== undefined) {
    throw new Error("--limit is not supported for versioned datasets; select a split or provide a dataset with the desired task population");
  }
  const runs = positiveInteger(options.runs, "--runs", 1);
  const minutes = positiveInteger(options.maxMinutes, "--max-minutes", 120);
  const runtime = resolver();
  const runnerModule = await import(pathToFileURL(runtime.runnerApiPath).href) as {
    runVersionedEvaluation(options: Record<string, unknown>): Promise<VersionedEvalRunnerResult>;
  };
  const outputPath = path.resolve(options.output ?? "eval-score.json");
  const outputDir = `${outputPath}.artifacts`;
  if (fs.existsSync(outputPath)) throw new Error(`score output already exists: ${outputPath}`);
  if (fs.existsSync(outputDir)) throw new Error(`evaluation artifact directory already exists: ${outputDir}`);
  const runner = await runnerModule.runVersionedEvaluation({
    config: {
      name: "nexus-eval-cli",
      agent: "nexus",
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      steps: positiveInteger(options.maxSteps, "--max-steps", config.maxSteps),
      minutes,
      sampling: { temperature: Number(options.temperature ?? config.temperature) },
      limits: { context: config.contextLimit, output: config.completionReserveTokens },
      workspace: path.resolve(options.workspace ?? config.workspace),
      sandboxRuntimeRoots: [runtime.packageRoot],
      // Mount only the installed candidate's CLI and core closures. The package root
      // also contains evaluator code and private dataset material, which stay unmounted.
      sandboxRuntimePaths: [path.join(runtime.packageRoot, "lib", "cli"), path.join(runtime.packageRoot, "lib", "core")],
    },
    nexusExecutable: runtime.nexusExecutable,
    dataset: path.resolve(options.dataset),
    outputDir,
    runs,
    split: options.split,
  });
  const output = JSON.stringify({
    schemaVersion: 1,
    dataset: path.resolve(options.dataset),
    runs,
    score: runner.score,
    artifacts: {
      outputDir: runner.outputDir,
      resultsFile: runner.resultsFile,
      manifestFile: runner.manifestFile,
      scoreFile: runner.scoreFile,
    },
  }, null, 2);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${output}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { output, runner };
}
