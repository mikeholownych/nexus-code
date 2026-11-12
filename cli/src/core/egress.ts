import { randomBytes } from "node:crypto";
import * as net from "node:net";
import { URL } from "node:url";

/**
 * Destination-aware trust boundary classification (DEST-001).
 *
 * - HOST_LOCAL: In-process runtime, memory, unix sockets, local workspace files.
 * - LOCAL_APPLIANCE: Private network services, e.g. localhost vLLM, private LAN endpoints.
 * - EXTERNAL_BOUNDED: Contracted external services with data-handling agreements.
 * - EXTERNAL_PUBLIC: Public cloud LLMs, public internet endpoints, public web.
 */
export type DestinationTrustBoundary =
  | "HOST_LOCAL"
  | "LOCAL_APPLIANCE"
  | "EXTERNAL_BOUNDED"
  | "EXTERNAL_PUBLIC";

/**
 * Formal sensitive data classification categories (DATA-002).
 */
export type SecretClassificationType =
  | "OPERATOR_EXPLICIT"     // Configured explicitly by operator (confidence 1.0)
  | "PATTERN_DETERMINISTIC" // Deterministic API keys, credentials, PEM keys (confidence 0.95)
  | "CONTEXTUAL_HEURISTIC"  // Key-value pairs, Shannon entropy indicators (confidence 0.75)
  | "UNCERTAIN";            // Suspicious high-entropy strings without recognized prefix (confidence 0.5)

/**
 * Protection selection modes supported at outbound boundaries (DISC-005).
 */
export type ProtectionMode =
  | "REVERSIBLE_TOKENIZATION" // Reversible unguessable scoped reference substitution
  | "IRREVERSIBLE_REDACTION"   // Permanent redaction marker [REDACTED:<type>]
  | "ENCRYPTION";              // Recipient-readable encryption

export interface ClassifiedSecret {
  secret: string;
  classificationType: SecretClassificationType;
  classifierId: string;
  confidence: number;
  patternName?: string;
}

export interface ReversibleTokenRecord {
  token: string;
  secret: string;
  taskId: string;
  sessionId: string;
  sourceBoundary: DestinationTrustBoundary;
  targetBoundary: DestinationTrustBoundary;
  createdAt: number;
  rehydratedCount: number;
}

export interface EgressEvaluationContext {
  taskId?: string;
  sessionId?: string;
  sourceBoundary?: DestinationTrustBoundary;
  preferredProtectionMode?: ProtectionMode;
  disclosureAuthorized?: boolean;
  actor?: string;
  isSimulatedFailure?: boolean;
}

export interface EgressEvaluationResult {
  allowed: boolean;
  destinationBoundary: DestinationTrustBoundary;
  transitionCrossesBoundary: boolean;
  quarantinedCount: number;
  sanitizedPayload?: any;
  sanitizedText?: string;
  classifiedSecrets: ClassifiedSecret[];
  /** The classified values actually replaced in sanitizedText (a value inside a longer one may not be). */
  quarantinedSecrets?: ClassifiedSecret[];
  reason?: string;
}

export interface RehydrationContext {
  taskId: string;
  sessionId?: string;
  isAuthorizedSink?: boolean;
  actor?: string;
}

export interface RehydrationResult {
  rehydrated: any;
  rehydratedCount: number;
  inertCount: number;
}

export interface EgressPolicy {
  allowedDomains?: string[];
  boundedDomains?: string[];
  explicitSecrets?: string[];
}

/**
 * Numeric trust rank ordering (Higher number = Higher trust).
 */
const TRUST_RANKS: Record<DestinationTrustBoundary, number> = {
  HOST_LOCAL: 4,
  LOCAL_APPLIANCE: 3,
  EXTERNAL_BOUNDED: 2,
  EXTERNAL_PUBLIC: 1,
};

/**
 * Authoritative reason codes for locality decisions (REQ-SEC-111).
 */
export type LocalityReason =
  | "loopback_ip"
  | "private_ip"
  | "cgnat_ip"
  | "ula_ip"
  | "operator_local_origin"
  | "operator_endpoint"
  | "hostname_external";

export interface DestinationClassification {
  boundary: DestinationTrustBoundary;
  reason: LocalityReason;
}

export interface LocalityOptions {
  operatorEndpoint?: string;
  localOrigins?: readonly string[];
}

let operatorSettingResolver: ((key: string) => string | undefined) | undefined;

/**
 * Register a resolver for operator-only configuration settings (avoiding circular imports).
 */
export function setLocalityAuthorityResolver(resolver: (key: string) => string | undefined): void {
  operatorSettingResolver = resolver;
}

/**
 * Parses a comma-separated list of local origins/hostnames/URLs/wildcards.
 */
export function parseLocalOrigins(raw?: string | readonly string[]): string[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return raw.map((r: string) => r.trim().toLowerCase()).filter(Boolean);
}

/**
 * Matches host or origin against the operator-provided local origins.
 */
export function matchesLocalOrigins(host: string, origin: string, origins: readonly string[]): boolean {
  const hostLower = host.toLowerCase();
  const originLower = origin.toLowerCase();
  for (const o of origins) {
    const oLower = o.toLowerCase();
    if (oLower === "*" || oLower === hostLower || oLower === originLower) {
      return true;
    }
    if (oLower.includes("://")) {
      try {
        const u = new URL(oLower);
        if (u.origin.toLowerCase() === originLower) return true;
        if (!u.port && u.hostname.toLowerCase() === hostLower) return true;
        if (u.port && u.host.toLowerCase() === hostLower) return true;
      } catch {}
    }
    if (oLower.startsWith("*.")) {
      const suffix = oLower.slice(2);
      if (hostLower.endsWith("." + suffix) || hostLower === suffix) return true;
    }
  }
  return false;
}

/**
 * Parses and expands a standard IPv6 string into a 128-bit BigInt value.
 */
function parseIPv6(ip: string): bigint | null {
  const zoneIndex = ip.indexOf("%");
  const cleanIp = (zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip).toLowerCase();

  let v4Suffix: string | null = null;
  let baseIp = cleanIp;
  const lastColon = cleanIp.lastIndexOf(":");
  if (lastColon >= 0) {
    const after = cleanIp.slice(lastColon + 1);
    if (after.includes(".")) {
      v4Suffix = after;
      baseIp = cleanIp.slice(0, lastColon);
    }
  }

  let groups: string[];
  if (baseIp.includes("::")) {
    const halves = baseIp.split("::");
    if (halves.length !== 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const needed = (v4Suffix ? 6 : 8) - (left.length + right.length);
    if (needed < 0) return null;
    groups = [...left, ...Array(needed).fill("0"), ...right];
  } else {
    groups = baseIp.split(":");
  }

  if (v4Suffix) {
    if (groups.length !== 6) return null;
    const v4Parts = v4Suffix.split(".").map((x) => parseInt(x, 10));
    if (v4Parts.length !== 4 || v4Parts.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
    const g6 = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const g7 = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    groups.push(g6, g7);
  }

  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    const num = parseInt(g, 16);
    if (isNaN(num) || num < 0 || num > 0xffff) return null;
    value = (value << 16n) | BigInt(num);
  }
  return value;
}

/**
 * Classifies an IPv4 literal by trust boundary (loopback/private/CGNAT/link-local vs public).
 */
function classifyIpv4Trust(host: string): DestinationClassification {
  const parts = host.split(".").map((x) => parseInt(x, 10));
  if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    // Loopback 127/8
    if (a === 127) {
      return { boundary: "LOCAL_APPLIANCE", reason: "loopback_ip" };
    }
    // RFC1918 private: 10/8, 172.16/12, 192.168/16, or link-local 169.254/16
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return { boundary: "LOCAL_APPLIANCE", reason: "private_ip" };
    }
    // CGNAT 100.64/10
    if (a === 100 && b >= 64 && b <= 127) {
      return { boundary: "LOCAL_APPLIANCE", reason: "cgnat_ip" };
    }
  }
  return { boundary: "EXTERNAL_PUBLIC", reason: "hostname_external" };
}

/**
 * Classifies an endpoint or URL with CIDR-based locality and explicit reason codes (REQ-SEC-111).
 */
export function classifyLocality(
  endpointOrUrl?: string | null,
  policy?: EgressPolicy,
  options?: LocalityOptions
): DestinationClassification {
  if (!endpointOrUrl || endpointOrUrl === "local" || endpointOrUrl === "host" || endpointOrUrl === "in-memory") {
    return { boundary: "HOST_LOCAL", reason: "loopback_ip" };
  }

  const trimmed = endpointOrUrl.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("file:") || trimmed.startsWith("unix:")) {
    return { boundary: "HOST_LOCAL", reason: "loopback_ip" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `http://${trimmed}`);
  } catch {
    return { boundary: "EXTERNAL_PUBLIC", reason: "hostname_external" };
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // 1. Loopback hostname
  if (host === "localhost") {
    return { boundary: "LOCAL_APPLIANCE", reason: "loopback_ip" };
  }

  // 2. IPv4 literals and CIDRs
  if (net.isIP(host) === 4) {
    return classifyIpv4Trust(host);
  }

  // 3. IPv6 literals and CIDRs
  if (net.isIP(host) === 6) {
    const v6 = parseIPv6(host);
    if (v6 !== null) {
      // Loopback ::1
      if (v6 === 1n) {
        return { boundary: "LOCAL_APPLIANCE", reason: "loopback_ip" };
      }
      // IPv4-mapped: ::ffff:a.b.c.d (top 80 bits zero, next 16 bits 0xffff)
      if ((v6 >> 32n) === 0xffffn) {
        const lower = Number(v6 & 0xffffffffn);
        return classifyIpv4Trust(
          `${(lower >>> 24) & 0xff}.${(lower >>> 16) & 0xff}.${(lower >>> 8) & 0xff}.${lower & 0xff}`
        );
      }
      // NAT64 well-known prefix: 64:ff9b::/96 (RFC 6052) embeds the IPv4 destination in
      // the low 32 bits, so on an IPv6-only/NAT64 network the prefix reaches that host.
      if ((v6 >> 32n) === 0x0064ff9b0000000000000000n) {
        const lower = Number(v6 & 0xffffffffn);
        return classifyIpv4Trust(
          `${(lower >>> 24) & 0xff}.${(lower >>> 16) & 0xff}.${(lower >>> 8) & 0xff}.${lower & 0xff}`
        );
      }
      // NAT64 local-use prefix: 64:ff9b:1::/48 (RFC 8215) is never globally reachable.
      if ((v6 >> 80n) === 0x0064ff9b0001n) {
        return { boundary: "LOCAL_APPLIANCE", reason: "private_ip" };
      }
      // IPv6 ULA: fc00::/7 (first 7 bits 1111 110 -> 0x7e)
      if ((v6 >> 121n) === 0x7en) {
        return { boundary: "LOCAL_APPLIANCE", reason: "ula_ip" };
      }
      // IPv6 link-local: fe80::/10 (first 10 bits 1111 1110 10 -> 0x3fa)
      if ((v6 >> 118n) === 0x3fan) {
        return { boundary: "LOCAL_APPLIANCE", reason: "private_ip" };
      }
      return { boundary: "EXTERNAL_PUBLIC", reason: "hostname_external" };
    }
  }

  // 4. Operator-configured endpoint match
  const opEndpoint =
    options?.operatorEndpoint ??
    operatorSettingResolver?.("LOCAL_LLM_ENDPOINT") ??
    process.env.LOCAL_LLM_ENDPOINT;
  if (opEndpoint) {
    try {
      const opUrl = new URL(
        opEndpoint.startsWith("http://") || opEndpoint.startsWith("https://")
          ? opEndpoint
          : `http://${opEndpoint}`
      );
      if (opUrl.hostname.toLowerCase() === host) {
        return { boundary: "LOCAL_APPLIANCE", reason: "operator_endpoint" };
      }
    } catch {}
  }

  // 5. Operator-only local origins (NEXUS_LOCAL_ORIGINS)
  const rawOrigins =
    options?.localOrigins ??
    parseLocalOrigins(
      operatorSettingResolver?.("NEXUS_LOCAL_ORIGINS") ??
        process.env.NEXUS_LOCAL_ORIGINS
    );
  if (matchesLocalOrigins(host, parsed.origin, rawOrigins)) {
    return { boundary: "LOCAL_APPLIANCE", reason: "operator_local_origin" };
  }

  // 6. Enterprise bounded domains from policy
  if (policy?.boundedDomains && policy.boundedDomains.length > 0) {
    for (const bd of policy.boundedDomains) {
      const bdl = bd.toLowerCase();
      if (host === bdl || host.endsWith("." + bdl)) {
        return { boundary: "EXTERNAL_BOUNDED", reason: "hostname_external" };
      }
    }
  }

  // 7. Non-local hostname
  return { boundary: "EXTERNAL_PUBLIC", reason: "hostname_external" };
}

/**
 * Classify endpoint or URL into an authoritative DestinationTrustBoundary (DEST-001, REQ-SEC-111).
 */
export function classifyDestination(
  endpointOrUrl?: string | null,
  policy?: EgressPolicy,
  options?: LocalityOptions
): DestinationTrustBoundary {
  return classifyLocality(endpointOrUrl, policy, options).boundary;
}

/**
 * Returns true if moving from source to dest constitutes an egress transition (DEST-002).
 */
export function isEgressTransition(
  source: DestinationTrustBoundary,
  dest: DestinationTrustBoundary
): boolean {
  if (dest === "EXTERNAL_PUBLIC" || dest === "EXTERNAL_BOUNDED") {
    return true;
  }
  return TRUST_RANKS[dest] < TRUST_RANKS[source];
}

/**
 * Shannon entropy calculation for high-entropy secret detection.
 */
export function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const len = str.length;
  const frequencies = new Map<string, number>();
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    frequencies.set(ch, (frequencies.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Strips trailing quote/semicolon/comma delimiters; a linear scan equivalent to `/["';,]+$/`. */
function trimTrailingDelimiters(value: string): string {
  let end = value.length;
  while (end > 0 && `"';,`.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

/** JSON may escape "/" as `\/`: classify the value as if the slash were plain; the redacted span keeps the escape. */
function unescapeSlashes(value: string): string {
  return value.includes("\\/") ? value.replaceAll("\\/", "/") : value;
}

/**
 * A "/" or "+" written other than plainly: percent-encoded (`%2F`, `%2B`, and once more encoded as `%252F`) or as a
 * look-alike (U+2215 division slash, U+2044 fraction slash, U+FF0F fullwidth solidus, U+29F8 big solidus; U+FF0B
 * fullwidth plus, U+FE62 small plus). Sticky: `matchEncodedKeyChar` tests it at one position.
 */
const ENCODED_KEY_CHAR = /%(?:25)?2[FfBb]|[\u2215\u2044\uFF0F\u29F8\uFF0B\uFE62]/y;
const ENCODED_KEY_CHARS = new RegExp(ENCODED_KEY_CHAR.source, "g");

/** The length of the encoded "/" or "+" at `at`, or 0 when there is none. */
function matchEncodedKeyChar(text: string, at: number): number {
  ENCODED_KEY_CHAR.lastIndex = at;
  const found = ENCODED_KEY_CHAR.exec(text);
  return found ? found[0].length : 0;
}

/** The text as detection sees it: encoded and look-alike "/" and "+" written plainly. The redacted span is never this copy. */
function normalizeKeyChars(value: string): string {
  return value.replace(ENCODED_KEY_CHARS, (found) => (/[/\u2215\u2044\uFF0F\u29F8]|2[Ff]$/.test(found) ? "/" : "+"));
}

function isBase64KeyChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 95 || code === 45 || code === 43 || code === 47; // _ - + /
}

/**
 * One word of a path: identifier words, numbers and short tags as `isIdentifierPart` defines them, or a word with a short
 * number (`Ridge2`). A part of 20 or more characters must split into two or more words (`RandomForestClassifier`): a
 * long run of one letter or of random characters is key material, not a name.
 */
function isPathWord(part: string): boolean {
  const word = /^[A-Za-z]{2,}\d{1,3}$/.test(part) ? part.replace(/\d+$/, "") : part;
  if (!isIdentifierPart(word)) return false;
  return part.length < 20 || (word.match(/[A-Z]{2,}(?![a-z])|[A-Z][a-z]+|[a-z]{2,}/g)?.length ?? 0) >= 2;
}

/**
 * A "/"-separated value is a path (`learn/linear_model/Ridge2`, `/v1/models`), not key material, when it carries no
 * base64-only "+" or "=" and every segment is made of path words. Random base64 segments carry digits, split into
 * one-letter pieces or run 20+ characters without words, so they are not taken for a path.
 */
function isPathLike(value: string): boolean {
  return !/[+=]/.test(value) && value.split("/").every((segment) => segment.split(/[._-]+/).every(isPathWord));
}

/**
 * How much of a Bearer value is the token. A value without "/" is a token. A value with "/" is a token when it has a
 * digit or a capital and is not a path (`isPathLike`); otherwise only the part before its first "/" can be, as in the
 * pattern before "/" was accepted, if it is at least 16 characters long. Returns 0 when nothing of it is a token.
 */
function bearerTokenLength(value: string): number {
  const plain = unescapeSlashes(value);
  if (!plain.includes("/") || (/[0-9A-Z]/.test(plain) && !isPathLike(plain))) return value.length;
  const slash = value.indexOf("/");
  const head = slash > 0 && value[slash - 1] === "\\" ? slash - 1 : slash;
  return head >= 16 ? head : 0;
}

/** How far past a key the encoded run and the dotted continuation are followed: keys are short. Every candidate key gets its own allowance of this size. */
const MAX_EXTENSION = 1024;
/**
 * Extension scans one family (the `sk-` family, or one `DETERMINISTIC_PATTERNS` entry) may start in one classifyText
 * call; an attempt is spent by each candidate (an `sk-` run or a pattern match) that a "." or, for `sk-`, an encoded
 * character directly follows. Extension work is therefore at most families x this x ~3 KB whatever the text length;
 * the extension values add at most about 3x the text (each extended value repeats its original run) plus that constant.
 * Honest limit: only text with more than 1024 key-like candidates of one family ahead of a real key can starve its
 * extension; its plain form is always redacted (the original match is never dropped).
 */
const MAX_EXTENSION_ATTEMPTS_PER_FAMILY = 1024;

/** The per-call attempt counter of one extension-capable family. */
interface ExtensionAttempts { left: number }

function newExtensionAttempts(): ExtensionAttempts {
  return { left: MAX_EXTENSION_ATTEMPTS_PER_FAMILY };
}

/** Spends one attempt; false (and nothing spent) when the family has none left. */
function takeAttempt(attempts: ExtensionAttempts): boolean {
  if (attempts.left <= 0) return false;
  attempts.left--;
  return true;
}

/**
 * The end of the run of key characters from `from`: a JSON-escaped `\/` counts as "/", and with `encoded` an encoded or
 * look-alike "/" or "+" does too. The run stops at `limit`.
 */
function scanKeyRun(text: string, from: number, encoded: boolean, limit = text.length): number {
  let end = from;
  while (end < limit) {
    const code = text.charCodeAt(end);
    const unit = encoded && (code === 37 || code >= 0x2044) ? matchEncodedKeyChar(text, end) : 0; // "%" or a look-alike
    if (unit > 0) {
      if (end + unit > limit) break; // a unit never crosses the limit, so a bounded scan stays within its budget
      end += unit;
    } else if (isBase64KeyChar(code)) end++;
    else if (text[end] === "\\" && text[end + 1] === "/" && end + 2 <= limit) end += 2; // a JSON-escaped "/"
    else break;
  }
  return end;
}

/** Names of `DETERMINISTIC_PATTERNS`: credential kinds whose value, written as a "."-joined run, continues past a dot. JWT_TOKEN matches three segments (`eyJ.eyJ.sig`); material joined after them is part of the same value. */
const DOTTED_CONTINUATION_PATTERNS = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GOOGLE_API_KEY", "HUGGINGFACE_TOKEN", "SLACK_TOKEN", "JWT_TOKEN",
]);

/** A "."-joined segment is key material when it is 6 or more characters with a digit, "/" or "+", or does not split into words. */
function isKeyMaterialSegment(segment: string): boolean {
  return segment.length >= 6 && (/[0-9+/]/.test(segment) || !segment.split(/[_-]+/).every(isIdentifierPart));
}

/**
 * A key followed by "." and more key characters keeps going: `sk-…RtBq.Xo2RtBq` is one credential, not a key and a
 * stray word; a sentence's full stop, a file extension (`.json`) and a word (`.Models`, `.toString`) end the key as
 * before (`isKeyMaterialSegment`). Returns `end` itself when nothing continues it.
 */
function extendDottedKey(text: string, end: number): number {
  const limit = end + MAX_EXTENSION;
  let extended = end;
  while (text[extended] === "." && extended < limit) {
    const segmentEnd = scanKeyRun(text, extended + 1, true, limit);
    if (!isKeyMaterialSegment(normalizeKeyChars(text.slice(extended + 1, segmentEnd)))) break;
    extended = segmentEnd;
  }
  return extended;
}

/** Whether `text[at, end)` (an `sk-` run) is a base64 key: see `scanBase64Keys` for the rule. */
function isBase64KeyRun(text: string, at: number, end: number, anthropic: boolean): boolean {
  const body = normalizeKeyChars(unescapeSlashes(text.slice(at + (anthropic ? 7 : 3), end)));
  const separator = body.search(/[/+]/);
  const plainKeyThenPath = separator >= 20 && separator <= 64 && body[separator] === "/" &&
    isPathLike(body.slice(separator + 1));
  return !plainKeyThenPath && body.length >= 20 && separator >= 0 && /[0-9A-Z+]/.test(body) && !isPathLike(body);
}

/**
 * `sk-` / `sk-ant-` keys whose body is base64 ("/" and "+" included), found in one left-to-right pass: from each `sk-`
 * at a word boundary take the maximal run of key characters (a JSON-escaped `\/` counts as "/") once, validate it,
 * and resume after it. Nothing of the run is trimmed: its last segment is key material whatever its letter case. A run
 * is a key if its body is at least 20 characters, contains "/" or "+", has a digit, a capital or "+", and is not a path
 * (`sk-learn/linear_model/Ridge2`, see `isPathLike`). A plain key followed by a URL path (`sk-…RtBq/models`: the body
 * before its first "/" is a 20-64 character plain key and the rest is a path) is left to the bounded `sk-` patterns,
 * which stop at the "/".
 * Invariant: redaction only grows. The original run is always judged and kept; longer runs (through an encoded
 * "/" or "+", or a dotted continuation) are judged in addition. Each run that something can continue (a "." or an
 * encoded character right after it) extends on its own, up to MAX_EXTENSION, and takes one of the family's
 * MAX_EXTENSION_ATTEMPTS_PER_FAMILY attempts; with none left the run keeps only its original form.
 * Scanning resumes after the original run; a `sk-` inside it is left to the bounded patterns.
 */
function scanBase64Keys(text: string): Array<{ start: number; end: number; name: string }> {
  const found: Array<{ start: number; end: number; name: string }> = [];
  const attempts = newExtensionAttempts();
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf("sk-", from);
    if (at < 0) break;
    if (at > 0 && /\w/.test(text[at - 1])) {
      from = at + 1;
      continue;
    }
    const anthropic = text.startsWith("sk-ant-", at);
    const name = anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const runEnd = scanKeyRun(text, at + 3, false);
    const continues = text[runEnd] === "." || matchEncodedKeyChar(text, runEnd) > 0;
    const extend = continues && takeAttempt(attempts);
    const encodedEnd = extend ? scanKeyRun(text, runEnd, true, runEnd + MAX_EXTENSION) : runEnd;
    const extendedEnd = extend ? extendDottedKey(text, encodedEnd) : runEnd;
    for (const end of new Set([runEnd, encodedEnd, extendedEnd])) {
      if (!isBase64KeyRun(text, at, end, anthropic)) continue;
      let secretEnd = end;
      while (secretEnd < end + 2 && text[secretEnd] === "=") secretEnd++;
      found.push({ start: at, end: secretEnd, name });
    }
    from = Math.max(runEnd, at + 1);
  }
  return found;
}

/** A classifier match with its place in the text. */
interface PositionedMatch {
  start: number;
  end: number;
  item: ClassifiedSecret;
}

/**
 * Two classifiers can match one credential at the same place, one taking more of it than the other: the Bearer pattern
 * stops at "~" where the Authorization pattern takes the whole token68 value; the Bearer capture keeps a sentence's
 * full stop where the entropy tokenizer trims it; an entropy token spans `sk-…/models` where the key pattern stops at
 * the "/". Redaction replaces by value, longest value first, so the enclosing value is replaced whole before a shorter
 * value inside it, and the shorter value is still replaced wherever else it occurs in the text. Resolution: an
 * uncertain (entropy) token that starts where a more confident match starts and extends past it is dropped (the token
 * `sk-…/models` loses to the key at its start, keeping the path). Every other match is kept, inner ones included:
 * an operator secret inside a key does not shorten the key (the key is longer), a key inside an uncertain token keeps
 * its deterministic classification for callers that refuse or redact only positive findings (the checkpoint guard,
 * path display), and a key inside a Bearer match is still redacted where it occurs again unmatched. The result has
 * one entry per distinct value, longest first.
 */
function resolveOverlaps(matches: PositionedMatch[]): ClassifiedSecret[] {
  const order = matches.map((_, i) => i).sort(
    (a, b) => matches[a].start - matches[b].start || matches[b].end - matches[a].end || a - b
  );
  const dropped = new Set<number>();
  let open: number[] = []; // earlier matches that reach the current position, so may contain the current one
  for (const i of order) {
    const { start, end, item } = matches[i];
    open = open.filter((j) => matches[j].end >= start);
    for (const j of open) {
      const enclosing = matches[j];
      if (
        enclosing.item.classificationType === "UNCERTAIN" && enclosing.start === start && enclosing.end >= end &&
        enclosing.item.confidence < item.confidence
      ) {
        dropped.add(j);
      }
    }
    open.push(i);
  }
  const seen = new Set<string>();
  const classified: ClassifiedSecret[] = [];
  matches.forEach((match, i) => {
    if (!dropped.has(i) && !seen.has(match.item.secret)) {
      seen.add(match.item.secret);
      classified.push(match.item);
    }
  });
  // Longest value first: a value that also occurs inside a longer one elsewhere is replaced after it, not through it.
  return classified.sort((a, b) => b.secret.length - a.secret.length);
}

/**
 * A token produced only by the newer delimiters (`<>`, backticks, `|`, `&`, `?`) or by trimming trailing sentence
 * punctuation must look like a credential, not like an identifier or a path: `UpgradeExecutionResult` from
 * `Promise<UpgradeExecutionResult>` and `downstream/branch-specific` are made of letters and word separators only.
 * Random credentials do not split into words (or carry "+"/"="). Tokens the original tokenizer already produced keep its behaviour.
 */
function looksLikeCredentialToken(token: string): boolean {
  if (/[+=]/.test(token)) return true;
  // A filesystem path (rooted, or with two or more separators) is not a credential even with a generated directory name;
  // a base64 secret that happens to contain slashes also carries "+" or "=", or has at most one.
  if (token.startsWith("/") || (token.match(/\//g)?.length ?? 0) >= 2) return false;
  return !token.split(/[/._-]+/).every(isIdentifierPart);
}

/**
 * A "."-joined token is key material only when it is unlike every ordinary dotted name: every segment is base64url
 * characters and `isKeyMaterialSegment` (so no path, host name, file name, version number, package or class name), and one
 * segment is at least 16 characters. The caller still applies the entropy threshold to the whole token.
 */
function isDottedKeyMaterial(plain: string): boolean {
  const segments = plain.split(".");
  return segments.length >= 2 &&
    segments.every((segment) => /^[a-zA-Z0-9+=_-]+$/.test(segment) && isKeyMaterialSegment(segment)) &&
    segments.some((segment) => segment.length >= 16);
}

/** A number, a short tag such as `v1` or `x86`, or letters that split cleanly into words of two or more letters. */
function isIdentifierPart(part: string): boolean {
  if (part === "") return true;
  if (/^\d+$/.test(part) || /^[a-z]{1,3}\d{1,3}$/i.test(part)) return true;
  if (!/^[A-Za-z]+$/.test(part)) return false;
  // camelCase, PascalCase, UPPER and lower words. Random base64 splits into one-letter pieces (`wJalrXUtn...`).
  const words = part.match(/[A-Z]{2,}(?![a-z])|[A-Z][a-z]+|[a-z]{2,}/g);
  return words !== null && words.join("").length === part.length;
}

/** An Aho-Corasick automaton over a list of values. */
interface Automaton {
  alphabet: Int32Array; // UTF-16 code unit -> symbol, -1 when no value uses it
  radix: number;
  next: Map<number, number>; // node * radix + symbol -> child node
  fail: Int32Array;
  depth: Int32Array;
  output: Int32Array; // the value that ends at this node (the first in the list when values repeat)
  dictionary: Int32Array; // the nearest node on the fail chain where a value ends
}

/**
 * Builds an Aho-Corasick automaton over the values. Transitions are keyed by node and by the index of the code unit in
 * the values' own alphabet, which keeps the keys small integers (fast Map lookups). Failure links are set in
 * breadth-first order (nodes sorted by depth), so a parent's link is set before its children's.
 */
function buildAutomaton(values: string[]): Automaton {
  const alphabet = new Int32Array(65536).fill(-1);
  let radix = 0;
  let capacity = 1;
  for (const value of values) {
    capacity += value.length;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (alphabet[code] < 0) alphabet[code] = radix++;
    }
  }
  radix = Math.max(radix, 1);
  const next = new Map<number, number>();
  const parent = new Int32Array(capacity);
  const symbolOf = new Int32Array(capacity);
  const depth = new Int32Array(capacity);
  const fail = new Int32Array(capacity);
  const output = new Int32Array(capacity).fill(-1);
  const dictionary = new Int32Array(capacity).fill(-1);
  let nodes = 1;
  let maxDepth = 0;
  values.forEach((value, index) => {
    if (!value) return;
    let node = 0;
    for (let i = 0; i < value.length; i++) {
      const symbol = alphabet[value.charCodeAt(i)];
      let child = next.get(node * radix + symbol);
      if (child === undefined) {
        child = nodes++;
        next.set(node * radix + symbol, child);
        parent[child] = node;
        symbolOf[child] = symbol;
        depth[child] = depth[node] + 1;
        if (depth[child] > maxDepth) maxDepth = depth[child];
      }
      node = child;
    }
    if (output[node] < 0) output[node] = index;
  });
  const byDepthStart = new Int32Array(maxDepth + 2);
  for (let node = 1; node < nodes; node++) byDepthStart[depth[node] + 1]++;
  for (let d = 1; d <= maxDepth + 1; d++) byDepthStart[d] += byDepthStart[d - 1];
  const order = new Int32Array(nodes);
  for (let node = 1; node < nodes; node++) order[byDepthStart[depth[node]]++] = node;
  for (let k = 0; k < nodes - 1; k++) {
    const node = order[k];
    const symbol = symbolOf[node];
    if (parent[node] !== 0) {
      let link = fail[parent[node]];
      while (link > 0 && !next.has(link * radix + symbol)) link = fail[link];
      fail[node] = next.get(link * radix + symbol) ?? 0;
    }
    dictionary[node] = output[fail[node]] >= 0 ? fail[node] : dictionary[fail[node]];
  }
  return { alphabet, radix, next, fail, depth, output, dictionary };
}

/**
 * Runs the automaton over the text and calls `visit(end, node)` at each position with the node of the longest value
 * ending there (a node whose `output` is set), or not at all when no value ends there.
 */
function scanAutomaton(automaton: Automaton, text: string, visit: (end: number, node: number) => boolean | void): void {
  const { alphabet, radix, next, fail, output, dictionary } = automaton;
  let node = 0;
  for (let i = 0; i < text.length; i++) {
    const symbol = alphabet[text.charCodeAt(i)];
    if (symbol < 0) {
      node = 0;
      continue;
    }
    while (node > 0 && !next.has(node * radix + symbol)) node = fail[node];
    node = next.get(node * radix + symbol) ?? 0;
    const found = output[node] >= 0 ? node : dictionary[node];
    if (found > 0 && visit(i + 1, found) === false) return;
  }
}

/**
 * Every occurrence (overlapping ones included) of each value, as [start, value index], or null when there are more than
 * `budget` of them. Few values: native search; many: one pass with an Aho-Corasick automaton.
 */
function findOccurrences(text: string, values: string[], budget: number): Array<[start: number, index: number]> | null {
  const occurrences: Array<[start: number, index: number]> = [];
  if (values.length <= 16) {
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (!value) continue;
      for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
        if (occurrences.push([at, index]) > budget) return null;
      }
    }
    return occurrences;
  }
  const automaton = buildAutomaton(values);
  let exceeded = false;
  scanAutomaton(automaton, text, (end, longest) => {
    for (let found = longest; found > 0; found = automaton.dictionary[found]) {
      if (occurrences.push([end - automaton.depth[found], automaton.output[found]]) > budget) {
        exceeded = true;
        return false;
      }
    }
  });
  return exceeded ? null : occurrences;
}

/**
 * Replaces every occurrence of each value, in one pass over the text: the same result as `replaceAll` for each value in
 * turn (values in priority order, longest first as classifyText returns them; text already replaced is not matched
 * again) unless two values overlap only partly (below), without one pass per value, which is quadratic for a text with thousands of distinct secrets. All occurrences
 * are found first; they are accepted in priority order unless they lie inside text already accepted (a Fenwick tree
 * counts accepted positions); the output is built once from the accepted spans. An occurrence that only partly overlaps
 * accepted text would leave its other part in clear: the union replacement below is used instead, which replaces every
 * part of every occurrence (the result then covers everything replaceAll in turn would, and more).
 *
 * Values that overlap themselves on a repetitive text (secrets that are suffixes of one another over a run of one
 * letter) can occur far more often than the text is long. Past one occurrence per character the replacement falls
 * back to a linear pass that replaces the union of all occurrences instead: each region where occurrences overlap is
 * replaced whole. Nothing that matches a value is left in clear.
 * `replacement(index, matched)` is called once for each distinct replaced text, in text order: `matched` is the exact
 * original text being replaced (the value itself, or a whole region in the fallback, where `index` is the longest value
 * in the region), so a reversible token keyed to `matched` restores the text exactly. Returns the new text.
 */
export function replaceValues(
  text: string,
  values: string[],
  replacement: (index: number, matched: string) => string
): string {
  if (values.length === 0 || text.length === 0) return text;
  const occurrences = findOccurrences(text, values, text.length + 1024);
  if (occurrences === null) return replaceUnion(text, values, replacement);
  if (occurrences.length === 0) return text;
  occurrences.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  const covered = new Int32Array(text.length + 1); // Fenwick tree over accepted positions
  const countBefore = (position: number): number => {
    let sum = 0;
    for (let i = position; i > 0; i -= i & -i) sum += covered[i];
    return sum;
  };
  const accepted: Array<[start: number, end: number, index: number]> = [];
  for (const [start, index] of occurrences) {
    const end = start + values[index].length;
    const overlap = countBefore(end) - countBefore(start);
    if (overlap === end - start) continue; // wholly inside text already accepted
    if (overlap !== 0) return replaceUnion(text, values, replacement); // partly inside: the rest of it must not stay in clear
    accepted.push([start, end, index]);
    for (let position = start + 1; position <= end; position++) {
      for (let i = position; i <= text.length; i += i & -i) covered[i]++;
    }
  }
  return buildReplaced(text, accepted, replacement);
}

/** The linear fallback of replaceValues: the union of all occurrences, each region replaced whole. */
function replaceUnion(
  text: string,
  values: string[],
  replacement: (index: number, matched: string) => string
): string {
  const automaton = buildAutomaton(values);
  // The longest value ending at each position covers every shorter one ending there (they are its suffixes).
  const spans: Array<[start: number, end: number, index: number]> = [];
  scanAutomaton(automaton, text, (end, longest) => {
    spans.push([end - automaton.depth[longest], end, automaton.output[longest]]);
  });
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const regions: Array<[start: number, end: number, index: number]> = [];
  for (const [start, end, index] of spans) {
    const last = regions[regions.length - 1];
    if (last && start < last[1]) {
      if (end > last[1]) last[1] = end;
      if (values[index].length > values[last[2]].length) last[2] = index;
    } else {
      regions.push([start, end, index]);
    }
  }
  return buildReplaced(text, regions, replacement);
}

/** Builds the text with the given non-overlapping spans replaced; `replacement` is called once per distinct text. */
function buildReplaced(
  text: string,
  spans: Array<[start: number, end: number, index: number]>,
  replacement: (index: number, matched: string) => string
): string {
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const replacements = new Map<string, string>();
  const parts: string[] = [];
  let from = 0;
  for (const [start, end, index] of spans) {
    const matched = text.slice(start, end);
    let replaced = replacements.get(matched);
    if (replaced === undefined) {
      replaced = replacement(index, matched);
      replacements.set(matched, replaced);
    }
    parts.push(text.slice(from, start), replaced);
    from = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** Irreversibly replaces every classified value in the text with its `[REDACTED:<pattern>]` label. */
function redactValues(text: string, classified: ClassifiedSecret[]): string {
  return replaceValues(text, classified.map((item) => item.secret), (index) =>
    `[REDACTED:${classified[index].patternName || "SECRET"}]`);
}

/**
 * InformationFlowBoundary: The authoritative egress interception & secret quarantine layer.
 */
export class InformationFlowBoundary {
  private static globalInstance?: InformationFlowBoundary;

  // Reversible token vault: token -> ReversibleTokenRecord
  private tokenVault: Map<string, ReversibleTokenRecord> = new Map();
  // Reverse lookup: secret -> token (scoped by taskId)
  private secretToTokenMap: Map<string, string> = new Map();

  private policy: EgressPolicy = {};

  // Deterministic secret patterns (DATA-002)
  private static DETERMINISTIC_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    // OpenAI / LLM API keys
    // The more specific Anthropic pattern first: at a tie between two matches of one key the first classifier names it.
    { name: "ANTHROPIC_API_KEY", regex: /\bsk-ant-[a-zA-Z0-9_\-]{20,64}\b/g },
    { name: "OPENAI_API_KEY", regex: /\bsk-[a-zA-Z0-9_\-]{20,64}\b/g },
    // GitHub Tokens (classic, fine-grained, oauth, user, server)
    { name: "GITHUB_TOKEN", regex: /\b(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{50,90}|gho_[a-zA-Z0-9]{36}|ghu_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36})\b/g },
    // Google API Key
    { name: "GOOGLE_API_KEY", regex: /\b(?:AIza[0-9A-Za-z-_]{30,36})\b/g },
    // HuggingFace Token
    { name: "HUGGINGFACE_TOKEN", regex: /\b(?:hf_[a-zA-Z0-9]{34})\b/g },
    // AWS Access Key ID
    { name: "AWS_ACCESS_KEY_ID", regex: /\b(?:AKIA[0-9A-Z]{16})\b/g },
    // Slack Tokens
    { name: "SLACK_TOKEN", regex: /\b(?:xox[baprs]-[0-9a-zA-Z]{10,48})\b/g },
    // Bearer tokens: RFC 6750 token68 (letters, digits, "-._~+/", "=" padding; a JSON-escaped `\/` counts as "/"),
    // not starting with "/"; the scheme name is case-insensitive (RFC 7235). A value with "/" is checked in
    // classifyText (`bearerTokenLength`): `Bearer /api/v1/x` and `Bearer api/v1/organizations` in ordinary text are
    // paths, not tokens.
    {
      name: "BEARER_AUTH_HEADER",
      regex: /\bBearer\s+([A-Za-z0-9_.~+-](?:[A-Za-z0-9_.~+\/-]|\\\/){15,}={0,2})/gi,
    },
    // Authorization header values, including Basic (base64 user:password) and provider Token schemes.
    { name: "AUTHORIZATION_HEADER", regex: /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:basic|bearer|token)\s+["']?((?:[A-Za-z0-9._~+/=-]|\\\/){8,})/gi },
    // JWT Tokens (3 base64url segments separated by dots)
    {
      name: "JWT_TOKEN",
      regex: /\b(?:eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g,
    },
    // Database URL / Connection String Credentials
    {
      name: "DATABASE_URL_PASSWORD",
      regex: /\b(?:[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^:\s\/]+:)([^@\s\/\\\\'"]{3,96})(?:@[^:\s\/]+)/g,
    },
    // PEM format private keys (RSA, EC, DSA, OPENSSH)
    {
      name: "PEM_PRIVATE_KEY",
      regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    },
  ];

  // Contextual key-value assignments (DATA-002, DATA-003: matches RHS value only, preserving variable names)
  private static CONTEXTUAL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    // A quoted value assigned to a credential-named key (`db_password = "…"`, `"apiKey": "…"`). The quotes are
    // required: unquoted right-hand sides are code (`password = process.env.DB_PASSWORD`, `password: Optional[str]`).
    {
      name: "KEY_VALUE_SECRET",
      regex: /\b[a-zA-Z0-9_-]{0,32}?(?:password|passwd|secret|api_key|apikey|access_token|private_key|auth_token|secret_key)["']?\s*[:=]\s*["']([^"'\s\\]{8,96})["']/gi,
    },
    // An unquoted value in an env-file style line: an upper-case credential-named variable at line start, not a
    // `$REFERENCE`, with nothing after the value.
    {
      name: "ENV_ASSIGNMENT_SECRET",
      regex: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)[A-Z0-9_]*=(?!\$)([^\s"'#()[\]]{8,96})[ \t]*$/gm,
    },
    {
      name: "AWS_SECRET_KEY_PAIR",
      regex: /\b(?:(?:aws_secret_access_key|secret_key)\s*[:=]\s*["']?)([a-zA-Z0-9/+=]{40})/gi,
    },
  ];

  constructor(policy?: EgressPolicy) {
    if (policy) {
      this.policy = policy;
    }
  }

  public static getGlobalInstance(): InformationFlowBoundary {
    if (!InformationFlowBoundary.globalInstance) {
      InformationFlowBoundary.globalInstance = new InformationFlowBoundary();
    }
    return InformationFlowBoundary.globalInstance;
  }

  public static setGlobalInstance(instance: InformationFlowBoundary): void {
    InformationFlowBoundary.globalInstance = instance;
  }

  public setPolicy(policy: EgressPolicy): void {
    this.policy = policy;
  }

  public getPolicy(): EgressPolicy {
    return this.policy;
  }

  /**
   * Values of credential-named environment variables, classified like operator-declared secrets. Reading the
   * environment is slow (each value is copied out of the process environment), so a caller classifying many strings
   * reads it once and passes the result to classifyText.
   */
  private environmentSecrets(): string[] {
    const envSecrets: string[] = [];
    const sensitiveEnvKeys = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "LOCAL_LLM_API_KEY",
      "NEXUS_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ];
    for (const [k, v] of Object.entries(process.env)) {
      // Short values, paths and plain flags/numbers are too common to replace wherever they appear.
      if (!v || typeof v !== "string" || v.length < 16 || /^[~/.]/.test(v) || /^(?:true|false|\d+)$/i.test(v)) continue;
      const upper = k.toUpperCase();
      if (
        sensitiveEnvKeys.includes(upper) ||
        upper.includes("API_KEY") ||
        upper.includes("SECRET") ||
        upper.includes("PASSWORD") ||
        upper.includes("AUTH_TOKEN") ||
        upper.includes("PRIVATE_KEY")
      ) {
        envSecrets.push(v);
      }
    }
    return envSecrets;
  }

  /**
   * Classify sensitive data within a text string (DATA-001, DATA-002, DATA-003, DATA-004).
   */
  public classifyText(text: string, envSecrets: string[] = this.environmentSecrets()): ClassifiedSecret[] {
    if (!text || typeof text !== "string") return [];

    // Every match with its place in the text; overlaps are resolved once all classifiers have run.
    const matches: PositionedMatch[] = [];
    const isReference = (value: string): boolean =>
      value.startsWith("[NEXUS_SEC_REF_") || value.startsWith("[SECRET_REF_") || value.startsWith("[REDACTED:");

    // 1. Explicit Operator Classifications (DATA-002: Category 1)
    const explicitList = [
      ...(this.policy.explicitSecrets || []),
      ...envSecrets,
    ];

    // One match per secret, at its first occurrence: redaction replaces the value wherever it occurs, and recording
    // every occurrence of short or self-overlapping secrets would grow with the text times the number of secrets.
    for (const explicit of explicitList) {
      if (!explicit) continue;
      const at = text.indexOf(explicit);
      if (at < 0) continue;
      matches.push({
        start: at,
        end: at + explicit.length,
        item: {
          secret: explicit,
          classificationType: "OPERATOR_EXPLICIT",
          classifierId: "operator:policy",
          confidence: 1.0,
          patternName: "EXPLICIT_SECRET",
        },
      });
    }

    // 2. Deterministic High-Confidence Patterns (DATA-002: Category 2)
    for (const { start, end, name } of text.includes("sk-") ? scanBase64Keys(text) : []) {
      matches.push({
        start,
        end,
        item: {
          secret: text.slice(start, end),
          classificationType: "PATTERN_DETERMINISTIC",
          classifierId: `regex:${name.toLowerCase()}`,
          confidence: 0.95,
          patternName: name,
        },
      });
    }
    for (const { name, regex } of InformationFlowBoundary.DETERMINISTIC_PATTERNS) {
      // Each pattern is a family with its own attempt counter: one pattern's keys cannot spend another's.
      const attempts = newExtensionAttempts();
      const re = new RegExp(regex.source, `${regex.flags}d`);
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        // If capture group exists (e.g. Bearer token), extract captured secret, else fullMatch
        const span = match.indices?.[match[1] && typeof match[1] === "string" ? 1 : 0];
        if (!span) continue;
        const [start, matchEnd] = span;
        // "bearer" in another case is also ordinary prose ("the bearer of"): its value must look like a token. An
        // Authorization header carrying it is matched by AUTHORIZATION_HEADER whatever the value.
        if (name === "BEARER_AUTH_HEADER" && !match[0].startsWith("Bearer") && !/[0-9A-Z+/=]/.test(text.slice(start, matchEnd))) {
          continue;
        }
        let end = name === "BEARER_AUTH_HEADER" ? start + bearerTokenLength(text.slice(start, matchEnd)) : matchEnd;
        while (end > start) {
          const ch = text.charCodeAt(end - 1);
          if (ch === 34 || ch === 39 || ch === 59 || ch === 44) { // ", ', ;, ,
            end--;
          } else {
            break;
          }
        }
        // The original match is kept; a dotted continuation is a second, longer match (never a replacement), so a
        // value found only by its shorter form (the key on its own elsewhere in the text) is still redacted.
        const ends = [end];
        if (DOTTED_CONTINUATION_PATTERNS.has(name)) {
          if (text[end] === "." && takeAttempt(attempts)) {
            const extended = extendDottedKey(text, end);
            if (extended > end) ends.push(extended);
          }
        }
        for (const spanEnd of ends) {
          const secretVal = text.slice(start, spanEnd);
          if (secretVal.length >= 8 && !isReference(secretVal)) {
            matches.push({
              start,
              end: spanEnd,
              item: {
                secret: secretVal,
                classificationType: "PATTERN_DETERMINISTIC",
                classifierId: `regex:${name.toLowerCase()}`,
                confidence: 0.95,
                patternName: name,
              },
            });
          }
        }
      }
    }

    // 3. Contextual / Heuristic Classifications (DATA-002: Category 3, DATA-003: Preserves LHS identifiers)
    // Every contextual pattern requires one of these literal key fragments.
    // Avoid the bounded identifier backtracking on large ordinary tool outputs;
    // matching texts still use the unchanged patterns and result ordering.
    const contextualPatterns = /password|passwd|secret|api_key|apikey|access_token|private_key|auth_token/i.test(text)
      ? InformationFlowBoundary.CONTEXTUAL_PATTERNS : [];
    for (const { name, regex } of contextualPatterns) {
      const re = new RegExp(regex.source, `${regex.flags}d`);
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        if (!match[1]) continue;
        const secretVal = trimTrailingDelimiters(match[1]);
        const start = match.indices?.[1]?.[0];
        if (start !== undefined && secretVal.length >= 8 && !isReference(secretVal)) {
          // Avoid matching obvious non-secrets / placeholders
          const lower = secretVal.toLowerCase();
          if (
            lower === "password" ||
            lower === "changeme" ||
            lower === "your_api_key_here" ||
            lower === "undefined" ||
            lower === "true" ||
            lower === "false" ||
            lower === "null" ||
            lower === "secret" ||
            lower === "not_set"
          ) {
            continue;
          }
          matches.push({
            start,
            end: start + secretVal.length,
            item: {
              secret: secretVal,
              classificationType: "CONTEXTUAL_HEURISTIC",
              classifierId: `heuristic:${name.toLowerCase()}`,
              confidence: 0.75,
              patternName: name,
            },
          });
        }
      }
    }

    // 4. High-Entropy Token Detection (DATA-002: Category 4 / DATA-004)
    // Check individual non-whitespace tokens length >= 20 with high Shannon entropy
    const originalTokens = new Set(text.split(/[\s,;'"()\[\]{}=:]+/));
    const tokenPattern = /[^\s,;'"()\[\]{}=:&?<>`|]+/g;
    let token: RegExpExecArray | null;
    while ((token = tokenPattern.exec(text)) !== null) {
      const start = token.index;
      // Trailing sentence punctuation is not part of the token. A backward scan: `/[.!]+$/` is quadratic on a long
      // run of dots, and checkpoint scans pass whole files through here.
      let end = start + token[0].length;
      while (end > start && (text[end - 1] === "." || text[end - 1] === "!")) end--;
      const tok = text.slice(start, end);
      const plain = normalizeKeyChars(unescapeSlashes(tok));
      // A token with an encoded or look-alike "/" or "+" is measured decoded; every other token keeps its own length.
      const length = plain.length !== unescapeSlashes(tok).length ? plain.length : tok.length;
      if (
        length >= 20 &&
        // Longer tokens are prose or data. A base64 run ("+" or "/", not a path) is still a secret up to 512 characters,
        // the size of long access tokens, unless it is a data-URI payload (`;base64,…`): then it is an embedded file.
        // A credential-sized token is classified wherever it stands, after `base64,` too.
        (length <= 128 ||
          (length <= 512 && /[+/]/.test(plain) && !isPathLike(plain) && !text.startsWith("base64,", start - 7))) &&
        // A token the original tokenizer did not produce must look like a credential, not an identifier or a path.
        (originalTokens.has(tok) || looksLikeCredentialToken(plain)) &&
        !isReference(tok)
      ) {
        // A dotted token must be dotted key material (`isDottedKeyMaterial`): file paths, versions and host names are not
        // tokens (JWTs have their own pattern above).
        // Nexus's own session ids (date, time and a short random suffix) are identifiers: about 1 in 70 looked high-entropy,
        // and a redacted id made the session impossible to save or resume.
        if ((/^[a-zA-Z0-9+/=_-]+$/.test(plain) || isDottedKeyMaterial(plain)) && !/^session_\d{8}_\d{6}_[a-z0-9]{1,8}$/.test(plain) &&
          // The temporary guard branch of `worktree remove` (`nexus-removed/<10 hex>-<8 hex>`): a redacted name cannot be undone by hand.
          !/^nexus-removed\/[0-9a-f]{10}-[0-9a-f]{8}$/.test(plain)) {
          const entropy = calculateShannonEntropy(plain);
          // Scaled entropy threshold: >= 4.0 for length 20-31, >= 4.5 for length >= 32
          const threshold = length < 32 ? 4.0 : 4.5;
          if (entropy >= threshold) {
            matches.push({
              start,
              end,
              item: {
                secret: tok,
                classificationType: "UNCERTAIN",
                classifierId: "entropy:shannon_token",
                confidence: 0.55,
                patternName: "HIGH_ENTROPY_STRING",
              },
            });
          }
        }
      }
    }

    return resolveOverlaps(matches);
  }

  /**
   * Irreversibly redact classified values from durable telemetry before it is written.
   * This uses the same DATA-001 classifier as egress protection and deliberately
   * does not create reversible vault references (DISC-005).
   */
  public redactForTelemetry<T>(value: T): T {
    return this.redactClassifiedValue(value);
  }

  /**
   * Irreversibly redact classified values from durable application state.
   * This preserves the accepted classifier and redaction semantics but does not
   * make the value recoverable as a credential store would.
   */
  public redactForDurablePersistence<T>(value: T): T {
    return this.redactClassifiedValue(value);
  }

  private redactClassifiedValue<T>(value: T): T {
    const envSecrets = this.environmentSecrets();
    // This cache lives only for one traversal, under one fresh environment and
    // policy snapshot. Repeated string values have identical classification;
    // the serialized context pass below remains mandatory and uncached.
    const redactedStrings = new Map<string, string>();
    const visit = (item: any): any => {
      if (typeof item === "string") {
        const cached = redactedStrings.get(item);
        if (cached !== undefined) return cached;
        const sanitized = redactValues(item, this.classifyText(item, envSecrets));
        redactedStrings.set(item, sanitized);
        return sanitized;
      }
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === "object") {
        const sanitized: Record<string, any> = {};
        for (const [key, nested] of Object.entries(item)) {
          sanitized[visit(key)] = visit(nested);
        }
        return sanitized;
      }
      return item;
    };

    const recursivelySanitized = visit(value);
    // Run the canonical classifier once over the serialized structure too. This
    // preserves contextual policies (for example, api_key=value) whose signal
    // spans an object key and its nested string value.
    const serialized = JSON.stringify(recursivelySanitized);
    if (serialized === undefined) throw new Error("Telemetry payload is not JSON serializable");
    const sanitizedSerialized = redactValues(serialized, this.classifyText(serialized, envSecrets));
    return JSON.parse(sanitizedSerialized) as T;
  }

  /**
   * Generates a cryptographically unguessable, task-scoped reference (REHYD-001, REHYD-002).
   */
  public generateToken(
    secret: string,
    taskId: string,
    sessionId: string,
    sourceBoundary: DestinationTrustBoundary,
    targetBoundary: DestinationTrustBoundary
  ): string {
    const scopeKey = `${taskId}:${secret}`;
    const existing = this.secretToTokenMap.get(scopeKey);
    if (existing) {
      return existing;
    }

    // 128 bits of cryptographic randomness (REHYD-001)
    const nonce = randomBytes(16).toString("hex");
    const token = `[NEXUS_SEC_REF_${nonce}]`;

    const record: ReversibleTokenRecord = {
      token,
      secret,
      taskId: taskId || "default_task",
      sessionId: sessionId || "default_session",
      sourceBoundary,
      targetBoundary,
      createdAt: Date.now(),
      rehydratedCount: 0,
    };

    this.tokenVault.set(token, record);
    this.secretToTokenMap.set(scopeKey, token);
    return token;
  }

  /**
   * Evaluates outbound payload against destination trust boundary (DEST-001, DEST-002, DISC-001..005, FAIL-003).
   */
  public evaluateEgress(
    payload: string | Record<string, any> | any[],
    destinationEndpointOrUrl?: string | null,
    context?: EgressEvaluationContext
  ): EgressEvaluationResult {
    // FAIL-CLOSED on simulated or internal failure (FAIL-003)
    if (context?.isSimulatedFailure) {
      return {
        allowed: false,
        destinationBoundary: "EXTERNAL_PUBLIC",
        transitionCrossesBoundary: true,
        quarantinedCount: 0,
        classifiedSecrets: [],
        reason: "Security Gate Violation [FAIL-003]: Simulated egress classification failure; failing closed.",
      };
    }

    try {
      const destBoundary = classifyDestination(destinationEndpointOrUrl, this.policy);
      const sourceBoundary = context?.sourceBoundary || "HOST_LOCAL";
      const crossesBoundary = isEgressTransition(sourceBoundary, destBoundary);

      // If within same high-trust boundary and no transition to external, allow without quarantine
      if (!crossesBoundary && destBoundary === "HOST_LOCAL") {
        return {
          allowed: true,
          destinationBoundary: destBoundary,
          transitionCrossesBoundary: false,
          quarantinedCount: 0,
          sanitizedPayload: payload,
          sanitizedText: typeof payload === "string" ? payload : JSON.stringify(payload),
          classifiedSecrets: [],
        };
      }

      // Convert payload to string for inspection
      const rawText = typeof payload === "string" ? payload : JSON.stringify(payload);
      const classifiedSecrets = this.classifyText(rawText);

      // If no secrets detected, allow
      if (classifiedSecrets.length === 0) {
        return {
          allowed: true,
          destinationBoundary: destBoundary,
          transitionCrossesBoundary: crossesBoundary,
          quarantinedCount: 0,
          sanitizedPayload: payload,
          sanitizedText: rawText,
          classifiedSecrets: [],
        };
      }

      // If secrets exist and disclosure is NOT explicitly authorized, apply protection (DISC-001)
      if (context?.disclosureAuthorized === true) {
        // Explicit disclosure authorized by policy
        return {
          allowed: true,
          destinationBoundary: destBoundary,
          transitionCrossesBoundary: crossesBoundary,
          quarantinedCount: 0,
          sanitizedPayload: payload,
          sanitizedText: rawText,
          classifiedSecrets,
        };
      }

      // Determine protection mode (DISC-005)
      const mode = context?.preferredProtectionMode || "REVERSIBLE_TOKENIZATION";

      const taskId = context?.taskId || "default_task";
      const sessionId = context?.sessionId || "default_session";

      const quarantinedSecrets: ClassifiedSecret[] = [];
      const sanitizedText = replaceValues(rawText, classifiedSecrets.map((item) => item.secret), (index, matched) => {
        // `matched` is the exact text replaced: the secret itself, or a whole region of overlapping secrets, so
        // the token restores exactly what it replaced.
        const item = matched === classifiedSecrets[index].secret
          ? classifiedSecrets[index]
          : { ...classifiedSecrets[index], secret: matched };
        quarantinedSecrets.push(item);
        if (mode === "IRREVERSIBLE_REDACTION") return `[REDACTED:${item.patternName || "SECRET"}]`;
        // ENCRYPTION (reversible encrypted token simulation) and REVERSIBLE_TOKENIZATION (the default) both tokenize.
        return this.generateToken(item.secret, taskId, sessionId, sourceBoundary, destBoundary);
      });
      const quarantinedCount = quarantinedSecrets.length;

      // Reconstruct payload in original format
      let sanitizedPayload: any = sanitizedText;
      if (typeof payload !== "string") {
        try {
          sanitizedPayload = JSON.parse(sanitizedText);
        } catch {
          sanitizedPayload = sanitizedText;
        }
      }

      return {
        allowed: true,
        destinationBoundary: destBoundary,
        transitionCrossesBoundary: crossesBoundary,
        quarantinedCount,
        sanitizedPayload,
        sanitizedText,
        classifiedSecrets,
        quarantinedSecrets,
      };
    } catch (err: any) {
      // Fail closed on unhandled error (FAIL-003)
      return {
        allowed: false,
        destinationBoundary: "EXTERNAL_PUBLIC",
        transitionCrossesBoundary: true,
        quarantinedCount: 0,
        classifiedSecrets: [],
        reason: `Egress Classification Failure [FAIL-003]: ${err?.message || "Internal error in egress evaluator"}. Failing closed.`,
      };
    }
  }

  /**
   * Rehydrates quarantined tokens for authorized local tool execution (REHYD-001..005, DISC-004).
   *
   * Invariants:
   * - Token possession alone != authority (REHYD-003). Requires isAuthorizedSink === true.
   * - Tokens are scoped to owning taskId (REHYD-002). Cross-task rehydration fails closed.
   * - Forged, stale, or unknown tokens remain completely inert (REHYD-005).
   */
  public rehydrate(
    payload: any,
    context: RehydrationContext
  ): RehydrationResult {
    let rehydratedCount = 0;
    let inertCount = 0;

    const serialize = (val: any): string => (typeof val === "string" ? val : JSON.stringify(val));
    const raw = serialize(payload);

    // Matches both [NEXUS_SEC_REF_<hex>] and legacy [SECRET_REF_<id>]
    const TOKEN_REGEX = /\[(?:NEXUS_SEC_REF_[a-f0-9]{32}|SECRET_REF_[a-zA-Z0-9_\-]+)\]/g;

    let restoredText = raw.replace(TOKEN_REGEX, (token) => {
      // Rule 1: Possession != Authority (REHYD-003)
      if (!context.isAuthorizedSink) {
        inertCount++;
        return token; // Inert
      }

      // Rule 2: Token must exist in vault (REHYD-005)
      const record = this.tokenVault.get(token);
      if (!record) {
        inertCount++;
        return token; // Inert
      }

      // Rule 3: Task & Session Scoping (REHYD-002, FINDING-WP05-001)
      // If the token is scoped to a taskId, rehydration context MUST supply the matching taskId
      if (record.taskId && (!context.taskId || record.taskId !== context.taskId)) {
        inertCount++;
        return token; // Cross-task or un-scoped token remains inert
      }

      // If the token is scoped to a sessionId, rehydration context cannot mismatch
      if (record.sessionId && context.sessionId && record.sessionId !== context.sessionId) {
        inertCount++;
        return token; // Cross-session token remains inert
      }

      // Authorized Rehydration
      record.rehydratedCount++;
      rehydratedCount++;
      return record.secret;
    });

    let rehydratedPayload: any = restoredText;
    if (typeof payload !== "string") {
      try {
        rehydratedPayload = JSON.parse(restoredText);
      } catch {
        rehydratedPayload = restoredText;
      }
    }

    return {
      rehydrated: rehydratedPayload,
      rehydratedCount,
      inertCount,
    };
  }

  /**
   * Directly registers a token mapping in the vault (used by SecretsVault migration).
   */
  public registerToken(record: ReversibleTokenRecord): void {
    this.tokenVault.set(record.token, record);
    this.secretToTokenMap.set(`${record.taskId}:${record.secret}`, record.token);
  }

  public getTokenRecord(token: string): ReversibleTokenRecord | undefined {
    return this.tokenVault.get(token);
  }

  public getVaultSize(): number {
    return this.tokenVault.size;
  }

  public clear(): void {
    this.tokenVault.clear();
    this.secretToTokenMap.clear();
  }
}
