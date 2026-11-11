import { LocalLlmClient } from "../client.js";
import { autoDetectModel, chosenByProjectEnvironment, projectSetting } from "../config.js";
import type { HarnessConfig } from "../types.js";
import type { Completer } from "./ai_message.js";

/** A one-shot completer over the configured provider; egress policy and receipts apply inside `chatCompletion`. */
export function providerCompleter(config: HarnessConfig): Completer {
  // A session started inside a worktree takes a project `.env` from it, and that file is the agent's: an endpoint it chose
  // is not somewhere a branch diff may go on the operator's behalf. (The CLI command builds its configuration without the
  // project layer, so this never applies there.)
  if (chosenByProjectEnvironment("LOCAL_LLM_ENDPOINT") && projectSetting("LOCAL_LLM_ENDPOINT") === config.endpoint) return async () => undefined;
  return async (messages, signal) => {
    const client = new LocalLlmClient({ ...config, workspace: "", maxSteps: 1 }, { role: "commit-message" });
    const reply = await client.chatCompletion(messages, [], undefined, signal, "commit-message");
    return typeof reply.content === "string" ? reply.content : "";
  };
}

/**
 * A completer whose configuration is built on first use. Only building the configuration is guarded (no provider or an
 * invalid setting means "no model": undefined); a failing request is not swallowed, so the caller can say it failed.
 * The `local-model` placeholder is resolved to the server's loaded model first, as the run and interactive entry points
 * do, because servers such as vLLM reject the placeholder.
 */
export function lazyProviderCompleter(build: () => HarnessConfig, make: (config: HarnessConfig) => Completer = providerCompleter): Completer {
  return async (messages, signal) => {
    let completer: Completer;
    try {
      completer = make(await autoDetectModel(build()));
    } catch {
      return undefined;
    }
    return completer(messages, signal);
  };
}
