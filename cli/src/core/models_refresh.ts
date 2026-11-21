/**
 * `nexus models refresh`: the operator's explicit refresh of the model data. Nothing here runs unless the operator asks;
 * the bundled snapshot is never fetched or modified. The result is written to a local cache that the snapshot reader
 * prefers (see models_snapshot.ts), and every provider passes the same validation as the bundled snapshot.
 * This mirrors scripts/gen_models_snapshot.mjs without the tool-choice clone step: `api.json` carries no tool-choice
 * data, so the reader keeps the bundled snapshot's modes for models the cache lists without them.
 */
import os from "node:os";
import path from "node:path";
import { writePrivateFile } from "./durable_file.js";
import { parseSnapshot, type ModelsSnapshot, type ProviderPin, type SnapshotModel, type SnapshotProvider } from "./models_snapshot.js";

export const MODELS_API_URL = "https://models.dev/api.json";
const MAX_API_BYTES = 30 * 1024 * 1024;

const OPENAI_CHAT_NPM = new Set([
  "@ai-sdk/openai-compatible", "@ai-sdk/groq", "@ai-sdk/mistral", "@ai-sdk/xai", "@ai-sdk/cerebras",
  "@ai-sdk/togetherai", "@ai-sdk/perplexity", "@ai-sdk/deepinfra", "@openrouter/ai-sdk-provider",
]);

export function modelsCachePath(home = process.env.HOME || os.homedir()): string {
  return path.join(home, ".cache/nexus/models-snapshot.json");
}

const protocolClass = (npm: unknown): string =>
  OPENAI_CHAT_NPM.has(String(npm)) ? "openai-chat" : npm === "@ai-sdk/openai" ? "openai-responses" : npm === "@ai-sdk/anthropic" ? "anthropic-messages" : `native:${String(npm)}`;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function keepModel(m: any): boolean {
  if (m?.type !== undefined && m.type !== "chat") return false;
  if (m?.tool_call !== true) return false;
  if (m.status === "deprecated" || m.status === "alpha") return false;
  if (typeof m.provider?.api === "string" && !/^https?:/.test(m.provider.api)) return false;
  return typeof m.id === "string";
}

function buildModel(m: any): SnapshotModel {
  const out: SnapshotModel = { id: m.id, context: num(m.limit?.context) ?? 0, output: num(m.limit?.output) ?? 0, toolCall: true, reasoning: m.reasoning === true };
  const input = num(m.limit?.input);
  if (input !== undefined) out.input = input;
  const effort = (Array.isArray(m.reasoning_options) ? m.reasoning_options : []).find((o: any) => o?.type === "effort" && Array.isArray(o.values))?.values;
  if (Array.isArray(effort) && effort.length && effort.every((v: unknown) => typeof v === "string")) out.effort = [...effort];
  const pin = num(m.cost?.input);
  const pout = num(m.cost?.output);
  if (pin !== undefined && pout !== undefined) out.price = { input: pin, output: pout };
  return out;
}

/** Convert a models.dev `api.json` document; providers failing validation are dropped and listed in `rejected`. */
export function snapshotFromApi(api: unknown, date: string, pins: Record<string, ProviderPin>): { snapshot: ModelsSnapshot; rejected: string[] } {
  if (!api || typeof api !== "object" || Array.isArray(api)) throw new Error("models.dev data is not an object of providers");
  const providers: SnapshotProvider[] = Object.keys(api).sort(cmp).map((key) => {
    const p = (api as Record<string, any>)[key] ?? {};
    const id = typeof p.id === "string" ? p.id : key;
    const entry: SnapshotProvider = { id, name: p.name, env: Array.isArray(p.env) ? [...p.env] : [], protocol: protocolClass(p.npm), models: [] };
    const pin = Object.hasOwn(pins, id) ? pins[id] : undefined;
    if (typeof p.api === "string" && p.api) entry.baseUrl = p.api;
    else if (pin?.defaultBaseUrl && entry.protocol === "openai-chat") entry.baseUrl = pin.defaultBaseUrl;
    if (entry.baseUrl && (entry.baseUrl.startsWith("${") || (entry.baseUrl.split("://")[1] ?? "").split(/[/?#]/)[0]!.includes("${"))) entry.hostFromEnv = true;
    if (!entry.baseUrl && entry.protocol === "openai-chat") entry.needsBaseUrl = true;
    entry.models = Object.values(p.models ?? {}).filter(keepModel).sort((a: any, b: any) => cmp(a.id, b.id)).map(buildModel);
    return entry;
  });
  return parseSnapshot({ date, license: "MIT", source: MODELS_API_URL, providers }, pins);
}

export interface RefreshResult {
  file: string;
  date: string;
  providers: number;
  models: number;
  rejected: string[];
}

/** The response body as text, refusing more than `maxBytes` bytes: by the declared length first, then while reading, so an oversized body is never held whole. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("models.dev data is larger than the 30 MiB limit");
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("models.dev data is larger than the 30 MiB limit");
    return text;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("models.dev data is larger than the 30 MiB limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetch models.dev (an explicit operator action), validate, and write the local cache atomically with private
 * permissions. `fetchImpl` is injectable so tests never touch the network.
 */
export async function refreshModelsCache(opts: { pins: Record<string, ProviderPin>; fetchImpl?: typeof fetch; home?: string; now?: Date; signal?: AbortSignal }): Promise<RefreshResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(MODELS_API_URL, { signal: opts.signal ?? AbortSignal.timeout(30_000), redirect: "error" });
  if (!res.ok) throw new Error(`models.dev answered HTTP ${res.status}`);
  const text = await readCapped(res, MAX_API_BYTES);
  let api: unknown;
  try {
    api = JSON.parse(text);
  } catch {
    throw new Error("models.dev data is not valid JSON");
  }
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const { snapshot, rejected } = snapshotFromApi(api, date, opts.pins);
  if (!snapshot.providers.length) throw new Error("models.dev data contained no usable providers; the cache was not changed");
  const file = modelsCachePath(opts.home);
  writePrivateFile(file, JSON.stringify(snapshot), { durable: true, mode: 0o600 });
  return { file, date, providers: snapshot.providers.length, models: snapshot.providers.reduce((n, p) => n + p.models.length, 0), rejected };
}
