import { test } from "node:test";
import assert from "node:assert/strict";

import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatDiagnosticForOutput } from "../src/core/persistence_protection.js";

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
