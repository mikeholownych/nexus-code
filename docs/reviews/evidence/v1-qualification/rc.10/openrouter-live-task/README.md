# RC10 OpenRouter live task

Disposition: `PASS` for the small live-task portion of provider E5, based on the final synthetic task below. Earlier attempts are retained as failures and are not counted as passes.

## Candidate and environment

- Candidate: signed `v1.0.0-rc.10`, tag target `16ee8ca3643824741b6da67936b41f262414fdf0`.
- Published Linux x86_64 archive SHA-256: `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`.
- Installed binary: `/home/mike/.local/nexus-rc10-qualification/bin/nexus` on `ubuntu-desktop` (`10.0.8.3`); it reported `1.0.0-rc.10 (16ee8ca36438)` during independent validation.
- Provider/model: OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Workspace: fresh synthetic repository under `/tmp/nexus-rc10-openrouter-live-js-v2-20261027/workspace`; no user project, held-out content, corpus, or private validator was used.
- Baseline commit: `d3cfb387f62ca7ff20b4ed5a4bd8e90ee871cb41`.
- Task run: 2026-10-27, 7 model requests, 36.215 seconds, provider-reported cost `$0`; the exact model is recorded in each receipt.

## Accepted attempt

`attempt-js-ascii/` contains the raw JSON result, stderr, inference receipts, flight log, baseline identity and hashes, final deliverable, unchanged test, and independent validation transcript.

The configured verifier was `node --test tests/slug.test.mjs`. Nexus reported `COMPLETED`, `PASSED`, and `isDeliverableBound: true`, with `unverifiedChangesPending: false`. The verifier executed one test case covering ASCII lowercasing, delimiter collapsing, non-ASCII handling, and trimming. Independent validation reran that verifier and added three assertions (`İ`, emoji separation, and whitespace-only input); all passed. Only `src/slug.mjs` was modified in the task workspace.

## Failed attempts retained

- `attempt-unsupported-verifier/`: the original Python run used unsupported unittest discovery syntax. Nexus failed closed with `UNVERIFIED` / `VERIFICATION_NOT_RUN`; it is not acceptance evidence.
- `attempt-python-verifier-unbound/`: a supported Python verifier executed and passed its four tests, but Nexus did not bind the declared deliverable (`REGRESSION_FREE`, `isDeliverableBound: false`). Independent validation also found that Unicode-wide lowercasing violated the ASCII-only objective. This is a product/evaluator failure, not a pass.
- The Python binding fix is tracked separately and has not been accepted; the independent reviewer requested a conservative correction for ambiguous Python `from package import name` syntax.

## Scope limits

This evidence establishes one synthetic OpenRouter live task on the installed RC10 artifact. It does not establish held-out, standalone long-task, provider recovery, T3/T4, cross-runner, manual terminal, exact-RC acceptance, or stable-release completion. OpenRouter's separate provider verification receipts and result are in [`../providers/openrouter-receipts-20261027T022710Z.jsonl`](../providers/openrouter-receipts-20261027T022710Z.jsonl) and [`../providers/openrouter-verify-20261027T022710Z.json`](../providers/openrouter-verify-20261027T022710Z.json).
