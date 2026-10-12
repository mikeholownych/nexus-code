import { randomBytes } from "node:crypto";
import { URL } from "node:url";
/**
 * Numeric trust rank ordering (Higher number = Higher trust).
 */
const TRUST_RANKS = {
    HOST_LOCAL: 4,
    LOCAL_APPLIANCE: 3,
    EXTERNAL_BOUNDED: 2,
    EXTERNAL_PUBLIC: 1,
};
/**
 * Classify endpoint or URL into an authoritative DestinationTrustBoundary (DEST-001).
 */
export function classifyDestination(endpointOrUrl, policy) {
    if (!endpointOrUrl || endpointOrUrl === "local" || endpointOrUrl === "host" || endpointOrUrl === "in-memory") {
        return "HOST_LOCAL";
    }
    const trimmed = endpointOrUrl.trim();
    if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("file:") || trimmed.startsWith("unix:")) {
        return "HOST_LOCAL";
    }
    let parsed;
    try {
        parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `http://${trimmed}`);
    }
    catch {
        return "EXTERNAL_PUBLIC";
    }
    const host = parsed.hostname.toLowerCase();
    // Localhost loopback
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
        return "LOCAL_APPLIANCE";
    }
    // Private RFC 1918 addresses & .local mDNS
    if (host.endsWith(".local") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) {
        return "LOCAL_APPLIANCE";
    }
    // Enterprise bounded domains from policy
    if (policy?.boundedDomains && policy.boundedDomains.length > 0) {
        for (const bd of policy.boundedDomains) {
            const bdl = bd.toLowerCase();
            if (host === bdl || host.endsWith("." + bdl)) {
                return "EXTERNAL_BOUNDED";
            }
        }
    }
    return "EXTERNAL_PUBLIC";
}
/**
 * Returns true if moving from source to dest constitutes an egress transition (DEST-002).
 */
export function isEgressTransition(source, dest) {
    if (dest === "EXTERNAL_PUBLIC" || dest === "EXTERNAL_BOUNDED") {
        return true;
    }
    return TRUST_RANKS[dest] < TRUST_RANKS[source];
}
/**
 * Shannon entropy calculation for high-entropy secret detection.
 */
export function calculateShannonEntropy(str) {
    if (!str)
        return 0;
    const len = str.length;
    const frequencies = new Map();
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
/**
 * InformationFlowBoundary: The authoritative egress interception & secret quarantine layer.
 */
export class InformationFlowBoundary {
    static globalInstance;
    // Reversible token vault: token -> ReversibleTokenRecord
    tokenVault = new Map();
    // Reverse lookup: secret -> token (scoped by taskId)
    secretToTokenMap = new Map();
    policy = {};
    // Deterministic secret patterns (DATA-002)
    static DETERMINISTIC_PATTERNS = [
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
    static CONTEXTUAL_PATTERNS = [
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
    constructor(policy) {
        if (policy) {
            this.policy = policy;
        }
    }
    static getGlobalInstance() {
        if (!InformationFlowBoundary.globalInstance) {
            InformationFlowBoundary.globalInstance = new InformationFlowBoundary();
        }
        return InformationFlowBoundary.globalInstance;
    }
    static setGlobalInstance(instance) {
        InformationFlowBoundary.globalInstance = instance;
    }
    setPolicy(policy) {
        this.policy = policy;
    }
    getPolicy() {
        return this.policy;
    }
    /**
     * Values of credential-named environment variables, classified like operator-declared secrets. Reading the
     * environment is slow (each value is copied out of the process environment), so a caller classifying many strings
     * reads it once and passes the result to classifyText.
     */
    environmentSecrets() {
        const envSecrets = [];
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
            if (!v || typeof v !== "string" || v.length < 16 || /^[~/.]/.test(v) || /^(?:true|false|\d+)$/i.test(v))
                continue;
            const upper = k.toUpperCase();
            if (sensitiveEnvKeys.includes(upper) ||
                upper.includes("API_KEY") ||
                upper.includes("SECRET") ||
                upper.includes("PASSWORD") ||
                upper.includes("AUTH_TOKEN") ||
                upper.includes("PRIVATE_KEY")) {
                envSecrets.push(v);
            }
        }
        return envSecrets;
    }
    /**
     * Classify sensitive data within a text string (DATA-001, DATA-002, DATA-003, DATA-004).
     */
    classifyText(text, envSecrets = this.environmentSecrets()) {
        if (!text || typeof text !== "string")
            return [];
        const classified = [];
        const seenSecrets = new Set();
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
            let match;
            while ((match = re.exec(text)) !== null) {
                const fullMatch = match[0];
                // If capture group exists (e.g. Bearer token), extract captured secret, else fullMatch
                let secretVal = match[1] && typeof match[1] === "string" ? match[1] : fullMatch;
                secretVal = secretVal.replace(/["';,]+$/, "");
                if (secretVal.length >= 8 &&
                    !secretVal.startsWith("[NEXUS_SEC_REF_") &&
                    !secretVal.startsWith("[SECRET_REF_") &&
                    !secretVal.startsWith("[REDACTED:") &&
                    !seenSecrets.has(secretVal)) {
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
        for (const { name, regex } of InformationFlowBoundary.CONTEXTUAL_PATTERNS) {
            const re = new RegExp(regex.source, regex.flags);
            let match;
            while ((match = re.exec(text)) !== null) {
                let secretVal = match[1];
                if (!secretVal)
                    continue;
                secretVal = secretVal.replace(/["';,]+$/, "");
                if (secretVal.length >= 8 &&
                    !secretVal.startsWith("[NEXUS_SEC_REF_") &&
                    !secretVal.startsWith("[SECRET_REF_") &&
                    !secretVal.startsWith("[REDACTED:") &&
                    !seenSecrets.has(secretVal)) {
                    // Avoid matching obvious non-secrets / placeholders
                    const lower = secretVal.toLowerCase();
                    if (lower === "password" ||
                        lower === "changeme" ||
                        lower === "your_api_key_here" ||
                        lower === "undefined" ||
                        lower === "true" ||
                        lower === "false" ||
                        lower === "null" ||
                        lower === "secret" ||
                        lower === "not_set") {
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
            if (tok.length >= 20 &&
                tok.length <= 128 &&
                !tok.startsWith("[NEXUS_SEC_REF_") &&
                !tok.startsWith("[SECRET_REF_") &&
                !tok.startsWith("[REDACTED:") &&
                !seenSecrets.has(tok)) {
                // No dots: file paths and dotted names are not tokens (JWTs have their own pattern above).
                if (/^[a-zA-Z0-9+/=_-]+$/.test(tok)) {
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
    redactForTelemetry(value) {
        return this.redactClassifiedValue(value);
    }
    /**
     * Irreversibly redact classified values from durable application state.
     * This preserves the accepted classifier and redaction semantics but does not
     * make the value recoverable as a credential store would.
     */
    redactForDurablePersistence(value) {
        return this.redactClassifiedValue(value);
    }
    redactClassifiedValue(value) {
        const envSecrets = this.environmentSecrets();
        const visit = (item) => {
            if (typeof item === "string") {
                let sanitized = item;
                for (const secret of this.classifyText(item, envSecrets)) {
                    sanitized = sanitized.replaceAll(secret.secret, `[REDACTED:${secret.patternName || "SECRET"}]`);
                }
                return sanitized;
            }
            if (Array.isArray(item))
                return item.map(visit);
            if (item && typeof item === "object") {
                const sanitized = {};
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
        if (serialized === undefined)
            throw new Error("Telemetry payload is not JSON serializable");
        let sanitizedSerialized = serialized;
        for (const secret of this.classifyText(serialized, envSecrets)) {
            sanitizedSerialized = sanitizedSerialized.replaceAll(secret.secret, `[REDACTED:${secret.patternName || "SECRET"}]`);
        }
        return JSON.parse(sanitizedSerialized);
    }
    /**
     * Generates a cryptographically unguessable, task-scoped reference (REHYD-001, REHYD-002).
     */
    generateToken(secret, taskId, sessionId, sourceBoundary, targetBoundary) {
        const scopeKey = `${taskId}:${secret}`;
        const existing = this.secretToTokenMap.get(scopeKey);
        if (existing) {
            return existing;
        }
        // 128 bits of cryptographic randomness (REHYD-001)
        const nonce = randomBytes(16).toString("hex");
        const token = `[NEXUS_SEC_REF_${nonce}]`;
        const record = {
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
    evaluateEgress(payload, destinationEndpointOrUrl, context) {
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
                if (!sanitizedText.includes(secret))
                    continue;
                let replacement;
                if (mode === "IRREVERSIBLE_REDACTION") {
                    replacement = `[REDACTED:${item.patternName || "SECRET"}]`;
                }
                else if (mode === "ENCRYPTION") {
                    // Reversible encrypted token simulation
                    replacement = this.generateToken(secret, taskId, sessionId, sourceBoundary, destBoundary);
                }
                else {
                    // REVERSIBLE_TOKENIZATION (Default)
                    replacement = this.generateToken(secret, taskId, sessionId, sourceBoundary, destBoundary);
                }
                sanitizedText = sanitizedText.replaceAll(secret, replacement);
                quarantinedCount++;
            }
            // Reconstruct payload in original format
            let sanitizedPayload = sanitizedText;
            if (typeof payload !== "string") {
                try {
                    sanitizedPayload = JSON.parse(sanitizedText);
                }
                catch {
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
        }
        catch (err) {
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
    rehydrate(payload, context) {
        let rehydratedCount = 0;
        let inertCount = 0;
        const serialize = (val) => (typeof val === "string" ? val : JSON.stringify(val));
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
        let rehydratedPayload = restoredText;
        if (typeof payload !== "string") {
            try {
                rehydratedPayload = JSON.parse(restoredText);
            }
            catch {
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
    registerToken(record) {
        this.tokenVault.set(record.token, record);
        this.secretToTokenMap.set(`${record.taskId}:${record.secret}`, record.token);
    }
    getTokenRecord(token) {
        return this.tokenVault.get(token);
    }
    getVaultSize() {
        return this.tokenVault.size;
    }
    clear() {
        this.tokenVault.clear();
        this.secretToTokenMap.clear();
    }
}
