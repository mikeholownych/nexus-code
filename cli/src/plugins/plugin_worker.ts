import { pathToFileURL } from "node:url";

const PROTOCOL = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;

type RpcMessage = {
  protocol: number;
  type: string;
  id?: string;
  callId?: string;
  method?: string;
  payload?: any;
  ok?: boolean;
  value?: any;
  error?: string;
  args?: Record<string, any>;
};

type PluginModule = {
  name: string;
  description?: string;
  onTurnStart?: (context: any) => unknown;
  onToolCall?: (context: any) => unknown;
  onToolResult?: (context: any) => unknown;
  preToolExecution?: (context: any, next: (args?: Record<string, any>) => Promise<any>) => unknown;
  postToolExecution?: (context: any) => unknown;
  onTurnEnd?: (context: any) => unknown;
  customTools?: Array<{ definition: unknown; handler: (args: Record<string, any>) => unknown }>;
};

function send(message: RpcMessage): void {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
    process.send?.({ protocol: PROTOCOL, type: "protocol-error", error: "plugin IPC response exceeded the 1 MiB limit" });
    process.exitCode = 1;
    return;
  }
  process.send?.(JSON.parse(encoded));
}

function cleanError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/[\r\n\0-\x1f\x7f]/g, " ").slice(0, 1000);
}

const nextWaiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let plugin: PluginModule;
let initializing = false;

async function start(modulePath: string): Promise<void> {
  const loaded = await import(pathToFileURL(modulePath).href);
  plugin = loaded.default ?? loaded;
  if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error("the module does not export a plugin object with a name");
  }
  const customTools = Array.isArray(plugin.customTools)
    ? plugin.customTools.filter((tool) => tool && typeof tool.handler === "function").map((tool) => ({ definition: tool.definition }))
    : [];
  send({
    protocol: PROTOCOL,
    type: "ready",
    value: {
      name: plugin.name,
      description: typeof plugin.description === "string" ? plugin.description.slice(0, 4096) : undefined,
      hooks: {
        onTurnStart: typeof plugin.onTurnStart === "function",
        onToolCall: typeof plugin.onToolCall === "function",
        onToolResult: typeof plugin.onToolResult === "function",
        preToolExecution: typeof plugin.preToolExecution === "function",
        postToolExecution: typeof plugin.postToolExecution === "function",
        onTurnEnd: typeof plugin.onTurnEnd === "function",
      },
      customTools,
    },
  });
}

async function invoke(message: RpcMessage): Promise<void> {
  const id = message.id;
  const method = message.method;
  if (!id || !method) throw new Error("malformed invoke request");
  const payload = message.payload ?? {};
  let value: unknown;
  if (method === "customTool") {
    const name = payload.name;
    const tool = plugin.customTools?.find((entry) => entry.definition && (entry.definition as any).function?.name === name);
    if (!tool) throw new Error(`custom tool not found: ${String(name).slice(0, 120)}`);
    value = await tool.handler(payload.args ?? {});
  } else if (method === "preToolExecution") {
    if (typeof plugin.preToolExecution !== "function") throw new Error("plugin callback is unavailable");
    value = await plugin.preToolExecution(payload.context, (args) => new Promise((resolve, reject) => {
      const nextId = `${id}:next:${Math.random().toString(36).slice(2)}`;
      nextWaiters.set(nextId, { resolve, reject });
      send({ protocol: PROTOCOL, type: "next", id: nextId, callId: id, args });
    }));
  } else {
    const callback = (plugin as any)[method];
    if (typeof callback !== "function") throw new Error(`plugin callback is unavailable: ${method}`);
    value = await callback(payload.context);
  }
  send({ protocol: PROTOCOL, type: "result", id, ok: true, value });
}

process.on("message", (raw: unknown) => {
  try {
    const encoded = JSON.stringify(raw);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error("plugin IPC request exceeded the 1 MiB limit");
    const message = raw as RpcMessage;
    if (!message || message.protocol !== PROTOCOL) throw new Error("unsupported plugin IPC protocol");
    if (message.type === "init") {
      if (initializing || plugin) throw new Error("duplicate plugin worker initialization request");
      initializing = true;
      void start(String(message.payload?.modulePath ?? "")).catch((error) => send({ protocol: PROTOCOL, type: "protocol-error", error: cleanError(error) }));
      return;
    }
    if (message.type === "invoke") {
      void invoke(message).catch((error) => send({ protocol: PROTOCOL, type: "result", id: message.id, ok: false, error: cleanError(error) }));
      return;
    }
    if (message.type === "next-result" && message.id) {
      const waiter = nextWaiters.get(message.id);
      if (!waiter) throw new Error("unknown or duplicate middleware continuation response");
      nextWaiters.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error ?? "parent continuation failed"));
      return;
    }
    throw new Error("unknown plugin IPC message");
  } catch (error) {
    send({ protocol: PROTOCOL, type: "protocol-error", error: cleanError(error) });
  }
});
