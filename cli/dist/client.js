import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { InformationFlowBoundary } from "./core/egress.js";
import pc from "picocolors";
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
/**
 * Typed inference failure. `failoverEligible` is false for operator aborts and client-originated faults
 * (malformed/truncated output, HTTP 4xx): another endpoint will not fix those.
 */
export class InferenceError extends Error {
    kind;
    origin;
    httpStatus;
    requestId;
    partialText;
    failoverEligible;
    constructor(kind, origin, message, opts = {}) {
        super(message);
        this.name = "InferenceError";
        this.kind = kind;
        this.origin = origin;
        this.httpStatus = opts.httpStatus;
        this.requestId = opts.requestId;
        this.partialText = opts.partialText ?? "";
        this.failoverEligible = opts.failoverEligible ?? (kind === "http_error" || kind === "network_error" || kind === "timeout" || kind === "stream_interrupted");
    }
    toFailure() {
        return {
            kind: this.kind,
            origin: this.origin,
            message: this.message,
            httpStatus: this.httpStatus,
            requestId: this.requestId,
            partialTextChars: this.partialText.length || undefined,
        };
    }
}
function abortedError(requestId, partialText) {
    return new InferenceError("aborted", "operator", "Inference request aborted by operator", { requestId, partialText, failoverEligible: false });
}
/** Classify a fetch/read rejection. `operatorSignal` distinguishes operator abort from the request timeout. */
function classifyTransportError(err, operatorSignal, requestId, phase, partialText = "") {
    if (err instanceof InferenceError)
        return err;
    if (operatorSignal?.aborted)
        return abortedError(requestId, partialText);
    if (err?.name === "TimeoutError") {
        return new InferenceError("timeout", "transport", `Inference request timed out: ${err.message}`, { requestId, partialText });
    }
    const msg = err?.message || String(err);
    return phase === "stream"
        ? new InferenceError("stream_interrupted", "transport", `Inference stream interrupted before completion: ${msg}`, { requestId, partialText })
        : new InferenceError("network_error", "transport", `Inference request failed: ${msg}`, { requestId });
}
export class LocalLlmClient {
    endpoints = [];
    activeEndpointIndex = 0;
    apiKey;
    model;
    temperature;
    boundary;
    taskId;
    sessionId;
    taskClass;
    constructor(config, options) {
        const normalizeEp = (urlStr) => {
            let ep = urlStr.trim().replace(/\/+$/, "");
            if (!ep.endsWith("/v1")) {
                ep = `${ep}/v1`;
            }
            return ep;
        };
        const endpointList = [normalizeEp(config.endpoint)];
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
        this.boundary = options?.boundary || InformationFlowBoundary.getGlobalInstance();
        this.taskId = options?.taskId;
        this.sessionId = options?.sessionId;
        this.taskClass = options?.taskClass ?? config.taskClass;
    }
    /** Hint the gateway's route table (sent as X-Task-Class); undefined sends none. */
    setTaskClass(taskClass) {
        this.taskClass = taskClass;
    }
    /**
     * Tool-call arguments must be a JSON string on the wire: servers such as llama.cpp parse the history
     * and reject the whole request (HTTP 500) when any earlier assistant tool call has malformed arguments.
     * Malformed arguments are wrapped so the history stays valid and the original text is preserved.
     */
    sanitizeHistory(messages) {
        let changed = false;
        const out = messages.map((m) => {
            if (m.role !== "assistant" || !m.tool_calls?.length)
                return m;
            const calls = m.tool_calls.map((tc) => {
                const a = tc.function?.arguments;
                if (typeof a !== "string")
                    return tc;
                try {
                    JSON.parse(a || "{}");
                    return tc;
                }
                catch {
                    changed = true;
                    return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ raw: a }) } };
                }
            });
            return { ...m, tool_calls: calls };
        });
        return changed ? out : messages;
    }
    routingHeaders() {
        return this.taskClass && /^[A-Za-z0-9_.-]{1,64}$/.test(this.taskClass) ? { "X-Task-Class": this.taskClass } : {};
    }
    /** Switch the model in place so session, task, boundary and routing state survive the change. */
    setModel(model) {
        this.model = model;
    }
    requestTimeoutMs() {
        const raw = Number(process.env.LOCAL_LLM_TIMEOUT_MS);
        return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
    }
    setTaskId(taskId) {
        this.taskId = taskId;
    }
    getTaskId() {
        return this.taskId;
    }
    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }
    getSessionId() {
        return this.sessionId;
    }
    getBoundary() {
        return this.boundary;
    }
    setBoundary(boundary) {
        this.boundary = boundary;
    }
    get endpoint() {
        return this.endpoints[this.activeEndpointIndex] || this.endpoints[0];
    }
    getActiveEndpoint() {
        return this.endpoint;
    }
    getEndpoints() {
        return [...this.endpoints];
    }
    addFallbackEndpoint(endpoint) {
        let ep = endpoint.trim().replace(/\/+$/, "");
        if (!ep.endsWith("/v1")) {
            ep = `${ep}/v1`;
        }
        if (!this.endpoints.includes(ep)) {
            this.endpoints.push(ep);
        }
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
    async executeWithFailover(operationName, operation) {
        const total = this.endpoints.length;
        let lastError = null;
        for (let attempt = 0; attempt < total; attempt++) {
            const idx = (this.activeEndpointIndex + attempt) % total;
            const currentEp = this.endpoints[idx];
            try {
                const result = await operation(currentEp);
                if (idx !== this.activeEndpointIndex) {
                    console.warn(pc.yellow(`\n⚡ Failover: Active inference endpoint switched to ${currentEp}`));
                    this.activeEndpointIndex = idx;
                }
                return result;
            }
            catch (err) {
                lastError = err;
                if (err instanceof InferenceError && !err.failoverEligible)
                    throw err;
                if (total > 1 && attempt < total - 1) {
                    const nextIdx = (idx + 1) % total;
                    console.warn(pc.dim(`⚠️ [Failover] ${operationName} failed on ${currentEp} (${err.message}). Trying backup endpoint ${this.endpoints[nextIdx]}...`));
                }
            }
        }
        throw (lastError ||
            new Error(`All inference endpoints failed for ${operationName} (attempted: ${this.endpoints.join(", ")})`));
    }
    async listModels() {
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
                    const data = (await retryRes.json());
                    return data.data?.map((m) => m.id) || [];
                }
            }
            if (!res.ok) {
                throw new Error(`Server returned HTTP ${res.status}: ${res.statusText}`);
            }
            const data = (await res.json());
            return data.data?.map((m) => m.id) || [];
        });
    }
    async chatCompletion(messages, tools, requestId = randomUUID(), signal) {
        return this.executeWithFailover("chatCompletion", async (currentEp) => {
            if (signal?.aborted)
                throw abortedError(requestId);
            const url = `${currentEp}/chat/completions`;
            // 1. Egress Interception & Quarantine (DISC-001..003, CTX-006, FAIL-003)
            const egressEvaluation = this.boundary.evaluateEgress(messages, currentEp, {
                taskId: this.taskId,
                sessionId: this.sessionId,
                sourceBoundary: "HOST_LOCAL",
            });
            if (!egressEvaluation.allowed) {
                throw new Error(egressEvaluation.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
            }
            const outboundMessages = this.sanitizeHistory(egressEvaluation.sanitizedPayload || messages);
            let outboundTools = tools;
            if (tools.length > 0) {
                const toolsEgress = this.boundary.evaluateEgress(tools, currentEp, {
                    taskId: this.taskId,
                    sessionId: this.sessionId,
                    sourceBoundary: "HOST_LOCAL",
                });
                if (!toolsEgress.allowed) {
                    throw new Error(toolsEgress.reason || `Egress of tools to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
                }
                outboundTools = toolsEgress.sanitizedPayload || tools;
            }
            const payload = {
                model: this.model,
                messages: outboundMessages.map((m) => ({
                    role: m.role,
                    content: m.content ?? null,
                    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                    ...(m.name ? { name: m.name } : {}),
                })),
                temperature: this.temperature,
            };
            if (outboundTools.length > 0) {
                payload.tools = outboundTools;
                payload.tool_choice = "auto";
            }
            let res;
            let data;
            try {
                res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.apiKey}`,
                        "X-Request-ID": requestId,
                        ...this.routingHeaders(),
                    },
                    body: JSON.stringify(payload),
                    signal: this.combinedSignal(signal),
                });
                if (res.status === 401 && this.reloadAuthToken()) {
                    return this.chatCompletion(messages, tools, requestId, signal);
                }
                if (!res.ok) {
                    const errText = await res.text();
                    throw this.httpError(res.status, errText, requestId);
                }
                data = (await res.json());
            }
            catch (err) {
                throw classifyTransportError(err, signal, requestId, "connect");
            }
            if (!data.choices || data.choices.length === 0) {
                throw new InferenceError("protocol_error", "provider", "Model returned empty choices array", { requestId, failoverEligible: false });
            }
            const choice = data.choices[0];
            if (choice.finish_reason === "length") {
                throw new InferenceError("output_truncated", "client", choice.message.tool_calls?.length
                    ? "Model output was truncated (finish_reason=length) inside a tool call; refusing to run partial arguments."
                    : "Model output was truncated (finish_reason=length); refusing to treat it as a complete answer.", { requestId, partialText: typeof choice.message.content === "string" ? choice.message.content : "", failoverEligible: false });
            }
            return choice.message;
        });
    }
    /**
     * Real-time SSE token streaming for typewriter terminal output (matching Codex / Claude Code)
     */
    async chatCompletionStream(messages, tools, onToken, requestId = randomUUID(), signal) {
        return this.executeWithFailover("chatCompletionStream", async (currentEp) => {
            if (signal?.aborted)
                throw abortedError(requestId);
            const url = `${currentEp}/chat/completions`;
            // 1. Egress Interception & Quarantine (DISC-001..003, CTX-006, FAIL-003)
            const egressEvaluation = this.boundary.evaluateEgress(messages, currentEp, {
                taskId: this.taskId,
                sessionId: this.sessionId,
                sourceBoundary: "HOST_LOCAL",
            });
            if (!egressEvaluation.allowed) {
                throw new Error(egressEvaluation.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
            }
            const outboundMessages = this.sanitizeHistory(egressEvaluation.sanitizedPayload || messages);
            let outboundTools = tools;
            if (tools.length > 0) {
                const toolsEgress = this.boundary.evaluateEgress(tools, currentEp, {
                    taskId: this.taskId,
                    sessionId: this.sessionId,
                    sourceBoundary: "HOST_LOCAL",
                });
                if (!toolsEgress.allowed) {
                    throw new Error(toolsEgress.reason || `Egress of tools to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
                }
                outboundTools = toolsEgress.sanitizedPayload || tools;
            }
            const payload = {
                model: this.model,
                messages: outboundMessages.map((m) => ({
                    role: m.role,
                    content: m.content ?? null,
                    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                    ...(m.name ? { name: m.name } : {}),
                })),
                temperature: this.temperature,
                stream: true,
            };
            if (outboundTools.length > 0) {
                payload.tools = outboundTools;
                payload.tool_choice = "auto";
            }
            let res;
            try {
                res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.apiKey}`,
                        "X-Request-ID": requestId,
                        ...this.routingHeaders(),
                    },
                    body: JSON.stringify(payload),
                    signal: this.combinedSignal(signal),
                });
            }
            catch (err) {
                const classified = classifyTransportError(err, signal, requestId, "connect");
                if (classified.kind === "aborted")
                    throw classified;
                // Network error establishing the stream: fall back to a non-streaming request that keeps
                // the same correlation id (the gateway can tie both attempts to one logical request).
                return this.chatCompletion(messages, tools, requestId, signal);
            }
            if (res.status === 401 && this.reloadAuthToken()) {
                return this.chatCompletionStream(messages, tools, onToken, requestId, signal);
            }
            if (!res.ok || !res.body) {
                const errText = await res.text().catch(() => res.statusText);
                throw this.httpError(res.status, errText, requestId);
            }
            let fullContent = "";
            let finishReason;
            let sawDone = false;
            const toolCallsMap = new Map();
            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            // Positive completion evidence for this protocol: a chunk carrying a non-null finish_reason, or the
            // terminal `data: [DONE]` event. Absence of both means the stream ended early.
            const handleLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":"))
                    return;
                if (trimmed === "data: [DONE]") {
                    sawDone = true;
                    return;
                }
                if (!trimmed.startsWith("data: "))
                    return;
                let chunk;
                try {
                    chunk = JSON.parse(trimmed.slice(6));
                }
                catch {
                    throw new InferenceError("malformed_event", "provider", `Malformed stream event: ${trimmed.slice(0, 120)}`, {
                        requestId,
                        partialText: fullContent,
                        failoverEligible: false,
                    });
                }
                if (chunk && typeof chunk === "object" && chunk.error) {
                    const em = typeof chunk.error === "string" ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
                    throw new InferenceError("provider_error_frame", "provider", `Provider error frame mid-stream: ${em}`, {
                        requestId,
                        partialText: fullContent,
                        failoverEligible: true,
                    });
                }
                if (chunk.choices?.[0]?.finish_reason)
                    finishReason = chunk.choices[0].finish_reason;
                const delta = chunk.choices?.[0]?.delta;
                if (!delta)
                    return;
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
                        // Spec streams give every fragment an index. Some servers (and re-streamed non-streaming
                        // responses) omit it; then a fragment that carries an id or a name starts a NEW call, and
                        // one with neither continues the latest call. Never fold distinct calls into index 0.
                        let idx;
                        if (typeof tc.index === "number") {
                            idx = tc.index;
                        }
                        else if (tc.id || tc.function?.name) {
                            idx = toolCallsMap.size === 0 ? 0 : Math.max(...toolCallsMap.keys()) + 1;
                        }
                        else {
                            idx = toolCallsMap.size === 0 ? 0 : Math.max(...toolCallsMap.keys());
                        }
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
            };
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines)
                        handleLine(line);
                }
                if (buffer.trim())
                    handleLine(buffer);
            }
            catch (streamErr) {
                try {
                    await reader.cancel();
                }
                catch { }
                const classified = classifyTransportError(streamErr, signal, requestId, "stream", fullContent);
                // A transport error after the terminal event cannot change the (already complete) response.
                const postCompletionTransportError = (finishReason || sawDone) && !(streamErr instanceof InferenceError) && classified.kind !== "aborted";
                if (!postCompletionTransportError)
                    throw classified;
            }
            if (!finishReason && !sawDone) {
                throw new InferenceError("stream_incomplete", "transport", "Inference stream ended without a finish_reason or [DONE]; response is incomplete.", { requestId, partialText: fullContent });
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
            if (finishReason === "length") {
                throw new InferenceError("output_truncated", "client", assembledToolCalls.length > 0
                    ? "Model output was truncated (finish_reason=length) inside a tool call; refusing to run partial arguments."
                    : "Model output was truncated (finish_reason=length); refusing to treat it as a complete answer.", { requestId, partialText: fullContent, failoverEligible: false });
            }
            if (!fullContent && assembledToolCalls.length === 0) {
                return this.chatCompletion(messages, tools, requestId, signal);
            }
            return {
                role: "assistant",
                content: fullContent || null,
                ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
            };
        });
    }
    combinedSignal(operatorSignal) {
        const timeout = AbortSignal.timeout(this.requestTimeoutMs());
        return operatorSignal ? AbortSignal.any([timeout, operatorSignal]) : timeout;
    }
    /** HTTP 5xx/429 are provider-side and may succeed elsewhere; other 4xx are request faults (client origin). */
    httpError(status, body, requestId) {
        const providerSide = status >= 500 || status === 429 || status === 408;
        return new InferenceError("http_error", providerSide ? "provider" : "client", `Inference error (HTTP ${status}): ${body}`, {
            httpStatus: status,
            requestId,
            failoverEligible: providerSide,
        });
    }
    getModel() {
        return this.model;
    }
    async generateEmbedding(text, model) {
        return this.executeWithFailover("generateEmbedding", async (currentEp) => {
            const url = `${currentEp}/embeddings`;
            // 1. Egress Interception & Quarantine (DISC-001..003, CTX-006, FAIL-003)
            const egressEvaluation = this.boundary.evaluateEgress(text, currentEp, {
                taskId: this.taskId,
                sessionId: this.sessionId,
                sourceBoundary: "HOST_LOCAL",
            });
            if (!egressEvaluation.allowed) {
                throw new Error(egressEvaluation.reason || `Egress to endpoint '${currentEp}' denied by InformationFlowBoundary [FAIL-003].`);
            }
            const outboundText = egressEvaluation.sanitizedText || text;
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: model || this.model,
                    input: outboundText,
                }),
            });
            if (!res.ok) {
                throw new Error(`Embedding request failed (${res.status}): ${await res.text()}`);
            }
            const data = await res.json();
            if (data.data && Array.isArray(data.data) && data.data[0]?.embedding) {
                return data.data[0].embedding;
            }
            throw new Error("Invalid embedding response format");
        });
    }
}
