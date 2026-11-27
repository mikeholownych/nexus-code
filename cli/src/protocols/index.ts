/** The wire protocols a connection can speak. Adding one is a module here plus an entry in WIRE_PROTOCOLS. */
import type { WireProtocol } from "../providers.js";
import { anthropicStreamParser, buildAnthropicRequest, parseAnthropicResponse } from "./anthropic.js";
import { buildGeminiRequest, geminiStreamParser, parseGeminiResponse } from "./gemini.js";
import type { NativeRequest, NativeRequestInput, NativeResult, StreamParser } from "./common.js";
import { bedrockStreamParser, buildBedrockRequest, parseBedrockResponse, signBedrockRequest } from "./bedrock_converse.js";
import { readEventStream } from "./aws_eventstream.js";
import { buildChatRequest, chatStreamParser, parseChatResponse } from "./openai_chat.js";
import { buildResponsesRequest, parseResponsesResponse, responsesStreamParser } from "./openai_responses.js";

export interface ProtocolAdapter {
  /** Served by the client's shared native request path; false means the client's own chat pipeline. */
  native: boolean;
  /** Tool calling is part of the protocol (otherwise a server may reject `tools`). */
  nativeTools: boolean;
  build(input: NativeRequestInput): NativeRequest;
  parse(data: any, owner: string, keepReasoning: boolean): NativeResult;
  stream(owner: string, keepReasoning: boolean, onToken?: (t: string) => void): StreamParser;
  /** Signs the final request instead of sending a bearer/key header (SigV4); returns headers to add. */
  sign?(req: { url: string; method: string; headers: Record<string, string>; body: string }, env: Record<string, string | undefined>): Record<string, string>;
  /** Streamed bodies are not SSE: reads this framing and calls `onEvent(name, payloadText)`. */
  readStream?: typeof readEventStream;
}

/** The positive output-token limit serialized by a wire protocol, when the protocol request contains one. */
export function serializedOutputTokenLimit(protocol: WireProtocol, body: Record<string, unknown>): number | undefined {
  let value: unknown;
  switch (protocol) {
    case "openai-chat":
    case "anthropic-messages":
      value = body.max_tokens;
      break;
    case "openai-responses":
      value = body.max_output_tokens;
      break;
    case "gemini-generate-content":
      value = (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens;
      break;
    case "bedrock-converse":
      value = (body.inferenceConfig as Record<string, unknown> | undefined)?.maxTokens;
      break;
  }
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

export const WIRE_PROTOCOLS: Record<WireProtocol, ProtocolAdapter> = {
  "openai-chat": {
    native: false,
    nativeTools: false,
    build: buildChatRequest,
    // Chat responses carry no provider state: owner and keepReasoning are ignored.
    parse: (data) => parseChatResponse(data),
    // Likewise ignored here; reasoning text is always kept on the message.
    stream: (_owner, _keepReasoning, onToken) => chatStreamParser(onToken),
  },
  "openai-responses": {
    native: true,
    nativeTools: true,
    build: buildResponsesRequest,
    parse: parseResponsesResponse,
    stream: responsesStreamParser,
  },
  "anthropic-messages": {
    native: true,
    nativeTools: true,
    build: buildAnthropicRequest,
    parse: (data, owner) => parseAnthropicResponse(data, owner),
    stream: (owner, _keepReasoning, onToken) => anthropicStreamParser(owner, onToken),
  },
  "gemini-generate-content": {
    native: true,
    nativeTools: true,
    build: buildGeminiRequest,
    parse: (data, owner) => parseGeminiResponse(data, owner),
    stream: (owner, _keepReasoning, onToken) => geminiStreamParser(owner, onToken),
  },
  "bedrock-converse": {
    native: true,
    nativeTools: true,
    build: buildBedrockRequest,
    parse: (data, owner) => parseBedrockResponse(data, owner),
    stream: (owner, _keepReasoning, onToken) => bedrockStreamParser(owner, onToken),
    sign: (req, env) => signBedrockRequest(req, { env }),
    readStream: readEventStream,
  },
};

export function wireProtocol(name: string): ProtocolAdapter {
  const adapter = (WIRE_PROTOCOLS as Record<string, ProtocolAdapter | undefined>)[name];
  if (!adapter) throw new Error(`unknown wire protocol: ${name}`);
  return adapter;
}
