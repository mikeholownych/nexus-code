import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
import { credentialOriginOf, environmentCredential, LocalLlmClient, setCredentialAuthority } from "./client.js";
import { HarnessConfig } from "./types.js";

const installEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
let credentialAuthorityRecorded = false;

/** Loads env files in precedence order; CLI flags are applied afterwards by buildConfig. */
export function loadEnvironment(): void {
  // The operator's own environment, before any file has written to process.env.
  const operatorEnvironment = credentialAuthorityRecorded ? undefined : { ...process.env };
  // 1. Installation directory defaults
  loadDotenv({ path: installEnv });
  // 2. Global user config (~/.config/nexus/config.env)
  const globalConfig = path.join(os.homedir(), ".config/nexus/config.env");
  let userConfig: Record<string, string> = {};
  if (fs.existsSync(globalConfig)) {
    loadDotenv({ path: globalConfig, override: true });
    userConfig = parseDotenv(fs.readFileSync(globalConfig));
  }
  // Credential bindings are decided by the operator environment and config.env only (see setCredentialAuthority).
  if (operatorEnvironment) {
    setCredentialAuthority({ ...operatorEnvironment, ...userConfig });
    credentialAuthorityRecorded = true;
  }
  // 3. Current working directory overrides (skipped when cwd is the install directory: that file is the
  //    shipped default already applied in step 1 and must not outrank the user's global config)
  const cwdEnv = path.resolve(process.cwd(), ".env");
  if (cwdEnv !== installEnv) {
    loadDotenv({ path: cwdEnv, override: true });
  }
}

export function buildConfig(options: any): HarnessConfig {
  const endpoint = options.endpoint || process.env.LOCAL_LLM_ENDPOINT || DEFAULT_ENDPOINT;
  const model = options.model || process.env.LOCAL_LLM_MODEL || "local-model";
  // Stored gateway credentials are not baked in here: the client attaches them only to the gateway they belong to.
  const envCredential = options.apiKey ? undefined : environmentCredential(options.endpoint || DEFAULT_ENDPOINT);
  const apiKey = options.apiKey || envCredential?.apiKey || "local";
  const credentialOrigin = apiKey === "local" ? undefined : options.apiKey ? credentialOriginOf(endpoint) : envCredential?.origin;
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const maxSteps = options.maxSteps ? parseInt(options.maxSteps, 10) : 30;
  const temperature = options.temperature ? parseFloat(options.temperature) : 0.2;
  const shell = options.shell || process.env.LOCAL_HARNESS_SHELL || "bash";
  const dryRun = Boolean(options.dryRun);
  const readOnly = Boolean(options.readOnly);
  const sandbox = options.sandbox ? (typeof options.sandbox === "string" ? options.sandbox : true) : undefined;
  const fallbackEndpoints = options.fallback ? options.fallback.split(",").map((s: string) => s.trim()) : undefined;
  const contextLimit = options.contextLimit ? parseInt(options.contextLimit, 10) : undefined;
  const worktree = Boolean(options.worktree);
  const authoritativeVerifierCommand = options.authoritativeVerifier;
  const recordFlight = Boolean(options.recordFlight || options.flight);
  const plannerModel = options.plannerModel || process.env.PLANNER_LLM_MODEL;
  const plannerEndpoint = options.plannerEndpoint || process.env.PLANNER_LLM_ENDPOINT;
  const coderModel = options.coderModel || process.env.CODER_LLM_MODEL;
  const coderEndpoint = options.coderEndpoint || process.env.CODER_LLM_ENDPOINT;
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
  };
}

/** Replaces the "local-model" placeholder with the first model the gateway lists; unchanged if the gateway is unreachable. */
export async function autoDetectModel(config: HarnessConfig): Promise<HarnessConfig> {
  if (config.model !== "local-model") return config;
  try {
    const models = await new LocalLlmClient(config).listModels();
    if (models.length > 0) return { ...config, model: models[0] };
  } catch {
    // Keep the placeholder; the first inference request will surface the connection problem.
  }
  return config;
}
