/** The wire protocols a connection can speak. Adding one is a module here plus an entry in WIRE_PROTOCOLS. */
import type { WireProtocol } from "../providers.js";
import { anthropicStreamParser, buildAnthropicRequest, parseAnthropicResponse } from "./anthropic.js";
import type { NativeRequest, NativeRequestInput, NativeResult, StreamParser } from "./common.js";
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
}

export const WIRE_PROTOCOLS: Record<WireProtocol, ProtocolAdapter> = {
  "openai-chat": {
    native: false,
    nativeTools: false,
    build: buildChatRequest,
    parse: (data) => parseChatResponse(data),
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
};
