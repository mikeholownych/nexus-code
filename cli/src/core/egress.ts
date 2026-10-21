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
      return { boundary: "EXTERNAL_PUBLIC", reason: "hostname_external" };
    }
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
        const a = (lower >>> 24) & 0xff;
        const b = (lower >>> 16) & 0xff;
        if (a === 127) {
          return { boundary: "LOCAL_APPLIANCE", reason: "loopback_ip" };
        }
        if (
          a === 10 ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) ||
          (a === 169 && b === 254)
        ) {
          return { boundary: "LOCAL_APPLIANCE", reason: "private_ip" };
        }
        if (a === 100 && b >= 64 && b <= 127) {
          return { boundary: "LOCAL_APPLIANCE", reason: "cgnat_ip" };
        }
        return { boundary: "EXTERNAL_PUBLIC", reason: "hostname_external" };
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
    { name: "OPENAI_API_KEY", regex: /\b(?:sk-[a-zA-Z0-9_\-]{20,64})\b/g },
    // Anthropic API keys
    { name: "ANTHROPIC_API_KEY", regex: /\b(?:sk-ant-[a-zA-Z0-9_\-]{20,64})\b/g },
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
    // Bearer / Authorization tokens
    { name: "BEARER_AUTH_HEADER", regex: /\bBearer\s+([a-zA-Z0-9_\-\.]{16,128})/g },
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

    const classified: ClassifiedSecret[] = [];
    const seenSecrets = new Set<string>();

    // 1. Explicit Operator Classifications (DATA-002: Category 1)
    const explicitList = [
      ...(this.policy.explicitSecrets || []),
      ...envSecrets,
    ];

    for (const explicit of explicitList) {
      if (explicit && text.includes(explicit) && !seenSecrets.has(explicit)) {
        seenSecrets.add(explicit);
        classified.push({
          secret: explicit,
          classificationType: "OPERATOR_EXPLICIT",
          classifierId: "operator:policy",
          confidence: 1.0,
          patternName: "EXPLICIT_SECRET",
        });
      }
    }

    // 2. Deterministic High-Confidence Patterns (DATA-002: Category 2)
    for (const { name, regex } of InformationFlowBoundary.DETERMINISTIC_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const fullMatch = match[0];
        // If capture group exists (e.g. Bearer token), extract captured secret, else fullMatch
        let secretVal = match[1] && typeof match[1] === "string" ? match[1] : fullMatch;
        let trimEnd = secretVal.length;
        while (trimEnd > 0) {
          const ch = secretVal.charCodeAt(trimEnd - 1);
          if (ch === 34 || ch === 39 || ch === 59 || ch === 44) { // ", ', ;, ,
            trimEnd--;
          } else {
            break;
          }
        }
        if (trimEnd < secretVal.length) {
          secretVal = secretVal.slice(0, trimEnd);
        }
        if (
          secretVal.length >= 8 &&
          !secretVal.startsWith("[NEXUS_SEC_REF_") &&
          !secretVal.startsWith("[SECRET_REF_") &&
          !secretVal.startsWith("[REDACTED:") &&
          !seenSecrets.has(secretVal)
        ) {
          seenSecrets.add(secretVal);
          classified.push({
            secret: secretVal,
            classificationType: "PATTERN_DETERMINISTIC",
            classifierId: `regex:${name.toLowerCase()}`,
            confidence: 0.95,
            patternName: name,
          });
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
      const re = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        let secretVal = match[1];
        if (!secretVal) continue;
        secretVal = trimTrailingDelimiters(secretVal);
        if (
          secretVal.length >= 8 &&
          !secretVal.startsWith("[NEXUS_SEC_REF_") &&
          !secretVal.startsWith("[SECRET_REF_") &&
          !secretVal.startsWith("[REDACTED:") &&
          !seenSecrets.has(secretVal)
        ) {
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
          seenSecrets.add(secretVal);
          classified.push({
            secret: secretVal,
            classificationType: "CONTEXTUAL_HEURISTIC",
            classifierId: `heuristic:${name.toLowerCase()}`,
            confidence: 0.75,
            patternName: name,
          });
        }
      }
    }

    // 4. High-Entropy Token Detection (DATA-002: Category 4 / DATA-004)
    // Check individual non-whitespace tokens length >= 20 with high Shannon entropy
    const tokens = text.split(/[\s,;'"()\[\]{}=:]+/);
    for (const tok of tokens) {
      if (
        tok.length >= 20 &&
        tok.length <= 128 &&
        !tok.startsWith("[NEXUS_SEC_REF_") &&
        !tok.startsWith("[SECRET_REF_") &&
        !tok.startsWith("[REDACTED:") &&
        !seenSecrets.has(tok)
      ) {
        // No dots: file paths and dotted names are not tokens (JWTs have their own pattern above). Nexus's own session
        // ids (date, time and a short random suffix) are identifiers: about 1 in 70 looked high-entropy, and a redacted
        // id made the session impossible to save or resume.
        if (/^[a-zA-Z0-9+/=_-]+$/.test(tok) && !/^session_\d{8}_\d{6}_[a-z0-9]{1,8}$/.test(tok)) {
          const entropy = calculateShannonEntropy(tok);
          // Scaled entropy threshold: >= 4.0 for length 20-31, >= 4.5 for length >= 32
          const threshold = tok.length < 32 ? 4.0 : 4.5;
          if (entropy >= threshold) {
            seenSecrets.add(tok);
            classified.push({
              secret: tok,
              classificationType: "UNCERTAIN",
              classifierId: "entropy:shannon_token",
              confidence: 0.55,
              patternName: "HIGH_ENTROPY_STRING",
            });
          }
        }
      }
    }

    return classified;
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
        let sanitized = item;
        for (const secret of this.classifyText(item, envSecrets)) {
          sanitized = sanitized.replaceAll(secret.secret, `[REDACTED:${secret.patternName || "SECRET"}]`);
        }
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
    let sanitizedSerialized = serialized;
    for (const secret of this.classifyText(serialized, envSecrets)) {
      sanitizedSerialized = sanitizedSerialized.replaceAll(secret.secret, `[REDACTED:${secret.patternName || "SECRET"}]`);
    }
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
      let sanitizedText = rawText;
      let quarantinedCount = 0;

      const taskId = context?.taskId || "default_task";
      const sessionId = context?.sessionId || "default_session";

      for (const item of classifiedSecrets) {
        const secret = item.secret;
        if (!sanitizedText.includes(secret)) continue;

        let replacement: string;
        if (mode === "IRREVERSIBLE_REDACTION") {
          replacement = `[REDACTED:${item.patternName || "SECRET"}]`;
        } else if (mode === "ENCRYPTION") {
          // Reversible encrypted token simulation
          replacement = this.generateToken(secret, taskId, sessionId, sourceBoundary, destBoundary);
        } else {
          // REVERSIBLE_TOKENIZATION (Default)
          replacement = this.generateToken(secret, taskId, sessionId, sourceBoundary, destBoundary);
        }

        sanitizedText = sanitizedText.replaceAll(secret, replacement);
        quarantinedCount++;
      }

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
