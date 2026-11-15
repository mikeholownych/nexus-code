#!/usr/bin/env node
// Offline generator for cli/src/providers.generated.ts from a models.dev api.json (MIT, github.com/sst/models.dev).
// It never touches the network: fetch api.json yourself first (see docs/CLOUD_PROVIDERS.md).
//   node scripts/gen_models_snapshot.mjs <api.json> --date YYYY-MM-DD [--commit <sha>] [--tools-from <models.dev clone>] [--out <file>]
// api.json carries no tool_choice data; --tools-from reads `capabilities.tools.choice` from the clone's TOML (data only,
// read as text; nothing in the clone is executed). Pruning rule: only chat models (type absent or "chat") that support
// tool calls (the harness is agentic), no deprecated/alpha status, no non-HTTP (ws://, wss://) endpoint. Repeated
// effort and tool-choice arrays are emitted once as tables (E, T) and referenced by index.
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
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined);
  const own = read(path.join(cloneDir, "providers", providerId, "models", `${modelId}.toml`));
  if (own === undefined) return undefined;
  const direct = toolChoiceFromToml(own);
  if (direct) return direct;
  const base = /^base_model\s*=\s*"([^"]+)"/m.exec(own)?.[1];
  if (!base || base.includes("..")) return undefined;
  const baseText = read(path.join(cloneDir, "models", `${base}.toml`));
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

export function buildSnapshot(api, { date, commit, toolsFrom } = {}) {
  const providers = Object.keys(api).sort(cmp).map((key) => {
    const p = api[key];
    const entry = { id: p.id ?? key, name: p.name, env: [...(p.env ?? [])], protocol: protocolClass(p.npm) };
    if (typeof p.api === "string" && p.api) entry.baseUrl = p.api;
    entry.models = Object.values(p.models ?? {})
      .filter(keepModel)
      .sort((a, b) => cmp(a.id, b.id))
      .map((m) => buildModel(m, toolsFrom ? readToolChoice(toolsFrom, entry.id, m.id) : undefined));
    return entry;
  });
  return { date, ...(commit ? { commit } : {}), license: "MIT", source: "https://models.dev/api.json", providers };
}

export function validateSnapshot(s) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? "")) bad("date must be YYYY-MM-DD");
  if (!Array.isArray(s?.providers) || s.providers.length === 0) return [...errors, "providers must be a non-empty array"];
  const seen = new Set();
  for (const p of s.providers) {
    const where = `provider ${p?.id}`;
    if (typeof p.id !== "string" || !p.id) bad(`${where}: id`);
    if (seen.has(p.id)) bad(`${where}: duplicate`);
    seen.add(p.id);
    if (typeof p.name !== "string" || !p.name) bad(`${where}: name`);
    if (typeof p.protocol !== "string" || !(/^(openai-chat|openai-responses|anthropic-messages)$/.test(p.protocol) || /^native:.+/.test(p.protocol))) bad(`${where}: protocol`);
    if (!Array.isArray(p.env) || p.env.some((e) => typeof e !== "string")) bad(`${where}: env`);
    if (p.baseUrl !== undefined && typeof p.baseUrl !== "string") bad(`${where}: baseUrl`);
    const ids = new Set();
    for (const m of p.models ?? []) {
      const mw = `${where} model ${m?.id}`;
      if (typeof m.id !== "string" || !m.id) bad(`${mw}: id`);
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
  const tables = { effort: new Map(), toolChoice: new Map() };
  for (const p of s.providers) for (const m of p.models) for (const k of Object.keys(tables)) if (m[k]) tables[k].set(JSON.stringify(m[k]), 0);
  for (const k of Object.keys(tables)) {
    const sorted = [...tables[k].keys()].sort(cmp);
    tables[k] = new Map(sorted.map((key, i) => [key, i]));
  }
  const model = (m) => {
    const parts = [`id:${JSON.stringify(m.id)}`, `context:${m.context}`, `output:${m.output}`];
    if (m.input !== undefined) parts.push(`input:${m.input}`);
    parts.push(`toolCall:${m.toolCall}`);
    if (m.toolChoice) parts.push(`toolChoice:T[${tables.toolChoice.get(JSON.stringify(m.toolChoice))}]`);
    parts.push(`reasoning:${m.reasoning}`);
    if (m.effort) parts.push(`effort:E[${tables.effort.get(JSON.stringify(m.effort))}]`);
    if (m.price) parts.push(`price:{input:${m.price.input},output:${m.price.output}}`);
    return `{${parts.join(",")}}`;
  };
  const rows = s.providers.map((p) => {
    const { models, ...head } = p;
    return `{...${JSON.stringify(head)},models:[\n${models.map(model).join(",\n")}]}`;
  });
  const table = (name, t) => `const ${name}: string[][] = [${[...t.keys()].join(",")}];`;
  const meta = { date: s.date, ...(s.commit ? { commit: s.commit } : {}), license: s.license, source: s.source };
  return `// GENERATED by scripts/gen_models_snapshot.mjs from models.dev (MIT licence, https://github.com/sst/models.dev).
// Snapshot date: ${s.date}${s.commit ? `; source commit: ${s.commit}` : ""}. Do not edit; regenerate offline (docs/CLOUD_PROVIDERS.md).
import type { ModelsSnapshot } from "./core/models_snapshot.js";

${table("E", tables.effort)}
${table("T", tables.toolChoice)}

export const MODELS_SNAPSHOT: ModelsSnapshot = {...${JSON.stringify(meta)},providers:[
${rows.join(",\n")}]};
`;
}

function main(argv) {
  const opt = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
    else files.push(argv[i]);
  }
  if (files.length !== 1 || !opt.date) {
    console.error("usage: gen_models_snapshot.mjs <api.json> --date YYYY-MM-DD [--commit sha] [--tools-from <clone>] [--out file]");
    return 2;
  }
  const snapshot = buildSnapshot(JSON.parse(fs.readFileSync(files[0], "utf8")), { date: opt.date, commit: opt.commit, toolsFrom: opt["tools-from"] });
  const errors = validateSnapshot(snapshot);
  if (errors.length) {
    console.error(`snapshot invalid:\n${errors.slice(0, 20).join("\n")}`);
    return 1;
  }
  const out = opt.out ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli/src/providers.generated.ts");
  const text = renderSnapshot(snapshot);
  fs.writeFileSync(out, text);
  console.log(`${out}: ${Buffer.byteLength(text)} bytes, ${snapshot.providers.length} providers, ${snapshot.providers.reduce((n, p) => n + p.models.length, 0)} models`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
