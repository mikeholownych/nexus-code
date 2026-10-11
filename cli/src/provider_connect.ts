/**
 * Connecting providers and switching the session's model; shared by the live TUI (through the sidecar) and the CLI.
 * A key is verified against the provider before it is saved; a sign-in is saved when the provider issues the
 * credential and then verified. Nothing here prints or returns a credential.
 */
import { InferenceError, LocalLlmClient } from "./client.js";
import { removeCredential, resolveCredential, saveCredential, type StoredCredential } from "./credentials.js";
import { APPLIANCE, applianceConfig, connectionOf, providerConfig, recordRecent, type ModelRef } from "./model_catalog.js";
import { openBrowser, startAuthFlow, type AuthPrompt } from "./oauth.js";
import { originOf, providerDefinition } from "./providers.js";
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
    agent.setInferenceTarget({
      provider: undefined,
      endpoint: a.endpoint,
      model,
      apiKey: a.apiKey,
      credentialOrigin: a.credentialOrigin,
      authorizedDisclosureOrigins: [...new Set([...(config.authorizedDisclosureOrigins ?? []), ...(a.authorizedDisclosureOrigins ?? [])])],
    });
    recordRecent({ provider: APPLIANCE, model });
    return { ok: true, message: `Model: ${model} on the appliance.` };
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
