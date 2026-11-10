import { LocalLlmClient } from "../client.js";
import type { HarnessConfig } from "../types.js";
import type { Completer } from "./ai_message.js";

/** A one-shot completer over the configured provider; egress policy and receipts apply inside `chatCompletion`. */
export function providerCompleter(config: HarnessConfig): Completer {
  return async (messages, signal) => {
    const client = new LocalLlmClient({ ...config, workspace: "", maxSteps: 1 }, { role: "commit-message" });
    const reply = await client.chatCompletion(messages, [], undefined, signal, "commit-message");
    return typeof reply.content === "string" ? reply.content : "";
  };
}

/**
 * A completer whose configuration is built on first use. Only building the configuration is guarded (no provider or an
 * invalid setting means "no model": undefined); a failing request is not swallowed, so the caller can say it failed.
 */
export function lazyProviderCompleter(build: () => HarnessConfig, make: (config: HarnessConfig) => Completer = providerCompleter): Completer {
  return async (messages, signal) => {
    let completer: Completer;
    try {
      completer = make(build());
    } catch {
      return undefined;
    }
    return completer(messages, signal);
  };
}
