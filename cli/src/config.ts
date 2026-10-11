import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
import { credentialOriginOf, credentialStorageHome, environmentCredential, LocalLlmClient, operatorSetting, setCredentialAuthority } from "./client.js";
import { baseUrlSetting, originOf, parseOriginList, PROVIDERS, providerDefinition } from "./providers.js";
import { providerApiKey } from "./credentials.js";
import { HarnessConfig } from "./types.js";

const installEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
let credentialAuthorityRecorded = false;

/** Loads env files in precedence order; CLI flags are applied afterwards by buildConfig. */
export function loadEnvironment(): void {
  // The operator's own environment and home, before any file has written to process.env.
  const operatorEnvironment = credentialAuthorityRecorded ? undefined : { ...process.env };
  const operatorHome = credentialAuthorityRecorded ? credentialStorageHome() : os.homedir();
  // 1. Installation directory defaults
  loadDotenv({ path: installEnv });
  // 2. Global user config (~/.config/nexus/config.env)
  const globalConfig = path.join(operatorHome, ".config/nexus/config.env");
  let userConfig: Record<string, string> = {};
  if (fs.existsSync(globalConfig)) {
    loadDotenv({ path: globalConfig, override: true });
    userConfig = parseDotenv(fs.readFileSync(globalConfig));
  }
  // Credential bindings are decided by the operator environment and config.env only (see setCredentialAuthority).
  if (operatorEnvironment) {
    setCredentialAuthority({ ...operatorEnvironment, ...userConfig }, operatorHome);
    credentialAuthorityRecorded = true;
  }
  // 3. Current working directory overrides (skipped when cwd is the install directory: that file is the
  //    shipped default already applied in step 1 and must not outrank the user's global config)
  const cwdEnv = path.resolve(process.cwd(), ".env");
  if (cwdEnv !== installEnv) {
    loadDotenv({ path: cwdEnv, override: true });
  }
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
  const own = operatorSetting(key);
  return own !== undefined && own === process.env[key]?.trim();
}

export function buildConfig(options: any): HarnessConfig {
  // `appliance: true` resolves the appliance connection regardless of any provider selection (the model picker's
  // appliance entry).
  const provider = options.appliance ? undefined : selectProvider(options.provider, "NEXUS_PROVIDER");
  const endpoint = provider ? providerBaseUrl(provider, options.baseUrl) : options.endpoint || process.env.LOCAL_LLM_ENDPOINT || DEFAULT_ENDPOINT;
  // A cloud model is named explicitly; the appliance's LOCAL_LLM_MODEL never selects a billable cloud model.
  const model = provider ? options.model || operatorSetting("NEXUS_MODEL") || "" : options.model || process.env.LOCAL_LLM_MODEL || "local-model";
  // Stored gateway credentials are not baked in here: the client attaches them only to the gateway they belong to.
  const envCredential = options.apiKey || provider ? undefined : environmentCredential(options.endpoint || DEFAULT_ENDPOINT);
  const apiKey = options.apiKey || (provider ? providerKey(provider) : envCredential?.apiKey) || "local";
  const credentialOrigin = apiKey === "local" ? undefined : options.apiKey || provider ? credentialOriginOf(endpoint) : envCredential?.origin;
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const maxSteps = options.maxSteps ? parseInt(options.maxSteps, 10) : 30;
  const temperature = options.temperature ? parseFloat(options.temperature) : 0.2;
  const shell = options.shell || process.env.LOCAL_HARNESS_SHELL || "bash";
  const dryRun = Boolean(options.dryRun);
  const readOnly = Boolean(options.readOnly);
  const sandbox = options.sandbox ? (typeof options.sandbox === "string" ? options.sandbox : true) : undefined;
  if (provider && options.fallback) warnOnce(`--fallback is ignored for provider '${provider}': a provider connection is pinned to its own endpoint.`);
  const fallbackEndpoints = options.fallback && !provider ? options.fallback.split(",").map((s: string) => s.trim()) : undefined;
  const contextLimit = options.contextLimit ? parseInt(options.contextLimit, 10) : undefined;
  const worktree = Boolean(options.worktree);
  const authoritativeVerifierCommand = options.authoritativeVerifier;
  const recordFlight = Boolean(options.recordFlight || options.flight);
  const plannerProvider = selectProvider(options.plannerProvider, "PLANNER_LLM_PROVIDER");
  const coderProvider = selectProvider(options.coderProvider, "CODER_LLM_PROVIDER");
  const plannerModel = options.plannerModel || process.env.PLANNER_LLM_MODEL;
  const plannerEndpoint = plannerProvider ? providerBaseUrl(plannerProvider) : options.plannerEndpoint || process.env.PLANNER_LLM_ENDPOINT;
  const coderModel = options.coderModel || process.env.CODER_LLM_MODEL;
  const coderEndpoint = coderProvider ? providerBaseUrl(coderProvider) : options.coderEndpoint || process.env.CODER_LLM_ENDPOINT;
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
  const reasoningEffort = process.env.NEXUS_REASONING_EFFORT?.trim() || undefined;
  const thinkingRaw = Number(process.env.NEXUS_ANTHROPIC_THINKING_BUDGET);
  const anthropicThinkingBudget = Number.isFinite(thinkingRaw) && thinkingRaw >= 1024 ? Math.floor(thinkingRaw) : undefined;
  const tdd = Boolean(options.tdd);
  const verifierTimeoutRaw = Number(process.env.NEXUS_VERIFIER_TIMEOUT_SECS);
  const verifierTimeoutSecs = Number.isFinite(verifierTimeoutRaw) && verifierTimeoutRaw > 0 ? verifierTimeoutRaw : undefined;
  const taskClass = process.env.NEXUS_TASK_CLASS || undefined;
  const plannerTaskClass = process.env.PLANNER_TASK_CLASS || undefined;
  return {
    taskClass,
    plannerTaskClass,
    endpoint,
    model,
    apiKey,
    ...(credentialOrigin ? { credentialOrigin } : {}),
    workspace,
    maxSteps,
    temperature,
    shell,
    dryRun,
    readOnly,
    sandbox,
    fallbackEndpoints,
    contextLimit,
    worktree,
    authoritativeVerifierCommand,
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
