#!/usr/bin/env node
// Offline generator for cli/src/providers.generated.json from a models.dev api.json (MIT, github.com/sst/models.dev).
// It never touches the network: fetch api.json yourself first (see docs/CLOUD_PROVIDERS.md).
//   node scripts/gen_models_snapshot.mjs <api.json> --date YYYY-MM-DD [--commit <sha>] [--tools-from <models.dev clone>] [--out <file>]
// api.json carries no tool_choice data; --tools-from reads `capabilities.tools.choice` from the clone's TOML (data only,
// read as text; nothing in the clone is executed). Pruning rule: only chat models (type absent or "chat") that support
// tool calls (the harness is agentic), no deprecated/alpha status, no non-HTTP (ws://, wss://) endpoint. Repeated
// Providers are validated against cli/src/providers.pins.json and the credential/URL policy below; a violation aborts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENAI_CHAT_NPM = new Set([
  "@ai-sdk/openai-compatible", "@ai-sdk/groq", "@ai-sdk/mistral", "@ai-sdk/xai", "@ai-sdk/cerebras",
  "@ai-sdk/togetherai", "@ai-sdk/perplexity", "@ai-sdk/deepinfra", "@openrouter/ai-sdk-provider",
]);

export function protocolClass(npm) {
  if (OPENAI_CHAT_NPM.has(npm)) return "openai-chat";
  if (npm === "@ai-sdk/openai") return "openai-responses";
  if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
  return `native:${npm}`;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const PINS = JSON.parse(fs.readFileSync(path.resolve(here, "../cli/src/providers.pins.json"), "utf8"));
const ENV_NAME = /^[A-Z0-9][A-Z0-9_]{1,63}$/;
const ENV_DENY = /^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|_SSH|^GITHUB_TOKEN$/;
const ENV_DENY_ALLOWED = new Set(["amazon-bedrock", "google-vertex", "google-vertex-anthropic", "github-copilot"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const unsafeId = (id, max) =>
  typeof id !== "string" || !id || id.length > max || id.includes("..") || id.startsWith("/") || id.includes("\0");

export function hostFromEnv(url) {
  return url.startsWith("${") || (url.split("://")[1] ?? "").split(/[/?#]/)[0].includes("${");
}

export function providerViolations(p, pins = PINS) {
  const out = [];
  if (typeof p?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.id) || p.id.includes("..")) out.push("id");
  if (typeof p?.name !== "string" || !p.name || p.name.length > 200) out.push("name");
  if (typeof p?.protocol !== "string" || !(/^(openai-chat|openai-responses|anthropic-messages)$/.test(p.protocol) || /^native:.{1,200}$/.test(p.protocol))) out.push("protocol");
  const env = Array.isArray(p?.env) ? p.env : [];
  if (!Array.isArray(p?.env)) out.push("env");
  for (const e of env) {
    if (typeof e !== "string" || !ENV_NAME.test(e)) out.push(`env name ${JSON.stringify(e)}`);
    else if (ENV_DENY.test(e) && !ENV_DENY_ALLOWED.has(p.id)) out.push(`env name ${e} not allowed for this provider`);
  }
  if (p?.baseUrl !== undefined) {
    const url = p.baseUrl;
    if (typeof url !== "string" || /[\s\u0000-\u001f]/.test(url)) out.push("baseUrl");
    else {
      const vars = [...url.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
      for (const v of vars) if (!env.includes(v)) out.push(`baseUrl variable ${v} is not one of the provider's env names`);
      const fromEnv = hostFromEnv(url);
      if (fromEnv !== (p.hostFromEnv === true)) out.push("hostFromEnv mismatch");
      if (url.startsWith("${")) {
        if (!/^\$\{[A-Z0-9_]+\}(\/[^$]*)?$/.test(url)) out.push("baseUrl template");
      } else {
        try {
          const u = new URL(url.replace(/\$\{[^}]*\}/g, "placeholder"));
          const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
          if (!ok) out.push("baseUrl must be https (http only for loopback)");
          if (u.username || u.password) out.push("baseUrl has credentials");
          const pin = Object.hasOwn(pins, p.id) ? pins[p.id] : undefined;
          if (pin && !fromEnv && !pin.suffixes.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`))) out.push(`baseUrl host ${u.hostname} leaves the pinned suffixes ${pin.suffixes.join(", ")}`);
        } catch {
          out.push("baseUrl does not parse");
        }
      }
    }
  } else if (p?.hostFromEnv !== undefined) out.push("hostFromEnv without baseUrl");
  if (Object.hasOwn(pins, p?.id) && p.hostFromEnv) out.push("pinned provider takes its host from env");
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function keepModel(m) {
  if (m.type !== undefined && m.type !== "chat") return false;
  if (m.tool_call !== true) return false;
  if (m.status === "deprecated" || m.status === "alpha") return false;
  if (typeof m.provider?.api === "string" && !/^https?:/.test(m.provider.api)) return false;
  return true;
}

export function toolChoiceFromToml(text) {
  const line = text.split("\n").find((l) => /^tools\s*=\s*\{/.test(l));
  const match = line && /choice\s*=\s*\[([^\]]*)\]/.exec(line);
  if (!match) return undefined;
  const modes = [...match[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return modes.length ? modes : undefined;
}

export function readToolChoice(cloneDir, providerId, modelId) {
  if (unsafeId(providerId, 64) || unsafeId(modelId, 200)) return undefined;
  const root = path.resolve(cloneDir);
  const read = (...parts) => {
    const file = path.resolve(root, ...parts);
    return file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  };
  const own = read("providers", providerId, "models", `${modelId}.toml`);
  if (own === undefined) return undefined;
  const direct = toolChoiceFromToml(own);
  if (direct) return direct;
  const base = /^base_model\s*=\s*"([^"]+)"/m.exec(own)?.[1];
  if (!base || unsafeId(base, 200)) return undefined;
  const baseText = read("models", `${base}.toml`);
  return baseText === undefined ? undefined : toolChoiceFromToml(baseText);
}

export function buildModel(m, toolChoice) {
  const out = { id: m.id, context: num(m.limit?.context) ?? 0, output: num(m.limit?.output) ?? 0 };
  const input = num(m.limit?.input);
  if (input !== undefined) out.input = input;
  out.toolCall = m.tool_call === true;
  if (toolChoice) out.toolChoice = toolChoice;
  out.reasoning = m.reasoning === true;
  const effort = (m.reasoning_options ?? []).find((o) => o.type === "effort" && Array.isArray(o.values))?.values;
  if (effort?.length) out.effort = [...effort];
  const pin = num(m.cost?.input);
  const pout = num(m.cost?.output);
  if (pin !== undefined && pout !== undefined) out.price = { input: pin, output: pout };
  return out;
}

export function buildSnapshot(api, { date, commit, toolsFrom, pins = PINS } = {}) {
  const providers = Object.keys(api).sort(cmp).map((key) => {
    const p = api[key];
    const entry = { id: p.id ?? key, name: p.name, env: [...(p.env ?? [])], protocol: protocolClass(p.npm) };
    const pin = Object.hasOwn(pins, entry.id) ? pins[entry.id] : undefined;
    if (typeof p.api === "string" && p.api) entry.baseUrl = p.api;
    else if (pin?.defaultBaseUrl && entry.protocol === "openai-chat") entry.baseUrl = pin.defaultBaseUrl;
    if (entry.baseUrl && hostFromEnv(entry.baseUrl)) entry.hostFromEnv = true;
    if (!entry.baseUrl && entry.protocol === "openai-chat") entry.needsBaseUrl = true;
    entry.models = Object.values(p.models ?? {})
      .filter(keepModel)
      .sort((a, b) => cmp(a.id, b.id))
      .map((m) => buildModel(m, toolsFrom ? readToolChoice(toolsFrom, entry.id, m.id) : undefined));
    return entry;
  });
  return { date, ...(commit ? { commit } : {}), license: "MIT", source: "https://models.dev/api.json", providers };
}

export function validateSnapshot(s, pins = PINS) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? "")) bad("date must be YYYY-MM-DD");
  if (s?.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(s.commit)) bad("commit must be 7-40 hex characters");
  if (!Array.isArray(s?.providers) || s.providers.length === 0) return [...errors, "providers must be a non-empty array"];
  const seen = new Set();
  for (const p of s.providers) {
    const where = `provider ${JSON.stringify(p?.id)}`;
    for (const v of providerViolations(p, pins)) bad(`${where}: ${v}`);
    if (seen.has(p.id)) bad(`${where}: duplicate`);
    seen.add(p.id);
    if (p.needsBaseUrl !== undefined && (p.needsBaseUrl !== true || p.baseUrl !== undefined)) bad(`${where}: needsBaseUrl`);
    if (p.protocol === "openai-chat" && !p.baseUrl && p.needsBaseUrl !== true) bad(`${where}: openai-chat provider without baseUrl must set needsBaseUrl`);
    const ids = new Set();
    for (const m of p.models ?? []) {
      const mw = `${where} model ${JSON.stringify(m?.id)}`;
      if (unsafeId(m?.id, 200)) bad(`${mw}: id`);
      if (ids.has(m.id)) bad(`${mw}: duplicate`);
      ids.add(m.id);
      for (const k of ["context", "output", "input"]) {
        if (m[k] !== undefined && !(Number.isFinite(m[k]) && m[k] >= 0)) bad(`${mw}: ${k}`);
      }
      if (typeof m.toolCall !== "boolean" || typeof m.reasoning !== "boolean") bad(`${mw}: toolCall/reasoning`);
      for (const k of ["toolChoice", "effort"]) {
        if (m[k] !== undefined && (!Array.isArray(m[k]) || m[k].some((x) => typeof x !== "string"))) bad(`${mw}: ${k}`);
      }
      if (m.price !== undefined && !(Number.isFinite(m.price.input) && Number.isFinite(m.price.output))) bad(`${mw}: price`);
    }
  }
  return errors;
}

export function renderSnapshot(s) {
  const meta = { generated: "scripts/gen_models_snapshot.mjs from models.dev (MIT, https://github.com/sst/models.dev); do not edit, regenerate offline (docs/CLOUD_PROVIDERS.md)", date: s.date, ...(s.commit ? { commit: s.commit } : {}), license: s.license, source: s.source };
  const rows = s.providers.map((p) => {
    const { models, ...head } = p;
    return `${JSON.stringify(head).slice(0, -1)},"models":[${models.length ? "\n" : ""}${models.map((m) => JSON.stringify(m)).join(",\n")}]}`;
  });
  return `${JSON.stringify(meta).slice(0, -1)},"providers":[\n${rows.join(",\n")}\n]}\n`;
}

const FLAGS = new Set(["date", "commit", "tools-from", "out"]);

export function parseArgs(argv) {
  const opt = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) files.push(argv[i]);
    else {
      const name = argv[i].slice(2);
      if (!FLAGS.has(name)) throw new Error(`unknown flag --${name}`);
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      opt[name] = value;
    }
  }
  if (files.length !== 1) throw new Error("exactly one api.json path is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opt.date ?? "")) throw new Error("--date YYYY-MM-DD is required");
  if (opt.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(opt.commit)) throw new Error("--commit must be 7-40 hex characters");
  return { file: files[0], opt };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\nusage: gen_models_snapshot.mjs <api.json> --date YYYY-MM-DD [--commit sha] [--tools-from <clone>] [--out file]`);
    return 2;
  }
  const { file, opt } = args;
  const snapshot = buildSnapshot(JSON.parse(fs.readFileSync(file, "utf8")), { date: opt.date, commit: opt.commit, toolsFrom: opt["tools-from"] });
  const errors = validateSnapshot(snapshot);
  if (errors.length) {
    console.error(`snapshot invalid:\n${errors.slice(0, 20).join("\n")}`);
    return 1;
  }
  const out = opt.out ?? path.resolve(here, "../cli/src/providers.generated.json");
  const text = renderSnapshot(snapshot);
  fs.writeFileSync(out, text);
  console.log(`${out}: ${Buffer.byteLength(text)} bytes, ${snapshot.providers.length} providers, ${snapshot.providers.reduce((n, p) => n + p.models.length, 0)} models`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
