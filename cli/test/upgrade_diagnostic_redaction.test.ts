import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatUpgradeDiagnostic } from "../src/upgrade.js";

test("redacts a synthetic credential from URL-bearing upgrade errors and preserves ordinary diagnostics", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_upgrade_query_secret_934a";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const message = `request failed for https://updates.example.invalid/releases?token=${secret}`;
    const formatted = formatUpgradeDiagnostic(new Error(message));
    assert.equal(formatted.includes(secret), false);
    assert.match(formatted, /request failed for https:\/\/updates\.example\.invalid\/releases\?token=/);
    assert.equal(formatUpgradeDiagnostic("HTTP 403 from GitHub releases API"), "HTTP 403 from GitHub releases API");
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("suppresses upgrade diagnostics if canonical credential classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const formatted = formatUpgradeDiagnostic(new Error("request failed with synthetic credential"));
    assert.match(formatted, /diagnostic suppressed/);
    assert.doesNotMatch(formatted, /synthetic credential/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
