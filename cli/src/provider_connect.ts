/**
 * Connecting providers and switching the session's model; shared by the live TUI (through the sidecar) and the CLI.
 * A key is verified against the provider before it is saved; a sign-in is saved when the provider issues the
 * credential and then verified. Nothing here prints or returns a credential.
 */
import { InferenceError, LocalLlmClient } from "./client.js";
import { commitLocalEndpointSetup, removeCredential, resolveCredential, saveCredential, type StoredCredential } from "./credentials.js";
import { APPLIANCE, applianceConfig, chatModel, connectionOf, providerConfig, recordRecent, type ModelRef } from "./model_catalog.js";
import { openBrowser, startAuthFlow, type AuthPrompt } from "./oauth.js";
import { disclosureClass, originOf, providerDefinition } from "./providers.js";
import { activateApplianceEndpoint, applianceEndpointSelection, pendingApplianceEndpointKey, resetApplianceEndpointOverride, saveLocalEndpointSettings } from "./config.js";
import type { HarnessConfig } from "./types.js";
import type { AutonomousAgent } from "./agent.js";
import { redactSecrets } from "./ui.js";

const describe = (err: unknown): string => {
  if (err instanceof InferenceError) {
    if (err.condition === "AUTH_FAILURE") return "the provider rejected the credential";
    return redactSecrets(err.message).slice(0, 300);
  }
  return redactSecrets(String((err as any)?.message ?? err)).slice(0, 300);
};

/** Lists the provider's models with `apiKey` (or its sign-in); proves the credential works without sending content. */
async function verify(base: HarnessConfig, providerId: string, apiKey?: string): Promise<number> {
  const cfg = providerConfig(base, providerId);
  const models = await new LocalLlmClient(apiKey ? { ...cfg, apiKey } : cfg).listModels();
  return models.length;
}

export async function connectWithKey(base: HarnessConfig, providerId: string, key: string): Promise<{ ok: boolean; message: string }> {
  const def = providerDefinition(providerId);
  const value = key.trim();
  if (!def || !def.methods.some((m) => m.kind === "key")) return { ok: false, message: `${providerId} does not take an API key.` };
  if (!value || /\s/.test(value)) return { ok: false, message: "That does not look like an API key." };
  try {
    const count = await verify(base, providerId, value);
    saveCredential(providerId, { type: "api", key: value, savedAt: new Date().toISOString() });
    const shadow = def.credentialEnv && process.env[def.credentialEnv]?.trim() ? ` Note: $${def.credentialEnv} is set and takes precedence over the saved key.` : "";
    return { ok: true, message: `${def.label} connected (${count} models available).${shadow}` };
  } catch (err) {
    return { ok: false, message: `${def.label} key not saved: ${describe(err)}.` };
  }
}

export interface LocalEndpointConnection {
  ok: boolean;
  message: string;
  models: string[];
}

export interface LocalEndpointPreparation {
  ok: boolean;
  message: string;
  cancelled?: boolean;
}

const localEndpointSetupRequests = new Map<string, { cancelled: boolean }>();
let provisionalLocalEndpointRequestId: string | undefined;

/** Cancel only the matching in-flight or already-completed local endpoint request. */
export function cancelLocalEndpointSetup(requestId: string): void {
  const request = localEndpointSetupRequests.get(requestId);
  if (request) {
    request.cancelled = true;
    localEndpointSetupRequests.delete(requestId);
  }
  clearLocalEndpointSetup(requestId);
}

/** Explicitly clear the matching completed setup when its model picker closes. */
export function clearLocalEndpointSetup(requestId: string): void {
  if (!requestId || provisionalLocalEndpointRequestId !== requestId) return;
  provisionalLocalEndpointRequestId = undefined;
  resetApplianceEndpointOverride();
}

/** Clear provisional state after the operator's explicit local model selection could not be committed. */
export function clearLocalEndpointSetupAfterSelectionFailure(): void {
  if (provisionalLocalEndpointRequestId) clearLocalEndpointSetup(provisionalLocalEndpointRequestId);
}

function validatedEndpoint(input: string): { endpoint: string; origin: string } | undefined {
  const endpoint = input.trim().replace(/\/+$/, "");
  try {
    const url = new URL(endpoint);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || /[\r\n\0]/.test(endpoint)) return undefined;
    return { endpoint, origin: url.origin };
  } catch {
    return undefined;
  }
}

function localEndpointConfig(base: HarnessConfig, endpoint: string, origin: string, key: string): HarnessConfig {
  return {
    ...base,
    provider: undefined,
    endpoint,
    model: "local-model",
    ...(key ? { apiKey: key, credentialOrigin: origin } : { apiKey: undefined, credentialOrigin: undefined }),
    pinEndpoint: true,
    fallbackEndpoints: undefined,
    authorizedDisclosureOrigins: [...new Set([...(base.authorizedDisclosureOrigins ?? []), origin])],
  };
}

function validatedKey(input: string): string | undefined {
  const key = input.trim();
  return /[\r\n\0]/.test(key) || (key && /\s/.test(key)) ? undefined : key;
}

/** Verify a local endpoint and keep its endpoint and optional key provisional for the live model picker. */
export async function prepareLocalEndpoint(base: HarnessConfig, endpointInput: string, keyInput = "", requestId?: string): Promise<LocalEndpointPreparation> {
  const parsed = validatedEndpoint(endpointInput);
  if (!parsed) return { ok: false, message: "Use an http:// or https:// endpoint without embedded credentials, query, or fragment." };
  const key = validatedKey(keyInput);
  if (key === undefined) return { ok: false, message: "The API key must be a single value without whitespace." };
  const request = { cancelled: false };
  if (requestId) localEndpointSetupRequests.set(requestId, request);
  try {
    const models = await new LocalLlmClient(localEndpointConfig(base, parsed.endpoint, parsed.origin, key), { allowCredentialReload: false }).listModels();
    if (request.cancelled) return { ok: false, cancelled: true, message: "Local endpoint setup was cancelled." };
    const available = models.filter((model) => chatModel(APPLIANCE, model) && /^[A-Za-z0-9._:/@+-]{1,160}$/.test(model));
    if (available.length === 0) return { ok: false, message: "That endpoint returned no usable chat models." };
    activateApplianceEndpoint(parsed.endpoint, undefined, true, key || undefined);
    provisionalLocalEndpointRequestId = requestId;
    const disclosure = disclosureClass(parsed.endpoint, undefined, base.cloudRoutedOrigins);
    return {
      ok: true,
      message: disclosure === "cloud"
        ? `Cloud endpoint verified (${available.length} models found). Choosing a model will send task content to this endpoint.`
        : `Local endpoint verified (${available.length} models found). Choose a model to save setup.`,
    };
  } catch {
    if (request.cancelled) return { ok: false, cancelled: true, message: "Local endpoint setup was cancelled." };
    return { ok: false, message: "Could not list models from that endpoint. Check the URL and API key, then try again." };
  } finally {
    if (requestId && localEndpointSetupRequests.get(requestId) === request) localEndpointSetupRequests.delete(requestId);
  }
}

/** Discover a local OpenAI-compatible endpoint, then persist only its selected URL/model and origin-scoped key. */
export async function connectLocalEndpoint(
  base: HarnessConfig,
  endpointInput: string,
  modelInput?: string,
  keyInput = "",
): Promise<LocalEndpointConnection> {
  const parsed = validatedEndpoint(endpointInput);
  if (!parsed) {
    return { ok: false, message: "Use an http:// or https:// endpoint without embedded credentials, query, or fragment.", models: [] };
  }
  const { endpoint, origin } = parsed;
  const key = validatedKey(keyInput);
  if (key === undefined) {
    return { ok: false, message: "The API key must be a single value without whitespace.", models: [] };
  }
  const config = localEndpointConfig(base, endpoint, origin, key);
  let models: string[];
  try {
    models = await new LocalLlmClient(config, { allowCredentialReload: false }).listModels();
  } catch {
    return { ok: false, message: "Could not list models from that endpoint. Check the URL and API key, then try again.", models: [] };
  }
  const available = models.filter((model) => chatModel(APPLIANCE, model) && /^[A-Za-z0-9._:/@+-]{1,160}$/.test(model));
  if (!modelInput?.trim()) {
    return { ok: available.length > 0, message: available.length > 0 ? "Model discovery succeeded." : "That endpoint returned no usable chat models.", models: available };
  }
  const model = modelInput.trim();
  if (!available.includes(model)) {
    return { ok: false, message: "Choose a model returned by the endpoint's model list.", models: available };
  }
  try {
    if (key) {
      if (!commitLocalEndpointSetup(endpoint, key, () => saveLocalEndpointSettings(endpoint, model))) {
        return { ok: false, message: "Nexus could not securely save the endpoint setup.", models: available };
      }
    } else {
      saveLocalEndpointSettings(endpoint, model);
    }
  } catch {
    return { ok: false, message: "Models were discovered, but Nexus could not securely save the endpoint setup.", models: available };
  }
  activateApplianceEndpoint(endpoint, model, false);
  provisionalLocalEndpointRequestId = undefined;
  const disclosure = disclosureClass(endpoint, undefined, base.cloudRoutedOrigins);
  return {
    ok: true,
    message: `${disclosure === "cloud" ? "Cloud" : "Local"} endpoint configured (${available.length} models available).${key ? " API key saved for this origin only." : " No API key was saved."}`,
    models: available,
  };
}

export interface SignIn {
  prompt: AuthPrompt;
  done: Promise<{ ok: boolean; message: string }>;
  cancel(): void;
}

export async function startSignIn(base: HarnessConfig, providerId: string, methodId: string): Promise<SignIn> {
  const def = providerDefinition(providerId);
  const method = def?.methods.find((m) => m.id === methodId);
  if (!def || !method || method.kind === "key") throw new Error(`${providerId} has no sign-in method '${methodId}'.`);
  const abort = new AbortController();
  const flow = await startAuthFlow(methodId, abort.signal);
  void openBrowser(flow.prompt.url);
  const done = flow.result.then(
    async (credential: StoredCredential) => {
      saveCredential(providerId, credential);
      try {
        const count = await verify(base, providerId);
        return { ok: true, message: `${def.label} connected (${count} models available).` };
      } catch (err) {
        return { ok: true, message: `${def.label} signed in, but listing its models failed: ${describe(err)}.` };
      }
    },
    (err) => ({ ok: false, message: `${def.label} sign-in failed: ${describe(err)}` }),
  );
  return { prompt: flow.prompt, done, cancel: () => { abort.abort(); flow.cancel(); } };
}

export function disconnect(providerId: string): { ok: boolean; message: string } {
  const def = providerDefinition(providerId);
  if (!def) return { ok: false, message: `Unknown provider '${providerId}'.` };
  const removed = removeCredential(providerId);
  const still = resolveCredential(providerId, def.credentialEnv);
  if (still) {
    return {
      ok: removed,
      message: `${removed ? "Removed Nexus's saved credential. " : ""}${def.label} is still connected via ${still.source}; Nexus does not change ${still.kind === "env" ? "your environment" : "other clients' sign-ins"}.`,
    };
  }
  return { ok: removed, message: removed ? `${def.label} disconnected.` : `${def.label} had no credential saved by Nexus.` };
}

/**
 * Switches the agent to `ref` — the operator's explicit choice, which authorizes that destination for this session.
 * Returns the operator-facing outcome.
 */
export function selectModel(agent: AutonomousAgent, config: HarnessConfig, ref: ModelRef): { ok: boolean; message: string } {
  const model = ref.model.trim();
  if (!model) return { ok: false, message: "Choose a model." };
  if (ref.provider === APPLIANCE) {
    const a = applianceConfig(config);
    const pendingSelection = applianceEndpointSelection();
    if (pendingSelection?.persistModelOnSelection && originOf(a.endpoint) === originOf(pendingSelection.endpoint)) {
      try {
        const pendingKey = pendingApplianceEndpointKey(a.endpoint);
        if (pendingKey) {
          const committed = commitLocalEndpointSetup(a.endpoint, pendingKey, () => saveLocalEndpointSettings(a.endpoint, model));
          if (!committed) return { ok: false, message: "The endpoint was verified, but Nexus could not securely save the API key." };
        } else {
          saveLocalEndpointSettings(a.endpoint, model);
        }
        activateApplianceEndpoint(a.endpoint, model, false);
        provisionalLocalEndpointRequestId = undefined;
      } catch {
        return { ok: false, message: "The model is available for this session, but Nexus could not securely save the selection." };
      }
    }
    agent.setInferenceTarget({
      provider: undefined,
      endpoint: a.endpoint,
      model,
      apiKey: a.apiKey,
      credentialOrigin: a.credentialOrigin,
      authorizedDisclosureOrigins: [...new Set([...(config.authorizedDisclosureOrigins ?? []), ...(a.authorizedDisclosureOrigins ?? []), ...(originOf(a.endpoint) ? [originOf(a.endpoint)!] : [])])],
    });
    recordRecent({ provider: APPLIANCE, model });
    const disclosure = disclosureClass(a.endpoint, undefined, config.cloudRoutedOrigins);
    return {
      ok: true,
      message: disclosure === "cloud"
        ? `Model: ${model} via the configured endpoint. Task content will be sent there.`
        : `Model: ${model} on the local appliance.`,
    };
  }
  const def = providerDefinition(ref.provider);
  if (!def) return { ok: false, message: `Unknown provider '${ref.provider}'.` };
  if (!connectionOf(def.id).connected) return { ok: false, message: `${def.label} is not connected. Open /model and press ctrl+p to connect it.` };
  let cfg: HarnessConfig;
  try {
    cfg = providerConfig(config, def.id, model);
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
  agent.setInferenceTarget({
    provider: def.id,
    endpoint: cfg.endpoint,
    model,
    apiKey: cfg.apiKey,
    credentialOrigin: cfg.credentialOrigin,
    authorizedDisclosureOrigins: cfg.authorizedDisclosureOrigins,
  });
  recordRecent({ provider: def.id, model });
  return { ok: true, message: `Model: ${model} via ${def.label} (${originOf(cfg.endpoint)}). Task content is sent to this provider.` };
}
