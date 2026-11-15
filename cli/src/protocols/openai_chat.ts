/**
 * OpenAI Chat Completions (and compatible servers): request projection from Nexus history and assembly of
 * streamed/non-streamed responses.
 *
 * Completion evidence on a stream is a chunk with a non-null finish_reason or the terminal `[DONE]` event; without
 * either the result is "incomplete". Tool-call fragments are keyed by index; a server that omits the index starts a
 * new call at a fragment carrying an id or name and continues the latest call otherwise.
 */
import type { ChatMessage, ToolCall } from "../types.js";
import type { UsageReport } from "../usage.js";
import { num, ProviderStreamError, type NativeRequest, type NativeRequestInput, type NativeResult, type StreamParser } from "./common.js";

/** Chat Completions usage (OpenRouter adds `cost`). */
export function chatUsage(u: any): UsageReport | undefined {
  if (!u || typeof u !== "object") return undefined;
  const r: UsageReport = {};
  if (num(u.prompt_tokens) !== undefined) r.inputTokens = u.prompt_tokens;
  if (num(u.completion_tokens) !== undefined) r.outputTokens = u.completion_tokens;
  if (num(u.prompt_tokens_details?.cached_tokens) !== undefined) r.cachedInputTokens = u.prompt_tokens_details.cached_tokens;
  if (num(u.completion_tokens_details?.reasoning_tokens) !== undefined) r.reasoningTokens = u.completion_tokens_details.reasoning_tokens;
  if (num(u.cost) !== undefined) r.costUsd = u.cost;
  return r;
}

export function buildChatRequest(input: NativeRequestInput): NativeRequest {
  const opts = input.chat ?? { toolChoice: "auto", capOutput: false, usage: "native" };
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((m) => ({
      role: m.role,
      content: m.content ?? null,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    })),
    temperature: input.temperature,
  };
  if (input.stream) body.stream = true;
  // A streamed request sets its output cap after the tools; a plain one before them.
  if (!input.stream && opts.capOutput) body.max_tokens = input.maxOutputTokens;
  if (input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = opts.toolChoice;
  }
  if (input.stream && opts.capOutput) body.max_tokens = input.maxOutputTokens;
  if (opts.usage === "openrouter") body.usage = { include: true };
  if (input.stream && (opts.usage === "openrouter" || opts.usage === "stream-options")) body.stream_options = { include_usage: true };
  return { path: "/chat/completions", body, droppedState: 0 };
}

/** A non-streamed body whose first choice is the answer; the caller has checked that `choices` is not empty. */
export function parseChatResponse(data: any): NativeResult {
  const choice = data.choices[0] as { message: ChatMessage; finish_reason?: string };
  if (choice.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
    for (const tc of choice.message.tool_calls) {
      if (tc.function && typeof tc.function.arguments === "object" && tc.function.arguments !== null) {
        tc.function.arguments = JSON.stringify(tc.function.arguments);
      }
    }
  }
  const finish = choice.finish_reason === "length" ? "length" : choice.message?.tool_calls?.length ? "tool_calls" : "stop";
  return {
    message: choice.message,
    finish,
    finishReason: choice.finish_reason,
    usage: chatUsage(data.usage),
    providerRequestId: data.id,
    effectiveModel: data.model,
    text: typeof choice.message?.content === "string" ? choice.message.content : "",
  };
}

/** An `error` object inside a chunk; the client classifies it from the raw frame. */
export class ChatErrorFrame extends ProviderStreamError {
  constructor(message: string, partialText: string, readonly error: unknown, readonly hasOutput: boolean) {
    super(message, undefined, partialText);
    this.name = "ChatErrorFrame";
  }
}

export interface ChatStreamParser extends StreamParser {
  /** One raw line of the body. */
  line(raw: string): void;
  /** A finish_reason or `[DONE]` arrived. */
  complete(): boolean;
  hasOutput(): boolean;
  /** Usage, id and model as reported so far, also available after a failure. */
  reported(): { usage?: UsageReport; id?: string; model?: string };
}

export function chatStreamParser(onToken?: (t: string) => void): ChatStreamParser {
  let text = "";
  let reasoning = "";
  let output = false;
  let finishReason: string | undefined;
  let sawDone = false;
  let usage: UsageReport | undefined;
  let id: string | undefined;
  let model: string | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const parser: ChatStreamParser = {
    text: () => text,
    complete: () => Boolean(finishReason || sawDone),
    hasOutput: () => output,
    reported: () => ({ usage, id, model }),
    line(raw) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith(":")) return;
      if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") {
        sawDone = true;
        return;
      }
      if (!trimmed.startsWith("data:") && !trimmed.startsWith("data: ")) return;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        throw new ProviderStreamError(`Malformed stream event: ${trimmed.slice(0, 120)}`, undefined, text, true);
      }
      parser.event(undefined, chunk);
    },
    event(_name, chunk) {
      if (chunk && typeof chunk === "object" && chunk.error) {
        const em = typeof chunk.error === "string" ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
        throw new ChatErrorFrame(em, text, chunk.error, output);
      }
      if (chunk && typeof chunk === "object") {
        if (chunk.usage) usage = chatUsage(chunk.usage);
        if (typeof chunk.id === "string") id ??= chunk.id;
        if (typeof chunk.model === "string") model ??= chunk.model;
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;

      if (delta.content) {
        output = true;
        text += delta.content;
        onToken?.(delta.content);
      }
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningDelta === "string") {
        if (reasoningDelta) output = true;
        reasoning += reasoningDelta;
      }

      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        if (delta.tool_calls.length > 0) output = true;
        for (const tc of delta.tool_calls) {
          // Spec streams give every fragment an index. Some servers (and re-streamed non-streaming
          // responses) omit it; then a fragment that carries an id or a name starts a NEW call, and
          // one with neither continues the latest call. Never fold distinct calls into index 0.
          let idx: number;
          if (typeof tc.index === "number") {
            idx = tc.index;
          } else if (tc.id || tc.function?.name) {
            idx = calls.size === 0 ? 0 : Math.max(...calls.keys()) + 1;
          } else {
            idx = calls.size === 0 ? 0 : Math.max(...calls.keys());
          }
          const current = calls.get(idx) || { id: "", name: "", args: "" };

          if (tc.id) current.id = tc.id;
          // The name arrives once in spec streams. Some servers repeat it in later deltas, or send it cumulatively;
          // only a genuinely new fragment is appended (PRV-04: a repeated name became "read_fileread_file").
          const fragment = tc.function?.name;
          if (fragment) {
            if (!current.name) current.name = fragment;
            else if (fragment !== current.name) current.name = fragment.startsWith(current.name) ? fragment : current.name + fragment;
          }
          const rawArgs = tc.function?.arguments;
          if (rawArgs !== undefined && rawArgs !== null) {
            if (typeof rawArgs === "object") current.args = JSON.stringify(rawArgs);
            else current.args += String(rawArgs);
          }

          calls.set(idx, current);
        }
      }
    },
    result() {
      const toolCalls: ToolCall[] = [];
      for (const tc of calls.values()) {
        if (tc.name) {
          toolCalls.push({
            id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
            type: "function",
            function: { name: tc.name, arguments: tc.args },
          });
        }
      }
      const message: ChatMessage = {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      } as ChatMessage;
      const finish = !finishReason && !sawDone ? "incomplete" : finishReason === "length" ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop";
      return { message, finish, finishReason, usage, providerRequestId: id, effectiveModel: model, text };
    },
  };
  return parser;
}

/** Feeds the body to `parser` line by line; a read failure cancels the body and is rethrown. */
export async function readChatStream(body: ReadableStream<Uint8Array>, parser: ChatStreamParser, onChunk?: () => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) parser.line(line);
    }
    if (buffer.trim()) parser.line(buffer);
  } catch (err) {
    try { await reader.cancel(); } catch {}
    throw err;
  }
}
