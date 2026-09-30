import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { ChatMessage, ToolDefinition, HarnessConfig, ToolCall } from "./types.js";
import pc from "picocolors";

export function readLatestAuthToken(): string | null {
  // 1. Check opencode client token file
  const opencodeTokenPath = path.join(os.homedir(), ".config/opencode/t5820-client-token");
  if (fs.existsSync(opencodeTokenPath)) {
    try {
      const val = fs.readFileSync(opencodeTokenPath, "utf-8").trim();
      if (val) return val;
    } catch {}
  }

  // 2. Check ~/.config/nexus/config.env
  const configEnvPath = path.join(os.homedir(), ".config/nexus/config.env");
  if (fs.existsSync(configEnvPath)) {
    try {
      const lines = fs.readFileSync(configEnvPath, "utf-8").split("\n");
      for (const line of lines) {
        if (line.startsWith("LOCAL_LLM_API_KEY=")) {
          const val = line.substring("LOCAL_LLM_API_KEY=".length).trim();
          if (val) return val;
        }
      }
    } catch {}
  }

  // 3. Check environment
  if (process.env.LOCAL_LLM_API_KEY) {
    return process.env.LOCAL_LLM_API_KEY.trim();
  }

  return null;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type StreamTokenCallback = (token: string) => void;

export class LocalLlmClient {
  private endpoints: string[] = [];
  private activeEndpointIndex: number = 0;
  private apiKey: string;
  private model: string;
  private temperature: number;

  constructor(config: HarnessConfig) {
    const normalizeEp = (urlStr: string) => {
      let ep = urlStr.trim().replace(/\/+$/, "");
      if (!ep.endsWith("/v1")) {
        ep = `${ep}/v1`;
      }
      return ep;
    };

    const endpointList: string[] = [normalizeEp(config.endpoint)];
    if (config.fallbackEndpoints && Array.isArray(config.fallbackEndpoints)) {
      for (const fb of config.fallbackEndpoints) {
        if (fb && typeof fb === "string") {
          endpointList.push(normalizeEp(fb));
        }
      }
    }
    if (process.env.LOCAL_LLM_FALLBACK_ENDPOINTS) {
      for (const fb of process.env.LOCAL_LLM_FALLBACK_ENDPOINTS.split(",")) {
        if (fb.trim()) {
          endpointList.push(normalizeEp(fb));
        }
      }
    }
    this.endpoints = Array.from(new Set(endpointList));
    this.activeEndpointIndex = 0;

    this.apiKey =
      config.apiKey && config.apiKey !== "local" && config.apiKey !== "not-needed"
        ? config.apiKey
        : readLatestAuthToken() || "not-needed";
    this.model = config.model;
    this.temperature = config.temperature ?? 0.2;
  }

  public get endpoint(): string {
    return this.endpoints[this.activeEndpointIndex] || this.endpoints[0];
  }

  public getActiveEndpoint(): string {
    return this.endpoint;
  }

  public getEndpoints(): string[] {
    return [...this.endpoints];
  }

  public addFallbackEndpoint(endpoint: string): void {
    let ep = endpoint.trim().replace(/\/+$/, "");
    if (!ep.endsWith("/v1")) {
      ep = `${ep}/v1`;
    }
    if (!this.endpoints.includes(ep)) {
      this.endpoints.push(ep);
    }
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
  }

  public reloadAuthToken(): boolean {
    const fresh = readLatestAuthToken();
    if (fresh && fresh !== this.apiKey) {
      this.apiKey = fresh;
      return true;
    }
    return false;
  }

  private async executeWithFailover<T>(
    operationName: string,
    operation: (endpoint: string) => Promise<T>
  ): Promise<T> {
    const total = this.endpoints.length;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this.activeEndpointIndex + attempt) % total;
      const currentEp = this.endpoints[idx];

      try {
        const result = await operation(currentEp);
        if (idx !== this.activeEndpointIndex) {
          console.warn(
            pc.yellow(`\n⚡ Failover: Active inference endpoint switched to ${currentEp}`)
          );
          this.activeEndpointIndex = idx;
        }
        return result;
      } catch (err: any) {
        lastError = err;
        if (total > 1 && attempt < total - 1) {
          const nextIdx = (idx + 1) % total;
          console.warn(
            pc.dim(
              `⚠️ [Failover] ${operationName} failed on ${currentEp} (${err.message}). Trying backup endpoint ${this.endpoints[nextIdx]}...`
            )
          );
        }
      }
    }

    throw (
      lastError ||
      new Error(
        `All inference endpoints failed for ${operationName} (attempted: ${this.endpoints.join(", ")})`
      )
    );
  }

  async listModels(): Promise<string[]> {
    return this.executeWithFailover("listModels", async (currentEp) => {
      const url = `${currentEp}/models`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (res.status === 401 && this.reloadAuthToken()) {
        const retryRes = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        });
        if (retryRes.ok) {
          const data = (await retryRes.json()) as { data?: Array<{ id: string }> };
          return data.data?.map((m) => m.id) || [];
        }
      }

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id) || [];
    });
  }

  async chatCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    requestId: string = randomUUID(),
  ): Promise<ChatMessage> {
    return this.executeWithFailover("chatCompletion", async (currentEp) => {
      const url = `${currentEp}/chat/completions`;

      const payload: any = {
        model: this.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content ?? null,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
        temperature: this.temperature,
      };

      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Request-ID": requestId,
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 401 && this.reloadAuthToken()) {
        return this.chatCompletion(messages, tools, requestId);
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Inference error (HTTP ${res.status}): ${errText}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      if (!data.choices || data.choices.length === 0) {
        throw new Error("Model returned empty choices array");
      }

      return data.choices[0].message;
    });
  }

  /**
   * Real-time SSE token streaming for typewriter terminal output (matching Codex / Claude Code)
   */
  async chatCompletionStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: StreamTokenCallback,
    requestId: string = randomUUID(),
  ): Promise<ChatMessage> {
    return this.executeWithFailover("chatCompletionStream", async (currentEp) => {
      const url = `${currentEp}/chat/completions`;

      const payload: any = {
        model: this.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content ?? null,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
        temperature: this.temperature,
        stream: true,
      };

      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "X-Request-ID": requestId,
          },
          body: JSON.stringify(payload),
        });
      } catch {
        // Fallback to non-streaming if network error
        return this.chatCompletion(messages, tools, requestId);
      }

      if (res.status === 401 && this.reloadAuthToken()) {
        return this.chatCompletionStream(messages, tools, onToken, requestId);
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`Inference error (HTTP ${res.status}): ${errText}`);
      }

      let fullContent = "";
      const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") {
              continue;
            }

            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6);
              try {
                const chunk = JSON.parse(jsonStr);
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;

                // 1. Text token chunk
                if (delta.content) {
                  fullContent += delta.content;
                  if (onToken) {
                    onToken(delta.content);
                  }
                }

                // 2. Tool call chunks
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const current = toolCallsMap.get(idx) || { id: "", name: "", args: "" };

                    if (tc.id) current.id = tc.id;
                    if (tc.function?.name) current.name += tc.function.name;
                    if (tc.function?.arguments) current.args += tc.function.arguments;

                    toolCallsMap.set(idx, current);
                  }
                }
              } catch {
                // Ignore malformed partial chunks
              }
            }
          }
        }
      } catch (streamErr) {
        if (!fullContent && toolCallsMap.size === 0) {
          throw streamErr;
        }
      }

      const assembledToolCalls: ToolCall[] = [];
      for (const [_, tc] of toolCallsMap.entries()) {
        if (tc.name) {
          assembledToolCalls.push({
            id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.args,
            },
          });
        }
      }

      if (!fullContent && assembledToolCalls.length === 0) {
        return this.chatCompletion(messages, tools);
      }

      return {
        role: "assistant",
        content: fullContent || null,
        ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
      };
    });
  }
}
