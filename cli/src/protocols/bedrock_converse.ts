/**
 * Amazon Bedrock Converse / ConverseStream: request projection from Nexus history and assembly of responses.
 *
 * Wire details: the model id is in the path (`/model/<id>/converse` or `/converse-stream`), the body is JSON and the
 * streamed response is AWS event-stream framing (aws_eventstream.ts), requests are signed with SigV4 (aws_sigv4.ts).
 * Tool calls come only from toolUse blocks of a response whose messageStop arrived; a stream that ends earlier is
 * "incomplete". reasoningContent blocks (text with signature, or redacted) are kept as provider_state owned by
 * "<provider>:<model>" and replayed only to that owner while thinking is enabled for the request.
 */
import type { ChatMessage, ToolCall } from "../types.js";
import type { UsageReport } from "../usage.js";
import { resolveAwsCredentials, resolveAwsRegion, type AwsEnvironment } from "./aws_credentials.js";
import { signSigV4 } from "./aws_sigv4.js";
import {
  argumentsObject,
  num,
  ownedState,
  ProviderStreamError,
  stateDigest,
  textOf,
  wireToolId,
  type NativeFinish,
  type NativeRequest,
  type NativeRequestInput,
  type NativeResult,
  type StreamParser,
} from "./common.js";

type Block = Record<string, any>;
interface Turn { role: "user" | "assistant"; content: Block[] }

function userBlocks(content: ChatMessage["content"]): Block[] {
  if (!Array.isArray(content)) {
    const t = textOf(content);
    return t ? [{ text: t }] : [];
  }
  const out: Block[] = [];
  for (const p of content as any[]) {
    if (typeof p === "string") out.push({ text: p });
    else if (p?.type === "text" && p.text) out.push({ text: p.text });
    else if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
      const m = /^data:image\/([a-z]+);base64,([A-Za-z0-9+/=]*)$/.exec(p.image_url.url);
      if (m) out.push({ image: { format: m[1] === "jpg" ? "jpeg" : m[1], source: { bytes: m[2] } } });
    }
  }
  return out;
}

function trailingToolTurnHasReasoning(messages: ChatMessage[], owner: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") continue;
    if (m.role === "assistant" && m.tool_calls?.length) return Boolean(ownedState(m, owner)?.length);
    return true;
  }
  return true;
}

export function buildBedrockRequest(input: NativeRequestInput): NativeRequest {
  const thinking = input.thinkingBudget !== undefined && trailingToolTurnHasReasoning(input.messages, input.owner);
  const system: Block[] = [];
  const turns: Turn[] = [];
  let droppedState = 0;
  let seenNonSystem = false;
  const push = (role: Turn["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const m of input.messages) {
    if (m.role === "system") {
      const t = textOf(m.content);
      if (!seenNonSystem) { if (t) system.push({ text: t }); }
      else if (t) push("user", [{ text: `[System notice]\n${t}` }]);
      continue;
    }
    seenNonSystem = true;
    if (m.role === "user") push("user", userBlocks(m.content));
    else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      push("user", [{ toolResult: { toolUseId: wireToolId(m.tool_call_id ?? ""), content: [{ text: content || "(no output)" }] } }]);
    } else {
      const blocks: Block[] = [];
      const owned = ownedState(m, input.owner);
      if (m.provider_state && !owned) droppedState++;
      if (thinking && owned) blocks.push(...owned.map((r) => ({ reasoningContent: r })));
      const t = textOf(m.content);
      if (t.trim()) blocks.push({ text: t });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ toolUse: { toolUseId: wireToolId(tc.id), name: tc.function.name, input: argumentsObject(tc.function.arguments) } });
      }
      push("assistant", blocks.length ? blocks : [{ text: "(no content)" }]);
    }
  }
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", content: [{ text: "(continue)" }] });

  const inferenceConfig: Record<string, unknown> = { maxTokens: input.maxOutputTokens };
  const body: Record<string, unknown> = { messages: turns };
  if (system.length) body.system = system;
  if (input.tools.length) {
    body.toolConfig = {
      tools: input.tools.map((t) => ({ toolSpec: { name: t.function.name, description: t.function.description, inputSchema: { json: t.function.parameters } } })),
    };
  }
  if (thinking) {
    // Extended thinking (Claude on Bedrock) needs maxTokens above the budget and no custom temperature.
    const budget = Math.max(1024, Math.min(input.thinkingBudget!, input.maxOutputTokens - 1024));
    body.additionalModelRequestFields = { thinking: { type: "enabled", budget_tokens: budget } };
    if (input.maxOutputTokens <= budget) inferenceConfig.maxTokens = budget + 1024;
  } else if (input.temperature !== undefined) {
    inferenceConfig.temperature = Math.min(1, Math.max(0, input.temperature));
  }
  body.inferenceConfig = inferenceConfig;
  return { path: `/model/${encodeURIComponent(input.model)}/${input.stream ? "converse-stream" : "converse"}`, body, droppedState };
}

function finishOf(stop: string | undefined, hasTools: boolean): NativeFinish {
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return "length";
  if (stop === "guardrail_intervened" || stop === "content_filtered") return "refusal";
  if (stop === "tool_use" || hasTools) return "tool_calls";
  return "stop";
}

function usageOf(u: any): UsageReport | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    ...(num(u.inputTokens) !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(num(u.outputTokens) !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(num(u.cacheReadInputTokens) !== undefined ? { cachedInputTokens: u.cacheReadInputTokens } : {}),
    ...(num(u.cacheWriteInputTokens) !== undefined ? { cacheWriteTokens: u.cacheWriteInputTokens } : {}),
  };
}

/** Assembled blocks: {text}, {toolUse:{toolUseId,name,input|json}}, {reasoningContent:{...}}. */
function assemble(blocks: Block[], stop: string | undefined, owner: string, usage: UsageReport | undefined): NativeResult {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const opaque: Block[] = [];
  for (const b of blocks) {
    if (typeof b.text === "string") text += b.text;
    else if (b.toolUse) {
      const u = b.toolUse;
      const args = typeof u.input === "object" && u.input !== null ? JSON.stringify(u.input) : (u.json || "{}");
      toolCalls.push({ id: u.toolUseId, type: "function", function: { name: u.name, arguments: args } });
    } else if (b.reasoningContent) opaque.push(b.reasoningContent);
  }
  const message: ChatMessage = {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(opaque.length ? { provider_state: { owner, items: opaque, digest: stateDigest(opaque) } } : {}),
  };
  return { message, finish: finishOf(stop, toolCalls.length > 0), usage, text };
}

export function parseBedrockResponse(data: any, owner: string): NativeResult {
  const content = data?.output?.message?.content;
  if (!Array.isArray(content)) throw new ProviderStreamError("Bedrock response has no output message", undefined, "", true);
  return assemble(content, data.stopReason, owner, usageOf(data.usage));
}

export function bedrockStreamParser(owner: string, onToken?: (t: string) => void): StreamParser {
  const blocks: Block[] = [];
  const open = new Set<number>();
  let stop: string | undefined;
  let stopped = false;
  let usage: UsageReport | undefined;
  let text = "";
  const block = (i: unknown, create?: Block): Block => {
    if (typeof i !== "number") throw new ProviderStreamError("Bedrock stream event without contentBlockIndex", undefined, text, true);
    if (create) { blocks[i] = create; open.add(i); }
    const b = blocks[i];
    if (!b) throw new ProviderStreamError(`Bedrock delta for unknown block ${i}`, undefined, text, true);
    return b;
  };
  return {
    text: () => text,
    event(name, ev) {
      if (name?.startsWith("exception:") || name?.startsWith("error:")) {
        const type = name.slice(name.indexOf(":") + 1);
        throw new ProviderStreamError(`Provider error frame mid-stream: ${ev?.message ?? JSON.stringify(ev)}`, type, text);
      }
      switch (name) {
        case "contentBlockStart": {
          const s = ev.start?.toolUse;
          block(ev.contentBlockIndex, s ? { toolUse: { toolUseId: s.toolUseId, name: s.name, json: "" } } : {});
          return;
        }
        case "contentBlockDelta": {
          const d = ev.delta ?? {};
          const i = ev.contentBlockIndex;
          if (typeof d.text === "string") {
            const b = blocks[i] ?? block(i, { text: "" });
            b.text = (b.text ?? "") + d.text;
            text += d.text;
            if (d.text) onToken?.(d.text);
          } else if (d.toolUse) {
            const b = block(i);
            if (!b.toolUse) throw new ProviderStreamError(`toolUse delta for non-tool block ${i}`, undefined, text, true);
            b.toolUse.json += d.toolUse.input ?? "";
          } else if (d.reasoningContent) {
            const b = blocks[i] ?? block(i, { reasoningContent: {} });
            const r = (b.reasoningContent ??= {});
            const rc = d.reasoningContent;
            if (typeof rc.text === "string") (r.reasoningText ??= { text: "", signature: "" }).text += rc.text;
            if (typeof rc.signature === "string") (r.reasoningText ??= { text: "", signature: "" }).signature += rc.signature;
            if (typeof rc.redactedContent === "string") r.redactedContent = rc.redactedContent;
          }
          return;
        }
        case "contentBlockStop":
          open.delete(ev.contentBlockIndex);
          return;
        case "messageStop":
          stop = ev.stopReason;
          stopped = true;
          return;
        case "metadata":
          usage = usageOf(ev.usage) ?? usage;
          return;
        default:
          return; // messageStart and future event types
      }
    },
    result() {
      if (!stopped || open.size > 0) {
        return { message: { role: "assistant", content: text || null }, finish: "incomplete", usage, text };
      }
      for (const b of blocks) {
        if (b?.toolUse) {
          try {
            b.toolUse.input = JSON.parse(b.toolUse.json || "{}");
          } catch {
            b.toolUse.input = undefined; // kept as raw text; nothing runs on a guess
          }
        }
      }
      return assemble(blocks.filter(Boolean), stop, owner, usage);
    },
  };
}

/**
 * Signs a Bedrock request from the AWS credential chain (environment and shared files). Throws an Error naming only
 * the missing variable or file, never a credential value.
 */
export function signBedrockRequest(
  req: { url: string; method: string; headers: Record<string, string>; body: string },
  e: AwsEnvironment,
  now: Date = new Date(),
): Record<string, string> {
  const host = new URL(req.url).hostname;
  const m = /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
  const region = m?.[1] ?? resolveAwsRegion(e);
  if (!region) throw new Error("no AWS region: use a bedrock-runtime.<region>.amazonaws.com base URL or set AWS_REGION");
  return signSigV4({ ...req, region, service: "bedrock", credentials: resolveAwsCredentials(e), now }).headers;
}
