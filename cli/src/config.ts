import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
import { credentialOriginOf, credentialStorageHome, environmentCredential, LocalLlmClient, operatorSetting, setCredentialAuthority } from "./client.js";
import { baseUrlSetting, originOf, parseOriginList, PROVIDERS, providerDefinition } from "./providers.js";
import { providerApiKey } from "./credentials.js";
import { ContinuationBudget, DEFAULT_CONTINUATION, HarnessConfig, ApprovalMode } from "./types.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";

const installEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
let credentialAuthorityRecorded = false;
let shellEnvironment: Record<string, string | undefined> = {};
let userConfigFile: Record<string, string> = {};

/** Loads env files in precedence order; CLI flags are applied afterwards by buildConfig. */
export function loadEnvironment(): void {
  // The operator's own environment and home, before any file has written to process.env.
  const operatorEnvironment = credentialAuthorityRecorded ? undefined : { ...process.env };
  if (!credentialAuthorityRecorded && operatorEnvironment) {
    shellEnvironment = { ...operatorEnvironment };
  }
  const operatorHome = credentialAuthorityRecorded ? credentialStorageHome() : os.homedir();
  // 1. Installation directory defaults
  loadDotenv({ path: installEnv });
  // 2. Global user config (~/.config/nexus/config.env)
  const globalConfig = path.join(operatorHome, ".config/nexus/config.env");
  userConfigFile = {};
  if (fs.existsSync(globalConfig)) {
    loadDotenv({ path: globalConfig, override: true });
    userConfigFile = parseDotenv(fs.readFileSync(globalConfig));
  }
  // Credential bindings are decided by the operator environment and config.env only (see setCredentialAuthority).
  if (operatorEnvironment) {
    setCredentialAuthority({ ...operatorEnvironment, ...userConfigFile }, operatorHome);
    credentialAuthorityRecorded = true;
  }
  // 3. Current working directory overrides (skipped when cwd is the install directory: that file is the
  //    shipped default already applied in step 1 and must not outrank the user's global config). A project .env
  //    belongs to the repository, not the operator: only per-project settings in PROJECT_ENV_KEYS are applied; the
  //    rest (TLS and proxy settings, credentials, HOME, the shell, timeouts, fallbacks, trust) is ignored and reported.
  const cwdEnv = path.resolve(process.cwd(), ".env");
  projectEnvSettings = {};
  projectEnvIgnored = [];
  if (cwdEnv !== installEnv && fs.existsSync(cwdEnv)) {
    let project: Record<string, string> = {};
    try {
      project = parseDotenv(fs.readFileSync(cwdEnv));
    } catch {}
    for (const [key, value] of Object.entries(project)) {
      if (isProjectEnvKey(key)) projectEnvSettings[key] = value;
      else projectEnvIgnored.push(key);
    }
    if (projectEnvIgnored.length) {
      warnOnce(`ignored in ${cwdEnv}: ${projectEnvIgnored.join(", ")} (a project .env may set only per-project settings; put operator settings in ~/.config/nexus/config.env)`);
    }
  }
}

/**
 * Settings a repository's .env may choose for itself: which endpoint, model and endpoint key to use (a cloud destination
 * still needs the operator's authorization, and the key is bound to that endpoint's origin), task classes, budgets and
 * reasoning effort. Everything else is operator authority, including cloud provider keys and selection.
 */
const PROJECT_ENV_KEYS = new Set([
  "LOCAL_LLM_ENDPOINT",
  "LOCAL_LLM_MODEL",
  // The project's own key for the project's own endpoint: credential binding sends it only to that origin.
  "LOCAL_LLM_API_KEY",
  "LOCAL_LLM_TASK_CLASS",
  "PLANNER_LLM_ENDPOINT",
  "PLANNER_LLM_MODEL",
  "PLANNER_TASK_CLASS",
  "CODER_LLM_ENDPOINT",
  "CODER_LLM_MODEL",
  "NEXUS_TASK_CLASS",
  "NEXUS_CONTINUATION",
  "NEXUS_MAX_TOTAL_STEPS",
  "NEXUS_MAX_TURN_MINUTES",
  "NEXUS_STAGNATION_STEPS",
  "NEXUS_VERIFIER_TIMEOUT_SECS",
  "NEXUS_REASONING_EFFORT",
  "NEXUS_STRICT_TOKEN_COUNT",
  "NEXUS_CONTEXT_LIMIT",
]);

export function isProjectEnvKey(key: string): boolean {
  return PROJECT_ENV_KEYS.has(key) || /^NEXUS_PROJECT_[A-Z0-9_]+$/.test(key);
}

let projectEnvSettings: Record<string, string> = {};
let projectEnvIgnored: string[] = [];

/**
 * Resolves an effective configuration setting across layers:
 * 1. Operator shell environment (highest non-flag authority)
 * 2. Allowlisted project .env setting (per-project overrides of global config.env and defaults; never touches process.env)
 * 3. Global user config (~/.config/nexus/config.env)
 * 4. Base process environment / install defaults
 */
export function effectiveSetting(key: string): string | undefined {
  const shellVal = shellEnvironment[key]?.trim();
  if (shellVal) return shellVal;
  if (isProjectEnvKey(key) && projectEnvSettings[key] !== undefined) {
    return projectEnvSettings[key];
  }
  const configVal = userConfigFile[key]?.trim();
  if (configVal) return configVal;
  return (process.env[key]?.trim() || undefined);
}

export function projectSetting(key: string): string | undefined {
  return projectEnvSettings[key];
}

/** Keys the working directory's .env set but loadEnvironment ignored (operator-only settings). */
export function ignoredProjectEnvKeys(): readonly string[] {
  return projectEnvIgnored;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[nexus] ${message}`);
}

/**
 * A role's cloud provider: the command-line flag, else the operator's setting. A project .env cannot select a cloud
 * provider: that choice discloses the workspace to a third party and spends the operator's account.
 */
function selectProvider(flag: string | undefined, key: string): string | undefined {
  const chosen = flag?.trim() || operatorSetting(key);
  const projectValue = process.env[key]?.trim();
  if (!flag?.trim() && projectValue && projectValue !== chosen) {
    warnOnce(`${key}=${projectValue} from a project .env is ignored: cloud provider selection belongs to the operator (command-line flag or ~/.config/nexus/config.env).`);
  }
  if (chosen && !providerDefinition(chosen)) {
    throw new Error(`Unknown provider '${chosen}' (${key}). Known providers: ${Object.keys(PROVIDERS).join(", ")}.`);
  }
  return chosen || undefined;
}

/** Base URL of a provider connection: the operator's override (flag or NEXUS_<ID>_BASE_URL), else the provider default. */
export function providerBaseUrl(id: string, flag?: string): string {
  const url = flag?.trim() || operatorSetting(baseUrlSetting(id)) || providerDefinition(id)?.baseUrl;
  if (!url || !originOf(url)) {
    throw new Error(`Provider '${id}' needs a base URL: pass --base-url or set ${baseUrlSetting(id)} in ~/.config/nexus/config.env.`);
  }
  return url.trim().replace(/\/+$/, "");
}

/**
 * The provider's own key — its variable, Nexus's credential store, or a connection registered in another client —
 * bound to the connection's origin and never sent anywhere else. Sign-in (OAuth) providers resolve their token per
 * request in the client instead.
 */
export function providerKey(id: string): string | undefined {
  return providerApiKey(id, providerDefinition(id)!.credentialEnv);
}

/** True when the operator (not a project .env) chose this setting's current value. */
function operatorChose(key: string): boolean {
  return operatorSetting(key) !== undefined;
}

/** Operator-declared workspace-relative task outputs; project files cannot populate this authority. */
function normalizeTrustedDeliverableFiles(workspace: string, value: unknown): string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (Array.isArray(value) && entries.length === 0) return [];
  if (entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("--deliverable-file requires one or more non-empty workspace-relative file paths.");
  }
  const root = path.resolve(workspace);
  const rootReal = fs.realpathSync(root);
  const normalized = entries.map((entry) => {
    const raw = (entry as string).trim();
    if (path.isAbsolute(raw) || raw.includes("\\") || raw.includes("\0") || /[*?{}]/.test(raw)) {
      throw new Error(`Invalid --deliverable-file '${raw}': use a literal workspace-relative path.`);
    }
    const candidate = path.posix.normalize(raw);
    const resolved = path.resolve(root, candidate);
    if (candidate !== raw || candidate === "." || candidate.startsWith("../") || resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Invalid --deliverable-file '${raw}': path must stay inside the workspace and be normalized.`);
    }
    if (/(^|\/)(?:test|tests|__tests__)(\/|$)|(?:^|\/)test[^/]*\.[^/]+$/i.test(candidate)) {
      throw new Error(`Invalid --deliverable-file '${raw}': test and oracle files cannot be declared as product deliverables.`);
    }
    let cursor = root;
    for (const part of candidate.split("/")) {
      cursor = path.join(cursor, part);
      try {
        const stat = fs.lstatSync(cursor);
        const real = fs.realpathSync(cursor);
        const relative = path.relative(rootReal, real);
        if (stat.isSymbolicLink() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Invalid --deliverable-file '${raw}': symlinked or external paths are not permitted.`);
        }
      } catch (error: any) {
        if (error?.code === "ENOENT") break;
        throw error;
      }
    }
    return candidate;
  });
  return [...new Set(normalized)].sort();
}

export function buildConfig(options: any): HarnessConfig {
  // `appliance: true` resolves the appliance connection regardless of any provider selection (the model picker's
  // appliance entry).
  const provider = options.appliance ? undefined : selectProvider(options.provider, "NEXUS_PROVIDER");
  const endpoint = provider ? providerBaseUrl(provider, options.baseUrl) : options.endpoint || effectiveSetting("LOCAL_LLM_ENDPOINT") || DEFAULT_ENDPOINT;
  // A cloud model is named explicitly; the appliance's LOCAL_LLM_MODEL never selects a billable cloud model.
  const model = provider ? options.model || operatorSetting("NEXUS_MODEL") || "" : options.model || effectiveSetting("LOCAL_LLM_MODEL") || "local-model";
  // Stored gateway credentials are not baked in here: the client attaches them only to the gateway they belong to.
  const operatorKey = operatorSetting("LOCAL_LLM_API_KEY");
  const projectApiKey = effectiveSetting("LOCAL_LLM_API_KEY");
  const envCredential = options.apiKey || provider ? undefined : environmentCredential(options.endpoint || DEFAULT_ENDPOINT);
  const apiKey = options.apiKey || (provider ? providerKey(provider) : operatorKey || projectApiKey || envCredential?.apiKey) || "local";
  const credentialOrigin = apiKey === "local" ? undefined : options.apiKey || provider ? credentialOriginOf(endpoint) : (operatorKey ? envCredential?.origin : (projectApiKey ? credentialOriginOf(endpoint) : envCredential?.origin));
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const maxSteps = options.maxSteps ? parseInt(options.maxSteps, 10) : 30;
  const continuation = continuationBudget(options);
  const temperature = options.temperature ? parseFloat(options.temperature) : 0.2;
  const shell = options.shell || operatorSetting("LOCAL_HARNESS_SHELL") || process.env.LOCAL_HARNESS_SHELL || "bash";
  const dryRun = Boolean(options.dryRun);
  const readOnly = Boolean(options.readOnly);
  const yes = Boolean(options.yes);
  const approve = Boolean(options.approve);
  const modeOption = options.mode ? String(options.mode).toLowerCase() : undefined;
  const envMode = (operatorSetting("NEXUS_APPROVAL_MODE") || process.env.NEXUS_APPROVAL_MODE)?.trim().toLowerCase();

  let approvalMode: ApprovalMode;
  let fullAccess = Boolean(options.fullAccess);

  if (readOnly) {
    approvalMode = "read-only";
  } else if (yes) {
    approvalMode = "auto";
    fullAccess = true;
  } else if (approve) {
    approvalMode = "review";
  } else if (modeOption === "auto" || modeOption === "review" || modeOption === "read-only") {
    approvalMode = modeOption as ApprovalMode;
    if (approvalMode === "auto" && options.yes) fullAccess = true;
  } else if (envMode === "auto" || envMode === "review" || envMode === "read-only") {
    approvalMode = envMode as ApprovalMode;
    if (approvalMode === "auto") fullAccess = true;
  } else {
    // Default resolution per DEC-01 C: trusted -> auto, else review
    const trusted = isWorkspaceTrusted(workspace, readOnly);
    approvalMode = trusted ? "auto" : "review";
  }

  const sandbox = options.sandbox ? (typeof options.sandbox === "string" ? options.sandbox : true) : undefined;
  if (provider && options.fallback) warnOnce(`--fallback is ignored for provider '${provider}': a provider connection is pinned to its own endpoint.`);
  const fallbackEndpoints = options.fallback && !provider ? options.fallback.split(",").map((s: string) => s.trim()) : undefined;
  const contextLimit = options.contextLimit ? parseInt(options.contextLimit, 10) : (effectiveSetting("NEXUS_CONTEXT_LIMIT") ? parseInt(effectiveSetting("NEXUS_CONTEXT_LIMIT")!, 10) : undefined);
  const strictTokenCount = Boolean(options.strictTokenCount) || effectiveSetting("NEXUS_STRICT_TOKEN_COUNT") === "1";
  const worktree = Boolean(options.worktree);
  const authoritativeVerifierCommand = options.authoritativeVerifier;
  const trustedDeliverableFiles = normalizeTrustedDeliverableFiles(workspace, options.deliverableFile);
  const recordFlight = Boolean(options.recordFlight || options.flight);
  const plannerProvider = selectProvider(options.plannerProvider, "PLANNER_LLM_PROVIDER");
  const coderProvider = selectProvider(options.coderProvider, "CODER_LLM_PROVIDER");
  const plannerModel = options.plannerModel || effectiveSetting("PLANNER_LLM_MODEL");
  const plannerEndpoint = plannerProvider ? providerBaseUrl(plannerProvider) : options.plannerEndpoint || effectiveSetting("PLANNER_LLM_ENDPOINT");
  const coderModel = options.coderModel || effectiveSetting("CODER_LLM_MODEL");
  const coderEndpoint = coderProvider ? providerBaseUrl(coderProvider) : options.coderEndpoint || effectiveSetting("CODER_LLM_ENDPOINT");
  if (plannerProvider && !plannerModel) throw new Error(`Planner provider '${plannerProvider}' needs an explicit model: pass --planner-model or set PLANNER_LLM_MODEL.`);
  if (coderProvider && !coderModel) throw new Error(`Coder provider '${coderProvider}' needs an explicit model: pass --coder-model or set CODER_LLM_MODEL.`);
  const plannerApiKey = plannerProvider ? providerKey(plannerProvider) : undefined;
  const coderApiKey = coderProvider ? providerKey(coderProvider) : undefined;

  // Disclosure authority: destinations the operator selected (flags, operator environment, config.env) plus origins
  // listed in NEXUS_CLOUD_DISCLOSURE_ORIGINS. An endpoint chosen only by a project .env, and any fallback endpoint,
  // is not authorized to receive task content when it is a cloud destination.
  const authorized = new Set(parseOriginList(operatorSetting("NEXUS_CLOUD_DISCLOSURE_ORIGINS")));
  const authorize = (url: string | undefined) => {
    const o = originOf(url);
    if (o) authorized.add(o);
  };
  if (provider || options.endpoint || operatorChose("LOCAL_LLM_ENDPOINT")) authorize(endpoint);
  if (plannerProvider || options.plannerEndpoint || operatorChose("PLANNER_LLM_ENDPOINT")) authorize(plannerEndpoint);
  if (coderProvider || options.coderEndpoint || operatorChose("CODER_LLM_ENDPOINT")) authorize(coderEndpoint);
  const cloudRoutedOrigins = parseOriginList(operatorSetting("NEXUS_CLOUD_ROUTED_ORIGINS"));
  const reasoningEffort = effectiveSetting("NEXUS_REASONING_EFFORT")?.trim() || undefined;
  const thinkingRaw = Number(process.env.NEXUS_ANTHROPIC_THINKING_BUDGET);
  const anthropicThinkingBudget = Number.isFinite(thinkingRaw) && thinkingRaw >= 1024 ? Math.floor(thinkingRaw) : undefined;
  const tdd = Boolean(options.tdd);
  const verifierTimeoutRaw = Number(effectiveSetting("NEXUS_VERIFIER_TIMEOUT_SECS"));
  const verifierTimeoutSecs = Number.isFinite(verifierTimeoutRaw) && verifierTimeoutRaw > 0 ? verifierTimeoutRaw : undefined;
  const taskClass = effectiveSetting("NEXUS_TASK_CLASS") || effectiveSetting("LOCAL_LLM_TASK_CLASS") || undefined;
  const plannerTaskClass = effectiveSetting("PLANNER_TASK_CLASS") || undefined;
  return {
    taskClass,
    plannerTaskClass,
    endpoint,
    model,
    apiKey,
    ...(credentialOrigin ? { credentialOrigin } : {}),
    workspace,
    maxSteps,
    ...(continuation ? { continuation } : {}),
    temperature,
    shell,
    dryRun,
    readOnly,
    approvalMode,
    yes,
    fullAccess,
    sandbox,
    fallbackEndpoints,
    contextLimit,
    ...(strictTokenCount ? { strictTokenCount } : {}),
    worktree,
    authoritativeVerifierCommand,
    trustedDeliverableFiles,
    verifierTimeoutSecs,
    recordFlight,
    plannerModel,
    plannerEndpoint,
    coderModel,
    coderEndpoint,
    tdd,
    ...(provider ? { provider } : {}),
    ...(plannerProvider ? { plannerProvider, plannerApiKey } : {}),
    ...(coderProvider ? { coderProvider, coderApiKey } : {}),
    authorizedDisclosureOrigins: [...authorized],
    ...(cloudRoutedOrigins.length ? { cloudRoutedOrigins } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(anthropicThinkingBudget ? { anthropicThinkingBudget } : {}),
  };
}

/**
 * Continuation budgets: flags, then NEXUS_MAX_TOTAL_STEPS / NEXUS_MAX_TURN_MINUTES / NEXUS_STAGNATION_STEPS, then
 * defaults. There is no default step or time ceiling: progressing work continues until it completes, is cancelled,
 * stagnates or fails. A step or time limit exists only when the operator sets one. `--no-continuation` (or
 * NEXUS_CONTINUATION=0) is the operator's explicit choice of the single-segment turn that ends at --max-steps.
 */
export function continuationBudget(options: any): ContinuationBudget | undefined {
  if (options.continuation === false || effectiveSetting("NEXUS_CONTINUATION") === "0") return undefined;
  const positive = (flag: unknown, env: string | undefined, fallback: number): number => {
    for (const raw of [flag, env]) {
      if (raw === undefined || raw === null || raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid continuation budget '${String(raw)}': expected a positive number.`);
      return value;
    }
    return fallback;
  };
  const steps = positive(options.maxTotalSteps, effectiveSetting("NEXUS_MAX_TOTAL_STEPS"), DEFAULT_CONTINUATION.maxTotalSteps);
  return {
    ...DEFAULT_CONTINUATION,
    maxTotalSteps: Number.isFinite(steps) ? Math.floor(steps) : steps,
    maxTurnMinutes: positive(options.maxTurnMinutes, effectiveSetting("NEXUS_MAX_TURN_MINUTES"), DEFAULT_CONTINUATION.maxTurnMinutes),
    stagnationSteps: Math.floor(positive(options.stagnationSteps, effectiveSetting("NEXUS_STAGNATION_STEPS"), DEFAULT_CONTINUATION.stagnationSteps)),
  };
}

/** Replaces the "local-model" placeholder with the first model the gateway lists; unchanged if the gateway is unreachable. */
export async function autoDetectModel(config: HarnessConfig): Promise<HarnessConfig> {
  // A provider's catalog lists billable models; one is never chosen on the operator's behalf.
  if (config.provider || config.model !== "local-model") return config;
  try {
    const models = await new LocalLlmClient(config).listModels();
    if (models.length > 0) return { ...config, model: models[0] };
  } catch {
    // Keep the placeholder; the first inference request will surface the connection problem.
  }
  return config;
}
