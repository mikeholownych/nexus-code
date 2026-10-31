import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatReplDiagnostic } from "../src/repl.js";

test("redacts and terminal-escapes REPL turn error output", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_repl_error_secret_7f31";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const output = formatReplDiagnostic(new Error(`turn failed with ${secret}\u001b[31m`));
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("\u001b"), false);
    assert.match(output, /REDACTED/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("suppresses REPL turn errors when credential classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const secret = "synthetic_repl_error_secret_7f31";
    const output = formatReplDiagnostic(new Error(`turn failed with ${secret}`));
    assert.match(output, /diagnostic suppressed/);
    assert.equal(output.includes(secret), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
