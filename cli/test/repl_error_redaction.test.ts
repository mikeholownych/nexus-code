import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatIgnoredInputExcerpt } from "../src/repl.js";
import { formatDiagnosticForOutput } from "../src/core/persistence_protection.js";

test("redacts and terminal-escapes REPL turn error output", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_repl_error_secret_7f31";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const output = formatDiagnosticForOutput(new Error(`turn failed with ${secret}\u001b[31m`));
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes("\u001b"), false);
    assert.match(output, /REDACTED/);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("operator-facing diagnostics share one formatter and the REPL step error path uses it", () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts")).map((f) => [f, fs.readFileSync(path.join(srcDir, f), "utf8")] as const);
  const duplicates = sources.filter(([, text]) => /safeTerminal\(\s*redactDiagnosticForOutput\(/.test(text)).map(([f]) => f);
  assert.deepEqual(duplicates, [], "every wrapper around safeTerminal(redactDiagnosticForOutput(..)) must be formatDiagnosticForOutput");
  const repl = sources.find(([f]) => f === "repl.ts")![1];
  const stepError = repl.split("\n").find((line) => line.includes("Step error"))!;
  assert.match(stepError, /formatDiagnosticForOutput\(err\)/, "the REPL step error path must redact the error text");
});

test("suppresses REPL turn errors when credential classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const secret = "synthetic_repl_error_secret_7f31";
    const output = formatDiagnosticForOutput(new Error(`turn failed with ${secret}`));
    assert.match(output, /diagnostic suppressed/);
    assert.equal(output.includes(secret), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("redacts ignored pasted input before making the bounded REPL excerpt", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_ignored_input_secret_63da";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const excerpt = formatIgnoredInputExcerpt(`${secret} ${"x".repeat(80)}`);
    assert.equal(excerpt.includes(secret), false);
    assert.ok(excerpt.length <= 61);
    assert.ok(excerpt.endsWith("…"));
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("suppresses ignored input excerpts when credential classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const secret = "synthetic_ignored_input_secret_63da";
    const excerpt = formatIgnoredInputExcerpt(secret);
    assert.match(excerpt, /diagnostic suppressed/);
    assert.equal(excerpt.includes(secret), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
