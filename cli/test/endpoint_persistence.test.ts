/**
 * Endpoints are persisted and logged as origin + path only: a URL such as `https://u:p@host/v1?api_key=SECRET#x`
 * never reaches a record, a saved turn, a flight manifest or a diagnostic with its userinfo, query or fragment.
 * (A secret in the path itself still persists: origin and path are kept, which is inherent.)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { LocalLlmClient, InferenceError } from "../src/client.js";
import { DEFAULT_RECOVERY_POLICY, ProviderRecoveryController, startupEndpointWarning, type RecoveryHooks } from "../src/core/provider_recovery.js";
import { FlightRecorder } from "../src/flight.js";
import { persistableEndpoint } from "../src/core/endpoint_identity.js";
import { fakeClock } from "./helpers/provider_fixture.js";

const RAW = "https://u:p@host.example:8443/v1?api_key=SECRET#frag";
const CLEAN = "https://host.example:8443/v1";
const noSecret = (value: unknown) => assert.ok(!JSON.stringify(value).includes("SECRET") && !JSON.stringify(value).includes("u:p@"), `leaked: ${JSON.stringify(value)}`);

describe("endpoints are persisted without credentials", () => {
  test("the form: origin and path, nothing else; a secret in the path is kept (inherent)", () => {
    assert.equal(persistableEndpoint(RAW), CLEAN);
    assert.equal(persistableEndpoint("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1");
    assert.equal(persistableEndpoint("https://host/v1/KEY123"), "https://host/v1/KEY123", "origin and path are kept");
  });

  test("provider recovery: the record's endpoint and the EXHAUSTED reason persisted in the turn", async () => {
    const refused = new InferenceError("network_error", "transport", "fetch failed (cause: ECONNREFUSED)", { condition: "TEMPORARILY_UNAVAILABLE", execution: "NOT_EXECUTED", transportCause: [{ code: "ECONNREFUSED" }] });
    let ids = 0;
    const hooks: RecoveryHooks<string> = {
      submit: async () => { throw refused; },
      probe: async () => ({ available: false, condition: "TEMPORARILY_UNAVAILABLE" }),
      classify: (e) => (e instanceof InferenceError ? e.toFailure() : null),
      newRequestId: () => `rid-${++ids}`,
      onState: () => {},
    };
    const c = new ProviderRecoveryController({ ...DEFAULT_RECOVERY_POLICY, deadlineMs: 120_000 }, fakeClock(), 1, { endpoint: RAW });
    await assert.rejects(() => c.run("rid-0", hooks));
    assert.equal(c.record?.state, "EXHAUSTED");
    assert.equal(c.record?.endpoint, CLEAN);
    assert.match(c.record?.reason ?? "", /host\.example:8443\/v1\)/);
    noSecret(c.record);
  });

  test("the startup reachability warning shown to the operator", () => {
    noSecret(startupEndpointWarning(RAW, { available: false, condition: "TEMPORARILY_UNAVAILABLE", cause: "ECONNREFUSED" } as any));
    noSecret(startupEndpointWarning(RAW, { available: true, condition: "AVAILABLE", httpStatus: 401 } as any));
  });

  test("the flight manifest", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ep-flight-"));
    try {
      execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git commit -q --allow-empty -m base", { cwd: repo, stdio: "ignore" });
      const recorder = new FlightRecorder(repo);
      const manifest = recorder.startSession({ model: "m", endpoint: RAW, taskPrompt: "x" });
      assert.equal(manifest.endpoint, CLEAN);
      noSecret(fs.readFileSync(recorder.getLogPath(), "utf-8"));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("failover diagnostics and the all-endpoints-failed error carry the cleaned endpoints", async () => {
    const diagnostics: string[] = [];
    const client = new LocalLlmClient({ model: "m", endpoint: "http://127.0.0.1:1/v1?api_key=SECRET", fallbackEndpoints: ["http://127.0.0.1:2/v1?api_key=SECRET"], apiKey: "k" } as any, {
      diagnosticHandler: (_level, message) => diagnostics.push(message),
    });
    await assert.rejects(() => client.listModels());
    noSecret(diagnostics);
    assert.ok(diagnostics.some((d) => d.includes("127.0.0.1:2/v1")), `a failover diagnostic names the backup: ${diagnostics.join(" | ")}`);
  });
});
