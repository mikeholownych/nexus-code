import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { formatSafeSidecarDiagnostic, formatSafeSidecarEvent, formatSafeSidecarStdoutSummary, formatSafeSidecarText } from "../src/sidecar.js";

test("sidecar debug/error formatter irreversibly redacts synthetic credentials", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_sidecar_credential_50f3";
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary({ explicitSecrets: [secret] }));
  try {
    const formatted = formatSafeSidecarDiagnostic(["debug payload", { authorization: secret }]);
    assert.equal(formatted.includes(secret), false);
    assert.match(formatted, /REDACTED/);

    const failure = new Error(`synthetic failure: ${secret}`);
    assert.equal(formatSafeSidecarDiagnostic([failure]).includes(secret), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("sidecar debug stdout summaries never include chunk content", () => {
  const secret = "synthetic_stream_secret_that_may_be_split";
  const summary = formatSafeSidecarStdoutSummary(`provider output ${secret}`);
  assert.equal(summary.includes(secret), false);
  assert.match(summary, /stdout chunk suppressed/);
  assert.match(summary, /bytes/);
});

test("sidecar debug/error formatter suppresses diagnostics if canonical sanitization fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const boundary = new InformationFlowBoundary();
  boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const formatted = formatSafeSidecarDiagnostic(["synthetic raw debug payload"]);
    assert.match(formatted, /diagnostic suppressed/);
    assert.equal(formatted.includes("synthetic raw debug payload"), false);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("sidecar messages and durable diff text use fail-closed canonical redaction", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_sidecar_diff_secret_203a";
  const boundary = new InformationFlowBoundary({ explicitSecrets: [secret] });
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const safe = formatSafeSidecarText(`+token=${secret}`);
    assert.equal(safe.includes(secret), false);
    assert.match(safe, /REDACTED/);

    boundary.classifyText = () => { throw new Error(secret); };
    assert.equal(formatSafeSidecarText(`+token=${secret}`), "[diagnostic suppressed: credential sanitization failed]");
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("sidecar protocol boundary redacts nested history fields and drops events if classification fails", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  const secret = "synthetic_nested_turn_secret_7c2e";
  const boundary = new InformationFlowBoundary({ explicitSecrets: [secret] });
  InformationFlowBoundary.setGlobalInstance(boundary);
  try {
    const event = formatSafeSidecarEvent({
      type: "history",
      session: "session-synthetic",
      total: 1,
      messages: [{ role: "outcome", heading: "Turn complete", text: `failure ${secret}` }],
    });
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes(secret), false);
    assert.match(JSON.stringify(event), /REDACTED/);

    boundary.classifyText = () => { throw new Error("synthetic classifier failure"); };
    assert.equal(formatSafeSidecarEvent({ type: "notice", text: "synthetic raw payload" }), undefined);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});
