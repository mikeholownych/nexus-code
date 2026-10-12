/**
 * `nexus doctor` and `/doctor`: one diagnostic engine for the CLI and the live session.
 *
 * Every check reuses the resolver Nexus itself uses — `buildConfig` for configuration, `LocalLlmClient` for the
 * endpoint, credentials and model list, `resolveCoreBinary` for the engine, the session and task-state directories,
 * and the MCP and plugin search paths — so a finding describes what Nexus would actually do. Checks are independent,
 * bounded by timeouts and an abort signal, and never start an agent, an MCP server or a plugin. Endpoint evidence is
 * layered: configured → reachable → authenticated → model available → inference verified (the last only with
 * --deep, which sends one minimal inference request and says so).
 *
 * Repairs (`--fix`) are a small deterministic set: create missing state directories and tighten permissions on
 * state and credential files. They are proposed first, applied only after confirmation (or `--yes`), refused under
 * read-only policy, serialised by a lock, backed up (previous modes recorded), checked again just before each change,
 * and verified afterwards by re-running the affected checks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { LocalLlmClient, credentialStorageHome } from "./client.js";
import { credentialsPath } from "./credentials.js";
import { mcpConfigFiles } from "./mcp.js";
import { pluginDirs } from "./plugins.js";
import { untrustedWorkspaceExtensions, WORKSPACE_MCP_FILES } from "./workspace_trust.js";
import { BuildIdentity, getBuildIdentity } from "./build_identity.js";
import { defaultSessionsDir } from "./session.js";
import { defaultTaskStateDir } from "./core/state.js";
import { coreCargoManifest, resolveCoreBinary } from "./tools.js";
import { redactSecrets } from "./ui.js";
import { SafePathError, ancestryProblem, chmodVerified, identityOf, mkdirVerified, readVerified, unlinkVerified, writeExclusiveVerified, type Identity } from "./safe_fs.js";
import type { HarnessConfig } from "./types.js";

export const DOCTOR_SCHEMA_VERSION = 2;
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

/** Exit codes: healthy, warnings only, at least one failure, the doctor itself could not run. */
export const DOCTOR_EXIT = { healthy: 0, warnings: 1, failures: 2, error: 3 } as const;

export interface DoctorFinding {
  id: string;
  category: "install" | "config" | "endpoint" | "runtime" | "engine" | "workspace" | "state" | "extensions";
  status: DoctorStatus;
  explanation: string;
  evidence: string[];
  action?: string;
  repairAvailable: boolean;
  /** `expect`: the object the diagnosis saw (device, inode, mode); a repair changes only that object. */
  repair?: { id: string; description: string; expect?: { dev: number; ino: number; mode: number } };
  durationMs: number;
}

export interface RepairResult {
  id: string;
  findingId: string;
  description: string;
  status: "applied" | "failed" | "skipped" | "declined" | "unresolved" | "refused";
  detail: string;
  /** Status of the affected check when it was run again after the repair. */
  verified?: DoctorStatus;
}

export interface DoctorReport {
  schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  tool: "nexus doctor";
  nexusVersion: string;
  buildIdentity?: BuildIdentity;
  /** `cli`: a fresh configuration built from flags and environment. `session`: the running session's configuration. */
  context: "cli" | "session";
  deep: boolean;
  generatedAt: string;
  durationMs: number;
  summary: Record<DoctorStatus, number>;
  effectiveConfig: Array<{ key: string; value: string; source: string }> | null;
  findings: DoctorFinding[];
  repairs?: RepairResult[];
  cancelled?: boolean;
}

export interface DoctorOptions {
  context?: "cli" | "session";
  /** The configuration to diagnose; absent when it could not be built (see `configError`). */
  config?: HarnessConfig;
  configError?: unknown;
  /** Flags the configuration was built from (for sources and for diagnosing without a config). */
  flags?: Record<string, any>;
  deep?: boolean;
  signal?: AbortSignal;
  /** Per-check limit in milliseconds (the deep inference probe gets six times this). */
  timeoutMs?: number;
  /** Home directory for state checks; defaults to the operator's home. */
  home?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(here, "../..");
const DEFAULT_TIMEOUT_MS = 4000;

/** Credentials, authorization headers and URL secrets, in any field. */
export function redactDiagnostic(value: string): string {
  return redactSecrets(
    value
      .replace(/(authorization\s*[:=]\s*(?:bearer|basic)?\s*)[^\s,;"']+/gi, "$1[REDACTED]")
      .replace(/((?:api[_-]?key|access[_-]?token|token|password|passwd|secret|key)=)[^&\s"']+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@"),
  );
}

/** Redacts every string in a value, plus any exact secret value given (a key never printed even when unpatterned). */
function redactDeep<T>(value: T, secrets: string[]): T {
  const scrub = (text: string) => {
    let out = text;
    for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[REDACTED]");
    return redactDiagnostic(out);
  };
  const visit = (item: any): any => {
    if (typeof item === "string") return scrub(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v)]));
    return item;
  };
  return visit(value);
}

function nexusVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, "cli/package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

type Check = (ctx: CheckContext, signal: AbortSignal) => Promise<Omit<DoctorFinding, "durationMs"> | Array<Omit<DoctorFinding, "durationMs">>>;

interface CheckContext {
  config?: HarnessConfig;
  configError?: unknown;
  flags: Record<string, any>;
  deep: boolean;
  home: string;
  timeoutMs: number;
  /** Shared endpoint evidence: later endpoint findings depend on earlier ones. */
  endpoint?: Promise<EndpointEvidence>;
}

const f = (
  id: string,
  category: DoctorFinding["category"],
  status: DoctorStatus,
  explanation: string,
  evidence: string[] = [],
  action?: string,
  repair?: { id: string; description: string; expect?: { dev: number; ino: number; mode: number } },
): Omit<DoctorFinding, "durationMs"> => ({
  id,
  category,
  status,
  explanation,
  evidence,
  ...(action ? { action } : {}),
  repairAvailable: Boolean(repair),
  ...(repair ? { repair } : {}),
});

/** Runs a process with a deadline; never throws. */
function run(command: string, args: string[], opts: { cwd?: string; timeoutMs: number; signal: AbortSignal; maxStdout?: number }): Promise<{ code: number | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout: stdout.slice(0, opts.maxStdout ?? 64_000), stderr: stderr.slice(0, 16_000), timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      resolve({ code: null, stdout: "", stderr: "", error: err?.message ?? String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (err) => finish({ code: null, error: err.message }));
    child.on("close", (code) => finish({ code }));
  });
}

/** An executable named bare or by path, resolved the way a shell `exec` would (PATH search). */
function resolveExecutable(name: string): string | undefined {
  const executable = (file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (name.includes("/")) return executable(path.resolve(name)) ? path.resolve(name) : undefined;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function newestMtime(dir: string, ext: string, limit = 2000, recursive = true): number {
  let newest = 0;
  let seen = 0;
  const walk = (d: string) => {
    if (seen > limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      }
      else if (entry.name.endsWith(ext)) {
        seen++;
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {}
      }
    }
  };
  walk(dir);
  return newest;
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration sources
// ---------------------------------------------------------------------------------------------------------------

const CONFIG_KEYS: Array<{ key: string; flag?: string; field: keyof HarnessConfig | ((c: HarnessConfig) => string | undefined); fallback?: string }> = [
  { key: "NEXUS_PROVIDER", flag: "provider", field: (c) => c.provider },
  { key: "LOCAL_LLM_ENDPOINT", flag: "endpoint", field: "endpoint", fallback: "http://localhost:1234/v1" },
  { key: "LOCAL_LLM_MODEL", flag: "model", field: "model", fallback: "local-model" },
  { key: "LOCAL_LLM_API_KEY", flag: "apiKey", field: (c) => (c.apiKey && c.apiKey !== "local" ? "set (not shown)" : "not set") },
  { key: "LOCAL_HARNESS_SHELL", flag: "shell", field: "shell", fallback: "bash" },
  { key: "workspace", flag: "workspace", field: "workspace" },
  { key: "max steps per segment", flag: "maxSteps", field: (c) => String(c.maxSteps), fallback: "30" },
  { key: "NEXUS_MAX_TOTAL_STEPS", flag: "maxTotalSteps", field: (c) => (c.continuation ? String(c.continuation.maxTotalSteps) : "continuation off"), fallback: "300" },
  { key: "NEXUS_STAGNATION_STEPS", flag: "stagnationSteps", field: (c) => (c.continuation ? String(c.continuation.stagnationSteps) : "continuation off"), fallback: "12" },
  { key: "NEXUS_VERIFIER_TIMEOUT_SECS", field: (c) => String(c.verifierTimeoutSecs ?? 300), fallback: "300" },
  { key: "PLANNER_LLM_MODEL", flag: "plannerModel", field: (c) => c.plannerModel },
  { key: "CODER_LLM_MODEL", flag: "coderModel", field: (c) => c.coderModel },
];

/**
 * Where each effective value came from, following `loadEnvironment` and `buildConfig` precedence: command-line flag,
 * then the working directory's `.env`, then `~/.config/nexus/config.env`, then the shell environment, then the
 * installation `.env`, then the built-in default.
 */
export function configSources(config: HarnessConfig, flags: Record<string, any>, home = credentialStorageHome()): Array<{ key: string; value: string; source: string }> {
  const read = (file: string): Record<string, string> => {
    try {
      return parseDotenv(fs.readFileSync(file));
    } catch {
      return {};
    }
  };
  const installEnv = path.join(INSTALL_ROOT, "cli/.env");
  const cwdEnvPath = path.resolve(process.cwd(), ".env");
  const cwdEnv = cwdEnvPath === installEnv ? {} : read(cwdEnvPath);
  const userEnv = read(path.join(home, ".config/nexus/config.env"));
  const install = read(installEnv);
  return CONFIG_KEYS.map(({ key, flag, field, fallback }) => {
    const raw = typeof field === "function" ? field(config) : (config[field] as unknown);
    const value = raw === undefined || raw === null || raw === "" ? "(not set)" : String(raw);
    let source = "default";
    if (flag && flags[flag] !== undefined && flags[flag] !== false) source = "command-line flag";
    else if (key in cwdEnv) source = `${cwdEnvPath} (working-directory .env)`;
    else if (key in userEnv) source = "~/.config/nexus/config.env";
    else if (process.env[key] !== undefined && install[key] !== process.env[key]) source = "shell environment";
    else if (key in install) source = "installation cli/.env";
    else if (key === "workspace") source = "current directory";
    else if (value === "(not set)" || (fallback && value === fallback)) source = "default";
    else source = "derived";
    return { key, value, source };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

const installCheck: Check = async () => {
  const build = getBuildIdentity();
  const dist = path.join(INSTALL_ROOT, "cli/dist/index.js");
  const evidence = [
    `version ${build.version}`,
    build.commit === "unknown" ? "build identity unknown (built before build-info was recorded; run `make build`)" : `built from ${build.commit}${build.dirty ? " with uncommitted changes" : ""}${build.branch ? ` on ${build.branch}` : ""}`,
    `install root ${INSTALL_ROOT}`,
  ];
  if (!fs.existsSync(dist)) return f("install.build", "install", "fail", "The CLI build (cli/dist) is missing.", evidence, `Run \`make build\` in ${INSTALL_ROOT}.`);
  const built = fs.statSync(dist).mtimeMs;
  const source = newestMtime(path.join(INSTALL_ROOT, "cli/src"), ".ts");
  if (source > built) {
    return f("install.build", "install", "warn", "cli/dist is older than cli/src: the running CLI may not include the latest source changes.", [...evidence, `dist ${new Date(built).toISOString()}`, `newest source ${new Date(source).toISOString()}`], `Run \`npm --prefix ${path.join(INSTALL_ROOT, "cli")} run build\`.`);
  }
  return f("install.build", "install", "pass", "The CLI build is present and not older than its source.", evidence);
};

const runtimeCheck: Check = async () => {
  const major = Number(process.versions.node.split(".")[0]);
  return f("runtime.node", "runtime", major >= 20 ? "pass" : "fail", `Node.js ${process.versions.node} (${major >= 20 ? "supported" : "older than the supported 20"}).`, [process.execPath], major >= 20 ? undefined : "Install Node.js 20 or later.");
};

const launcherCheck: Check = async () => {
  const launcher = resolveExecutable("nexus");
  if (!launcher) return f("runtime.launcher", "runtime", "skip", "No `nexus` launcher is on PATH (optional: Nexus can run as `node cli/dist/index.js`).", [], `Optionally link ${path.join(INSTALL_ROOT, "harness.sh")} into a PATH directory as \`nexus\`.`);
  let real = launcher;
  try {
    real = fs.realpathSync(launcher);
  } catch {}
  const evidence = [`${launcher} -> ${real}`];
  const ours = real === path.join(INSTALL_ROOT, "harness.sh");
  let routesDoctor = false;
  try {
    routesDoctor = /\[\[ "\$1" == "doctor" \]\]/.test(fs.readFileSync(real, "utf8"));
  } catch {}
  if (!ours) return f("runtime.launcher", "runtime", "warn", "The `nexus` on PATH is not this installation's launcher.", evidence, `Point it at ${path.join(INSTALL_ROOT, "harness.sh")}, or run this installation directly.`);
  if (!routesDoctor) return f("runtime.launcher", "runtime", "fail", "The `nexus` launcher does not route `doctor`; `nexus doctor` would start an agent task instead.", evidence, "Update harness.sh from this checkout.");
  return f("runtime.launcher", "runtime", "pass", "The `nexus` launcher on PATH is this installation and routes `doctor`.", evidence);
};

const configCheck: Check = async (ctx) => {
  if (ctx.configError) {
    const message = ctx.configError instanceof Error ? ctx.configError.message : String(ctx.configError);
    return f("config.valid", "config", "fail", "The configuration could not be built, so Nexus would not start a session.", [message], "Correct the setting named above (flag, ~/.config/nexus/config.env, or the working-directory .env) and run doctor again.");
  }
  if (!ctx.config) return f("config.valid", "config", "skip", "No configuration was supplied.");
  const evidence = [`provider ${ctx.config.provider ?? "(appliance / OpenAI-compatible endpoint)"}`, `model ${ctx.config.model || "(none)"}`];
  if (ctx.config.provider && !ctx.config.model) {
    return f("config.valid", "config", "fail", `Provider ${ctx.config.provider} is selected but no model is named.`, evidence, "Pass -m <model> or set NEXUS_MODEL in ~/.config/nexus/config.env (or pick one with /model).");
  }
  return f("config.valid", "config", "pass", "The configuration builds with the same rules a session uses.", evidence);
};

interface EndpointEvidence {
  configured: boolean;
  endpoint?: string;
  reachable?: boolean;
  httpStatus?: number;
  detail?: string;
  models?: string[];
  modelError?: string;
}

async function gatherEndpoint(ctx: CheckContext, signal: AbortSignal): Promise<EndpointEvidence> {
  const config = ctx.config;
  if (!config?.endpoint) return { configured: false };
  const client = new LocalLlmClient({ ...config, maxSteps: 1 }, { role: "diagnostic" });
  const probe = await client.probeAvailability(signal, { timeoutMs: ctx.timeoutMs });
  const evidence: EndpointEvidence = { configured: true, endpoint: config.endpoint, reachable: probe.httpStatus !== undefined, httpStatus: probe.httpStatus, detail: probe.detail };
  if (probe.httpStatus !== undefined && probe.httpStatus >= 200 && probe.httpStatus < 300) {
    try {
      evidence.models = await Promise.race([
        client.listModels(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`model list did not answer within ${ctx.timeoutMs} ms`)), ctx.timeoutMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          }, { once: true });
        }),
      ]);
    } catch (err: any) {
      evidence.modelError = err?.message ?? String(err);
    }
  }
  return evidence;
}

const endpointChecks: Check = async (ctx, signal) => {
  const config = ctx.config;
  if (!config) {
    return ["endpoint.configured", "endpoint.reachable", "endpoint.authenticated", "model.available"].map((id) =>
      f(id, "endpoint", "skip", "Skipped: there is no valid configuration to take the endpoint from."),
    );
  }
  const where = `${config.endpoint}${config.provider ? ` (provider ${config.provider})` : ""}`;
  const out: Array<Omit<DoctorFinding, "durationMs">> = [];
  out.push(f("endpoint.configured", "endpoint", config.endpoint ? "pass" : "fail", config.endpoint ? "An inference endpoint is configured." : "No inference endpoint is configured.", [where, `credential ${config.apiKey && config.apiKey !== "local" ? "present (bound to its own origin; not shown)" : "none configured; stored gateway credentials are attached per origin by the client"}`]));
  const ev = await (ctx.endpoint ??= gatherEndpoint(ctx, signal));
  if (!ev.reachable) {
    out.push(f("endpoint.reachable", "endpoint", "fail", "The endpoint did not answer.", [where, ev.detail ?? "no HTTP response"], config.provider ? `Check network access to ${config.endpoint}.` : "Start the local model server (LM Studio / vLLM) or point LOCAL_LLM_ENDPOINT / -e at a running one."));
    out.push(f("endpoint.authenticated", "endpoint", "skip", "Skipped: the endpoint was not reachable."));
    out.push(f("model.available", "endpoint", "skip", "Skipped: the endpoint was not reachable."));
    return out;
  }
  out.push(f("endpoint.reachable", "endpoint", "pass", `The endpoint answered GET /models with HTTP ${ev.httpStatus}.`, [`${config.endpoint}/models`]));
  const status = ev.httpStatus!;
  if (status === 401 || status === 403) {
    out.push(f("endpoint.authenticated", "endpoint", "fail", `The endpoint rejected the credential Nexus sends (HTTP ${status}).`, [where], config.provider ? `Reconnect with \`nexus connect ${config.provider}\` (or ctrl+p in /model).` : "Set LOCAL_LLM_API_KEY (or pass -k) to a credential this gateway accepts."));
    out.push(f("model.available", "endpoint", "skip", "Skipped: the credential was rejected."));
    return out;
  }
  if (status >= 400) {
    out.push(f("endpoint.authenticated", "endpoint", "warn", `The endpoint answered HTTP ${status} to the model list, so authentication could not be confirmed.`, [where]));
    out.push(f("model.available", "endpoint", "skip", "Skipped: the model list was not served."));
    return out;
  }
  out.push(f("endpoint.authenticated", "endpoint", "pass", "The endpoint accepted the request with the credential Nexus would send.", [where]));
  if (ev.modelError || !ev.models) {
    out.push(f("model.available", "endpoint", "warn", "The model list could not be read.", [ev.modelError ?? "no list"]));
  } else if (!config.model || config.model === "local-model") {
    out.push(f("model.available", "endpoint", ev.models.length ? "pass" : "warn", ev.models.length ? `No model is named; a session would use the first listed model (${ev.models[0]}).` : "The endpoint lists no models.", [`${ev.models.length} listed`], ev.models.length ? undefined : "Load a model on the server."));
  } else if (ev.models.includes(config.model)) {
    out.push(f("model.available", "endpoint", "pass", `The configured model ${config.model} is listed by the endpoint.`, [`${ev.models.length} models listed`]));
  } else {
    out.push(f("model.available", "endpoint", "fail", `The configured model ${config.model} is not in the endpoint's model list.`, [`listed: ${ev.models.slice(0, 8).join(", ")}${ev.models.length > 8 ? ", …" : ""}`], "Choose a listed model (-m, LOCAL_LLM_MODEL, NEXUS_MODEL or /model)."));
  }
  return out;
};

const inferenceCheck: Check = async (ctx, signal) => {
  if (!ctx.deep) {
    return f("inference.verified", "endpoint", "skip", "Inference was not tested: a listed model is not proof that inference works. --deep sends one minimal request.", [], "Run `nexus doctor --deep` to send one short inference request (it costs model work, and tokens on paid providers).");
  }
  if (!ctx.config) return f("inference.verified", "endpoint", "skip", "Skipped: there is no valid configuration.");
  const ev = await (ctx.endpoint ??= gatherEndpoint(ctx, signal));
  if (!ev.reachable || (ev.httpStatus ?? 500) >= 400) return f("inference.verified", "endpoint", "skip", "Skipped: the endpoint is not reachable and authenticated.");
  const client = new LocalLlmClient({ ...ctx.config, maxSteps: 1 }, { role: "diagnostic" });
  const started = Date.now();
  try {
    const reply = await client.chatCompletion([{ role: "user", content: "Reply with the single word OK." }], [], undefined, AbortSignal.any([signal, AbortSignal.timeout(ctx.timeoutMs * 6)]), "diagnostic");
    const text = typeof reply.content === "string" ? reply.content.trim() : "";
    if (!text && !reply.tool_calls?.length) return f("inference.verified", "endpoint", "fail", "The model answered with an empty reply.", [`${Date.now() - started} ms`]);
    return f("inference.verified", "endpoint", "pass", `One inference request completed (costed model work: one short prompt and reply).`, [`model ${ctx.config.model}`, `${Date.now() - started} ms`, `reply ${JSON.stringify(text.slice(0, 40))}`]);
  } catch (err: any) {
    return f("inference.verified", "endpoint", "fail", "The inference request failed.", [err?.message ?? String(err)], "Check the model name and the provider's account limits; run with NEXUS_DEBUG=1 for request ids.");
  }
};

const shellCheck: Check = async (ctx, signal) => {
  const shell = ctx.config?.shell ?? ctx.flags.shell ?? process.env.LOCAL_HARNESS_SHELL ?? "bash";
  const resolved = resolveExecutable(shell);
  if (!resolved) return f("shell.executable", "runtime", "fail", `The configured shell ${shell} is not an executable on PATH; run_command would fail.`, [`PATH ${process.env.PATH ?? ""}`.slice(0, 300)], "Install it, or choose an available shell with --shell / LOCAL_HARNESS_SHELL.");
  const res = await run(resolved, ["-c", "printf nexus-doctor"], { timeoutMs: ctx.timeoutMs, signal });
  if (res.stdout === "nexus-doctor" && res.code === 0) return f("shell.executable", "runtime", "pass", `The shell ${shell} runs commands.`, [resolved]);
  return f("shell.executable", "runtime", "fail", `The shell ${shell} did not run a test command.`, [resolved, res.timedOut ? "timed out" : `exit ${res.code} ${res.error ?? res.stderr.trim()}`.trim()], "Check the shell installation and its startup files.");
};

const engineCheck: Check = async (ctx, signal) => {
  // Same choice as RustCoreBridge: a configured binary that exists, else the build layout's.
  const configured = ctx.config?.coreBinaryPath;
  const binary = configured && fs.existsSync(configured) ? configured : resolveCoreBinary();
  const out: Array<Omit<DoctorFinding, "durationMs">> = [];
  if (!binary) {
    const cargo = resolveExecutable("cargo");
    out.push(
      cargo
        ? f("engine.binary", "engine", "warn", "The Rust engine is not built; tools will run through a slow `cargo run` fallback.", [coreCargoManifest(), cargo], "Run `make build-core`.")
        : f("engine.binary", "engine", "fail", "The Rust engine is not built and cargo is unavailable, so no tool can run.", [coreCargoManifest()], "Install Rust and run `make build-core`."),
    );
    return out;
  }
  const version = await run(binary, ["--version"], { timeoutMs: ctx.timeoutMs, signal });
  const reported = version.stdout.trim().split(/\s+/).pop() ?? "";
  const evidence = [binary, version.stdout.trim() || version.error || version.stderr.trim()];
  if (version.code !== 0) {
    out.push(f("engine.binary", "engine", "fail", "The Rust engine binary does not run.", evidence, "Rebuild it with `make build-core`."));
    return out;
  }
  const builtAt = fs.statSync(binary).mtimeMs;
  // The engine is built from core/src/*.rs; core/src/bin holds the TUI, checked separately.
  const sourceAt = newestMtime(path.join(path.dirname(coreCargoManifest()), "src"), ".rs", 2000, false);
  if (reported !== nexusVersion()) {
    out.push(f("engine.binary", "engine", "warn", `The engine reports version ${reported}, the CLI ${nexusVersion()}.`, evidence, "Rebuild with `make build`."));
  } else if (sourceAt > builtAt) {
    out.push(f("engine.binary", "engine", "warn", "The engine binary is older than its source; it may not include recent fixes.", [...evidence, `built ${new Date(builtAt).toISOString()}`, `newest source ${new Date(sourceAt).toISOString()}`], "Rebuild with `make build-core`."));
  } else {
    out.push(f("engine.binary", "engine", "pass", "The Rust engine binary runs and matches the CLI version.", evidence));
  }
  if (ctx.deep) {
    const workspace = ctx.config?.workspace ?? process.cwd();
    // One level only, and the whole answer kept: a large workspace (a home directory) lists thousands of entries, and a
    // listing cut at the usual output cap would not parse and would look like an engine failure.
    const call = await run(binary, ["-w", workspace, "call", "--tool", "list_dir", "--args", JSON.stringify({ path: ".", max_depth: 1 })], { timeoutMs: ctx.timeoutMs, signal, maxStdout: 16_000_000 });
    let ok = false;
    try {
      ok = Array.isArray(JSON.parse(call.stdout).entries);
    } catch {}
    out.push(ok
      ? f("engine.tool", "engine", "pass", "The engine executed a read-only tool (list_dir) in the workspace.", [workspace])
      : f("engine.tool", "engine", "fail", "The engine could not execute a read-only tool in the workspace.", [workspace, call.timedOut ? "timed out" : (call.stderr || call.error || call.stdout).trim().slice(0, 300)], "Check workspace permissions and rebuild the engine."));
  }
  return out;
};

/** The live TUI and its sidecar: present and built from current source (a stale build hides recent fixes). */
const tuiCheck: Check = async () => {
  const core = path.dirname(coreCargoManifest());
  const tui = path.join(core, "target/release/nexus-tui");
  const sidecar = path.join(INSTALL_ROOT, "cli/dist/sidecar.js");
  if (!fs.existsSync(tui) || !fs.existsSync(sidecar)) {
    return f("tui.build", "install", "warn", "The live TUI is not built; `nexus` without arguments falls back to the readline REPL.", [fs.existsSync(tui) ? sidecar : tui], "Run `make build`.");
  }
  const sourceAt = newestMtime(path.join(core, "src/bin"), ".rs");
  const builtAt = fs.statSync(tui).mtimeMs;
  if (sourceAt > builtAt) {
    return f("tui.build", "install", "warn", "The live TUI binary is older than its source.", [tui, `built ${new Date(builtAt).toISOString()}`, `newest source ${new Date(sourceAt).toISOString()}`], "Run `make build-core`.");
  }
  return f("tui.build", "install", "pass", "The live TUI and its sidecar are built from current source.", [tui, sidecar]);
};

const workspaceCheck: Check = async (ctx) => {
  const workspace = ctx.config?.workspace ?? (ctx.flags.workspace ? path.resolve(ctx.flags.workspace) : process.cwd());
  try {
    if (!fs.statSync(workspace).isDirectory()) return f("workspace.access", "workspace", "fail", "The workspace is not a directory.", [workspace], "Pass -w <directory>.");
    fs.accessSync(workspace, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err: any) {
    return f("workspace.access", "workspace", "fail", "The workspace is not readable and writable.", [workspace, err?.code ?? String(err)], "Fix its permissions or choose another workspace with -w.");
  }
  const git = fs.existsSync(path.join(workspace, ".git"));
  return f("workspace.access", "workspace", "pass", `The workspace is readable and writable${git ? " and is a git repository (checkpoints and /undo available)" : "; it is not a git repository, so checkpoints use file snapshots"}.`, [workspace]);
};

function modeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

const stateDirCheck: Check = async (ctx) => {
  const dirs = [
    { id: "state.sessions", dir: ctx.home === os.homedir() ? defaultSessionsDir() : path.join(ctx.home, ".nexus", "sessions"), what: "saved sessions" },
    { id: "state.tasks", dir: ctx.home === os.homedir() ? defaultTaskStateDir() : path.join(ctx.home, ".nexus", "tasks"), what: "durable task state" },
  ];
  const out: Array<Omit<DoctorFinding, "durationMs">> = [];
  for (const { id, dir, what } of dirs) {
    // A linked or foreign-owned component below the home means any change could land outside it: no repair.
    const unsafe = ancestryProblem(ctx.home, dir);
    if (!fs.existsSync(dir)) {
      out.push(unsafe
        ? f(id, "state", "warn", `The ${what} directory does not exist, and its path is not safe to create automatically (${unsafe}).`, [dir], `Check the path and create ${dir} yourself.`)
        : f(id, "state", "warn", `The ${what} directory does not exist yet; Nexus creates it on first save.`, [dir], undefined, { id: "state.create", description: `Create ${dir} with mode 0700` }));
      continue;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) {
        out.push(f(id, "state", "fail", `The ${what} path exists but is not a directory, so nothing can be saved there.`, [dir], `Move ${dir} aside (Nexus will not delete it) and run doctor again.`));
        continue;
      }
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch (err: any) {
      out.push(f(id, "state", "fail", `The ${what} directory is not writable; sessions and recovery state cannot be saved.`, [dir, err?.code ?? String(err)], `Fix ownership and permissions of ${dir} (e.g. \`chmod u+rwx ${dir}\`).`));
      continue;
    }
    const mode = modeOf(dir)!;
    if (mode & 0o022) {
      if (unsafe) {
        out.push(f(id, "state", "warn", `The ${what} directory is writable by other users (mode ${mode.toString(8)}), and its path is not safe to change automatically (${unsafe}).`, [dir, `-> ${fs.realpathSync(dir)}`], `Review the path and restrict the real directory yourself (doctor never changes permissions through a link).`));
        continue;
      }
      out.push(f(id, "state", "warn", `The ${what} directory is writable by other users (mode ${mode.toString(8)}); others could alter saved state.`, [dir], undefined, { id: "state.permissions", description: `chmod ${dir} from ${mode.toString(8)} to 700`, expect: identityOf(dir) }));
      continue;
    }
    if (ctx.deep) {
      const probe = path.join(dir, `.doctor-probe-${process.pid}-${Date.now()}`);
      try {
        fs.writeFileSync(probe, "probe", { flag: "wx", mode: 0o600 });
        fs.unlinkSync(probe);
      } catch (err: any) {
        out.push(f(id, "state", "fail", `Writing a probe file into the ${what} directory failed.`, [dir, err?.code ?? String(err)], "Check free space, quotas and mount options."));
        continue;
      }
    }
    out.push(f(id, "state", "pass", `The ${what} directory is writable${ctx.deep ? " (a probe file was written and removed)" : ""}.`, [dir, `mode ${mode.toString(8)}`]));
  }
  return out;
};

const stateIntegrityCheck: Check = async (ctx) => {
  const dirs = [path.join(ctx.home, ".nexus", "sessions"), path.join(ctx.home, ".nexus", "tasks")];
  let checked = 0;
  const corrupt: string[] = [];
  const temps: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".tmp")) temps.push(path.join(dir, name));
    const files = names
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ n, t: (() => { try { return fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.t - a.t)
      .slice(0, ctx.deep ? 5000 : 300);
    for (const { n } of files) {
      checked++;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
        if (!(data.taskId || data.sessionId || data.id) || !Array.isArray(data.messages)) corrupt.push(path.join(dir, n));
      } catch {
        corrupt.push(path.join(dir, n));
      }
    }
  }
  if (checked === 0 && temps.length === 0) return f("state.integrity", "state", "pass", "No saved sessions or task state yet.");
  const evidence = [`${checked} record(s) checked${ctx.deep ? "" : " (newest 300 per directory; --deep checks all)"}`];
  if (corrupt.length || temps.length) {
    return f("state.integrity", "state", "warn", `${corrupt.length} saved record(s) cannot be read${temps.length ? ` and ${temps.length} interrupted write(s) were left behind` : ""}; they are skipped when listing or resuming.`, [...evidence, ...corrupt.slice(0, 5), ...temps.slice(0, 3)], "Inspect and move the listed files aside manually; doctor never deletes sessions or checkpoints.");
  }
  return f("state.integrity", "state", "pass", "Every checked session and task-state record parses and has an id and a message list.", evidence);
};

const credentialStoreCheck: Check = async (ctx) => {
  const file = ctx.home === credentialStorageHome() ? credentialsPath() : path.join(ctx.home, ".config/nexus/credentials.json");
  if (!fs.existsSync(file)) return f("credentials.store", "state", "pass", "Nexus's own credential store is not in use (credentials come from the environment or other clients).", [file]);
  const mode = modeOf(file) ?? 0;
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return f("credentials.store", "state", "fail", "Nexus's credential store is not valid JSON; stored provider connections are unavailable.", [file], "Move the file aside and reconnect with `nexus connect <provider>`.");
  }
  if (mode & 0o077) {
    const unsafe = ancestryProblem(ctx.home, file);
    if (unsafe) {
      return f("credentials.store", "state", "warn", `The credential store is readable by other users (mode ${mode.toString(8)}), and its path is not safe to change automatically (${unsafe}).`, [file], "Review the path and restrict the real file yourself (doctor never changes permissions through a link).");
    }
    return f("credentials.store", "state", "warn", `The credential store is readable by other users (mode ${mode.toString(8)}).`, [file], undefined, { id: "credentials.permissions", description: `chmod ${file} from ${mode.toString(8)} to 600`, expect: identityOf(file) });
  }
  return f("credentials.store", "state", "pass", "The credential store is private to this user.", [file, `mode ${mode.toString(8)}`]);
};

const mcpCheck: Check = async (ctx) => {
  const workspace = ctx.config?.workspace ?? process.cwd();
  const out: Array<Omit<DoctorFinding, "durationMs">> = [];
  const servers: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  // Every configuration file is inspected, including a workspace's own that is not loaded because it is untrusted.
  for (const file of mcpConfigFiles(workspace, true)) {
    if (!fs.existsSync(file)) continue;
    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err: any) {
      problems.push(`${file}: not valid JSON (Nexus ignores the whole file): ${err?.message ?? err}`);
      continue;
    }
    for (const [name, server] of Object.entries<any>(config?.mcpServers ?? {})) {
      if (seen.has(name)) {
        servers.push(`${name} (${file}): shadowed by an earlier definition`);
        continue;
      }
      seen.add(name);
      if (server?.command) {
        const exe = resolveExecutable(String(server.command));
        if (!exe) problems.push(`${name} (${file}): command ${server.command} is not an executable on PATH`);
        else servers.push(`${name}: ${server.command} -> ${exe}`);
      } else if (server?.url) {
        try {
          new URL(String(server.url));
          servers.push(`${name}: ${server.url}`);
        } catch {
          problems.push(`${name} (${file}): url is not a valid URL`);
        }
      } else {
        problems.push(`${name} (${file}): neither command nor url; Nexus skips it`);
      }
    }
  }
  for (const file of untrustedWorkspaceExtensions(workspace).filter((f) => WORKSPACE_MCP_FILES.includes(path.basename(f)))) {
    problems.push(`${file}: not loaded — this workspace is not trusted. Trust it with \`nexus trust ${workspace}\` to use its MCP servers.`);
  }
  const note = "Servers were inspected from configuration only; none was started.";
  if (problems.length) out.push(f("mcp.config", "extensions", "warn", `${problems.length} configured MCP server problem(s); affected servers will not provide tools. ${note}`, [...problems, ...servers], "Fix the listed configuration entries."));
  else out.push(f("mcp.config", "extensions", seen.size ? "pass" : "skip", seen.size ? `${seen.size} MCP server(s) are configured with resolvable commands or valid URLs. ${note}` : "No MCP servers are configured (optional).", servers));
  return out;
};

const pluginCheck: Check = async (ctx) => {
  const workspace = ctx.config?.workspace ?? process.cwd();
  const found: string[] = [];
  const risky: string[] = [];
  for (const file of untrustedWorkspaceExtensions(workspace).filter((f) => !WORKSPACE_MCP_FILES.includes(path.basename(f)))) {
    risky.push(`${file}: not loaded — this workspace is not trusted. Trust it with \`nexus trust ${workspace}\` to load its plugins.`);
  }
  for (const dir of pluginDirs(workspace, true)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".js") || n.endsWith(".mjs"))) {
      const file = path.join(dir, name);
      found.push(file);
      const mode = modeOf(file) ?? 0;
      if (mode & 0o002) risky.push(`${file} is world-writable (mode ${mode.toString(8)}); anyone could change code Nexus runs`);
    }
  }
  const note = "Plugin modules were listed, not loaded (loading runs their code).";
  if (risky.length) return f("plugins.config", "extensions", "warn", `${risky.length} plugin problem(s): untrusted workspace plugins are not loaded; world-writable plugin files could be changed by anyone. ${note}`, [...risky, ...found.slice(0, 10)], "Trust the workspace (`nexus trust`) or remove its plugins; restrict writable files with `chmod o-w <file>`.");
  return f("plugins.config", "extensions", found.length ? "pass" : "skip", found.length ? `${found.length} plugin module(s) found. ${note}` : "No plugins are installed (optional).", found.slice(0, 10));
};

const CHECKS: Array<[string, Check]> = [
  ["install", installCheck],
  ["tui", tuiCheck],
  ["runtime", runtimeCheck],
  ["launcher", launcherCheck],
  ["config", configCheck],
  ["endpoint", endpointChecks],
  ["inference", inferenceCheck],
  ["shell", shellCheck],
  ["engine", engineCheck],
  ["workspace", workspaceCheck],
  ["state", stateDirCheck],
  ["integrity", stateIntegrityCheck],
  ["credentials", credentialStoreCheck],
  ["mcp", mcpCheck],
  ["plugins", pluginCheck],
];

/** Runs `check` with its own deadline; a throw or timeout becomes a finding, so other checks are unaffected. */
async function runCheck(name: string, check: Check, ctx: CheckContext, parent: AbortSignal): Promise<DoctorFinding[]> {
  const started = Date.now();
  const limit = name === "inference" ? ctx.timeoutMs * 6 + 1000 : name === "endpoint" ? ctx.timeoutMs * 2 + 1000 : ctx.timeoutMs + 1000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      check(ctx, controller.signal),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), limit))),
      new Promise<"cancelled">((resolve) => (parent.aborted ? resolve("cancelled") : parent.addEventListener("abort", () => resolve("cancelled"), { once: true }))),
    ]);
    if (result === "timeout" || result === "cancelled") {
      controller.abort();
      return [{ ...f(`${name}.check`, "runtime", result === "timeout" ? "warn" : "skip", result === "timeout" ? `The ${name} check did not finish within ${limit} ms.` : `The ${name} check was cancelled.`), durationMs: Date.now() - started }];
    }
    return (Array.isArray(result) ? result : [result]).map((finding) => ({ ...finding, durationMs: Date.now() - started }));
  } catch (err: any) {
    return [{ ...f(`${name}.check`, "runtime", "warn", `The ${name} check could not run.`, [err?.message ?? String(err)]), durationMs: Date.now() - started }];
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}

export async function runDoctor(optionsOrConfig: DoctorOptions | HarnessConfig | Record<string, any> = {}, legacyError?: unknown): Promise<DoctorReport> {
  const options: DoctorOptions = isDoctorOptions(optionsOrConfig)
    ? optionsOrConfig
    : { config: legacyError ? undefined : (optionsOrConfig as HarnessConfig), configError: legacyError, flags: optionsOrConfig as Record<string, any> };
  const started = Date.now();
  if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) {
    throw new Error(`--timeout must be a positive number of milliseconds (got ${String(options.timeoutMs)})`);
  }
  const signal = options.signal ?? new AbortController().signal;
  const ctx: CheckContext = {
    config: options.config,
    configError: options.configError,
    flags: options.flags ?? {},
    deep: Boolean(options.deep),
    home: options.home ?? credentialStorageHome(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const results = await Promise.all(CHECKS.map(([name, check]) => runCheck(name, check, ctx, signal)));
  const findings = results.flat();
  const summary: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const finding of findings) summary[finding.status]++;
  const report: DoctorReport = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    tool: "nexus doctor",
    nexusVersion: nexusVersion(),
    buildIdentity: getBuildIdentity(),
    context: options.context ?? "cli",
    deep: ctx.deep,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary,
    effectiveConfig: options.config ? configSources(options.config, ctx.flags, ctx.home) : null,
    findings,
    ...(signal.aborted ? { cancelled: true } : {}),
  };
  return redactDeep(report, secretValues(options));
}

function isDoctorOptions(value: unknown): value is DoctorOptions {
  return Boolean(value && typeof value === "object" && ("config" in (value as any) || "configError" in (value as any) || "context" in (value as any) || "deep" in (value as any)));
}

/** Exact secret values the report must never contain, whatever their shape. */
function secretValues(options: DoctorOptions): string[] {
  const c = options.config;
  return [c?.apiKey, c?.plannerApiKey, c?.coderApiKey, options.flags?.apiKey].filter((v): v is string => typeof v === "string" && v !== "local");
}

// ---------------------------------------------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------------------------------------------

interface PlannedRepair {
  id: string;
  findingId: string;
  description: string;
  target: string;
  previousMode?: number;
  /**
   * Makes the change under `home`, bound to the diagnosed object (see safe_fs.ts). Throws SafePathError when the
   * target, its mode, or any component of its path changed since the diagnosis; nothing is changed then.
   */
  apply(home: string): void;
}

function planRepairs(report: DoctorReport): PlannedRepair[] {
  const plans: PlannedRepair[] = [];
  for (const finding of report.findings) {
    if (!finding.repair) continue;
    const target = finding.evidence[0];
    if (!target) continue;
    if (finding.repair.id === "state.create") {
      plans.push({
        id: "state.create",
        findingId: finding.id,
        description: finding.repair.description,
        target,
        apply: (home) => {
          // lstat-based: anything now at the path (a directory, a link, a dangling link) means it is no longer missing.
          if (identityOf(target)) throw new SafePathError(`${target} exists now`);
          mkdirVerified(home, target);
        },
      });
    } else if (finding.repair.id === "state.permissions" || finding.repair.id === "credentials.permissions") {
      const wanted = finding.repair.id === "state.permissions" ? 0o700 : 0o600;
      // The object as diagnosed, not as it is now: a change made in between must make the repair stand down.
      const diagnosed: Identity | undefined = finding.repair.expect;
      plans.push({
        id: finding.repair.id,
        findingId: finding.id,
        description: finding.repair.description,
        target,
        previousMode: diagnosed?.mode,
        apply: (home) => {
          if (!diagnosed) throw new SafePathError(`${target} was not found when the repair was planned`);
          chmodVerified(home, target, wanted, diagnosed, wanted === 0o700 ? "dir" : "file");
        },
      });
    }
  }
  return plans;
}

export function proposedRepairs(report: DoctorReport): Array<{ id: string; findingId: string; description: string }> {
  return planRepairs(report).map(({ id, findingId, description }) => ({ id, findingId, description }));
}

export interface RepairOptions extends DoctorOptions {
  /** Asked once with the proposed changes; resolve true to apply them. */
  confirm: (proposals: Array<{ id: string; findingId: string; description: string }>) => Promise<boolean>;
  /** Read-only policy: repairs are refused, never applied. */
  readOnly?: boolean;
}

/**
 * Applies the supported repairs the report proposes, then re-runs the checks to verify them. Returns the report from
 * the verification run with `repairs` filled in. Nothing changes without confirmation, under read-only policy, or
 * while another `doctor --fix` holds the lock.
 */
export async function runRepairs(report: DoctorReport, options: RepairOptions): Promise<DoctorReport> {
  const plans = planRepairs(report);
  const result = (status: RepairResult["status"], detail: string) => plans.map((p): RepairResult => ({ id: p.id, findingId: p.findingId, description: p.description, status, detail }));
  if (!plans.length) return { ...report, repairs: [] };
  if (options.readOnly) return { ...report, repairs: result("refused", "Read-only policy is in effect; no change was made.") };
  const proposals = plans.map(({ id, findingId, description }) => ({ id, findingId, description }));
  if (!(await options.confirm(proposals))) return { ...report, repairs: result("declined", "Not confirmed; no change was made.") };

  const home = options.home ?? credentialStorageHome();
  const nexusDir = path.join(home, ".nexus");
  // The lock and the backups live under ~/.nexus: it must be a real, user-owned directory, not a link elsewhere.
  try {
    mkdirVerified(home, nexusDir);
  } catch (err) {
    return { ...report, repairs: result("refused", `${(err as Error).message}; no change was made.`) };
  }
  const lock = path.join(nexusDir, "doctor.lock");
  let lockIdentity: Identity | undefined;
  try {
    lockIdentity = acquireLock(home, lock);
  } catch (err) {
    return { ...report, repairs: result("refused", `Could not take ${lock} safely (${(err as Error).message}); no change was made.`) };
  }
  if (!lockIdentity) return { ...report, repairs: result("skipped", `Another doctor --fix holds ${lock}; no change was made.`) };
  const repairs: RepairResult[] = [];
  try {
    const backupDir = path.join(nexusDir, "doctor-backups");
    const manifest = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
    const backups = plans.filter((p) => p.previousMode !== undefined).map((p) => ({ path: p.target, previousMode: p.previousMode!.toString(8), repair: p.id }));
    if (backups.length) {
      try {
        mkdirVerified(home, backupDir);
        writeExclusiveVerified(home, manifest, JSON.stringify({ createdAt: new Date().toISOString(), restore: "chmod <previousMode> <path>", entries: backups }, null, 2));
      } catch (err) {
        // No backup, no permission change.
        for (const p of plans) repairs.push({ id: p.id, findingId: p.findingId, description: p.description, status: "refused", detail: `The backup manifest could not be written safely (${(err as Error).message}); no change was made.` });
        return { ...report, repairs };
      }
    }
    for (const plan of plans) {
      try {
        plan.apply(home);
        repairs.push({ id: plan.id, findingId: plan.findingId, description: plan.description, status: "applied", detail: backups.some((b) => b.path === plan.target) ? `Previous mode recorded in ${manifest}.` : "Applied." });
      } catch (err: any) {
        if (err instanceof SafePathError) {
          repairs.push({ id: plan.id, findingId: plan.findingId, description: plan.description, status: "skipped", detail: `Left alone: ${err.message} (changed since the diagnosis, or not safe to change).` });
        } else {
          repairs.push({ id: plan.id, findingId: plan.findingId, description: plan.description, status: "failed", detail: err?.message ?? String(err) });
        }
      }
    }
  } finally {
    try {
      unlinkVerified(home, lock, lockIdentity);
    } catch {}
  }
  const verified = await runDoctor({ ...options, signal: options.signal });
  for (const repair of repairs) {
    const after = verified.findings.find((finding) => finding.id === repair.findingId && finding.evidence[0] === plans.find((p) => p.id === repair.id && p.findingId === repair.findingId)?.target)
      ?? verified.findings.find((finding) => finding.id === repair.findingId);
    repair.verified = after?.status;
    if (repair.status === "applied" && after && after.status !== "pass") {
      repair.status = "unresolved";
      repair.detail += ` The check still reports ${after.status}: ${after.explanation}`;
    }
  }
  return { ...verified, repairs };
}

/**
 * An exclusive lock file holding our pid, created and verified without following links. A lock left by a process
 * that no longer exists is taken over. Returns the lock's identity (for a verified removal), or undefined when a live
 * process holds it.
 */
function acquireLock(home: string, lock: string): Identity | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return writeExclusiveVerified(home, lock, String(process.pid));
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const pid = Number(readVerified(home, lock));
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {}
      if (alive) return undefined;
      const stale = identityOf(lock);
      if (stale) unlinkVerified(home, lock, stale);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderDoctorText(report: DoctorReport): string {
  const out: string[] = [];
  const s = report.summary;
  out.push(`Nexus doctor ${report.nexusVersion} — ${report.context === "session" ? "active session configuration" : "fresh CLI configuration"}${report.deep ? " (deep)" : ""}`);
  out.push(`${s.pass} pass · ${s.warn} warn · ${s.fail} fail · ${s.skip} skipped · ${report.durationMs} ms${report.cancelled ? " · CANCELLED (incomplete)" : ""}`);
  out.push("");
  const order: DoctorStatus[] = ["fail", "warn", "pass", "skip"];
  for (const status of order) {
    for (const item of report.findings.filter((finding) => finding.status === status)) {
      out.push(`${status.toUpperCase().padEnd(4)} ${item.id}: ${item.explanation}`);
      for (const line of item.evidence.slice(0, 6)) out.push(`       · ${line}`);
      if (item.action) out.push(`       → ${item.action}`);
      if (item.repair) out.push(`       ⚒ supported repair: ${item.repair.description} (doctor --fix)`);
    }
  }
  if (report.effectiveConfig) {
    out.push("", "Effective configuration (value ← source):");
    for (const row of report.effectiveConfig) out.push(`  ${row.key.padEnd(28)} ${row.value}  ← ${row.source}`);
  }
  if (report.repairs) {
    out.push("", report.repairs.length ? "Repairs:" : "Repairs: none needed.");
    for (const r of report.repairs) out.push(`  ${r.status.toUpperCase()} ${r.id} — ${r.description}. ${r.detail}${r.verified ? ` (check now: ${r.verified})` : ""}`);
  }
  return out.join("\n");
}

export function doctorExitCode(report: DoctorReport): number {
  if (report.findings.some((item) => item.status === "fail")) return DOCTOR_EXIT.failures;
  if (report.findings.some((item) => item.status === "warn")) return DOCTOR_EXIT.warnings;
  return DOCTOR_EXIT.healthy;
}
