/**
 * Google Gemini `generateContent` / `streamGenerateContent` (Generative Language API): request projection from Nexus
 * history and assembly of streamed/non-streamed responses.
 *
 * The model is part of the URL path, so `build` returns `/models/<model>:generateContent` (or the streaming method
 * with `alt=sse`). Parallel tool calls are several `functionCall` parts of one model turn; their results go back as
 * several `functionResponse` parts of one user turn, in call order. Gemini pairs results by name and position, so the
 * name comes from the assistant turn that made the call. Thought-summary parts (`thought: true`) are shown to nobody
 * and never replayed; every other part, including its `thoughtSignature`, is kept as provider_state owned by
 * "<provider>:<model>" and replayed verbatim only to that owner (Gemini 3 rejects a tool turn that lost its signature).
 * A stream is complete only once a chunk carries a `finishReason`.
 */
import { randomBytes } from "node:crypto";
import type { ChatMessage, ToolCall } from "../types.js";
import type { UsageReport } from "../usage.js";
import {
  argumentsObject,
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

type Part = Record<string, any>;
interface Turn { role: "user" | "model"; parts: Part[] }

function userParts(content: ChatMessage["content"]): Part[] {
  if (!Array.isArray(content)) {
    const t = textOf(content);
    return t ? [{ text: t }] : [];
  }
  const out: Part[] = [];
  for (const p of content as any[]) {
    if (typeof p === "string") out.push({ text: p });
    else if (p?.type === "text" && p.text) out.push({ text: p.text });
    else if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
      const url: string = p.image_url.url;
      const m = /^data:([^;,]+);base64,/.exec(url);
      out.push(m ? { inlineData: { mimeType: m[1], data: url.slice(m[0].length) } } : { fileData: { fileUri: url } });
    }
  }
  return out;
}

/** `models/gemini-x` and `gemini-x` name the same model; the path always gets the bare, encoded id. */
function modelPath(model: string, stream: boolean): string {
  const id = model.replace(/^models\//, "");
  return `/models/${encodeURIComponent(id)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}

export function buildGeminiRequest(input: NativeRequestInput): NativeRequest {
  const systemParts: string[] = [];
  const turns: Turn[] = [];
  const names = new Map<string, string>(); // tool call id -> function name
  let droppedState = 0;
  let seenNonSystem = false;
  const push = (role: Turn["role"], parts: Part[]) => {
    if (!parts.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else turns.push({ role, parts });
  };
  for (const m of input.messages) {
    if (m.role === "system") {
      const t = textOf(m.content);
      if (!seenNonSystem) systemParts.push(t);
      else if (t) push("user", [{ text: `[System notice]\n${t}` }]);
      continue;
    }
    seenNonSystem = true;
    if (m.role === "user") push("user", userParts(m.content));
    else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const name = names.get(m.tool_call_id ?? "") ?? m.name ?? "tool";
      push("user", [{ functionResponse: { name, response: { output: content || "(no output)" } } }]);
    } else {
      for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name);
      const owned = ownedState(m, input.owner);
      if (m.provider_state && !owned) droppedState++;
      const parts: Part[] = [];
      if (owned) parts.push(...owned);
      else {
        const t = textOf(m.content);
        if (t.trim()) parts.push({ text: t });
        for (const tc of m.tool_calls ?? []) parts.push({ functionCall: { name: tc.function.name, args: argumentsObject(tc.function.arguments) } });
      }
      push("model", parts.length ? parts : [{ text: "(no content)" }]);
    }
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", parts: [{ text: "(continue)" }] });

  const generationConfig: Record<string, unknown> = { maxOutputTokens: input.maxOutputTokens };
  if (input.temperature !== undefined) generationConfig.temperature = input.temperature;
  const level = input.reasoningEffort?.toLowerCase();
  if (input.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: Math.max(0, Math.floor(input.thinkingBudget)) };
  } else if (level === "minimal" || level === "low" || level === "medium" || level === "high") {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
  }

  const body: Record<string, unknown> = { contents: turns, generationConfig };
  const system = systemParts.filter(Boolean).join("\n\n");
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (input.tools.length) {
    // parametersJsonSchema takes the schema as written; the OpenAPI-subset `parameters` field rejects common keywords.
    body.tools = [{ functionDeclarations: input.tools.map((t) => ({ name: t.function.name, description: t.function.description, parametersJsonSchema: t.function.parameters })) }];
  }
  return { path: modelPath(input.model, input.stream), body, droppedState };
}

const REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

function finishOf(reason: string | undefined, hasTools: boolean): NativeFinish {
  if (reason === "MAX_TOKENS") return "length";
  if (reason && REFUSALS.has(reason)) return "refusal";
  return hasTools ? "tool_calls" : "stop";
}

function usageOf(u: any): UsageReport | undefined {
  if (!u || typeof u !== "object") return undefined;
  const r: UsageReport = {};
  if (num(u.promptTokenCount) !== undefined) r.inputTokens = u.promptTokenCount;
  // Gemini reports thinking tokens apart from candidatesTokenCount; output here includes them, as in Chat Completions.
  if (num(u.candidatesTokenCount) !== undefined || num(u.thoughtsTokenCount) !== undefined) r.outputTokens = (num(u.candidatesTokenCount) ?? 0) + (num(u.thoughtsTokenCount) ?? 0);
  if (num(u.cachedContentTokenCount) !== undefined) r.cachedInputTokens = u.cachedContentTokenCount;
  if (num(u.thoughtsTokenCount) !== undefined) r.reasoningTokens = u.thoughtsTokenCount;
  return r;
}

function callId(part: Part): string {
  return typeof part.functionCall?.id === "string" && part.functionCall.id ? part.functionCall.id : `call_${randomBytes(6).toString("hex")}`;
}

function assemble(parts: Part[], owner: string, reason: string | undefined, usage: UsageReport | undefined, id?: string, model?: string): NativeResult {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const kept: Part[] = [];
  for (const p of parts) {
    if (p.thought === true) continue;
    kept.push(p);
    if (typeof p.text === "string") text += p.text;
    if (p.functionCall && typeof p.functionCall.name === "string") {
      const args = typeof p.functionCall.args === "object" && p.functionCall.args !== null ? p.functionCall.args : {};
      toolCalls.push({ id: callId(p), type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(args) } });
    }
  }
  const signed = kept.some((p) => typeof p.thoughtSignature === "string");
  const message: ChatMessage = {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(signed ? { provider_state: { owner, items: kept, digest: stateDigest(kept) } } : {}),
  };
  return { message, finish: finishOf(reason, toolCalls.length > 0), usage, providerRequestId: id, effectiveModel: model, text };
}

function blocked(data: any): string | undefined {
  const reason = data?.promptFeedback?.blockReason;
  return typeof reason === "string" ? reason : undefined;
}

export function parseGeminiResponse(data: any, owner: string): NativeResult {
  if (data?.error) throw new ProviderStreamError(`Gemini error: ${data.error.message ?? JSON.stringify(data.error)}`, data.error.status, "");
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
  if (!cand) {
    if (blocked(data)) return { message: { role: "assistant", content: null }, finish: "refusal", usage: usageOf(data.usageMetadata), providerRequestId: data.responseId, effectiveModel: data.modelVersion, text: "" };
    throw new ProviderStreamError("Gemini response has no candidates", undefined, "", true);
  }
  if (cand.finishReason === "MALFORMED_FUNCTION_CALL") throw new ProviderStreamError("Gemini produced a malformed function call", cand.finishReason, "", true);
  const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  return assemble(parts, owner, cand.finishReason, usageOf(data.usageMetadata), data.responseId, data.modelVersion);
}

export function geminiStreamParser(owner: string, onToken?: (t: string) => void): StreamParser {
  const parts: Part[] = [];
  let reason: string | undefined;
  let usage: UsageReport | undefined;
  let id: string | undefined;
  let model: string | undefined;
  let text = "";
  let sawBlock: string | undefined;
  return {
    text: () => text,
    event(_name, ev) {
      if (ev?.error) throw new ProviderStreamError(`Provider error frame mid-stream: ${ev.error.message ?? JSON.stringify(ev.error)}`, ev.error.status, text);
      id = ev?.responseId ?? id;
      model = ev?.modelVersion ?? model;
      usage = usageOf(ev?.usageMetadata) ?? usage;
      sawBlock = blocked(ev) ?? sawBlock;
      const cand = Array.isArray(ev?.candidates) ? ev.candidates[0] : undefined;
      if (!cand) return;
      for (const p of Array.isArray(cand.content?.parts) ? cand.content.parts : []) {
        const last = parts[parts.length - 1];
        // Consecutive text fragments of the same kind (answer or thought) are one part; a signature rides the fragment it signs.
        if (typeof p.text === "string" && last && typeof last.text === "string" && Boolean(last.thought) === Boolean(p.thought) && !last.thoughtSignature) {
          last.text += p.text;
          if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
        } else parts.push({ ...p });
        if (typeof p.text === "string" && p.thought !== true && p.text) {
          text += p.text;
          onToken?.(p.text);
        }
      }
      if (cand.finishReason) reason = cand.finishReason;
    },
    result() {
      if (!reason) {
        if (sawBlock && parts.length === 0) return { message: { role: "assistant", content: null }, finish: "refusal", usage, providerRequestId: id, effectiveModel: model, text };
        return { message: { role: "assistant", content: text || null }, finish: "incomplete", usage, providerRequestId: id, effectiveModel: model, text };
      }
      if (reason === "MALFORMED_FUNCTION_CALL") throw new ProviderStreamError("Gemini produced a malformed function call", reason, text, true);
      return assemble(parts, owner, reason, usage, id, model);
    },
  };
}
