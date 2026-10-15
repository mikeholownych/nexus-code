# PLAN-05: Standalone local inference and provider robustness

Implements [SPEC-05](../specs/SPEC-05-standalone-local-inference.md). Milestone **M3**. Code tasks run in M3; live qualification runs in M5.

Requirements: REQ-PRV-101, 102, 103, 104, 105, 106, 107, 109 and 110; REQ-TUI-105. Decision: DEC-06.

## Safe change boundary

- `cli/src/client.ts`
- `cli/src/core/provider_capabilities.ts`
- `cli/src/core/provider_recovery.ts`
- `cli/src/protocols/*`
- `cli/src/model_catalog.ts`
- `cli/src/providers.ts`
- `cli/src/embeddings.ts`
- `cli/src/agent.ts` (capacity-rejection handling at 4684-4689; startup probe)
- `cli/src/sidecar.ts`, `cli/src/repl.ts` (startup probe display)
- `cli/src/doctor.ts`
- `harness.sh`, `scripts/package-linux.sh` (CA export)
- docs

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | `ServerKind` probe (gateway / vllm / llamacpp / lmstudio / ollama / unknown). Context discovery through `/props`, `/api/v0/models` and `/api/show`, with 2 s timeouts, cached per endpoint. Source label shown in `/status` and doctor. | `provider_capabilities.ts:29,72,184-195`; `client.ts:939-977` | — |
| 2 | Capacity rules cover llama.cpp (`exceed_context_size_error`), LM Studio and Ollama bodies. Build the table test from recorded bodies. | `provider_recovery.ts:82,106` | — |
| 3 | On CAPACITY_REJECTED: compact once, retry once at the reduced budget, then end with an actionable message that names `--context-limit` and the discovered value. | `agent.ts:4684-4689`; compaction ladder `agent.ts:2767` | 1,2 |
| 4 | `boundedProviderText` on every error path (inference, listModels, embeddings, tokenize, OAuth). | `client.ts:903,1636,1689`; `oauth.ts` | — |
| 5 | First-byte, idle and total timeouts with a watchdog. Default total timeout is 0 for local endpoints and 900 s for cloud. At most one replay of a timed-out generation, visible to the user. Timeouts on listModels, catalog, embeddings and tokenize. Embeddings are disabled for the session after a 404 or 501. | `client.ts:744-747,890-913,1627-1630,1676`; `embeddings.ts:299-305`; `model_catalog.ts:93-100`; `provider_recovery.ts:331-337` | — |
| 6 | Stream parser: assign the tool name when empty and ignore repeats; accept object-typed arguments; handle a missing `index` (already handled) and `<think>` split across chunks (shared with PLAN-11). | `client.ts:1326-1483` (1406) | — |
| 7 | Server-kind conformance fixtures, built from each project's published API docs with version and source references recorded: llama.cpp, vLLM, LM Studio, Ollama. Covers `/models`/`/props`/`/api/v0/models`/`/api/show` shapes, SSE tool-call deltas, think tags and overflow bodies. Also record real SSE through the gateway (llama.cpp workers) with `scripts/record_sse.mjs`. Add a replay test. | `cli/test/fixtures/sse/<server>/<case>.sse`; `inference_transport.test.ts` | — (no extra hardware; DEC-16) |
| 8 | Empty-stream re-request: same `max_tokens`; `executions: 2` recorded in the receipt and shown in the UI. | `client.ts:1118-1135,1472-1476` | 9 |
| 9 | Local receipts: `origin_class: local`, same writer, opt-out with `NEXUS_RECEIPTS=0`. | `client.ts:561-569`; receipts writer | — |
| 10 | Startup endpoint probe (3 s) in the TUI and REPL, with the startup message and fix hint. In `ProviderRecoveryController`, the first-contact deadline (`everSucceeded=false`) defaults to 120 s. | `sidecar.ts` session start; `repl.ts` banner; `protocol.ts:306-325` notice text; `provider_recovery.ts` | — |
| 11 | Remove homelab coupling: `NEXUS_GATEWAY_TOKEN_FILE` replaces the hardcoded token path; send `X-Task-Class` only when the gateway capability is advertised or configured; neutral doc examples. | `client.ts:63-69,644-647,947`; `providers.ts:161`; `CLOUD_PROVIDERS.md`; `ARCHITECTURE.md` | — |
| 12 | Custom CA: document `NODE_EXTRA_CA_CERTS` in config.env; the launcher (node entry re-exec, or `bin/nexus` sh) exports it before node starts; doctor validates that the file exists and parses. | `scripts/package-linux.sh:24-30` launcher; `harness.sh`; `doctor.ts` | PLAN-06 task 1 |
| 13 | Small fixes: egress denial throws `InferenceError("policy_denied")` (PRV-12); `addFallbackEndpoint` uses `normalizeEp` and checks pins (PRV-13); key-less `compatible` provider listed (PRV-14); Responses `incomplete` reasons mapped (PRV-16). | `client.ts:785-793,865,1091-1113,1226-1229,1490-1494`; `model_catalog.ts:128-136,170`; `protocols/openai_responses.ts:108` | — |
| 14 | Docs: standalone setup per server kind (LM Studio, llama.cpp, vLLM, Ollama), with how context is discovered and how to override it. | `quickstart.md`, `USER_MANUAL.md`, new `docs/LOCAL_SERVERS.md` | 1,12 |

## PR slices

| PR | Tasks | Focus |
|---|---|---|
| PR-5a | 1, 2, 3 | Standalone context sizing (blocker core) |
| PR-5b | 4, 5, 8, 9 | Robustness and receipts |
| PR-5c | 6, 13 | Parser and small fixes |
| PR-5d | 10, 12 | Startup diagnosis and CA |
| PR-5e | 11, 14 | Decoupling and docs |
| PR-5f | 7 | Recorded fixtures (after M5 recording) |

## Tests

- **Context discovery:** `provider_capabilities.test.ts` gets a fixture per server-kind response shape (ACC-INF-01).
- **Capacity:** `provider_recovery.test.ts` gets a table of recorded capacity bodies (ACC-INF-02). `provider_recovery_agent.test.ts` covers compact-and-retry once.
- **Ported probes:** port `evidence/prv/err.mts` and `probe.mts` into `client_robustness.test.ts` (ACC-INF-03/04/05/06).
- **PTY:** a new `startup_unreachable_e2e.test.ts` (ACC-INF-07).
- **Grep test:** for homelab identifiers (ACC-INF-08).
- **Custom CA:** a TLS mock using a fixture CA (ACC-INF-09).

## Recording fixtures

There is no inference path except the gateway (DEC-16):

1. Record real SSE through the gateway (llama.cpp-served models): `node scripts/record_sse.mjs --endpoint <gateway> --case {text,tool,parallel_tools,think,overflow}`. The script is new: a thin `fetch` that tees the body to a file. Commit the redacted files.
2. For vLLM, LM Studio and Ollama, write the fixtures from each project's published API documentation and source. Record the project version and the doc URL in each fixture header.
3. Optional: run a CPU-only llama.cpp `server` container on the dev box, built without AVX, with a ≤ 1.5B model, for a protocol smoke test.

## Live qualification (M5)

The matrix in ACCEPTANCE §4.2, run through `eval/standalone/plain_proxy.mjs` (PLAN-10 task 13) in both profiles: plain, and emulated server shapes. Archive receipts, transcripts and `/status` output per profile under `docs/reviews/evidence/v1-qualification/<rc>/standalone/`.

## Rollback

- Discovery probes are additive. A bad probe can be disabled with `NEXUS_SERVER_PROBE=0`.
- The timeout change has env overrides.

## Definition of done

- ACC-INF-01 to ACC-INF-09 pass in CI.
- ACC-INF-10 (stripped-proxy profiles plus conformance) is archived in M5.
- Release notes list the qualified server kinds (DEC-06).
