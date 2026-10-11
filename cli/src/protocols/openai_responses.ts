/**
 * OpenAI Responses API: request projection from Nexus history and assembly of streamed/non-streamed responses.
 *
 * Requests are stateless (`store: false`); history is replayed in full. Function calls are taken only from completed
 * output items of a response that reached response.completed. With a reasoning effort configured, encrypted
 * reasoning items are requested and kept as provider_state owned by "openai:<model>", replayed only to that owner.
 */
import type { ChatMessage, ToolCall } from "../types.js";
import type { UsageReport } from "../usage.js";
import {
  num,
  ownedState,
  ProviderStreamError,
  stateDigest,
  textOf,
  type NativeFinish,
  type NativeRequest,
  type NativeRequestInput,
  type NativeResult,
  type StreamParser,
} from "./common.js";

/** Reasoning models (o-series, gpt-5 family) reject sampling temperature. */
export function acceptsTemperature(model: string, reasoningEffort?: string): boolean {
  return !reasoningEffort && !/^(o\d|gpt-5)/i.test(model.replace(/^.*\//, ""));
}

function userContent(content: ChatMessage["content"]): string | any[] {
  if (!Array.isArray(content)) return textOf(content);
  return (content as any[]).flatMap((p): any[] => {
    if (typeof p === "string") return [{ type: "input_text", text: p }];
    if (p?.type === "text") return [{ type: "input_text", text: p.text ?? "" }];
    if (p?.type === "image_url" && typeof p.image_url?.url === "string") return [{ type: "input_image", image_url: p.image_url.url }];
    return [];
  });
}

export function buildResponsesRequest(input: NativeRequestInput): NativeRequest {
  const items: any[] = [];
  let droppedState = 0;
  for (const m of input.messages) {
    if (m.role === "system") items.push({ role: "system", content: textOf(m.content) });
    else if (m.role === "user") items.push({ role: "user", content: userContent(m.content) });
    else if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    } else {
      const owned = ownedState(m, input.owner);
      if (m.provider_state && !owned) droppedState++;
      if (owned && input.reasoningEffort) items.push(...owned);
      const t = textOf(m.content);
      if (t.trim()) items.push({ role: "assistant", content: t });
      for (const tc of m.tool_calls ?? []) {
        items.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
      }
    }
  }
  const body: Record<string, unknown> = {
    model: input.model,
    input: items,
    store: false,
    stream: input.stream,
    max_output_tokens: input.maxOutputTokens,
  };
  if (input.tools.length) {
    body.tools = input.tools.map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false }));
  }
  if (input.reasoningEffort) {
    body.reasoning = { effort: input.reasoningEffort };
    body.include = ["reasoning.encrypted_content"];
  }
  if (input.temperature !== undefined && acceptsTemperature(input.model, input.reasoningEffort)) body.temperature = input.temperature;
  return { path: "/responses", body, droppedState };
}

function usageOf(u: any): UsageReport | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    ...(num(u.input_tokens) !== undefined ? { inputTokens: u.input_tokens } : {}),
    ...(num(u.output_tokens) !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(num(u.input_tokens_details?.cached_tokens) !== undefined ? { cachedInputTokens: u.input_tokens_details.cached_tokens } : {}),
    ...(num(u.output_tokens_details?.reasoning_tokens) !== undefined ? { reasoningTokens: u.output_tokens_details.reasoning_tokens } : {}),
  };
}

function assemble(output: any[], status: string | undefined, incompleteReason: string | undefined, owner: string, keepReasoning: boolean, usage?: UsageReport, id?: string, model?: string): NativeResult {
  let text = "";
  let refused = false;
  const toolCalls: ToolCall[] = [];
  const opaque: any[] = [];
  for (const item of output) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text") text += part.text ?? "";
        else if (part?.type === "refusal") { text += part.refusal ?? ""; refused = true; }
      }
    } else if (item?.type === "function_call") {
      if (item.status && item.status !== "completed") continue; // an unfinished call never runs
      toolCalls.push({ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } });
    } else if (item?.type === "reasoning" && keepReasoning && item.encrypted_content) {
      opaque.push({ type: "reasoning", id: item.id, encrypted_content: item.encrypted_content, summary: item.summary ?? [] });
    }
  }
  let finish: NativeFinish = toolCalls.length ? "tool_calls" : refused ? "refusal" : "stop";
  if (status === "incomplete") finish = incompleteReason === "max_output_tokens" ? "length" : "incomplete";
  const message: ChatMessage = {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(opaque.length ? { provider_state: { owner, items: opaque, digest: stateDigest(opaque) } } : {}),
  };
  return { message, finish, usage, providerRequestId: id, effectiveModel: model, text };
}

export function parseResponsesResponse(data: any, owner: string, keepReasoning: boolean): NativeResult {
  if (!data || !Array.isArray(data.output)) throw new ProviderStreamError("Responses payload has no output array", undefined, "", true);
  if (data.status === "failed") throw new ProviderStreamError(`Response failed: ${data.error?.message ?? "unknown error"}`, data.error?.code, "");
  return assemble(data.output, data.status, data.incomplete_details?.reason, owner, keepReasoning, usageOf(data.usage), data.id, data.model);
}

export function responsesStreamParser(owner: string, keepReasoning: boolean, onToken?: (t: string) => void): StreamParser {
  const done: any[] = [];
  let final: any;
  let text = "";
  return {
    text: () => text,
    event(_name, ev) {
      switch (ev?.type) {
        case "response.output_text.delta":
          text += ev.delta ?? "";
          if (ev.delta) onToken?.(ev.delta);
          return;
        case "response.output_item.done":
          if (ev.item) done[ev.output_index ?? done.length] = ev.item;
          return;
        case "response.completed":
        case "response.incomplete":
          final = ev.response ?? {};
          return;
        case "response.failed":
          throw new ProviderStreamError(`Response failed: ${ev.response?.error?.message ?? "unknown error"}`, ev.response?.error?.code, text);
        case "error":
          throw new ProviderStreamError(`Provider error frame mid-stream: ${ev.message ?? ev.error?.message ?? JSON.stringify(ev)}`, ev.code ?? ev.error?.code, text);
        default:
          return;
      }
    },
    result() {
      if (!final) return { message: { role: "assistant", content: text || null }, finish: "incomplete", text };
      const output = Array.isArray(final.output) && final.output.length ? final.output : done.filter(Boolean);
      return assemble(output, final.status, final.incomplete_details?.reason, owner, keepReasoning, usageOf(final.usage), final.id, final.model);
    },
  };
}
