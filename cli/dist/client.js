import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
export function readLatestAuthToken() {
    // 1. Check opencode client token file
    const opencodeTokenPath = path.join(os.homedir(), ".config/opencode/t5820-client-token");
    if (fs.existsSync(opencodeTokenPath)) {
        try {
            const val = fs.readFileSync(opencodeTokenPath, "utf-8").trim();
            if (val)
                return val;
        }
        catch { }
    }
    // 2. Check ~/.config/nexus/config.env
    const configEnvPath = path.join(os.homedir(), ".config/nexus/config.env");
    if (fs.existsSync(configEnvPath)) {
        try {
            const lines = fs.readFileSync(configEnvPath, "utf-8").split("\n");
            for (const line of lines) {
                if (line.startsWith("LOCAL_LLM_API_KEY=")) {
                    const val = line.substring("LOCAL_LLM_API_KEY=".length).trim();
                    if (val)
                        return val;
                }
            }
        }
        catch { }
    }
    // 3. Check environment
    if (process.env.LOCAL_LLM_API_KEY) {
        return process.env.LOCAL_LLM_API_KEY.trim();
    }
    return null;
}
export class LocalLlmClient {
    endpoint;
    apiKey;
    model;
    temperature;
    constructor(config) {
        let ep = config.endpoint.replace(/\/+$/, "");
        if (!ep.endsWith("/v1")) {
            ep = `${ep}/v1`;
        }
        this.endpoint = ep;
        this.apiKey = config.apiKey && config.apiKey !== "local" && config.apiKey !== "not-needed"
            ? config.apiKey
            : (readLatestAuthToken() || "not-needed");
        this.model = config.model;
        this.temperature = config.temperature ?? 0.2;
    }
    setApiKey(key) {
        this.apiKey = key;
    }
    reloadAuthToken() {
        const fresh = readLatestAuthToken();
        if (fresh && fresh !== this.apiKey) {
            this.apiKey = fresh;
            return true;
        }
        return false;
    }
    async listModels() {
        const url = `${this.endpoint}/models`;
        try {
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
                    const data = (await retryRes.json());
                    return data.data?.map((m) => m.id) || [];
                }
            }
            if (!res.ok) {
                throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
            }
            const data = (await res.json());
            return data.data?.map((m) => m.id) || [];
        }
        catch (err) {
            throw new Error(`Failed to connect to local AI server at ${url}: ${err.message}`);
        }
    }
    async chatCompletion(messages, tools) {
        const url = `${this.endpoint}/chat/completions`;
        const payload = {
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
            },
            body: JSON.stringify(payload),
        });
        if (res.status === 401 && this.reloadAuthToken()) {
            return this.chatCompletion(messages, tools);
        }
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Inference error (HTTP ${res.status}): ${errText}`);
        }
        const data = (await res.json());
        if (!data.choices || data.choices.length === 0) {
            throw new Error("Model returned empty choices array");
        }
        return data.choices[0].message;
    }
    /**
     * Real-time SSE token streaming for typewriter terminal output (matching Codex / Claude Code)
     */
    async chatCompletionStream(messages, tools, onToken) {
        const url = `${this.endpoint}/chat/completions`;
        const payload = {
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
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(payload),
            });
        }
        catch {
            // Fallback to non-streaming if network error
            return this.chatCompletion(messages, tools);
        }
        if (res.status === 401 && this.reloadAuthToken()) {
            return this.chatCompletionStream(messages, tools, onToken);
        }
        if (!res.ok || !res.body) {
            // Fallback to non-streaming on status error
            return this.chatCompletion(messages, tools);
        }
        let fullContent = "";
        const toolCallsMap = new Map();
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
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
                            if (!delta)
                                continue;
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
                                    if (tc.id)
                                        current.id = tc.id;
                                    if (tc.function?.name)
                                        current.name += tc.function.name;
                                    if (tc.function?.arguments)
                                        current.args += tc.function.arguments;
                                    toolCallsMap.set(idx, current);
                                }
                            }
                        }
                        catch {
                            // Ignore malformed partial chunks
                        }
                    }
                }
            }
        }
        catch {
            // If stream broken mid-flight, proceed with what was accumulated
        }
        const assembledToolCalls = [];
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
    }
}
