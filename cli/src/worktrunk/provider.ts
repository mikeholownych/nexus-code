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
