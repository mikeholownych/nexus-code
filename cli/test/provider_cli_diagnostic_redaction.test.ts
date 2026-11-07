import { test } from "node:test";
import assert from "node:assert/strict";

import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatDiagnosticForOutput } from "../src/ui.js";
import { safeClientDiagnostic } from "../src/provider_cli.js";
import type { HarnessConfig } from "../src/types.js";

test("provider CLI diagnostics redact explicit credentials and fail closed", () => {
  const syntheticCredential = "synthetic-provider-secret-2026";
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary({ explicitSecrets: [syntheticCredential] });

  try {
    InformationFlowBoundary.setGlobalInstance(boundary);
    const sanitized = formatDiagnosticForOutput(`Provider request failed: ${syntheticCredential}`);
    assert.ok(!sanitized.includes(syntheticCredential));
    assert.match(sanitized, /Provider request failed/);
    assert.equal(formatDiagnosticForOutput("Provider request failed"), "Provider request failed");

    boundary.redactForTelemetry = () => {
      throw new Error(syntheticCredential);
    };
    assert.equal(formatDiagnosticForOutput(`Provider request failed: ${syntheticCredential}`), "[diagnostic suppressed: credential sanitization failed]");
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("client diagnostics redact a slash-containing secret whole when the endpoint is origin-only", () => {
  const secret = "AKIA/synthetic+K7MDENG/bPxRfiCYEXAMPLEKEY";
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const config = { endpoint: "http://llm.example:8080", model: "m" } as HarnessConfig;
    const out = safeClientDiagnostic(`request to http://llm.example:8080/v1 failed with key ${secret}`, config);
    assert.match(out, /REDACTED/);
    assert.ok(!out.includes("K7MDENG"), out);
    assert.ok(!out.includes("bPxRf"), out);
    assert.ok(!out.includes("EXAMPLEKEY"), out);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
