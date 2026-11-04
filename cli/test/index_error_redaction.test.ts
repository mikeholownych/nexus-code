import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { redactDiagnosticForOutput } from "../src/core/persistence_protection.js";
import { safeTerminal } from "../src/ui.js";

test("redacts diagnostic text used by JSON task failure output", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_json_error_secret_22b1";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const safePrompt = redactDiagnosticForOutput(`user task includes ${secret}`);
    const safeError = redactDiagnosticForOutput(`failed with ${secret}`);
    assert.equal(safePrompt.includes(secret), false);
    assert.equal(safeError.includes(secret), false);
    assert.match(safePrompt, /REDACTED/);
    assert.match(safeError, /REDACTED/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("suppresses JSON diagnostic text if canonical classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const unsafe = "synthetic_json_error_secret_22b1";
    const responseText = redactDiagnosticForOutput(`prompt/error: ${unsafe}`);
    assert.match(responseText, /diagnostic suppressed/);
    assert.equal(responseText.includes(unsafe), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("redacts credentials and terminal controls from CLI error output", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_cli_output_secret_41a9";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const formatted = safeTerminal(redactDiagnosticForOutput(`failed with ${secret}\u001b[31m`));
    assert.equal(formatted.includes(secret), false);
    assert.equal(formatted.includes("\u001b"), false);
    assert.match(formatted, /REDACTED/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
