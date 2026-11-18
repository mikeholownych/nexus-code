# Redaction and terminal-safe variants (MT-3)

Decision for every variant found in `cli/src` (2026-11-18). The rule: where two variants behave identically they share one
helper; where they differ on purpose they stay separate and the difference is written down. No output changed;
`cli/test/redaction_helpers.test.ts` pins the shared forms, and the existing suites ran unchanged.

Part 2 (2026-11-18): `cli/test/mt3_redaction_characterization.test.ts` pins the exact output of 23 variants (and the non-string
inputs they accept) over a shared 19-input corpus, recorded on unmodified main before any change. Of the remaining
variants one was a pure restatement of `safeTerminal` and now calls it (`formatSafeSidecarText`); every other
variant produces different bytes from `redactPlain` / `safeTerminal` on some corpus input (the table gives the reason) and stays.

The literal secret patterns live once in `cli/src/redaction_patterns.json` (parity with Rust `redact.rs` in
`cli/test/redaction_parity.test.ts`).

## Redaction

| Variant | Where | Decision |
|---|---|---|
| `redactSecrets` | `ui.ts` | Canonical text redactor (classifier + pattern table). Kept. |
| `redactSecretPatterns` | `ui.ts` | Pattern half of `redactSecrets` for text the classifier already ran over. Kept, deliberately a parameter-free subset. |
| `redactPlain` (new) | `protocol.ts` | The shared `redactSecrets(stripEscapes(x))`; replaces seven identical inline copies (`evidence.ts` x3, `diagnostics.ts`, `protocol.ts` x3). |
| `redactDiagnosticForOutput` | `core/persistence_protection.ts` | Classifier-only, fail-closed. Kept; now uses the one `SANITIZATION_FAILED` constant instead of a second copy of the string. |
| `redactForPersistence` | `core/persistence_protection.ts` | Irreversible durable redaction (different classifier entry point). Kept. |
| `redactPathForOutput` | `core/persistence_protection.ts` | Path-component classification that keeps UNCERTAIN findings. Differs on purpose (temp dir names look like tokens). Kept. |
| `redactDiagnostic` | `doctor.ts` | Already one function with `kind: "path" \| "text"`; adds URL/header scrubbing. Kept. |
| `redactDeep` | `doctor.ts` | Walks a value applying `redactDiagnostic` plus exact secrets. Kept. |
| `redactedJson` | `evidence.ts` | Redacts string values and the encoded JSON; strips escapes. Differs from the next row. Kept. |
| `redactedJson` | `ceri/evidence_store.ts` | Also replaces whole values under credential keys; no escape stripping (frozen CERI fixtures are sha256-pinned). Kept. |
| `redactedOutput` | `evidence.ts` | Parses JSON output then `redactedJson`. Kept. |
| `redactThenCap` | `sidecar.ts` | `capText(formatSafeSidecarText(x), max)`. Kept. |
| `redactValues` | `core/egress.ts` | Replaces already-classified findings. Kept. |
| `redactTaskStateForPersistence` | `core/persistence_protection.ts` | Field-aware wrapper of `redactForPersistence`. Kept. |
| `redactOptional` | `protocol.ts` | One-line local closure over `redactSecrets` inside `projectTurn` (undefined passes through). Does not strip escapes, so it is not `redactPlain`: replacing it would change output for escape sequences inside a secret. Kept. |
| `redactSecrets(..)` direct calls | `agent.ts`, `client.ts`, `approval_review.ts`, `core/run_turn.ts`, `model_catalog.ts`, `tui.ts`, `skills.ts`, others | Classifier plus patterns without escape stripping. Not `redactPlain` (escapes are kept for callers that later show or fence them). Kept. |
| `finishStrings` / path fields | `sidecar.ts` (`formatSafeSidecarEvent`) | `visibleControls(redactSecretPatterns(..))`: patterns only, no classifier, because the classifier already ran over the whole event (and component-wise over path fields). Not `safeTerminal`: running the classifier a second time could change bytes. Kept. |
| `redactableHeaderNames` | `provider_safety.ts` | Lists header names to redact; not a redactor. Out of scope. |
| `redactForTelemetry` / `redactForDurablePersistence` | `core/egress.ts` | The classifier entry points the above wrap. Kept. |

## Terminal-safe

| Variant | Where | Decision |
|---|---|---|
| `safeTerminal` | `ui.ts` | The one terminal-safe helper: `visibleControls(redactSecrets(x))`. |
| `safeDiffText` | `evidence.ts` | Was an identical copy; now calls `safeTerminal`. Kept as a named alias for the diff call sites (pinned equal to `safeTerminal` in `redaction_helpers.test.ts`). |
| inline `visibleControls(redactSecrets(..))` | `core/objective.ts` x2, `protocol.ts` | Identical; now `safeTerminal`. |
| `formatSafeSidecarText` | `safe_text.ts` | Persistence redaction first, fail-closed, then `safeTerminal` (was an inline `visibleControls(redactSecrets(..))`; now calls `safeTerminal`, output byte-identical per the characterization test). The wrapper stays: it adds the persistence step and the failure placeholder. `sanitizeForTerminal` (`slash/workspace_commands.ts`) is a thin wrapper of it that maps the failure placeholder to empty. Kept. |
| `safeTerminalText` | `startup_trust.ts` | Replaces controls and format characters with U+FFFD and does not redact (trust-prompt text is fixed-width laid out). Differs on purpose. Kept. |
| `flat` | `delete_preview.ts` | Expands tabs and replaces with U+FFFD for columnar preview. Differs on purpose. Kept. |
| `safeOperatorText` | `protocol.ts` | One line, controls to spaces before redaction, capped without marker. Order of operations differs from `sanitizeDiagnosticMessage`; changing it alters output for control characters inside a secret. Kept. |
| `sanitizeDiagnosticMessage` | `diagnostics.ts` | Controls to spaces after redaction, fence markers defused, capped with a truncation marker. Kept. |

Observed differences the characterization test pins (not changed): `safeTerminal` does not hide a secret that has a control
character inside it (`sk-abcdefghij<BEL>klmno...`): the pattern no longer matches and the control is made visible. That is the
reason `safeOperatorText` and `sanitizeDiagnosticMessage` differ in order of operations, and it is left alone here.
