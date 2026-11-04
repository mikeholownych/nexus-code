# WP-1105 evaluator review remediation

### Item: WP-1105-R1 — Close evaluator review findings F1–F3

**User story:** As a release operator, I need deterministic evaluators to reject unavailable or bypassed checks and to syntax-check only source files that still exist, so that scores describe the candidate's actual changes.

**Acceptance criteria (binary, testable):**

- AC1: `typecheck_clean` fails as an infrastructure error when the checker cannot execute on either revision, even if both attempts produce the same failure → test: `typecheck_clean rejects unavailable checkers on both revisions`.
- AC2: Build and typecheck run against the pre-agent build configuration while still evaluating candidate source files, including build-only tasks without a `typecheck_clean` evaluator; the test edits `tsconfig.json` and package build scripts, proves a source error remains visible in the combined run, and proves the build-only path receives baseline configuration → test: `build and typecheck use pinned baseline configuration after candidate config edits`.
- AC3: The default `syntax_ast` file list ignores deleted paths and changed non-source files, while still parsing every changed, existing, supported source file → test: `syntax_ast defaults to existing supported changed source files`.
- AC4: `typecheck_clean` compares supported Rust compiler diagnostics as well as TypeScript diagnostics, preserving an unchanged baseline diagnostic and rejecting a newly added one → test: `typecheck_clean compares Rust diagnostics across baseline and candidate`.
- AC5: Overlaying candidate source onto the pre-agent workspace never follows a baseline symlink to write outside the pinned workspace → test: `pinned candidate workspace replaces baseline symlinks before overlaying candidate source`.

**Out of scope:** F4–F8 findings from the review; changing evaluator scoring beyond F1–F3.

**Dependencies:** WP-1103/1104 evaluator integration (already present in the v1.1.2 candidate).

**Files (claimed, including this spec and plan):** `eval/run.mjs`, `eval/evaluators/code/typecheck_clean.mjs`, `eval/evaluators/code/build.mjs`, `eval/evaluators/code/runner.mjs`, `eval/evaluators/code/syntax_ast.mjs`, `cli/test/code_evaluators.test.ts`, `docs/v1.1.0/WP-1105-PLAN.md`.

### Plan for WP-1105-R1

**Chunks (each independently testable):**

  1. Reject unavailable typecheck infrastructure and compare TypeScript/Rust diagnostics — files: `eval/evaluators/code/typecheck_clean.mjs`, `cli/test/code_evaluators.test.ts` — tests: `typecheck_clean rejects unavailable checkers on both revisions`; `typecheck_clean compares Rust diagnostics across baseline and candidate`.
  2. Pin evaluator configuration to the pre-agent baseline, retaining candidate source without following baseline symlinks — files: `eval/run.mjs`, `eval/evaluators/code/build.mjs`, `eval/evaluators/code/typecheck_clean.mjs`, `eval/evaluators/code/runner.mjs`, `cli/test/code_evaluators.test.ts` — tests: `build and typecheck use pinned baseline configuration after candidate config edits`; `pinned candidate workspace replaces baseline symlinks before overlaying candidate source`.
  3. Filter the implicit syntax list to extant supported source files — files: `eval/evaluators/code/runner.mjs`, `eval/evaluators/code/syntax_ast.mjs`, `cli/test/code_evaluators.test.ts` — test: `syntax_ast defaults to existing supported changed source files`.

**Reference corpora to query:**

- `v112-wp1105-eval` — current implementation contract for diagnostic comparison, snapshots, evaluator dispatch, and syntax parsers.
- `nexus-cli` — source-of-truth filesystem confinement and isolated command invocation contracts in committed main code.

**Risk / unknowns:**

- Whether candidate source can be combined safely with baseline configuration without copying untrusted candidate symlinks — retrieval query: "how does the evaluator snapshot bind file identity and prevent symlink replacement while constructing an isolated candidate view?"
- Whether build and typecheck configuration inputs are enumerated or arbitrary — inspect the task schema and `runner.mjs` before coding; do not silently fall back to candidate configuration.

### Item: WP-1107-R2 — Preserve provider identity on temporary rediscovery failures

**User story:** As a local-model operator, I need a previously verified provider kind to survive a temporary model-list or version-discovery outage on the same endpoint, so that strict-schema adaptation, exact token counting, and task-class privacy remain consistent. Changing endpoints must never inherit the old endpoint's provider identity.

**Acceptance criteria (binary, testable):**

- AC1: Cache a verified provider kind when rediscovery is unavailable or the selected model is absent; a positively identified different provider replaces it, and a readable generic selected-model entry clears stale identity. Standalone llama.cpp, Ollama, and vLLM still suppress `X-Task-Class`, while the positively identified gateway continues to send it → tests: `unavailable rediscovery retains verified provider kind and header policy`, `gateway task class survives unavailable rediscovery`, and existing `successful generic rediscovery clears prior gateway identity`.
- AC2: A same-endpoint vLLM rediscovery outage preserves `/tokenize` counting behavior; changing to another endpoint starts as unknown and cannot reuse the old endpoint identity → tests: `vLLM token counting survives same-endpoint rediscovery outage` and `changed endpoint does not inherit cached provider identity`.
- AC3: A transient vLLM `/version` failure during otherwise successful rediscovery retains the last verified vLLM identity → test: `transient vLLM version failure retains verified identity and strict schemas`.
- AC6: A positively identified gateway on the same endpoint replaces cached vLLM identity, so gateway request headers and non-vLLM schema adaptation take effect → test: `positive rediscovery replaces vLLM identity with gateway identity`.
- AC4: Nullable optional tool arguments are normalized from the declared tool schema at the client response boundary, before either streamed or non-streamed calls reach agent read tracking and observation keys; `false`, `0`, and empty strings remain, and null for required arguments remains invalid → tests: `client normalizes nullable optional arguments in streamed and non-streamed calls`, `normalized nullable optional arguments produce canonical observation identity`, and `vllm nullable optional tool arguments execute through the Rust RPC bridge`.
- AC5: The matrix binds `sourceCommit` to `git rev-parse HEAD` from an explicit candidate checkout root, rejects a dirty candidate checkout, and requires an explicit archive digest pin before loading the installed candidate → tests: `matrix rejects self-attested sourceCommit that differs from Git HEAD`, `matrix rejects dirty candidate checkout`, and `matrix requires a pinned archive SHA-256`.

**Out of scope:** Live provider inference while another agent holds the GATEWAY claim.

**Dependencies:** WP-1107 remediation commit `b032791e` (currently under exact-head qualification).

**Files (claimed):** `cli/src/client.ts`, `cli/src/agent.ts`, `cli/src/core/provider_capabilities.ts`, `cli/test/client_tool_grammar.test.ts`, `cli/test/provider_capabilities.test.ts`, `cli/test/task_class.test.ts`, `cli/test/tokens.test.ts`, `cli/test/agent_observer.test.ts`, `cli/test/vllm_nullable_dispatch.test.ts`, `eval/tool_grammar_matrix.mjs`, `eval/tool_grammar_matrix.test.mjs`, `docs/v1.1.0/WP-1107-PLAN.md`.

### Plan for WP-1107-R2

**Chunks (each independently testable):**

  1. Retain verified provider identity when discovery is temporarily unavailable and replace it on positive contradictory identity — files: `cli/src/client.ts`, `cli/src/core/provider_capabilities.ts`, `cli/test/provider_capabilities.test.ts`, `cli/test/task_class.test.ts`, `cli/test/tokens.test.ts`, `cli/test/client_tool_grammar.test.ts` — tests: AC1 and AC2 tests above, including positive gateway retention and endpoint-change invalidation; `transient vLLM version failure retains verified identity and strict schemas`; `positive rediscovery replaces vLLM identity with gateway identity`.
2. Normalize nullable optionals by the original declared tool schema at the client response boundary (before vLLM strict adaptation marks them required), and replace the dispatch-time per-tool field list with the same schema-driven normalizer — files: `cli/src/client.ts`, `cli/src/agent.ts`, `cli/test/client_tool_grammar.test.ts`, `cli/test/agent_observer.test.ts`, `cli/test/vllm_nullable_dispatch.test.ts` — tests: all three AC4 test names above.
3. Require a clean explicit Git checkout root and archive digest pin in matrix admission — files: `eval/tool_grammar_matrix.mjs`, `eval/tool_grammar_matrix.test.mjs` — tests: all AC5 test names above.

**Reference corpora to query:**

- `nexus-cli` — provider advertisement, task-class privacy, tool-call parsing, and workspace identity contracts.
- `v112-wp1105-eval` — existing candidate inventory and digest verification behavior.

**Risk / unknowns:**

- Provider capability cache ownership and invalidation across endpoint changes — retrieval query: "where are server advertisements cached and invalidated when model discovery fails or the selected endpoint changes?"
- Exact source of the matrix runner's trusted Git head and pinned archive digest — retrieval query: "how does the release harness bind an installed package archive and source commit to its immutable candidate record?"
