import type { LocalLlmClient } from "../client.js";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 128 * 1024;
const TIMEOUT_MS = 60_000;

/** A proposal is data from a single read-only request. The caller owns schema validation and persistence. */
export async function requestJsonProposal(
  client: Pick<LocalLlmClient, "chatCompletion">,
  contract: string,
  input: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  requestSignal.throwIfAborted();
  if (Buffer.byteLength(contract) + Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new Error("Proposal input is too large.");
  }
  const response = await client.chatCompletion([
    { role: "system", content: contract },
    { role: "user", content: input },
  ], [], undefined, requestSignal, "proposal");
  requestSignal.throwIfAborted();
  if (response.role !== "assistant" || response.tool_calls?.length || typeof response.content !== "string") {
    throw new Error("Expected a JSON proposal without tool calls.");
  }
  if (Buffer.byteLength(response.content) > MAX_REPLY_BYTES) {
    throw new Error("Proposal output is too large.");
  }
  try {
    return JSON.parse(response.content) as unknown;
  } catch {
    throw new Error("Proposal output is not valid JSON.");
  }
}
