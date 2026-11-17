/**
 * The operator's own provider declarations: `~/.config/nexus/providers.json`. Read only from the operator's home (a
 * project file is never consulted); every field is validated and errors name the field that is wrong.
 *
 *   { "providers": { "azure-openai": {
 *       "label": "Azure OpenAI", "protocol": "openai-chat",
 *       "baseUrl": "https://{resource}.openai.azure.com/openai/deployments/{deployment}",
 *       "variables": { "resource": "acme", "deployment": "gpt-4o" },
 *       "query": { "api-version": "2024-10-21" },
 *       "auth": "header", "authHeader": "api-key", "credentialEnv": "AZURE_OPENAI_API_KEY" } } }
 */
import fs from "node:fs";
import type { AuthStyle, ProviderDefinition, WireProtocol } from "./providers.js";
import { expandUrlTemplate, validateAuthHeaderName, validateBaseUrl, validateExtraHeaders, validateProviderId } from "./provider_safety.js";

const PROTOCOLS: readonly WireProtocol[] = ["openai-chat", "openai-responses", "anthropic-messages", "bedrock-converse"];
const AUTHS: readonly AuthStyle[] = ["bearer", "x-api-key", "header", "none", "sigv4"];
const USAGES = ["openrouter", "stream-options", "native"] as const;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const QUERY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const QUERY_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const KNOWN_FIELDS = new Set([
  "label", "protocol", "baseUrl", "variables", "query", "headers", "auth", "authHeader", "credentialEnv", "streamOnly", "omitParams", "usage",
]);

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${field}: must be one of ${allowed.join(", ")}`);
  return value as T;
}

function parseProvider(id: string, raw: unknown, localOrigins: readonly string[]): ProviderDefinition {
  const f = `providers.${id}`;
  if (!isObject(raw)) throw new Error(`${f}: must be an object`);
  for (const key of Object.keys(raw)) if (!KNOWN_FIELDS.has(key)) throw new Error(`${f}.${key}: unknown field`);
  const label = typeof raw.label === "string" && raw.label.trim() && raw.label.length <= 80 ? raw.label.trim() : undefined;
  if (!label) throw new Error(`${f}.label: a short label is required`);
  const protocol = oneOf(raw.protocol ?? "openai-chat", PROTOCOLS, `${f}.protocol`);
  const auth = oneOf(raw.auth ?? "bearer", AUTHS, `${f}.auth`);

  let variables: Record<string, string> = {};
  if (raw.variables !== undefined) {
    if (!isObject(raw.variables)) throw new Error(`${f}.variables: must be an object`);
    variables = Object.fromEntries(Object.entries(raw.variables).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  }
  // Omitted: the operator supplies the URL (NEXUS_<ID>_BASE_URL or --base-url), as for the generic `compatible` provider.
  if (raw.baseUrl !== undefined && typeof raw.baseUrl !== "string") throw new Error(`${f}.baseUrl: must be a URL string`);
  const baseUrl = raw.baseUrl === undefined ? undefined : validateBaseUrl(expandUrlTemplate(raw.baseUrl, variables, `${f}.baseUrl`), `${f}.baseUrl`, localOrigins);

  let authHeader: string | undefined;
  if (auth === "header") {
    if (raw.authHeader === undefined) throw new Error(`${f}.authHeader: required when auth is "header"`);
    authHeader = validateAuthHeaderName(raw.authHeader, `${f}.authHeader`);
  } else if (raw.authHeader !== undefined) {
    throw new Error(`${f}.authHeader: only valid when auth is "header"`);
  }

  let credentialEnv: string | undefined;
  if (raw.credentialEnv !== undefined) {
    if (typeof raw.credentialEnv !== "string" || !ENV_NAME.test(raw.credentialEnv)) throw new Error(`${f}.credentialEnv: must be an environment variable name (A-Z, 0-9, _)`);
    credentialEnv = raw.credentialEnv;
  } else if (auth !== "none" && auth !== "sigv4") {
    throw new Error(`${f}.credentialEnv: required unless auth is "none" or "sigv4"`);
  }

  let query: Record<string, string> | undefined;
  if (raw.query !== undefined) {
    if (!isObject(raw.query)) throw new Error(`${f}.query: must be an object`);
    query = {};
    for (const [k, v] of Object.entries(raw.query)) {
      if (!QUERY_NAME.test(k)) throw new Error(`${f}.query.${k}: not a valid parameter name`);
      if (typeof v !== "string" || !QUERY_VALUE.test(v)) throw new Error(`${f}.query.${k}: value must be letters, digits or . _ : -`);
      query[k] = v;
    }
  }

  let omitParams: string[] | undefined;
  if (raw.omitParams !== undefined) {
    if (!Array.isArray(raw.omitParams) || !raw.omitParams.every((p) => typeof p === "string" && /^[a-z_]{1,48}$/.test(p))) throw new Error(`${f}.omitParams: must be a list of parameter names`);
    omitParams = raw.omitParams as string[];
  }
  if (raw.streamOnly !== undefined && typeof raw.streamOnly !== "boolean") throw new Error(`${f}.streamOnly: must be true or false`);

  const headers = validateExtraHeaders(raw.headers, `${f}.headers`);
  return {
    id: validateProviderId(id, `${f} (id)`),
    label,
    protocol,
    ...(baseUrl ? { baseUrl } : {}),
    ...(credentialEnv ? { credentialEnv } : {}),
    auth,
    ...(authHeader ? { authHeader } : {}),
    ...(Object.keys(headers).length ? { staticHeaders: headers } : {}),
    ...(query && Object.keys(query).length ? { query } : {}),
    ...(raw.streamOnly ? { streamOnly: true } : {}),
    ...(omitParams?.length ? { omitParams } : {}),
    usage: raw.usage === undefined ? (protocol === "openai-chat" ? "stream-options" : "native") : oneOf(raw.usage, USAGES, `${f}.usage`),
    methods: auth === "none" ? [] : [{ id: "api-key", label: "API key", kind: "key" }],
  };
}

export function parseProvidersDocument(raw: unknown, localOrigins: readonly string[] = []): ProviderDefinition[] {
  if (!isObject(raw)) throw new Error("providers.json: must be an object with a \"providers\" map");
  for (const key of Object.keys(raw)) if (key !== "providers") throw new Error(`providers.json: unknown field "${key}"`);
  if (!isObject(raw.providers)) throw new Error("providers: must be an object mapping provider ids to definitions");
  return Object.entries(raw.providers).map(([id, def]) => parseProvider(id, def, localOrigins));
}

/** Read the operator's providers file; a missing file declares none. */
export function readProvidersFile(file: string, localOrigins: readonly string[] = []): ProviderDefinition[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`providers.json: cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`providers.json: ${file} is not valid JSON`);
  }
  return parseProvidersDocument(parsed, localOrigins);
}
