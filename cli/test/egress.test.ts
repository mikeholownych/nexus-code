/**
 * WP-05 / INC-06: Sensitive-Data Egress Interception & Secret Quarantine Test Suite
 * Requirements:
 * - DATA-001, DATA-002, DATA-004 (Classification, Confidence, Patterns, Shannon Entropy)
 * - DEST-001, DEST-002 (Destination Trust Hierarchy & Transition Enforcement)
 * - DISC-001, DISC-002, DISC-003, DISC-005 (Resource Authority != Disclosure Authority, Egress Interception, Protection Modes)
 * - REHYD-001, REHYD-002, REHYD-003, REHYD-005 (Unguessable Tokens, Task/Session Scoping, Possession != Authority, Inertness)
 * - FAIL-003 (Fail-Closed Classifier & Egress Behavior)
 * - CTX-006 (Route Fallback Re-Admission)
 * - TEST-003 (Dynamic Mock Transport Capture Verifying 0 Plaintext Synthetic Secrets Over The Wire)
 */

import { describe, test, after, beforeEach } from "node:test";
import assert from "node:assert";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  InformationFlowBoundary,
  classifyDestination,
  classifyLocality,
  isEgressTransition,
  calculateShannonEntropy,
  DestinationTrustBoundary,
  SecretClassificationType,
} from "../src/core/egress.js";
import { LocalLlmClient } from "../src/client.js";
import { SecretsVault } from "../src/security.js";
import { McpClientManager } from "../src/mcp.js";
import { RustCoreBridge } from "../src/tools.js";

describe("WP-05: Sensitive-Data Egress Interception & Secret Quarantine (INC-06)", () => {
  let boundary: InformationFlowBoundary;

  beforeEach(() => {
    boundary = new InformationFlowBoundary();
  });

  after(() => {
    McpClientManager.shutdownAllGlobal();
    RustCoreBridge.shutdownAllGlobal();
  });

  // ==========================================================================
  // 1. DATA-001, DATA-002, DATA-004: Sensitive Data Classification & Scanning
  // ==========================================================================
  describe("DATA-001, DATA-002, DATA-004: Formal Classification & Detection", () => {
    test("DATA-002: Classifies into formal categories with normative confidence levels", () => {
      const explicitPolicy = { explicitSecrets: ["MY_CUSTOM_OPERATOR_SECRET_12345"] };
      const customBoundary = new InformationFlowBoundary(explicitPolicy);

      const payload = `
        Operator explicit: MY_CUSTOM_OPERATOR_SECRET_12345
        Deterministic pattern: sk-proj-abcdef1234567890abcdef1234567890abcdef
        Contextual heuristic: api_key = "SuperSecretTokenValue12345!"
      `;

      const secrets = customBoundary.classifyText(payload);
      assert.ok(secrets.length >= 3, `Expected at least 3 classified items, got ${secrets.length}`);

      const explicitItem = secrets.find((s) => s.classificationType === "OPERATOR_EXPLICIT");
      assert.ok(explicitItem, "OPERATOR_EXPLICIT classification not found");
      assert.strictEqual(explicitItem.confidence, 1.0);
      assert.strictEqual(explicitItem.secret, "MY_CUSTOM_OPERATOR_SECRET_12345");

      const deterministicItem = secrets.find((s) => s.classificationType === "PATTERN_DETERMINISTIC");
      assert.ok(deterministicItem, "PATTERN_DETERMINISTIC classification not found");
      assert.strictEqual(deterministicItem.confidence, 0.95);
      assert.strictEqual(deterministicItem.secret, "sk-proj-abcdef1234567890abcdef1234567890abcdef");

      const contextualItem = secrets.find((s) => s.classificationType === "CONTEXTUAL_HEURISTIC");
      assert.ok(contextualItem, "CONTEXTUAL_HEURISTIC classification not found");
      assert.strictEqual(contextualItem.confidence, 0.75);
    });

    test("DATA-001: Detects vendor credentials, tokens, bearer headers, and PEM keys", () => {
      const samplePemKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3vV4k8t...fake...pem...body...content...
-----END RSA PRIVATE KEY-----`;

      const text = `
        Anthropic key: sk-ant-api03-abcdef1234567890abcdef1234567890abcdef
        GitHub PAT: ghp_1234567890abcdef1234567890abcdef1234
        AWS Key: AKIAIOSFODNN7EXAMPLE
        Bearer auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDc
        Google key: AIzaSyD-1234567890abcdef12345678901234
        HuggingFace token: hf_1234567890abcdef1234567890abcdef12
        PEM Key:
        ${samplePemKey}
      `;

      const secrets = boundary.classifyText(text);
      const matchedSecrets = secrets.map((s) => s.secret);

      assert.ok(matchedSecrets.some((s) => s.startsWith("sk-ant-")));
      assert.ok(matchedSecrets.some((s) => s.startsWith("ghp_")));
      assert.ok(matchedSecrets.some((s) => s.startsWith("AKIA")));
      assert.ok(matchedSecrets.some((s) => s.startsWith("eyJhbGci") || s.startsWith("Bearer ")));
      assert.ok(matchedSecrets.some((s) => s.startsWith("AIza")));
      assert.ok(matchedSecrets.some((s) => s.startsWith("hf_")));
      assert.ok(matchedSecrets.some((s) => s.includes("BEGIN RSA PRIVATE KEY")));
    });

    test("DATA-003: Preserves code identifiers and matches RHS values only", () => {
      const codeSnippet = `
        const passwordInput = document.getElementById("passwordInput");
        const userApiKey = "actual_secret_value_12345_qwerty";
      `;

      const secrets = boundary.classifyText(codeSnippet);
      const matchedSecrets = secrets.map((s) => s.secret);

      // LHS identifier passwordInput must NOT be classified as secret
      assert.ok(!matchedSecrets.includes("passwordInput"));
      // RHS secret value MUST be classified
      assert.ok(matchedSecrets.includes("actual_secret_value_12345_qwerty"));
    });

    test("DATA-004: Calculates Shannon entropy and flags high-entropy random secrets", () => {
      const lowEntropy = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 0 entropy
      const naturalEnglish = "The cat sat on the mat and then sat on the rug"; // ~3.4
      const highEntropyBase64 = "4fA8zK1x9qLmP3wV7tY0bE5rC2uI8oNs"; // > 4.6

      assert.strictEqual(calculateShannonEntropy(lowEntropy), 0);
      assert.ok(calculateShannonEntropy(naturalEnglish) < 4.0);
      assert.ok(calculateShannonEntropy(highEntropyBase64) >= 4.5);

      const payload = `Entropy test: ${highEntropyBase64}`;
      const secrets = boundary.classifyText(payload);
      assert.ok(secrets.some((s) => s.secret === highEntropyBase64 && s.classificationType === "UNCERTAIN"));
    });

    test("DATA-004: Detects 20-31 character high-entropy tokens (FINDING-WP05-002)", () => {
      // 24-character random base64 string with high entropy
      const random24 = "4fA8zK1x9qLmP3wV7tY0bE5r";
      const payload = `Token: ${random24}`;
      const secrets = boundary.classifyText(payload);
      assert.ok(secrets.some((s) => s.secret === random24 && s.classificationType === "UNCERTAIN"));
    });
  });

  // ==========================================================================
  // 2. DEST-001, DEST-002: Destination Trust Boundaries & Transitions
  // ==========================================================================
  describe("DEST-001, DEST-002: Destination Classification & Boundary Crossing", () => {
    test("DEST-001: Correctly classifies destinations into the 4 trust ranks", () => {
      // HOST_LOCAL
      assert.strictEqual(classifyDestination("local"), "HOST_LOCAL");
      assert.strictEqual(classifyDestination("/tmp/local-socket.sock"), "HOST_LOCAL");
      assert.strictEqual(classifyDestination("file:///workspace/repo"), "HOST_LOCAL");
      assert.strictEqual(classifyDestination("unix:///var/run/docker.sock"), "HOST_LOCAL");

      // LOCAL_APPLIANCE
      assert.strictEqual(classifyDestination("http://localhost:8000/v1"), "LOCAL_APPLIANCE");
      assert.strictEqual(classifyDestination("http://127.0.0.1:11434"), "LOCAL_APPLIANCE");
      assert.strictEqual(classifyDestination("http://192.168.1.50:8080"), "LOCAL_APPLIANCE");
      assert.strictEqual(classifyDestination("http://10.0.0.15:5000"), "LOCAL_APPLIANCE");
      // .local hostnames are external unless in NEXUS_LOCAL_ORIGINS (REQ-SEC-111, PRV-02)
      assert.strictEqual(classifyDestination("http://vllm.local:8000"), "EXTERNAL_PUBLIC");
      assert.strictEqual(classifyDestination("http://vllm.local:8000", undefined, { localOrigins: ["vllm.local"] }), "LOCAL_APPLIANCE");

      // EXTERNAL_BOUNDED
      const policy = { boundedDomains: ["internal-corp.net", "partner-api.com"] };
      assert.strictEqual(classifyDestination("https://llm.internal-corp.net/v1", policy), "EXTERNAL_BOUNDED");
      assert.strictEqual(classifyDestination("https://partner-api.com/predict", policy), "EXTERNAL_BOUNDED");

      // EXTERNAL_PUBLIC
      assert.strictEqual(classifyDestination("https://api.openai.com/v1"), "EXTERNAL_PUBLIC");
      assert.strictEqual(classifyDestination("https://api.anthropic.com/v1"), "EXTERNAL_PUBLIC");
      assert.strictEqual(classifyDestination("https://example.com"), "EXTERNAL_PUBLIC");
    });

    test("DEST-002: Transition enforcement detects lower-trust crossing", () => {
      // Transition from higher to lower trust constitutes egress
      assert.strictEqual(isEgressTransition("HOST_LOCAL", "LOCAL_APPLIANCE"), true);
      assert.strictEqual(isEgressTransition("HOST_LOCAL", "EXTERNAL_BOUNDED"), true);
      assert.strictEqual(isEgressTransition("HOST_LOCAL", "EXTERNAL_PUBLIC"), true);
      assert.strictEqual(isEgressTransition("LOCAL_APPLIANCE", "EXTERNAL_PUBLIC"), true);

      // Remaining within HOST_LOCAL is not egress
      assert.strictEqual(isEgressTransition("HOST_LOCAL", "HOST_LOCAL"), false);
      // Upward transition is not egress
      assert.strictEqual(isEgressTransition("EXTERNAL_PUBLIC", "HOST_LOCAL"), false);
    });

    // ACC-TRUST-02 (REQ-SEC-111): CIDR-based locality classification table
    test("ACC-TRUST-02: CIDR classification table, reason codes, and operator origins", () => {
      // 10.attacker.example and 192.168.evil.com -> external
      const att1 = classifyLocality("http://10.attacker.example/v1");
      assert.strictEqual(att1.boundary, "EXTERNAL_PUBLIC");
      assert.strictEqual(att1.reason, "hostname_external");

      const att2 = classifyLocality("http://192.168.evil.com/v1");
      assert.strictEqual(att2.boundary, "EXTERNAL_PUBLIC");
      assert.strictEqual(att2.reason, "hostname_external");

      // 10.0.0.5 -> local (private_ip)
      const priv1 = classifyLocality("http://10.0.0.5:8000");
      assert.strictEqual(priv1.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(priv1.reason, "private_ip");

      // 192.168.1.2 -> local (private_ip)
      const priv2 = classifyLocality("http://192.168.1.2:8000");
      assert.strictEqual(priv2.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(priv2.reason, "private_ip");

      // 127.0.0.2 -> local (loopback_ip)
      const loop = classifyLocality("http://127.0.0.2:8000");
      assert.strictEqual(loop.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(loop.reason, "loopback_ip");

      // 100.101.102.103 -> local (cgnat_ip)
      const cgnat = classifyLocality("http://100.101.102.103:8000");
      assert.strictEqual(cgnat.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(cgnat.reason, "cgnat_ip");

      // [fd00::1] -> local (ula_ip)
      const ula = classifyLocality("http://[fd00::1]:8000");
      assert.strictEqual(ula.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(ula.reason, "ula_ip");

      // gpubox -> external unless in NEXUS_LOCAL_ORIGINS
      const gpuDef = classifyLocality("http://gpubox:8000");
      assert.strictEqual(gpuDef.boundary, "EXTERNAL_PUBLIC");
      assert.strictEqual(gpuDef.reason, "hostname_external");

      const gpuLocal = classifyLocality("http://gpubox:8000", undefined, { localOrigins: ["gpubox"] });
      assert.strictEqual(gpuLocal.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(gpuLocal.reason, "operator_local_origin");

      // operator-configured endpoint match
      const opEndpoint = classifyLocality("http://my-lan-server:8000/v1", undefined, {
        operatorEndpoint: "http://my-lan-server:8000/v1",
      });
      assert.strictEqual(opEndpoint.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(opEndpoint.reason, "operator_endpoint");

      // IPv4-mapped IPv6 literals unwrapped
      const v4mapLoop = classifyLocality("http://[::ffff:127.0.0.1]:8000");
      assert.strictEqual(v4mapLoop.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(v4mapLoop.reason, "loopback_ip");

      const v4mapPriv = classifyLocality("http://[::ffff:10.0.0.1]:8000");
      assert.strictEqual(v4mapPriv.boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(v4mapPriv.reason, "private_ip");

      // NAT64 well-known prefix 64:ff9b::/96 embeds the destination IPv4 in the low 32 bits.
      assert.deepStrictEqual(classifyLocality("http://[64:ff9b::7f00:1]:8000"), {
        boundary: "LOCAL_APPLIANCE",
        reason: "loopback_ip",
      });
      assert.strictEqual(classifyLocality("http://[64:ff9b::a00:1]").boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(classifyLocality("http://[64:ff9b::c0a8:1]").boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(classifyLocality("http://[64:ff9b::808:808]").boundary, "EXTERNAL_PUBLIC");

      // NAT64 local-use prefix 64:ff9b:1::/48 is not globally reachable.
      assert.strictEqual(classifyLocality("http://[64:ff9b:1::7f00:1]").boundary, "LOCAL_APPLIANCE");
      assert.strictEqual(classifyLocality("http://[64:ff9b:1::808:808]").boundary, "LOCAL_APPLIANCE");
    });
  });

  // ==========================================================================
  // 3. DISC-001, DISC-002, DISC-005: Protection Modes & Invariants
  // ==========================================================================
  describe("DISC-001, DISC-002, DISC-005: Disclosure Invariants & Protection Modes", () => {
    test("DISC-001: Resource authority does not confer disclosure authority", () => {
      // An actor can legitimately read a secret locally, but outbound egress without
      // disclosureAuthorized=true MUST quarantine the secret
      const secret = "ghp_1234567890abcdef1234567890abcdef1234";
      const payload = { prompt: `Deploy repository using ${secret}` };

      // Normal egress without explicit disclosure authorization
      const result = boundary.evaluateEgress(payload, "https://api.openai.com/v1", {
        taskId: "task-001",
        disclosureAuthorized: false,
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.quarantinedCount, 1);
      assert.ok(!JSON.stringify(result.sanitizedPayload).includes(secret));
      assert.match(JSON.stringify(result.sanitizedPayload), /\[NEXUS_SEC_REF_[a-f0-9]{32}\]/);
    });

    test("DISC-005: Supports IRREVERSIBLE_REDACTION mode permanently destroying plaintext", () => {
      const secret = "sk-ant-api03-abcdef1234567890abcdef1234567890abcdef";
      const payload = `Log event: user connected with ${secret}`;

      const result = boundary.evaluateEgress(payload, "EXTERNAL_PUBLIC", {
        preferredProtectionMode: "IRREVERSIBLE_REDACTION",
      });

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.quarantinedCount, 1);
      assert.ok(!result.sanitizedText!.includes(secret));
      assert.ok(result.sanitizedText!.includes("[REDACTED:"));

      // Rehydration attempt on irreversible redaction remains inert
      const rehydrated = boundary.rehydrate(result.sanitizedText, {
        taskId: "task-001",
        isAuthorizedSink: true,
      });
      assert.strictEqual(rehydrated.rehydratedCount, 0);
      assert.ok(!String(rehydrated.rehydrated).includes(secret));
    });
  });

  // ==========================================================================
  // 4. REHYD-001..005: Unguessable Scoped References & Rehydration Security
  // ==========================================================================
  describe("REHYD-001..005: Unguessable Scoped References & Anti-Forgery", () => {
    test("REHYD-001: Reference tokens are cryptographically unguessable nonces (prohibiting sequential integers)", () => {
      const secret1 = "sk-proj-token111111111111111111111111111111";
      const secret2 = "sk-proj-token222222222222222222222222222222";

      const token1 = boundary.generateToken(secret1, "task-1", "session-1", "HOST_LOCAL", "EXTERNAL_PUBLIC");
      const token2 = boundary.generateToken(secret2, "task-1", "session-1", "HOST_LOCAL", "EXTERNAL_PUBLIC");

      // Verify format [NEXUS_SEC_REF_<32 hex chars>]
      assert.match(token1, /^\[NEXUS_SEC_REF_[a-f0-9]{32}\]$/);
      assert.match(token2, /^\[NEXUS_SEC_REF_[a-f0-9]{32}\]$/);

      // Verify tokens are non-sequential and distinct
      assert.notStrictEqual(token1, token2);
      assert.ok(!token1.includes("SECRET_REF_1"));
      assert.ok(!token2.includes("SECRET_REF_2"));
    });

    test("REHYD-002: Tokens are strictly scoped to owning taskId (cross-task fails closed)", () => {
      const secret = "ghp_1234567890abcdef1234567890abcdef1234";
      const result = boundary.evaluateEgress(`Authorization: ${secret}`, "EXTERNAL_PUBLIC", {
        taskId: "task-alpha",
        sessionId: "session-1",
      });

      const tokenized = result.sanitizedText!;
      assert.ok(!tokenized.includes(secret));

      // Attempt 1: Rehydrate from the correct owning task -> SUCCESS
      const validRehydration = boundary.rehydrate(tokenized, {
        taskId: "task-alpha",
        isAuthorizedSink: true,
      });
      assert.strictEqual(validRehydration.rehydratedCount, 1);
      assert.strictEqual(validRehydration.inertCount, 0);
      assert.ok(validRehydration.rehydrated.includes(secret));

      // Attempt 2: Rehydrate from a DIFFERENT task -> FAILS CLOSED (remains inert)
      const invalidRehydration = boundary.rehydrate(tokenized, {
        taskId: "task-bravo", // Different task
        isAuthorizedSink: true,
      });
      assert.strictEqual(invalidRehydration.rehydratedCount, 0);
      assert.strictEqual(invalidRehydration.inertCount, 1);
      assert.ok(!invalidRehydration.rehydrated.includes(secret));
      assert.ok(invalidRehydration.rehydrated.includes("[NEXUS_SEC_REF_"));

      // Attempt 3: Rehydrate with missing/empty taskId -> FAILS CLOSED (FINDING-WP05-001)
      const emptyTaskRehydration = boundary.rehydrate(tokenized, {
        taskId: "", // Empty taskId
        isAuthorizedSink: true,
      });
      assert.strictEqual(emptyTaskRehydration.rehydratedCount, 0);
      assert.strictEqual(emptyTaskRehydration.inertCount, 1);
      assert.ok(!emptyTaskRehydration.rehydrated.includes(secret));
      assert.ok(emptyTaskRehydration.rehydrated.includes("[NEXUS_SEC_REF_"));
    });

    test("REHYD-003: Possession alone != authority (isAuthorizedSink=false leaves tokens inert)", () => {
      const secret = "AKIAIOSFODNN7EXAMPLE";
      const result = boundary.evaluateEgress(`Key: ${secret}`, "EXTERNAL_PUBLIC", {
        taskId: "task-001",
      });
      const tokenized = result.sanitizedText!;

      // Possession of token, but sink is NOT authorized (e.g. outbound network dispatch)
      const unauthorizedRehydration = boundary.rehydrate(tokenized, {
        taskId: "task-001",
        isAuthorizedSink: false, // Unauthorized sink!
      });

      assert.strictEqual(unauthorizedRehydration.rehydratedCount, 0);
      assert.strictEqual(unauthorizedRehydration.inertCount, 1);
      assert.ok(!unauthorizedRehydration.rehydrated.includes(secret));
    });

    test("REHYD-005: Forged, stale, or unknown tokens remain completely inert", () => {
      const forgedToken = "[NEXUS_SEC_REF_00112233445566778899aabbccddeeff]";
      const legacyForged = "[SECRET_REF_9999]";

      const res1 = boundary.rehydrate(`Command: curl -H "Token: ${forgedToken}"`, {
        taskId: "task-001",
        isAuthorizedSink: true,
      });
      assert.strictEqual(res1.rehydratedCount, 0);
      assert.strictEqual(res1.inertCount, 1);
      assert.strictEqual(res1.rehydrated, `Command: curl -H "Token: ${forgedToken}"`);

      const res2 = boundary.rehydrate(`Command: curl -H "Token: ${legacyForged}"`, {
        taskId: "task-001",
        isAuthorizedSink: true,
      });
      assert.strictEqual(res2.rehydratedCount, 0);
      assert.strictEqual(res2.inertCount, 1);
      assert.strictEqual(res2.rehydrated, `Command: curl -H "Token: ${legacyForged}"`);
    });
  });

  // ==========================================================================
  // 5. FAIL-003: Fail-Closed Classifier & Egress Behavior
  // ==========================================================================
  describe("FAIL-003: Fail-Closed Behavior on Failure", () => {
    test("FAIL-003: Simulated classifier failure fails closed and blocks egress", () => {
      const payload = { prompt: "Hello world with sk-proj-1234567890abcdef1234567890abcdef" };

      const result = boundary.evaluateEgress(payload, "EXTERNAL_PUBLIC", {
        taskId: "task-fail",
        isSimulatedFailure: true,
      });

      assert.strictEqual(result.allowed, false);
      assert.match(result.reason!, /FAIL-003/);
      assert.match(result.reason!, /failing closed/i);
    });

    test("FAIL-003: LocalLlmClient fails closed and refuses dispatch if egress evaluation fails", async () => {
      const client = new LocalLlmClient({
        model: "mock-model",
        endpoint: "http://127.0.0.1:8000",
      });

      // Inject a boundary that simulates classifier failure
      const failingBoundary = new InformationFlowBoundary();
      client.setBoundary(failingBoundary);

      // Force simulated failure on the boundary
      const origEvaluate = failingBoundary.evaluateEgress.bind(failingBoundary);
      failingBoundary.evaluateEgress = (payload, dest, ctx) => {
        return origEvaluate(payload, dest, { ...ctx, isSimulatedFailure: true });
      };

      await assert.rejects(
        async () => {
          await client.chatCompletion(
            [{ role: "user", content: "Prompt containing sk-proj-1234567890abcdef1234567890abcdef" }],
            []
          );
        },
        /FAIL-003/
      );
    });
  });

  // ==========================================================================
  // 6. CTX-006: Route Fallback Trust Re-Admission
  // ==========================================================================
  describe("CTX-006: Route Fallback Trust Re-Admission", () => {
    test("CTX-006: Fallback switching from high-trust to low-trust endpoint re-evaluates egress", async () => {
      const syntheticSecret = "sk-proj-fallbacksecret1234567890abcdef123456";
      let capturedPayloadOnBackup: string | null = null;

      // 1. Create a primary endpoint that is unavailable (503: refused without executing, so failover is safe)
      const primaryServer = http.createServer((_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Local vLLM unavailable" }));
      });

      // 2. Create a backup public endpoint that captures the payload
      const backupServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          capturedPayloadOnBackup = body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chat-backup",
              choices: [{ index: 0, message: { role: "assistant", content: "Response from backup" }, finish_reason: "stop" }],
            })
          );
        });
      });

      await new Promise<void>((r) => primaryServer.listen(0, "127.0.0.1", () => r()));
      await new Promise<void>((r) => backupServer.listen(0, "127.0.0.1", () => r()));

      const pPort = (primaryServer.address() as AddressInfo).port;
      const bPort = (backupServer.address() as AddressInfo).port;

      const primaryEp = `http://127.0.0.1:${pPort}`;
      const backupEp = `http://127.0.0.1:${bPort}`;

      try {
        const client = new LocalLlmClient({
          model: "test-model",
          endpoint: primaryEp,
          fallbackEndpoints: [backupEp],
        });
        client.setTaskId("task-fallback-test");

        const response = await client.chatCompletion(
          [{ role: "user", content: `Please review secret: ${syntheticSecret}` }],
          []
        );

        assert.strictEqual(response.content, "Response from backup");
        assert.ok(capturedPayloadOnBackup, "Backup server was never called");

        // The captured body on backup MUST NOT contain the synthetic secret in plaintext!
        assert.ok(!capturedPayloadOnBackup!.includes(syntheticSecret), "Plaintext secret leaked to backup endpoint!");
        assert.match(capturedPayloadOnBackup!, /\[NEXUS_SEC_REF_[a-f0-9]{32}\]/);
      } finally {
        primaryServer.close();
        backupServer.close();
      }
    });
  });

  // ==========================================================================
  // 7. TEST-003: Dynamic Transport Capture Proving 0 Synthetic Secrets Over Wire
  // ==========================================================================
  describe("TEST-003: Dynamic Transport Capture Verification", () => {
    test("TEST-003: Outbound chatCompletion transmits 0 synthetic secrets in serialized HTTP body", async () => {
      const syntheticSecrets = [
        "sk-proj-test003secret1234567890abcdef123456",
        "ghp_test003githubpat1234567890abcdef1234",
        "Bearer eyJhbGciOiJIUzI1NiJ9.test003payload.signature12345",
      ];

      let capturedHttpBody: string | null = null;
      let capturedHeaders: http.IncomingHttpHeaders | null = null;

      const captureServer = http.createServer((req, res) => {
        capturedHeaders = req.headers;
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          capturedHttpBody = body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "test-003-resp",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Understood." },
                  finish_reason: "stop",
                },
              ],
            })
          );
        });
      });

      await new Promise<void>((r) => captureServer.listen(0, "127.0.0.1", () => r()));
      const port = (captureServer.address() as AddressInfo).port;
      const endpoint = `http://127.0.0.1:${port}`;

      try {
        const client = new LocalLlmClient({
          model: "test-model",
          endpoint,
        });
        client.setTaskId("task-test-003");

        const prompt = `
          Here are system credentials:
          API Key: ${syntheticSecrets[0]}
          GitHub Token: ${syntheticSecrets[1]}
          Auth Header: ${syntheticSecrets[2]}
        `;

        await client.chatCompletion([{ role: "user", content: prompt }], []);

        assert.ok(capturedHttpBody, "Capture server received no HTTP body");

        // Verify that NONE of the synthetic secrets appear in the serialized body
        for (const secret of syntheticSecrets) {
          assert.strictEqual(
            capturedHttpBody!.includes(secret),
            false,
            `Synthetic secret '${secret}' leaked in serialized HTTP body!`
          );
        }

        // Verify tokens were substituted
        const tokenMatches = capturedHttpBody!.match(/\[NEXUS_SEC_REF_[a-f0-9]{32}\]/g);
        assert.ok(tokenMatches && tokenMatches.length >= 3, `Expected at least 3 tokens, found ${tokenMatches?.length}`);
      } finally {
        captureServer.close();
      }
    });

    test("TEST-003: Outbound chatCompletionStream transmits 0 synthetic secrets in serialized HTTP body", async () => {
      const syntheticSecret = "sk-ant-api03-test003streamsecret1234567890abcdef1234";
      let capturedBody: string | null = null;

      const captureServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          capturedBody = body;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write('data: {"choices":[{"delta":{"content":"Chunk 1"}}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });

      await new Promise<void>((r) => captureServer.listen(0, "127.0.0.1", () => r()));
      const port = (captureServer.address() as AddressInfo).port;
      const endpoint = `http://127.0.0.1:${port}`;

      try {
        const client = new LocalLlmClient({
          model: "test-model",
          endpoint,
        });
        client.setTaskId("task-test-003-stream");

        await client.chatCompletionStream(
          [{ role: "user", content: `Stream prompt with ${syntheticSecret}` }],
          []
        );

        assert.ok(capturedBody, "Capture server received no stream body");
        assert.strictEqual(capturedBody!.includes(syntheticSecret), false, "Secret leaked in stream body!");
        assert.match(capturedBody!, /\[NEXUS_SEC_REF_[a-f0-9]{32}\]/);
      } finally {
        captureServer.close();
      }
    });

    test("TEST-003: Outbound generateEmbedding transmits 0 synthetic secrets in serialized HTTP body (FINDING-WP05-004)", async () => {
      const syntheticSecret = "sk-proj-embeddingsecret1234567890abcdef123456";
      let capturedBody: string | null = null;

      const captureServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          capturedBody = body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
            })
          );
        });
      });

      await new Promise<void>((r) => captureServer.listen(0, "127.0.0.1", () => r()));
      const port = (captureServer.address() as AddressInfo).port;
      const endpoint = `http://127.0.0.1:${port}`;

      try {
        const client = new LocalLlmClient({
          model: "test-model",
          endpoint,
        });
        client.setTaskId("task-test-003-embedding");

        await client.generateEmbedding(`Input text containing ${syntheticSecret}`);

        assert.ok(capturedBody, "Capture server received no embedding body");
        assert.strictEqual(capturedBody!.includes(syntheticSecret), false, "Secret leaked in embedding body!");
        assert.match(capturedBody!, /\[NEXUS_SEC_REF_[a-f0-9]{32}\]/);
      } finally {
        captureServer.close();
      }
    });
  });

  // ==========================================================================
  // 8. Adversarial Token Attacks: Guessing, Forging, Replaying
  // ==========================================================================
  describe("Adversarial Attacks on References and Authority", () => {
    test("Token guessing attack: brute force random tokens find 0 matches", () => {
      // Register 10 legitimate tokens
      for (let i = 0; i < 10; i++) {
        boundary.generateToken(`secret-${i}`, "task-guess", "session-1", "HOST_LOCAL", "EXTERNAL_PUBLIC");
      }

      // Generate 1000 random tokens and attempt rehydration
      let successfulGuesses = 0;
      for (let i = 0; i < 1000; i++) {
        const randomHex = Math.random().toString(16).substring(2).padEnd(32, "0");
        const guess = `[NEXUS_SEC_REF_${randomHex}]`;
        const result = boundary.rehydrate(guess, {
          taskId: "task-guess",
          isAuthorizedSink: true,
        });
        if (result.rehydratedCount > 0) {
          successfulGuesses++;
        }
      }

      assert.strictEqual(successfulGuesses, 0, "Adversarial token guessing succeeded!");
    });

    test("Authority attack: Full-access execution authority does NOT bypass disclosure interception", () => {
      // Even if an agent runs with fullAccess: true, egress interception is NOT bypassed
      const secret = "sk-proj-fullaccesssecret1234567890abcdef123456";
      const payload = { code: `console.log("${secret}");` };

      const egressResult = boundary.evaluateEgress(payload, "EXTERNAL_PUBLIC", {
        taskId: "task-full-access",
        actor: "agent",
        disclosureAuthorized: false, // Full access != disclosure authority
      });

      assert.strictEqual(egressResult.allowed, true);
      assert.strictEqual(egressResult.quarantinedCount, 1);
      assert.ok(!JSON.stringify(egressResult.sanitizedPayload).includes(secret));
    });
  });
});

describe("authorization header schemes", () => {
  test("Basic and Token credentials are classified and redacted", () => {
    const boundary = new InformationFlowBoundary();
    const basic = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const token = "authorization=Token abcdefghijklmnop";
    const redactedBasic = boundary.redactForTelemetry(basic);
    const redactedToken = boundary.redactForTelemetry(token);
    assert.ok(!redactedBasic.includes("dXNlcjpwYXNzd29yZA=="), redactedBasic);
    assert.ok(!redactedToken.includes("abcdefghijklmnop"), redactedToken);
    assert.match(redactedBasic, /\[REDACTED:AUTHORIZATION_HEADER\]/);

    const structured = boundary.redactForTelemetry({ headers: { authorization: "Basic dXNlcjpwYXNzd29yZA==" } });
    assert.ok(!JSON.stringify(structured).includes("dXNlcjpwYXNzd29yZA=="), JSON.stringify(structured));
    const quoted = boundary.redactForTelemetry('Authorization: Basic "dXNlcjpwYXNzd29yZA=="');
    assert.ok(!quoted.includes("dXNlcjpwYXNzd29yZA=="), quoted);
  });
});

describe("environment-declared secrets", () => {
  test("a redaction pass over many strings reads the environment once, and still redacts its secrets", () => {
    const original = process.env;
    let enumerations = 0;
    process.env = new Proxy({ ...original, NEXUS_TEST_API_KEY: "env-secret-value-0123" }, {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    }) as NodeJS.ProcessEnv;
    try {
      const payload = { messages: Array.from({ length: 2000 }, (_, i) => ({ role: "tool", content: `line ${i}` })), note: "uses env-secret-value-0123" };
      const redacted = new InformationFlowBoundary().redactForTelemetry(payload);
      assert.ok(enumerations <= 1, `the environment was enumerated ${enumerations} times`);
      assert.ok(!JSON.stringify(redacted).includes("env-secret-value-0123"), "the environment secret is redacted");
    } finally {
      process.env = original;
    }
  });
});

describe("contextual secrets in code", () => {
  test("code that names a credential is left intact; quoted values and env-file values are classified", () => {
    const boundary = new InformationFlowBoundary();
    const code = [
      "password = process.env.DB_PASSWORD",
      'secret = os.environ["X"]',
      'auth = require("./auth")',
      "password: Optional[str]",
      "self.auth_token = self._generate_token()",
      "const apiKey = config.apiKey;",
    ].join("\n");
    assert.deepEqual(boundary.classifyText(code).filter((s) => s.classificationType !== "UNCERTAIN").map((s) => s.secret), [], "no code is classified");
    const secrets = [
      'db_password = "hunter2-correct-horse"',
      '{"apiKey": "k3y-v4lue-0123456789"}',
      "DATABASE_PASSWORD=plain-env-value-42",
      "export STRIPE_SECRET=whsec_live_value_99",
    ].join("\n");
    const found = boundary.classifyText(secrets).map((s) => s.secret);
    for (const value of ["hunter2-correct-horse", "k3y-v4lue-0123456789", "plain-env-value-42", "whsec_live_value_99"]) {
      assert.ok(found.includes(value), `${value} is classified: ${JSON.stringify(found)}`);
    }
    assert.ok(!boundary.classifyText("API_KEY=$OTHER_VARIABLE_NAME").some((s) => s.patternName === "ENV_ASSIGNMENT_SECRET"), "a reference is not a value");
  });

  test("trailing quote, semicolon and comma delimiters are stripped from a contextual value", () => {
    const boundary = new InformationFlowBoundary();
    const found = boundary.classifyText("DATABASE_PASSWORD=plain-env-value-42;;,").map((s) => s.secret);
    assert.ok(found.includes("plain-env-value-42"), JSON.stringify(found));
    assert.ok(!found.some((s) => /[;,]$/.test(s)), JSON.stringify(found));
  });
});

describe("paths are not secrets", () => {
  test("workspace and worktree paths are not classified as high-entropy tokens", () => {
    const boundary = new InformationFlowBoundary();
    for (const p of ["/tmp/nexus-journey-x7Hq2a/.nexus/worktrees/task_20261012_223700_ab12cd", "/home/mike/.nexus/worktrees/task-mk8f2x9q1-7f3a9c2b/src/index.ts"]) {
      assert.deepEqual(boundary.classifyText(p), [], p);
    }
  });
});

describe("Nexus identifiers are not secrets", () => {
  test("generated session ids are never classified, while a real high-entropy token still is", async () => {
    const { SessionManager } = await import("../src/session.js");
    const generate = SessionManager.prototype.generateSessionId;
    const boundary = new InformationFlowBoundary();
    const RealDate = Date;
    try {
      // Sessions are created at any time of any day: vary the clock the generator reads.
      for (let i = 0; i < 5000; i++) {
        const at = new RealDate(2026, i % 12, 1 + (i % 28), (i * 7) % 24, (i * 13) % 60, (i * 17) % 60);
        (globalThis as any).Date = class extends RealDate {
          constructor() {
            super(at.getTime());
          }
        };
        const id = generate.call({});
        assert.deepEqual(boundary.classifyText(id), [], id);
      }
    } finally {
      (globalThis as any).Date = RealDate;
    }
    assert.ok(boundary.classifyText("token Zx9Qp2Lm7Rt4Vb8Nc1Kd6Hs3Jf5Gw0Ya").length > 0, "a random token is still flagged");
  });
});
