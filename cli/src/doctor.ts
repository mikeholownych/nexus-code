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
import { X509Certificate } from "node:crypto";
import { setMaxListeners } from "node:events";
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
import { untrustedWorkspaceExtensions, WORKSPACE_MCP_FILES, isWorkspaceTrusted } from "./workspace_trust.js";
import { BuildIdentity, getBuildIdentity } from "./build_identity.js";
import { defaultSessionsDir } from "./session.js";
import { defaultTaskStateDir } from "./core/state.js";
import { coreCargoManifest, resolveCoreBinary } from "./tools.js";
import { isProjectEnvKey } from "./config.js";
import { classifyLocality } from "./core/egress.js";
import { redactSecrets } from "./ui.js";
import { SafePathError, ancestryProblem, chmodVerified, identityOf, mkdirVerified, readVerified, unlinkVerified, writeExclusiveVerified, type Identity } from "./safe_fs.js";
import { isNexusDirPermissive } from "./core/durable_file.js";
export { isNexusDirPermissive };
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
  posture?: {
    mode: "auto" | "review" | "read-only";
    sandbox: string;
    trusted: boolean;
  };
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
const PACKAGED_HOME = process.env.NEXUS_HOME ? path.resolve(process.env.NEXUS_HOME) : undefined;
const INSTALL_ROOT = PACKAGED_HOME ?? path.resolve(here, "../..");
const CLI_ROOT = PACKAGED_HOME ? path.join(PACKAGED_HOME, "lib/cli") : path.join(INSTALL_ROOT, "cli");
const CORE_ROOT = PACKAGED_HOME ? path.join(PACKAGED_HOME, "lib/core") : path.join(INSTALL_ROOT, "core");
const DEFAULT_TIMEOUT_MS = 4000;

/** Credentials, authorization headers and URL secrets, in any field. */
export function redactDiagnostic(value: string, options?: { kind?: "path" | "text" }): string {
  const scrubbed = value
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)?\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|passwd|secret|key)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@");
  const isPath = options?.kind === "path" || (options?.kind !== "text" && path.isAbsolute(scrubbed));
  if (isPath) {
    return scrubbed;
  }
  return redactSecrets(scrubbed);
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
    return JSON.parse(fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8")).version ?? "unknown";
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
  timeoutOverride: boolean;
  /** Shared endpoint evidence: later endpoint findings depend on earlier ones. */
  endpoint?: Promise<EndpointEvidence>;
  /** An absent /models entry is advisory; --deep can independently verify it. */
  unlistedModel?: string;
  deepModelVerified?: boolean;
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
  { key: "max steps per segment", flag: "maxSteps", field: (c) => (c.continuation ? `${c.maxSteps} (checkpoint interval, not a limit)` : `${c.maxSteps} (turn limit: continuation off)`), fallback: "30" },
  { key: "NEXUS_MAX_TOTAL_STEPS", flag: "maxTotalSteps", field: (c) => (c.continuation ? (Number.isFinite(c.continuation.maxTotalSteps) ? String(c.continuation.maxTotalSteps) : "none") : "continuation off"), fallback: "none" },
  { key: "NEXUS_MAX_TURN_MINUTES", flag: "maxTurnMinutes", field: (c) => (c.continuation ? (Number.isFinite(c.continuation.maxTurnMinutes) ? String(c.continuation.maxTurnMinutes) : "none") : "continuation off"), fallback: "none" },
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
  const installEnv = path.join(CLI_ROOT, ".env");
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
  const dist = path.join(CLI_ROOT, "dist/index.js");
  const evidence = [
    `version ${build.version}`,
    build.commit === "unknown" ? (PACKAGED_HOME ? "build identity unknown" : "build identity unknown (built before build-info was recorded; run `make build`)") : `built from ${build.commit}${build.dirty ? " with uncommitted changes" : ""}${build.branch ? ` on ${build.branch}` : ""}`,
    `install root ${INSTALL_ROOT}`,
  ];
  if (!fs.existsSync(dist)) return f("install.build", "install", "fail", "The CLI build (cli/dist) is missing.", evidence, PACKAGED_HOME ? "Re-run the installer to restore missing files." : `Run \`make build\` in ${INSTALL_ROOT}.`);
  const built = fs.statSync(dist).mtimeMs;
  const source = PACKAGED_HOME ? 0 : newestMtime(path.join(CLI_ROOT, "src"), ".ts");
  if (source > built) {
    return f("install.build", "install", "warn", "cli/dist is older than cli/src: the running CLI may not include the latest source changes.", [...evidence, `dist ${new Date(built).toISOString()}`, `newest source ${new Date(source).toISOString()}`], `Run \`npm --prefix ${path.join(INSTALL_ROOT, "cli")} run build\`.`);
  }
  return f("install.build", "install", "pass", "The CLI build is present and not older than its source.", evidence);
};

const runtimeCheck: Check = async () => {
  const major = Number(process.versions.node.split(".")[0]);
  return f("runtime.node", "runtime", major >= 22 ? "pass" : "fail", `Node.js ${process.versions.node} (${major >= 22 ? "supported" : "older than the supported 22"}).`, [process.execPath], major >= 22 ? undefined : "Install Node.js 22 or later.");
};

const launcherCheck: Check = async () => {
  const launcher = resolveExecutable("nexus");
  if (!launcher) return f("runtime.launcher", "runtime", "skip", "No `nexus` launcher is on PATH (optional: Nexus can run as `node cli/dist/index.js`).", [], PACKAGED_HOME ? "Add ~/.local/bin to PATH or re-run the installer." : `Optionally link ${path.join(INSTALL_ROOT, "harness.sh")} into a PATH directory as \`nexus\`.`);
  let real = launcher;
  try {
    real = fs.realpathSync(launcher);
  } catch {}
  const ours = real === (PACKAGED_HOME ? path.join(PACKAGED_HOME, "bin/nexus") : path.join(INSTALL_ROOT, "harness.sh"));
  const evidence = PACKAGED_HOME
    ? [ours ? "The nexus launcher resolves to this packaged installation." : "The nexus launcher resolves outside this packaged installation."]
    : [`${launcher} -> ${real}`];
  let routesDoctor = false;
  try {
    routesDoctor = /\[\[ "\$1" == "doctor" \]\]/.test(fs.readFileSync(real, "utf8"));
  } catch {}
  if (!ours) return f("runtime.launcher", "runtime", "warn", "The `nexus` on PATH is not this installation's launcher.", evidence, PACKAGED_HOME ? "Use the nexus launcher installed by the package (add ~/.local/bin to PATH)." : `Point it at ${path.join(INSTALL_ROOT, "harness.sh")}, or run this installation directly.`);
  if (PACKAGED_HOME) return f("runtime.launcher", "runtime", "pass", "The `nexus` launcher on PATH is this packaged installation.", evidence);
  if (!routesDoctor) return f("runtime.launcher", "runtime", "fail", "The `nexus` launcher does not route `doctor`; `nexus doctor` would start an agent task instead.", evidence, PACKAGED_HOME ? "Re-run the installer to restore the nexus launcher." : "Update harness.sh from this checkout.");
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

/** REQ-SEC-110: settings a workspace .env tried to set that Nexus ignores (they belong to the operator). */
const projectEnvCheck: Check = async (ctx) => {
  const workspace = ctx.config?.workspace ?? process.cwd();
  const file = path.join(workspace, ".env");
  if (!fs.existsSync(file)) return f("config.project_env_ignored", "config", "skip", "The workspace has no .env.", [file]);
  let keys: string[];
  try {
    keys = Object.keys(parseDotenv(fs.readFileSync(file)));
  } catch (err) {
    return f("config.project_env_ignored", "config", "warn", "The workspace .env could not be read.", [file, String((err as Error)?.message ?? err)]);
  }
  const ignored = keys.filter((key) => !isProjectEnvKey(key));
  if (!ignored.length) return f("config.project_env_ignored", "config", "pass", "The workspace .env sets only per-project settings.", [file]);
  return f(
    "config.project_env_ignored",
    "config",
    "warn",
    `The workspace .env sets ${ignored.length} operator-only setting(s) that Nexus ignores: ${ignored.join(", ")}.`,
    [file],
    "Move settings you meant for Nexus to ~/.config/nexus/config.env (or your shell environment); a repository cannot change TLS, proxies, credentials, timeouts, the shell or trust.",
  );
};

interface EndpointEvidence {
  configured: boolean;
  endpoint?: string;
  reachable?: boolean;
  httpStatus?: number;
  detail?: string;
  models?: string[];
  modelError?: string;
  advertised?: import("./core/provider_capabilities.js").Advertisement;
}

async function gatherEndpoint(ctx: CheckContext, signal: AbortSignal): Promise<EndpointEvidence> {
  const config = ctx.config;
  if (!config?.endpoint) return { configured: false };
  const client = new LocalLlmClient({ ...config, maxSteps: 1 }, { role: "diagnostic" });
  const probe = await client.probeAvailability(signal, { timeoutMs: ctx.timeoutMs });
  const evidence: EndpointEvidence = { configured: true, endpoint: config.endpoint, reachable: probe.httpStatus !== undefined, httpStatus: probe.httpStatus, detail: probe.detail };
  if (probe.httpStatus !== undefined && probe.httpStatus >= 200 && probe.httpStatus < 300) {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      evidence.models = await Promise.race([
        client.listModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`model list did not answer within ${ctx.timeoutMs} ms`)), ctx.timeoutMs);
          onAbort = () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (err: any) {
      evidence.modelError = err?.message ?? String(err);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    try {
      const adv = await client.discoverAdvertisement(signal);
      if (adv?.advertised) evidence.advertised = adv.advertised;
    } catch {}
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
  const locality = classifyLocality(config.endpoint);
  const localityEvidence = `locality ${locality.boundary} (${locality.reason})`;
  const localityHelp =
    locality.boundary === "EXTERNAL_PUBLIC" && locality.reason === "hostname_external" && !config.provider
      ? "If this is a local LAN host, add it to NEXUS_LOCAL_ORIGINS in ~/.config/nexus/config.env."
      : undefined;
  out.push(
    f(
      "endpoint.configured",
      "endpoint",
      config.endpoint ? "pass" : "fail",
      config.endpoint ? "An inference endpoint is configured." : "No inference endpoint is configured.",
      [where, localityEvidence, `credential ${config.apiKey && config.apiKey !== "local" ? "present (bound to its own origin; not shown)" : "none configured; stored gateway credentials are attached per origin by the client"}`],
      localityHelp
    )
  );
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
  const contextEvidence = ev.advertised
    ? [`context ${ev.advertised.contextLength ?? "default"} via ${ev.advertised.via}${ev.advertised.serverKind ? ` (${ev.advertised.serverKind})` : ""}`]
    : [];
  if (ev.modelError || !ev.models) {
    out.push(f("model.available", "endpoint", "warn", "The model list could not be read.", [ev.modelError ?? "no list", ...contextEvidence]));
  } else if (!config.model || config.model === "local-model") {
    out.push(f("model.available", "endpoint", ev.models.length ? "pass" : "warn", ev.models.length ? `No model is named; a session would use the first listed model (${ev.models[0]}).` : "The endpoint lists no models.", [`${ev.models.length} listed`, ...contextEvidence], ev.models.length ? undefined : "Load a model on the server."));
  } else if (ev.models.includes(config.model)) {
    out.push(f("model.available", "endpoint", "pass", `The configured model ${config.model} is listed by the endpoint.`, [`${ev.models.length} models listed`, ...contextEvidence]));
  } else {
    ctx.unlistedModel = config.model;
    out.push(f("model.available", "endpoint", "warn", `The configured model ${config.model} is not listed by the endpoint; availability is unverified. A --deep inference probe can verify it.`, [`${ev.models.length} model(s) listed: ${ev.models.slice(0, 8).join(", ")}${ev.models.length > 8 ? ", …" : ""}`, ...contextEvidence]));
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
    ctx.deepModelVerified = true;
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
        ? f("engine.binary", "engine", "warn", "The Rust engine is not built; tools will run through a slow `cargo run` fallback.", [coreCargoManifest(), cargo], PACKAGED_HOME ? "Re-run the installer." : "Run `make build-core`.")
        : f("engine.binary", "engine", "fail", "The Rust engine is not built and cargo is unavailable, so no tool can run.", [coreCargoManifest()], PACKAGED_HOME ? "Re-run the installer." : "Install Rust and run `make build-core`."),
    );
    return out;
  }
  const version = await run(binary, ["--version"], { timeoutMs: ctx.timeoutMs, signal });
  const reported = version.stdout.trim().split(/\s+/).pop() ?? "";
  const evidence = [binary, version.stdout.trim() || version.error || version.stderr.trim()];
  if (version.code !== 0) {
    out.push(f("engine.binary", "engine", "fail", "The Rust engine binary does not run.", evidence, PACKAGED_HOME ? "Re-run the installer." : "Rebuild it with `make build-core`."));
    return out;
  }
  const builtAt = fs.statSync(binary).mtimeMs;
  // The engine is built from core/src/*.rs; core/src/bin holds the TUI, checked separately.
  const sourceAt = PACKAGED_HOME ? 0 : newestMtime(path.join(path.dirname(coreCargoManifest()), "src"), ".rs", 2000, false);
  if (reported !== nexusVersion()) {
    out.push(f("engine.binary", "engine", "warn", `The engine reports version ${reported}, the CLI ${nexusVersion()}.`, evidence, PACKAGED_HOME ? "Re-run the installer." : "Rebuild with `make build`."));
  } else if (sourceAt > builtAt) {
    out.push(f("engine.binary", "engine", "warn", "The engine binary is older than its source; it may not include recent fixes.", [...evidence, `built ${new Date(builtAt).toISOString()}`, `newest source ${new Date(sourceAt).toISOString()}`], PACKAGED_HOME ? "Re-run the installer." : "Rebuild with `make build-core`."));
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
      : f("engine.tool", "engine", "fail", "The engine could not execute a read-only tool in the workspace.", [workspace, call.timedOut ? "timed out" : (call.stderr || call.error || call.stdout).trim().slice(0, 300)], PACKAGED_HOME ? "Check workspace permissions and re-run the installer." : "Check workspace permissions and rebuild the engine."));
  }
  return out;
};

/** The live TUI and its sidecar: launchable and built from current source. */
const tuiCheck: Check = async (ctx, signal) => {
  const core = path.dirname(coreCargoManifest());
  const candidates = [
    ...(PACKAGED_HOME ? [path.join(CORE_ROOT, "nexus-tui")] : []),
    path.join(core, "target/release/nexus-tui"),
    path.join(core, "target/debug/nexus-tui"),
  ];
  const tui = candidates.find((c) => fs.existsSync(c));
  const sidecar = path.join(CLI_ROOT, "dist/sidecar.js");
  if (!tui || !fs.existsSync(sidecar)) {
    return f(
      "tui.launch",
      "install",
      "warn",
      "The live TUI is not built; `nexus` without arguments falls back to the readline REPL.",
      [!tui ? "nexus-tui binary missing" : "cli/dist/sidecar.js missing"],
      PACKAGED_HOME ? "Re-run the installer." : "Run `make build`."
    );
  }
  const checkResult = await run(tui, ["--live", "--check"], { timeoutMs: ctx.timeoutMs, signal });
  if (checkResult.code !== 0) {
    return f(
      "tui.launch",
      "install",
      "warn",
      "The live TUI cannot launch; `nexus` without arguments falls back to the readline REPL.",
      [tui, checkResult.stderr.trim() || checkResult.stdout.trim() || "sidecar resolution failed"],
      PACKAGED_HOME ? "Re-run the installer." : "Run `make build`."
    );
  }
  const sourceAt = PACKAGED_HOME ? 0 : newestMtime(path.join(core, "src/bin"), ".rs");
  const builtAt = fs.statSync(tui).mtimeMs;
  if (sourceAt > builtAt) {
    return f(
      "tui.launch",
      "install",
      "warn",
      "The live TUI binary is older than its source.",
      [tui, `built ${new Date(builtAt).toISOString()}`, `newest source ${new Date(sourceAt).toISOString()}`],
      "Run `make build-core`."
    );
  }
  return f("tui.launch", "install", "pass", "The live TUI is launchable and its sidecar resolves.", [tui, sidecar]);
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

const statePermissionsCheck: Check = async (ctx) => {
  const nexusDir = path.join(ctx.home, ".nexus");
  const historyFile = path.join(ctx.home, ".nexus_history");
  const out: Array<Omit<DoctorFinding, "durationMs">> = [];

  if (fs.existsSync(nexusDir)) {
    const unsafe = ancestryProblem(ctx.home, nexusDir);
    const mode = modeOf(nexusDir);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      if (unsafe) {
        out.push(f("state.permissions", "state", "warn", `The ~/.nexus directory is readable by other users (mode ${mode.toString(8)}), and its path is not safe to change automatically (${unsafe}).`, [nexusDir], "Review the path and restrict the real directory yourself (doctor never changes permissions through a link)."));
      } else {
        out.push(f("state.permissions", "state", "warn", `The ~/.nexus directory is readable by other users (mode ${mode.toString(8)}).`, [nexusDir], undefined, { id: "state.permissions", description: `chmod ${nexusDir} from ${mode.toString(8)} to 700`, expect: identityOf(nexusDir) }));
      }
    }

    const scanDir = (dir: string, depth = 0) => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const itemUnsafe = ancestryProblem(ctx.home, full);
        if (entry.isDirectory()) {
          if (entry.isSymbolicLink()) continue;
          const dirMode = modeOf(full);
          if (dirMode !== undefined && (dirMode & 0o077) !== 0) {
            if (itemUnsafe) {
              out.push(f("state.permissions", "state", "warn", `The ${path.relative(ctx.home, full)} directory is readable by other users (mode ${dirMode.toString(8)}), and its path is not safe to change automatically (${itemUnsafe}).`, [full], "Review the path and restrict the real directory yourself."));
            } else {
              out.push(f("state.permissions", "state", "warn", `The ${path.relative(ctx.home, full)} directory is readable by other users (mode ${dirMode.toString(8)}).`, [full], undefined, { id: "state.permissions", description: `chmod ${full} from ${dirMode.toString(8)} to 700`, expect: identityOf(full) }));
            }
          }
          scanDir(full, depth + 1);
        } else if (entry.isFile()) {
          if (entry.isSymbolicLink()) continue;
          const fileMode = modeOf(full);
          if (fileMode !== undefined && ((fileMode & 0o077) !== 0 || (fileMode & 0o111) !== 0)) {
            if (itemUnsafe) {
              out.push(f("state.permissions", "state", "warn", `The ${path.relative(ctx.home, full)} file is readable by other users (mode ${fileMode.toString(8)}), and its path is not safe to change automatically (${itemUnsafe}).`, [full], "Review the path and restrict the real file yourself."));
            } else {
              out.push(f("state.permissions", "state", "warn", `The ${path.relative(ctx.home, full)} file is readable by other users (mode ${fileMode.toString(8)}).`, [full], undefined, { id: "state.permissions", description: `chmod ${full} from ${fileMode.toString(8)} to 600`, expect: identityOf(full) }));
            }
          }
        }
      }
    };
    scanDir(nexusDir);
  }

  if (fs.existsSync(historyFile)) {
    const histUnsafe = ancestryProblem(ctx.home, historyFile);
    const histMode = modeOf(historyFile);
    if (histMode !== undefined && ((histMode & 0o077) !== 0 || (histMode & 0o111) !== 0)) {
      if (histUnsafe) {
        out.push(f("state.permissions", "state", "warn", `The ~/.nexus_history file is readable by other users (mode ${histMode.toString(8)}), and its path is not safe to change automatically (${histUnsafe}).`, [historyFile], "Review the path and restrict the real file yourself."));
      } else {
        out.push(f("state.permissions", "state", "warn", `The ~/.nexus_history file is readable by other users (mode ${histMode.toString(8)}).`, [historyFile], undefined, { id: "state.permissions", description: `chmod ${historyFile} from ${histMode.toString(8)} to 600`, expect: identityOf(historyFile) }));
      }
    }
  }

  if (out.length === 0) {
    return f("state.permissions", "state", "pass", "Nexus state directories and files are private (0700/0600).", [nexusDir]);
  }
  return out;
};

interface RecentStateFile {
  name: string;
  mtimeMs: number;
}

/** Keep only the newest `limit` entries in a min-heap, with filesystem work remaining asynchronous. */
function keepNewest(heap: RecentStateFile[], candidate: RecentStateFile, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].mtimeMs <= heap[index].mtimeMs) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (candidate.mtimeMs <= heap[0].mtimeMs) return;
  heap[0] = candidate;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && heap[left].mtimeMs < heap[smallest].mtimeMs) smallest = left;
    if (right < heap.length && heap[right].mtimeMs < heap[smallest].mtimeMs) smallest = right;
    if (smallest === index) return;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

const ATOMIC_JSON_TEMP = /^([A-Za-z0-9._-]{1,200}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

/** Only recognize the target.UUID.tmp names used by atomic JSON state writers, never arbitrary *.tmp files. */
function isAtomicJsonTemp(name: string): boolean {
  return ATOMIC_JSON_TEMP.test(name);
}

async function newestStateFiles(dir: string, limit: number, signal: AbortSignal, temps: string[]): Promise<RecentStateFile[]> {
  const newest: RecentStateFile[] = [];
  const directory = await fs.promises.opendir(dir);
  const pending: Promise<void>[] = [];
  // Keep the scan asynchronous without making long-lived state directories spend one deadline per file.
  // A fixed batch also bounds metadata requests if an operator has an unexpectedly large state tree.
  const statBatchSize = 128;
  const inspect = (entry: fs.Dirent) => {
    const full = path.join(dir, entry.name);
    const isTemp = isAtomicJsonTemp(entry.name);
    const isRecord = entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json" && !entry.name.startsWith(".corrupt-");
    if (!isTemp && !isRecord) return;
    pending.push((async () => {
      try {
        const stat = await fs.promises.lstat(full);
        if (signal.aborted || !stat.isFile() || stat.nlink !== 1) return;
        if (isTemp) temps.push(full);
        if (isRecord) keepNewest(newest, { name: entry.name, mtimeMs: stat.mtimeMs }, limit);
      } catch {}
    })());
  };
  for await (const entry of directory) {
    if (signal.aborted) break;
    inspect(entry);
    if (pending.length >= statBatchSize) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  await Promise.all(pending);
  return newest.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function validMessageCursor(value: any): boolean {
  return Boolean(value && typeof value === "object" && value.schemaVersion === 2 &&
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.offset) && value.offset >= 0 &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 1 &&
    Number.isSafeInteger(value.count) && value.count >= 0);
}

function validStateConversation(data: any, taskRecord: boolean): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (data.schemaVersion === 2) {
    return typeof data.taskId === "string" && data.taskId.length > 0 &&
      !Object.hasOwn(data, "messages") &&
      (data.messageLog === null || validMessageCursor(data.messageLog));
  }
  const identity = taskRecord ? data.taskId || data.id : data.sessionId || data.taskId || data.id;
  return Boolean(identity) && Array.isArray(data.messages);
}

const stateIntegrityCheck: Check = async (ctx, signal) => {
  const dirs = [path.join(ctx.home, ".nexus", "sessions"), path.join(ctx.home, ".nexus", "tasks")];
  let checked = 0;
  const corrupt: string[] = [];
  const temps: string[] = [];
  const unreadable: string[] = [];
  const limit = ctx.deep ? 5000 : 300;
  for (const dir of dirs) {
    if (signal.aborted) break;
    let files: RecentStateFile[];
    try {
      files = await newestStateFiles(dir, limit, signal, temps);
    } catch (error: any) {
      if (signal.aborted) break;
      // A missing store is simply empty; a store that exists but cannot be opened is not evidence of
      // health and must not be reported as "no saved state".
      if (error?.code !== "ENOENT") unreadable.push(dir);
      continue;
    }
    for (const { name } of files) {
      if (signal.aborted) break;
      const full = path.join(dir, name);
      checked++;
      try {
        const text = await fs.promises.readFile(full, { encoding: "utf8", signal });
        if (signal.aborted) break;
        const data = JSON.parse(text);
        if (!validStateConversation(data, path.basename(dir) === "tasks")) corrupt.push(full);
      } catch (error: any) {
        if (signal.aborted || error?.name === "AbortError") break;
        corrupt.push(full);
      }
    }
  }
  if (checked === 0 && temps.length === 0 && unreadable.length === 0) {
    return f("state.integrity", "state", "pass", "No saved sessions or task state yet.");
  }
  const evidence = [`${checked} record(s) checked${ctx.deep ? " (newest 5000 per directory)" : " (newest 300 per directory; --deep checks up to 5000)"}`];
  const issues: string[] = [];
  if (corrupt.length) issues.push(`${corrupt.length} saved record(s) are malformed and may not load`);
  if (temps.length) issues.push(`${temps.length} recognized atomic-write temporary file(s) are present; a write may still be active, so doctor cannot determine whether they are stale`);
  if (unreadable.length) issues.push(`${unreadable.length} state director${unreadable.length === 1 ? "y" : "ies"} could not be read, so doctor cannot determine whether the saved state is healthy`);
  if (issues.length) {
    return f("state.integrity", "state", "warn", `${issues.join("; ")}.`, [...evidence, ...corrupt.slice(0, 5), ...unreadable, ...temps.slice(0, 3)], "Inspect the listed paths and their permissions; doctor never deletes or repairs session or task files.");
  }
  return f("state.integrity", "state", "pass", "Every checked session and task-state record parses and has an id plus valid conversation metadata.", evidence);
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

const configEnvCheck: Check = async (ctx) => {
  const file = path.join(ctx.home, ".config/nexus/config.env");
  if (!fs.existsSync(file)) {
    return f("config.env", "config", "pass", "No ~/.config/nexus/config.env file present (optional configuration).", [file]);
  }
  const mode = modeOf(file) ?? 0;
  if (mode & 0o077) {
    const unsafe = ancestryProblem(ctx.home, file);
    if (unsafe) {
      return f("config.env", "config", "warn", `The configuration file is readable by other users (mode ${mode.toString(8)}), and its path is not safe to change automatically (${unsafe}).`, [file], "Review the path and restrict the real file yourself (doctor never changes permissions through a link).");
    }
    return f("config.env", "config", "warn", `The configuration file is readable by other users (mode ${mode.toString(8)}).`, [file], undefined, { id: "config.permissions", description: `chmod ${file} from ${mode.toString(8)} to 600`, expect: identityOf(file) });
  }
  return f("config.env", "config", "pass", "The configuration file is private to this user.", [file, `mode ${mode.toString(8)}`]);
};

const customCaCheck: Check = async (ctx) => {
  let raw: string | undefined;
  const configFile = path.join(ctx.home, ".config/nexus/config.env");
  if (fs.existsSync(configFile)) {
    try {
      raw = parseDotenv(fs.readFileSync(configFile)).NODE_EXTRA_CA_CERTS?.trim();
    } catch {}
  }
  if (!raw && ctx.home === credentialStorageHome()) {
    raw = process.env.NODE_EXTRA_CA_CERTS?.trim();
  }
  if (!raw) {
    return f("config.custom_ca", "config", "skip", "No custom CA certificate bundle (NODE_EXTRA_CA_CERTS) is configured (optional).");
  }
  const resolved = raw.startsWith("~/") ? path.join(ctx.home, raw.slice(2)) : path.resolve(ctx.home, raw);
  if (!fs.existsSync(resolved)) {
    return f("config.custom_ca", "config", "fail", `The configured custom CA bundle (${resolved}) does not exist.`, [resolved], "Set NODE_EXTRA_CA_CERTS in ~/.config/nexus/config.env to a readable PEM certificate file.");
  }
  let content: string;
  try {
    if (!fs.statSync(resolved).isFile()) {
      return f("config.custom_ca", "config", "fail", `The configured custom CA bundle (${resolved}) is not a regular file.`, [resolved], "Set NODE_EXTRA_CA_CERTS in ~/.config/nexus/config.env to a PEM certificate file.");
    }
    content = fs.readFileSync(resolved, "utf8");
  } catch (err: any) {
    return f("config.custom_ca", "config", "fail", `The configured custom CA bundle (${resolved}) could not be read.`, [resolved, err?.code ?? String(err)], "Check permissions on the certificate file.");
  }
  const blocks = content.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) {
    return f("config.custom_ca", "config", "fail", `The custom CA bundle (${resolved}) contains no PEM certificate blocks.`, [resolved], "Point NODE_EXTRA_CA_CERTS at a PEM-encoded X.509 certificate file.");
  }
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch (err: any) {
    return f("config.custom_ca", "config", "fail", `The custom CA bundle (${resolved}) could not be parsed as X.509 PEM.`, [resolved, String(err?.message ?? err)], "Replace the file named by NODE_EXTRA_CA_CERTS with a valid PEM certificate.");
  }
  return f("config.custom_ca", "config", "pass", `The custom CA bundle (${resolved}) exists and contains ${blocks.length} valid X.509 certificate(s).`, [resolved]);
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
  ["project_env_ignored", projectEnvCheck],
  ["endpoint", endpointChecks],
  ["inference", inferenceCheck],
  ["shell", shellCheck],
  ["engine", engineCheck],
  ["workspace", workspaceCheck],
  ["state", stateDirCheck],
  ["permissions", statePermissionsCheck],
  ["integrity", stateIntegrityCheck],
  ["credentials", credentialStoreCheck],
  ["config_env", configEnvCheck],
  ["custom_ca", customCaCheck],
  ["mcp", mcpCheck],
  ["plugins", pluginCheck],
];

/** Runs `check` with its own deadline; a throw or timeout becomes a finding, so other checks are unaffected. */
async function runCheck(name: string, check: Check, ctx: CheckContext, parent: AbortSignal): Promise<DoctorFinding[]> {
  const started = Date.now();
  const defaultLimit = name === "inference" ? ctx.timeoutMs * 6 + 1000 : name === "endpoint" ? ctx.timeoutMs * 2 + 1000 : ctx.timeoutMs + 1000;
  // The default integrity scan gets more time for large, long-lived stores.
  // An explicit --timeout remains authoritative for every check.
  const limit = name === "integrity" && !ctx.timeoutOverride ? Math.max(defaultLimit, 30_000) : defaultLimit;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  let onParentCancel: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      check(ctx, controller.signal),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), limit))),
      new Promise<"cancelled">((resolve) => {
        if (parent.aborted) {
          resolve("cancelled");
        } else {
          onParentCancel = () => resolve("cancelled");
          parent.addEventListener("abort", onParentCancel, { once: true });
        }
      }),
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
    if (onParentCancel) {
      parent.removeEventListener("abort", onParentCancel);
    }
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
  // Checks are deliberately started together. Each `runCheck` owns two one-shot
  // listeners on its parent signal (abort propagation and Promise.race cancellation),
  // so their known bounded fan-out exceeds Node 20's default EventTarget warning
  // threshold. Use a private signal and set its limit to that explicit fan-out;
  // never change the caller's signal or the process-wide listener default.
  const checksController = new AbortController();
  const signal = checksController.signal;
  const callerSignal = options.signal;
  const forwardAbort = () => checksController.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  setMaxListeners(CHECKS.length * 2, signal);
  const ctx: CheckContext = {
    config: options.config,
    configError: options.configError,
    flags: options.flags ?? {},
    deep: Boolean(options.deep),
    home: options.home ?? credentialStorageHome(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    timeoutOverride: options.timeoutMs !== undefined,
  };
  let results: DoctorFinding[][];
  try {
    results = await Promise.all(CHECKS.map(([name, check]) => runCheck(name, check, ctx, signal)));
  } finally {
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
  const findings = results.flat();
  if (ctx.unlistedModel && ctx.deepModelVerified) {
    const availability = findings.find((finding) => finding.id === "model.available");
    if (availability?.status === "warn") {
      availability.status = "pass";
      availability.explanation = `The configured model ${ctx.unlistedModel} is not listed by the endpoint, but a successful --deep inference probe verified that it is available.`;
      availability.evidence.push("verified by one successful deep inference request");
    }
  }
  const summary: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const finding of findings) summary[finding.status]++;
  const config = options.config;
  let posture: { mode: "auto" | "review" | "read-only"; sandbox: string; trusted: boolean } | undefined;
  if (config) {
    const trusted = isWorkspaceTrusted(config.workspace, Boolean(config.readOnly));
    const sandboxStatus = config.sandbox ? (typeof config.sandbox === "string" ? config.sandbox : "on") : "off";
    posture = {
      mode: config.approvalMode ?? (config.readOnly ? "read-only" : config.fullAccess ? "auto" : "review"),
      sandbox: sandboxStatus,
      trusted,
    };
  }
  const report: DoctorReport = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    tool: "nexus doctor",
    nexusVersion: nexusVersion(),
    buildIdentity: getBuildIdentity(),
    posture,
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
  return Boolean(value && typeof value === "object" && ("config" in (value as any) || "configError" in (value as any) || "context" in (value as any) || "deep" in (value as any) || "home" in (value as any) || "timeoutMs" in (value as any)));
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
  const seenTargets = new Set<string>();
  for (const finding of report.findings) {
    if (!finding.repair) continue;
    const target = finding.evidence[0];
    if (!target) continue;
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
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
    } else if (finding.repair.id === "state.permissions" || finding.repair.id === "credentials.permissions" || finding.repair.id === "config.permissions") {
      let isDir = false;
      try {
        isDir = fs.lstatSync(target).isDirectory();
      } catch {
        isDir = finding.repair.id === "state.permissions";
      }
      const wanted = isDir ? 0o700 : 0o600;
      const kind: "dir" | "file" = isDir ? "dir" : "file";
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
          chmodVerified(home, target, wanted, diagnosed, kind);
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
    const plan = plans.find((p) => p.id === repair.id && p.description === repair.description);
    const stillFailing = verified.findings.find((finding) => finding.id === repair.findingId && finding.evidence[0] === plan?.target && finding.status !== "pass");
    const after = stillFailing ?? verified.findings.find((finding) => finding.id === repair.findingId);
    repair.verified = after?.status ?? "pass";
    if (repair.status === "applied" && stillFailing) {
      repair.status = "unresolved";
      repair.detail += ` The check still reports ${stillFailing.status}: ${stillFailing.explanation}`;
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
  if (report.posture) {
    const p = report.posture;
    const trustStr = p.trusted ? "trusted" : "untrusted (nexus trust .)";
    out.push(`mode: ${p.mode} · sandbox: ${p.sandbox} · workspace: ${trustStr}`);
  }
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
