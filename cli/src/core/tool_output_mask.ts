/**
 * CX-4: tool-output masking. In the messages a request carries, an old tool result above a token threshold is replaced by
 * a short marker with a content id; the full output stays in the conversation (and, after a compaction, the archive) and
 * resolves with `read_tool_output` (the marker's 12-character id).
 *
 * Scope, deliberately narrow:
 *  - request-time only: callers pass the stored conversation in and send the result; nothing here is persisted;
 *  - only results the model has already acted on (a later assistant message exists);
 *  - tool results only: the pinned ledger, findings and durable records are system messages and are never touched;
 *  - retrieval results (read_archive, read_tool_output, read_findings, read_objective) are never masked, so a retrieval is not undone;
 *  - the independent reviewer's evidence (core/independent_review.ts) is built from the diff and verifier receipts, not
 *    from the conversation, and does not import this module.
 * Opt-in: NEXUS_TOOL_OUTPUT_MASK_TOKENS=<n> (a positive integer). Unset, 0 or invalid leaves requests unchanged.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../types.js";
import type { CanonicalCapability } from "./capabilities.js";
import { countTokens } from "../tokens.js";

export const MASK_MARKER_PREFIX = "[Tool output masked:";
const NEVER_MASKED = new Set(["read_archive", "read_tool_output", "read_findings", "read_objective"]);
const PREVIEW_CHARS = 200;
const ID_QUERY = /^tool-output:([0-9a-f]{12})$/;

export const READ_TOOL_OUTPUT_CAPABILITY: CanonicalCapability = {
  id: "orchestrate_read_tool_output",
  modelToolName: "read_tool_output",
  category: "orchestration",
  mutating: false,
  effect: "internal",
  sideEffectContract: "Read a full tool result masked from this conversation's model context (no workspace change)",
  backend: "ts_native",
  toolDefinition: {
    type: "function",
    function: {
      name: "read_tool_output",
      description: "Retrieve a tool result that was masked from context. Pass the 12-character id shown in its mask marker.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The 12-character lowercase hexadecimal id in the tool-output marker" } },
        required: ["id"],
      },
    },
  },
} as CanonicalCapability;

const textOf = (message: ChatMessage): string | undefined => (typeof message.content === "string" ? message.content : undefined);

/** A stable, content-addressed id (12 hex characters of the output's SHA-256). */
export const maskedOutputId = (output: string): string => createHash("sha256").update(output).digest("hex").slice(0, 12);

export function maskThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.NEXUS_TOOL_OUTPUT_MASK_TOKENS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

/** `messages` with old large tool results masked; the same array when nothing is masked. Never mutates its input. */
export function maskToolOutputs(messages: ChatMessage[], thresholdTokens: number | undefined): ChatMessage[] {
  if (!thresholdTokens || thresholdTokens <= 0) return messages;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") { lastAssistant = i; break; }
  if (lastAssistant < 0) return messages;
  let changed = false;
  const out = messages.map((message, index) => {
    if (message.role !== "tool" || index > lastAssistant) return message;
    const text = textOf(message);
    if (!text || text.startsWith(MASK_MARKER_PREFIX) || (message.name && NEVER_MASKED.has(message.name))) return message;
    const tokens = countTokens(text);
    if (tokens <= thresholdTokens) return message;
    changed = true;
    const preview = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim();
    return { ...message, content: `${MASK_MARKER_PREFIX} ${message.name ?? "tool"} returned ~${tokens} tokens (${text.length} characters), which you have already acted on. Full output: call read_tool_output with id "${maskedOutputId(text)}" (tool-output:${maskedOutputId(text)}). Begins: ${preview}…]` };
  });
  return changed ? out : messages;
}

/** The full output a `tool-output:<id>` query names, from the live conversation first, then the archive; undefined when it is not one or is not found. */
export function resolveMaskedOutput(query: string, live: readonly ChatMessage[], archive: readonly ChatMessage[]): string | undefined {
  const id = ID_QUERY.exec(query.trim())?.[1];
  if (!id) return undefined;
  for (const source of [live, archive]) {
    for (const message of source) {
      const text = message.role === "tool" ? textOf(message) : undefined;
      if (text && !text.startsWith(MASK_MARKER_PREFIX) && maskedOutputId(text) === id) return text;
    }
  }
  return undefined;
}

/** Resolve an exact mask id without requiring the model to construct a read_archive search query. */
export function readToolOutput(id: unknown, live: readonly ChatMessage[], archive: readonly ChatMessage[]): { ok: boolean; text: string } {
  if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) {
    return { ok: false, text: "read_tool_output needs the 12-character lowercase hexadecimal id from a tool-output marker." };
  }
  const output = resolveMaskedOutput(`tool-output:${id}`, live, archive);
  if (output === undefined) return { ok: false, text: `No tool output is available for id ${id} in this conversation.` };
  return { ok: true, text: output };
}
