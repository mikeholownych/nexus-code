import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatDiagnosticForOutput } from "../src/core/persistence_protection.js";

test("redacts a synthetic credential from URL-bearing upgrade errors and preserves ordinary diagnostics", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_upgrade_query_secret_934a";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const message = `request failed for https://updates.example.invalid/releases?token=${secret}`;
    const formatted = formatDiagnosticForOutput(new Error(message));
    assert.equal(formatted.includes(secret), false);
    assert.match(formatted, /request failed for https:\/\/updates\.example\.invalid\/releases\?token=/);
    assert.equal(formatDiagnosticForOutput("HTTP 403 from GitHub releases API"), "HTTP 403 from GitHub releases API");
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
    const formatted = formatDiagnosticForOutput(new Error("request failed with synthetic credential"));
    assert.match(formatted, /diagnostic suppressed/);
    assert.doesNotMatch(formatted, /synthetic credential/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("redacts credentials before escaping terminal controls in upgrade diagnostics", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_upgrade_terminal_secret_aa71";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const formatted = formatDiagnosticForOutput(new Error(`failed ${secret}\u001b[31mred\u001b[0m\u0007\u0085\u202e`));
    assert.equal(formatted.includes(secret), false);
    assert.doesNotMatch(formatted, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
    assert.match(formatted, /REDACTED/);
    assert.match(formatted, /␛\[31mred␛\[0m␇<U\+0085><U\+202E>/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
