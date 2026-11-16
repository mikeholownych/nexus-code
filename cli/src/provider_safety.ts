/**
 * Validation for operator-declared provider settings (ids, base URLs, URL template variables, extra headers).
 * Pure functions: each returns the cleaned value or throws an Error naming the offending field.
 */
import { classifyDestination } from "./core/egress.js";

/** Lowercase letters, digits and hyphens, starting with a letter: safe inside `NEXUS_<ID>_BASE_URL` once mapped. */
const ID_GRAMMAR = /^[a-z][a-z0-9-]{0,31}$/;

/** Headers a provider definition may never set: routing, framing, or another party's credentials. */
const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect",
  "proxy-authorization", "proxy-connection", "cookie", "set-cookie", "forwarded", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-real-ip", "x-task-class",
]);

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Visible ASCII plus space and tab; no CR, LF or other control characters. */
const HEADER_VALUE = /^[\t\x20-\x7e]{0,512}$/;
const TEMPLATE_VARIABLE = /\{([^{}]*)\}/g;
const VARIABLE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function validateProviderId(id: unknown, field = "id"): string {
  if (typeof id !== "string" || !ID_GRAMMAR.test(id)) {
    throw new Error(`${field}: must be 1-32 characters of a-z, 0-9 and "-", starting with a letter`);
  }
  return id;
}

/**
 * A provider base URL: absolute, no userinfo, query or fragment surprises, and https unless the destination is local
 * (loopback, private, or listed in NEXUS_LOCAL_ORIGINS, as the egress classifier decides).
 */
export function validateBaseUrl(raw: unknown, field = "baseUrl", localOrigins: readonly string[] = []): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${field}: a URL is required`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${field}: not a valid absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${field}: only http and https URLs are allowed`);
  if (url.username || url.password) throw new Error(`${field}: credentials in the URL are not allowed`);
  if (url.hash) throw new Error(`${field}: a URL fragment is not allowed`);
  if (url.protocol === "http:") {
    const boundary = classifyDestination(url.toString(), undefined, { localOrigins });
    if (boundary === "EXTERNAL_PUBLIC" || boundary === "EXTERNAL_BOUNDED") {
      throw new Error(`${field}: http is allowed only for local destinations; use https or add the origin to NEXUS_LOCAL_ORIGINS`);
    }
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Fill `{name}` variables in a URL template. Each value is validated before substitution so it cannot change the
 * host, path structure or query; an unknown or unfilled variable is an error.
 */
export function expandUrlTemplate(template: string, values: Readonly<Record<string, string | undefined>>, field = "baseUrl"): string {
  return template.replace(TEMPLATE_VARIABLE, (_m, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${field}: variable {${name}} has no value`);
    if (!VARIABLE_VALUE.test(value)) throw new Error(`${field}: value of {${name}} must be letters, digits, ".", "_" or "-"`);
    return value;
  });
}

/** Extra headers a provider sends on every request; auth belongs to the auth style, never here. */
export function validateExtraHeaders(headers: unknown, field = "headers"): Record<string, string> {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error(`${field}: must be an object of header names to values`);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new Error(`${field}.${name}: not a valid header name`);
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) throw new Error(`${field}.${name}: this header cannot be set by a provider`);
    if (AUTH_HEADERS.has(lower)) throw new Error(`${field}.${name}: credentials are set by the provider's auth style, not as a static header`);
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) throw new Error(`${field}.${name}: value must be printable text without line breaks`);
    out[name] = value;
  }
  return out;
}

/** Header names an operator-declared provider adds, for the redaction list (keys never reach logs). */
export function redactableHeaderNames(authHeader: string | undefined, extra: Readonly<Record<string, string>>): string[] {
  return [...new Set([...(authHeader ? [authHeader.toLowerCase()] : []), ...Object.keys(extra).map((n) => n.toLowerCase())])];
}
