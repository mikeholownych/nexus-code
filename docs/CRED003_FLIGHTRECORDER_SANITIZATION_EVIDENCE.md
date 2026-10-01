# CRED-003 FlightRecorder Sanitization Evidence

**Starting baseline:** `fc543cab7bb4be3f00993fbbfd148fb11843b16a`
**Scope:** CRED-003 durable credential sanitization for flight and audit records.
**Status:** Implementation and test evidence; operator acceptance remains pending.

## Normative contract

Authoritative Phase 2 requirement, `docs/PHASE2_RECONCILED_REQUIREMENTS.md`, Domain 13 — Credential Requirements:

> Credential material MUST be immune from logging, telemetry, and debugging persistence. Crash reports, flight logs, and audit trails MUST scrub all identified credential values prior to disk writes.

Acceptance criterion:

> A crash log or stack trace MUST NOT print active bearer tokens or private keys.

The Phase 3 architecture maps CRED-003 to `InformationFlowBoundary` in INC-06. Phase 4 maps CRED-003 to WP-05 (INC-06), with WP-06/WP-08 listed as dependent packages. The accepted post-WP-05 assessment identified `FlightRecorder` as the known gap: restored tool arguments were persisted in `.nexus/flights/<flightId>.flightlog` without sanitization.

## Defect reproduction

Before correction, a controlled temporary workspace was used with synthetic bearer, GitHub-style, and OpenAI-style values passed through `FlightRecorder.recordToolCall()`. Reading the resulting `.flightlog` showed all three synthetic plaintext values present (`bearerPersisted=true`, `githubPersisted=true`, `openAiPersisted=true`). No real credentials were used.

## Correction

`InformationFlowBoundary.redactForTelemetry()` recursively sanitizes string values and object keys in arrays and nested objects, then applies the same canonical classifier over the serialized structure. The second pass preserves contextual classification that depends on a field name and value together. Replacements use the classifier's `[REDACTED:<pattern>]` labels and irreversibly discard plaintext. It does not create reversible token references.

`FlightRecorder.appendEvent()` is the single event persistence boundary. It sanitizes the entire event payload before constructing and appending the JSON line. If classification/sanitization fails, it returns a safe `recordingSkipped` event result without writing that record or propagating classifier diagnostics; authorized local execution continues. Session metadata, prompts, thoughts, tool arguments, result snippets, errors, durable state, diffs, and arbitrary nested payload fields all pass through this boundary.

The separate local audit append in `agent.ts` uses the shared classifier on the complete record, including workspace and tool metadata, arguments, and errors. CRED-003 explicitly names audit trails, and the previous display redactor did not cover all classifier-supported patterns. Sanitization failure is caught by the existing audit-write guard and skips the write.

## Adversarial and utility evidence

Focused test file: `cli/test/flight_sanitization.test.ts`.

- Before/after disk inspection exercises safe event → sensitive event → safe event appends and parses every JSON line.
- Nested arrays and objects contain multiple synthetic credentials, including bearer, GitHub-style, OpenAI-style, and contextual `api_key` values. None survive in the serialized file; matching irreversible redaction markers remain.
- Session metadata, model request prompt, thought/reasoning, tool arguments, tool result output snippet, and error fields are checked at the durable artifact.
- An authorized WP-05 tokenization/rehydration sequence is dispatched through `AutonomousAgent` under `fullAccess: true`. The registered local capability receives the restored synthetic plaintext and succeeds, while the `.flightlog` contains only the redaction marker. The resulting audit record is read from disk and confirms the credential embedded in the workspace metadata is redacted.
- Injected classifier failure during agent dispatch skips flight and audit persistence without blocking the authorized local capability. The capability receives the original synthetic argument, and neither durable file is created.
- Non-sensitive paths, notes, call IDs, success state, and neighboring safe records remain materially intact and structurally parseable.

The original implementation had a single `appendFileSync()` in `FlightRecorder`; all record methods route through `appendEvent()`. No alternate FlightRecorder write path was found. Model inputs are represented by turn prompts and session task prompts; reasoning text is recorded as thoughts. Model responses are not stored as raw response bodies. Tool results persist a bounded output snippet and error text, both covered by the common boundary.

## Validation performed

- Focused CRED-003 tests: 3 passed, 0 failed.
- `npm --prefix cli test`: 197 passed, 0 failed; natural exit.
- `make test`: Rust tests passed and nested CLI suite reported 197 passed, 0 failed; natural exit.
- `npm --prefix cli run build`: passed.
- `bash scripts/security_gates.sh`: passed; dependency audits reported zero known vulnerabilities and credential scan reported none in the codebase.
- `git diff --check`: passed.

All test credentials are synthetic values constructed in test code. This artifact contains no credential plaintext.

## Limitations and disposition

This evidence establishes FlightRecorder and the directly named local audit append behavior. It does not claim that every application persistence subsystem is a logging or telemetry sink, nor does it change WP-05 trust ranks, token scoping, rehydration authority, or egress policy. No separate crash-report persistence writer was found in the examined paths; the Phase 2 acceptance criterion for bearer tokens/private keys in crash reports and stack traces remains a bounded limitation pending qualification of all exception-display paths.

CRED-003 is ready for independent qualification and operator review. Issue #12 remains open pending the separate narrow closure reconciliation and operator acceptance.
