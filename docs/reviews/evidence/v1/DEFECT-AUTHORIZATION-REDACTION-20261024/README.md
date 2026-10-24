# DEFECT: Authorization Basic/Token credentials are not redacted

| | |
|---|---|
| Base revision | `82c5c3c823f861fa3ac40a9ba42c9918f301d947` (`origin/main`) |
| Branch | `v1/defect-authorization-redaction` |
| Affected behavior | `InformationFlowBoundary` classified/redacted `Bearer`, API keys and JWTs, but not `Authorization: Basic …` (base64 user:password) or `Authorization: Token …`. `redactSecrets` (CLI output) and the TUI `StderrRedactor` had the same gap. `doctor.redactDiagnostic` already redacted Basic, so the layers disagreed. |
| Severity | Medium: credential disclosure to the terminal, diagnostics and durable telemetry/logs. The value is a credential even when it is not a recognizable provider key. |

## Reproduction (pre-fix)

```
Authorization: Basic dXNlcjpwYXNzd29yZA==
```

`redactForTelemetry`, `redactSecrets` and the TUI redactor returned the value unchanged; the same input
through `doctor.redactDiagnostic` became `Authorization: Basic [REDACTED]`. `authorization=Token
abcdefghijklmnop` was likewise unchanged.

## Fix

- Add an `AUTHORIZATION_HEADER` deterministic classifier for `(proxy-)?authorization[:=] (basic|bearer|token) <value>`; the captured value is redacted while the header and scheme stay readable.
- Accept quoted keys/values and JSON header objects (`{"authorization":"Basic …"}`), and align the
  three layers on an 8-character minimum.
- Add the matching replacement to `redactSecrets` as defence in depth.
- Add the same pattern to the TUI stderr redactor, so sidecar stderr cannot print it.
- Remove the 128-character cap on the Bearer classifier so a long token is fully redacted.

## Verification

- `cli/test/egress.test.ts`: 28/28; the Basic/Token test (including structured and quoted forms)
  fails on the pre-fix source.
- `cli/test/harness.test.ts` redaction test now covers Basic and fails on the pre-fix source.
- Rust `nexus-tui` redact tests: 6/6; the Basic/Token/JSON assertions fail when the new pattern is
  removed.
- `npx tsc --noEmit -p tsconfig.json`; `cargo test --bin nexus-tui redact`; `git diff --check`: pass.

## Residual risk

Only the standard `Basic`, `Bearer` and `Token` schemes are recognized; `Digest`/`Negotiate` parameters,
values shorter than 8 characters, and non-header encodings are not. Operator-declared environment
secrets are still covered by the explicit classifier, and `doctor` retains its broader header scrub.
