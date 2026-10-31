# RC14 live provider and small-task evidence

This supplement records fresh checks against the published and installed `v1.0.0-rc.14` artifact. It addresses the receipt-archive gap identified in the review of PR #346. It does not establish overall RC acceptance or stable-release readiness.

## Candidate identity

- Tag: `v1.0.0-rc.14`
- Source commit: `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99`
- Published Linux x86_64 archive SHA-256: `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`
- Installed CLI reported: `1.0.0-rc.14 (16eeb6eeffe7)`
- Qualification host: Ubuntu 26.04.1, Linux 7.0.0-38-generic, Node `v22.22.1`, npm `9.2.0`

The archive and release `SHA256SUMS` were downloaded from the GitHub RC14 release and verified before execution. The exact commands were:

```text
nexus providers verify --provider openrouter -m nvidia/nemotron-3-ultra-550b-a55b:free -j
nexus providers verify --provider chatgpt -m gpt-6-luna -j
```

The exact provider receipt JSON files are archived in `provider-verification/`; each contains three completed receipts and the three successful checks (streaming, tool call, and tool-result round trip). OpenRouter used the pinned supported model. ChatGPT sign-in is recorded as experimental.

## Live small task

The task used a fresh synthetic JavaScript repository, not a user project or qualification corpus. Its initial commit was `8b115a4f3a9cfa9d02a1b5efc7e485387a72feb8`. The baseline test run failed as intended: 2 passed, 1 failed, with the failure limited to HTTP 429 classification. The task asked Nexus to make 429 retryable while preserving 2xx success, 5xx retry, and failure for other 4xx responses.

Nexus ran installed RC14 with this command shape, `--mode auto`, `--sandbox auto`, and authoritative verifier `npm test`:

```text
nexus run --workspace <synthetic-workspace> --provider openrouter --model nvidia/nemotron-3-ultra-550b-a55b:free --mode auto --sandbox auto --authoritative-verifier "npm test" --deliverable-file src/status.js --record-flight --max-steps 10 --max-total-steps 15 --json -y "Update src/status.js so HTTP 429 is classified as retryable. Preserve 2xx as success, 5xx as retryable, and every other 4xx as failure. Do not change the tests. Run npm test and finish only if it passes."
```

Its task record is `task-db8af731`, with outcome `VERIFIED`; the record reports six steps and a passing configured verifier. The only workspace change was `src/status.js`; no test files changed. The baseline fixture, final source, exact patch, baseline test output, and a separate post-run test output are included here.

The post-run test was executed independently after inspecting the complete diff. It passed 3/3 tests, with no skips. This external run is the acceptance evidence; Nexus's task status alone is not used as proof. The test covers 2xx, 5xx, 429, 404, and 418 behavior.

## Provenance and privacy

`live-small-task.json` records the RC identity, verification results, file hashes, and hashes of the original task/session/message/flight records. `live-small-task-event-summary.json` records a content-free projection of the flight event sequence and tool outcomes. Full model-turn messages and reasoning are not included. The original run records remain in the restricted temporary qualification directory on the Ubuntu host; their SHA-256 digests are included for correlation. Provider credentials were used by the installed CLI from the host's existing credential store; credential contents were not read, copied, logged, or included in this packet.

No held-out tasks, hidden answers, private validators, or user workspace content were accessed. Provider and task usage receipts are included as machine-readable records. OpenRouter reported zero cost for these requests; ChatGPT cost is not asserted by its receipt.

## Scope disposition

This packet supports the required OpenRouter provider verification and one independently validated OpenRouter task. It also records the RC repeat verification for experimental ChatGPT sign-in described in ACCEPTANCE §4.3; it does not treat ChatGPT as a supported required provider. Standalone stripped-proxy profiles, held-out qualification, other provider tiers, exact-RC overall acceptance, and stable release remain separate gates.
