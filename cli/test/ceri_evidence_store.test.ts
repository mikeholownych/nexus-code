import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CeriEvidenceStore } from "../src/ceri/evidence_store.js";
import type { RunManifest } from "../src/ceri/contracts.js";

test("CeriEvidenceStore initializes run, appends events, redacts secrets, and computes integrity hash", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-evidence-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const manifest: RunManifest = {
      runId: "run-001",
      evaluationId: "eval-ast",
      evaluationVersion: "1.0.0",
      sourceCommit: "abcd1234abcd1234abcd1234abcd1234abcd1234",
      dirtyWorktree: false,
      model: {
        name: "test-model",
        parameters: { temperature: 0.0 },
      },
      routingConfig: {
        gatewayUrl: "http://localhost:9200",
        specialistRouting: true,
      },
      agentProfileVersion: "1.1.2",
      harnessVersion: "1.1.2",
      toolchainVersions: { node: "22.0.0" },
      environment: { os: "Linux", kernel: "6.8.0", nodeVersion: "22.0.0" },
      hardware: { cpuModel: "Intel", totalMemoryBytes: 32000000000 },
      startedAt: new Date().toISOString(),
      status: "RUNNING",
      mandatoryComparabilityKeys: ["evaluationId", "evaluationVersion", "model.name"],
    };

    const runDir = store.initRun(manifest);
    assert.ok(fs.existsSync(path.join(runDir, "manifest.json")));

    // Append event with a secret
    store.appendEvent({
      action: "call_tool",
      apiKey: "sk-ant-api03-abcdef1234567890abcdef1234567890",
      payload: "safe data",
    });

    // Record assertions
    store.recordAssertions([{ assertionId: "a1", passed: true }]);

    // Finalize run
    const finalized = store.finalizeRun("COMPLETED", "All checks passed");
    assert.ok(finalized.integrityHash);
    assert.equal(finalized.runDir, runDir);

    // Verify secrets are redacted in events.jsonl
    const eventsContent = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8");
    assert.ok(!eventsContent.includes("sk-ant-api03"));
    assert.ok(eventsContent.includes("[REDACTED"));

    // Verify integrity.json was written
    const integrityContent = JSON.parse(
      fs.readFileSync(path.join(runDir, "integrity.json"), "utf-8")
    );
    assert.equal(integrityContent.compositeSha256, finalized.integrityHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvidenceStore detects interrupted runs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-interrupted-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const manifest: RunManifest = {
      runId: "run-crashed",
      evaluationId: "eval-crash",
      evaluationVersion: "1.0.0",
      sourceCommit: "abcd",
      dirtyWorktree: false,
      model: { name: "model-x", parameters: { temperature: 0 } },
      routingConfig: { gatewayUrl: "http://localhost", specialistRouting: false },
      agentProfileVersion: "1.1.2",
      harnessVersion: "1.1.2",
      toolchainVersions: {},
      environment: { os: "Linux", kernel: "x", nodeVersion: "22" },
      hardware: { cpuModel: "Intel", totalMemoryBytes: 1000 },
      startedAt: new Date().toISOString(),
      status: "RUNNING",
      mandatoryComparabilityKeys: [],
    };

    store.initRun(manifest);
    // Simulate process crash: finalizeRun is NOT called

    const interrupted = store.detectInterruptedRuns();
    assert.deepEqual(interrupted, ["run-crashed"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvidenceStore rejects path traversal in evaluationId and runId", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-traversal-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);

    const baseManifest: RunManifest = {
      runId: "run-01",
      evaluationId: "eval-01",
      evaluationVersion: "1.0.0",
      sourceCommit: "abcd",
      dirtyWorktree: false,
      model: { name: "model-x", parameters: { temperature: 0 } },
      routingConfig: { gatewayUrl: "http://localhost", specialistRouting: false },
      agentProfileVersion: "1.1.2",
      harnessVersion: "1.1.2-rc.1",
      toolchainVersions: {},
      environment: { os: "Linux", kernel: "x", nodeVersion: "22" },
      hardware: { cpuModel: "Intel", totalMemoryBytes: 1000 },
      startedAt: new Date().toISOString(),
      status: "RUNNING",
      mandatoryComparabilityKeys: [],
    };

    assert.throws(
      () => store.initRun({ ...baseManifest, evaluationId: "../../etc" }),
      /contains invalid characters or path traversal elements/
    );

    assert.throws(
      () => store.initRun({ ...baseManifest, runId: "sub/../../escape" }),
      /contains invalid characters or path traversal elements/
    );

    // "." would collapse into the parent directory (a run written into the evaluation directory itself).
    assert.throws(
      () => store.initRun({ ...baseManifest, runId: "." }),
      /contains invalid characters or path traversal elements/
    );
    assert.throws(
      () => store.initRun({ ...baseManifest, evaluationId: " . " }),
      /contains invalid characters or path traversal elements/
    );

    assert.throws(
      () => store.loadAssertions("../etc", "run-01"),
      /contains invalid characters or path traversal elements/
    );

    assert.throws(
      () => store.loadManifest("eval-01", "../escape"),
      /contains invalid characters or path traversal elements/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvidenceStore redacts by key name: an unregistered credential value never reaches events.jsonl or an artifact", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-evidence-keys-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);
    const runDir = store.initRun({
      runId: "run-002", evaluationId: "eval-keys", evaluationVersion: "1.0.0", sourceCommit: "abcd1234abcd1234abcd1234abcd1234abcd1234", dirtyWorktree: false,
      model: { name: "m", parameters: {} }, routingConfig: { gatewayUrl: "http://localhost:9200", specialistRouting: false }, agentProfileVersion: "1.1.2", harnessVersion: "1.1.2",
      toolchainVersions: {}, environment: { os: "Linux", kernel: "6", nodeVersion: "22" }, hardware: { cpuModel: "x", totalMemoryBytes: 1 }, startedAt: new Date().toISOString(), status: "RUNNING",
      mandatoryComparabilityKeys: ["evaluationId"],
    } as RunManifest);
    store.appendEvent({ action: "call", apiKey: "abcdef1234567890", nested: { password: "hunter2hunter2", session_token: 1234567890, tokens: { input: 12, output: 3 } }, note: "kept" });
    store.recordAssertions([{ assertionId: "a1", passed: true, authorization: "abcdef1234567890", clientSecret: "zzzzzz987654" }]);
    store.recordReceipts([{ id: "r1", detail: { api_key: "qqqqqq123456" } }]);

    const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8");
    const assertions = fs.readFileSync(path.join(runDir, "assertions.json"), "utf-8");
    const receipts = fs.readFileSync(path.join(runDir, "receipts.json"), "utf-8");
    for (const [text, secrets] of [[events, ["abcdef1234567890", "hunter2hunter2", "1234567890"]], [assertions, ["abcdef1234567890", "zzzzzz987654"]], [receipts, ["qqqqqq123456"]]] as const) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} leaked`);
    }
    const event = JSON.parse(events.trim());
    assert.equal(event.note, "kept");
    assert.deepEqual(event.nested.tokens, { input: 12, output: 3 }, "usage counters are not credentials");
    assert.equal(JSON.parse(assertions)[0].passed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CeriEvidenceStore redacts whole values under credential keys and keeps count-like keys, on events.jsonl and artifacts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ceri-evidence-words-"));
  try {
    const store = new CeriEvidenceStore(tmpDir);
    const runDir = store.initRun({
      runId: "run-003", evaluationId: "eval-words", evaluationVersion: "1.0.0", sourceCommit: "abcd1234abcd1234abcd1234abcd1234abcd1234", dirtyWorktree: false,
      model: { name: "m", parameters: {} }, routingConfig: { gatewayUrl: "http://localhost:9200", specialistRouting: false }, agentProfileVersion: "1.1.2", harnessVersion: "1.1.2",
      toolchainVersions: {}, environment: { os: "Linux", kernel: "6", nodeVersion: "22" }, hardware: { cpuModel: "x", totalMemoryBytes: 1 }, startedAt: new Date().toISOString(), status: "RUNNING",
      mandatoryComparabilityKeys: ["evaluationId"],
    } as RunManifest);
    const secrets: Record<string, unknown> = {
      apiKey: ["LEAK-array-1"], api_key: "LEAK-snake", "api-key": "LEAK-kebab", access_token: "LEAK-access", token: { value: "LEAK-object" },
      password: "LEAK-pw", passwd: "LEAK-passwd", secret: "LEAK-secret", secrets: ["LEAK-secrets"], credentials: { user: "LEAK-cred" }, credential: "LEAK-cred1",
      authorization: "LEAK-authz", auth: "LEAK-auth", cookie: "LEAK-cookie", cookies: "LEAK-cookies", bearer: "LEAK-bearer", jwt: "LEAK-jwt", private_key: "LEAK-pk", privateKey: "LEAK-pk2",
      // Concatenated or split spellings of the same credential names.
      accesstoken: "LEAK-c1", refreshtoken: "LEAK-c2", idtoken: "LEAK-c3", authtoken: "LEAK-c4", clientsecret: "LEAK-c5", privatekey: "LEAK-c6", secretkey: "LEAK-c7", accesskey: "LEAK-c8",
      sessiontoken: "LEAK-c9", bearertoken: "LEAK-c10", DB_PASS: "LEAK-c11", dbPass: "LEAK-c12", passWord: "LEAK-c13", PASSWORD: "LEAK-c14", user_pass: "LEAK-c15", ADMIN_PASS: "LEAK-c16",
      pwd: "LEAK-c17", dbpass: "LEAK-d1", sshKey: "LEAK-d2", masterKey: "LEAK-d3", pat: "LEAK-d4", secretvalue: "LEAK-d5", ssh_key: "LEAK-d6", client_secret: "LEAK-c18", ClientSecret: "LEAK-c19", AWS_SECRET_ACCESS_KEY: "LEAK-c20",
    };
    const kept = { pass: 12, bypass: "kept-bypass", max_token: 4096, max_tokens: 8192, tokens: { input: 5, output: 7 }, passed: true, keyboard: "kept-kb", author: "kept-author", compass: "kept-compass", passport: "kept-passport", tokenCount: 3, token_used: 99, passes: 4, keys: 5 };
    store.appendEvent({ ...secrets, ...kept });
    store.recordAssertions([{ ...secrets, ...kept }]);
    store.recordReceipts([{ nested: { ...secrets, ...kept } }]);
    const files = ["events.jsonl", "assertions.json", "receipts.json"].map((f) => fs.readFileSync(path.join(runDir, f), "utf-8"));
    for (const text of files) {
      assert.ok(!/LEAK-/.test(text), text.match(/LEAK-[\w-]+/)?.[0]);
      for (const k of ["kept-bypass", "kept-kb", "kept-author", "4096", "8192"]) assert.ok(text.includes(k), `${k} was over-redacted`);
      assert.match(text, /"pass":\s*12/);
      assert.match(text, /"input":\s*5/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
