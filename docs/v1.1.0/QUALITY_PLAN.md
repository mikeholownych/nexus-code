# V11-QUALITY-04 — cancellation, message durability, and replay edge cases

## Item specification

**User story:** As an operation operator, I need cancellation and message delivery to remain truthful across aborts, crashes, persistence failures, and legacy records, so that recovery never publishes cancelled work or loses advisory messages.

**Acceptance criteria (binary, testable):**
- AC1: An executor that completes after abort cannot produce a completed unit, a post-cancel artifact, or a second `OPERATION_CANCELLED`; a pre-existing integration receipt survives late completion and repeated cleanup → test: `an abort suppresses late completion, preserves receipts, and emits one cancellation`.
- AC2: A turn with `pendingMessageRetained !== false` and `persistence.durable === false` cannot acknowledge its messages; a later durably submitted turn receives them exactly once → test: `a persistence failure leaves messages owed until a durable retry`.
- AC3: Only a marker in a genuine Nexus-generated submitted unit prompt counts as prior submission. Assistant-output markers and markers in unrelated user-role messages cannot suppress delivery; a genuine submitted prompt suppresses reinjection → test: `only a genuine submitted unit prompt suppresses message reinjection`.
- AC4: A future task envelope containing an invalid nested operation reports the envelope-version error before nested interpretation, leaves bytes and mtime unchanged, and creates no backup or quarantine sidecar → test: `replay refuses a future task envelope before nested interpretation without writing`.

**Out of scope:** scheduler redesign, provider behavior changes, new message semantics, stable-tag publication, and changes outside the four named edge cases.

**Dependencies:** V11 persistence and runner fixes through `3c727547`; independent plan approval; XERJ retrieval for every runtime contract.

**Files (claimed):** `cli/src/core/operation_runner.ts`, `cli/src/core/operation_runner_execution.ts`, `cli/src/core/operation_runner_persistence.ts`, `cli/src/core/operation_messages.ts`, `cli/test/operation_release_review.test.ts`.

## Implementation plan

**Chunks (each independently testable):**
1. Idempotent abort — `operation_runner.ts` — AC1. Suppress late result application/publication after `CANCELLED`; make cleanup idempotent while retaining integration receipts.
2. Durability-positive acknowledgment — `operation_runner_execution.ts` — AC2. Require both prompt retention and `turn.persistence?.durable !== false`.
3. Structured duplicate suppression — `operation_runner_execution.ts`, `operation_messages.ts` — AC3. Recognize only the exact structured block in a genuine Nexus-generated submitted unit prompt; assistant output and unrelated user-role messages never count.
4. Envelope-version guard — `operation_runner_persistence.ts` — AC4. Reject an unsupported envelope before nested operation interpretation without a write.

**Reference corpora to query:**
- `nexus-cli-docs` — established abort/result, `TurnResult.persistence`, `ChatMessage`, and task-envelope contracts.
- `opencode-docs` — cancellation and durable-outbox approaches where applicable; no runtime adoption without checking Nexus semantics.

**Risk / unknowns:**
- Whether cleanup must still save after a prior cancellation — retrieval query: `nexus-cli-docs` / `operation_runner cancelled scheduler.cancel`.
- Exact persistence evidence for a retained prompt — retrieval query: `nexus-cli-docs` / `TurnResult persistence durable failures`.
- Structured history evidence that distinguishes submitted prompt content from assistant output — retrieval query: `nexus-cli-docs` / `ChatMessage role user content`.
- Envelope version field and refusal behavior — retrieval query: `nexus-cli-docs` / `CURRENT_STATE_SCHEMA_VERSION migrateIfLegacy`.

FRICTION: full repository regression and independent quality approval remain open. The premature remote `v1.1.0` tag is unpublished; no later tag may be created until all release gates pass.
