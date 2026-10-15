# SPEC-05: Standalone local inference and provider robustness

| | |
|---|---|
| Status | Ready. Provider tiers resolved by [DEC-06](../DECISIONS.md#dec-06-supported-providers-for-v1). |
| Release class | **BLOCKER**: standalone context sizing + live standalone qualification. RELEASE-REQUIRED: error bounding, timeouts, stream fixes, startup diagnosis, docs. |
| Requirements | REQ-PRV-101, REQ-PRV-102, REQ-PRV-103, REQ-PRV-104, REQ-PRV-105, REQ-PRV-106, REQ-PRV-107, REQ-PRV-109, REQ-PRV-110, REQ-TUI-105 |
| Findings | PRV-03, PRV-04, PRV-05, PRV-06, PRV-07, PRV-09, PRV-10, PRV-11, PRV-12, PRV-13, PRV-14, PRV-16, PRV-17, PRV-18, TUI-06, HIST-08 |
| Plan | [PLAN-05](../plans/PLAN-05-standalone-local-inference.md) |
| Acceptance | ACC-INF-01 to ACC-INF-10, plus the standalone qualification matrix in ACCEPTANCE §4 |

## 1. Problem

Local inference is the product's first-class mode. The quickstart first-run path is LM Studio or vLLM at `localhost:1234`. The code is gateway-optional by design (B §5): `/tokenize`, capacity headers and `limits_version` are all optional and absent-safe. The gaps are below.

### 1.1 No live standalone evidence

Every live run on record is against the homelab gateway: llama.cpp behind aihost (HIST-08). Local requests are never receipted (`client.ts:561-569`), so there is no machine-readable local evidence (B §6 G1).

### 1.2 Context sizing on LM Studio and llama.cpp

Only `context_length` and `max_model_len` are parsed (`core/provider_capabilities.ts:29,72`). LM Studio's and llama.cpp's `/v1/models` do not carry these fields (INFERENCE on server behaviour; verify in G1). On those servers sizing falls back to 65536. If the loaded window is smaller, the first large turn ends with a capacity error and no compaction-and-retry (`agent.ts:4684-4689`; PRV-06). On top of that, llama.cpp's overflow body is classified as REQUEST_REJECTED, not CAPACITY_REJECTED (PRV-07, reproduced).

### 1.3 Robustness gaps

All reproduced against local mocks unless noted.

| ID | Gap |
|---|---|
| PRV-03 | Local-endpoint error bodies are not bounded or redacted (a 200 KB body with an `sk-ant…` string passed through intact). |
| PRV-04 | A repeated tool name in later deltas is concatenated: `read_fileread_file`. |
| PRV-05 | `listModels` and `generateEmbedding` have no timeout or cancel. Embeddings retry per chunk. |
| PRV-09 | The empty-stream re-request is uncapped (`max_tokens` absent) and is not reported as a second execution. |
| PRV-10 | There is a single 900 s whole-request timeout and no idle or first-byte timeout. A timed-out long generation is replayed up to 2× (SOURCE + RUNTIME). |
| PRV-12 | Egress denial throws a plain `Error`, so it is failover-eligible and mislabelled. |
| PRV-13 | `addFallbackEndpoint` ignores provider pins. |
| PRV-14 | A key-less `compatible` provider never appears in the picker. |
| PRV-16 | A Responses `incomplete` result for a non-length reason may be replayed. |

### 1.4 Diagnosis gaps

- **TUI-06.** With an unreachable endpoint, startup shows nothing. The first prompt then loops "temporarily unavailable; waiting Ns" (7× in 28 s, no bound seen), with no endpoint URL and no fix hint.
- **PRV-18.** A custom CA for an HTTPS gateway is undocumented, so users will reach for `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### 1.5 Homelab coupling (PRV-11, PRV-17)

- `~/.config/opencode/t5820-client-token` (`client.ts:63-69`).
- `X-Task-Class` sent to every endpoint.
- `/model appliance engineering/b0` and the "parity with Codex and Claude Code" claim in the docs.
- Hardware named in ARCHITECTURE.md.

## 2. Requirements

1. **REQ-PRV-101.** Context window discovery:
   - covers vLLM (`max_model_len`), llama.cpp (`GET /props` → `default_generation_settings.n_ctx`), LM Studio (`GET /api/v0/models` → `loaded_context_length`), and Ollama (`POST /api/show` → `model_info.*.context_length`, or `num_ctx`);
   - falls back to the operator's `--context-limit` / `NEXUS_CONTEXT_LIMIT`;
   - only then uses the 65536 default, labelled `client_default` in `/status`.
2. **REQ-PRV-102.** A capacity rejection (classified for vLLM, llama.cpp, LM Studio and Ollama bodies) triggers one compaction and one retry at a reduced budget. A second rejection ends the turn with an actionable message naming `--context-limit` and the discovered value.
3. **REQ-PRV-103.** Every provider/endpoint error string is bounded (≤ 2000 chars) and redacted on every path: inference, listModels, embeddings, tokenize, OAuth.
4. **REQ-PRV-104.** Every network call has a timeout and honours operator cancel. Inference has separate first-byte (default 120 s), idle inter-chunk (default 120 s) and optional total timeouts. Replays of timed-out generations are bounded (max 1) and visible.
5. **REQ-PRV-105.** The stream parser tolerates:
   - repeated tool names;
   - object-typed `arguments`;
   - missing `index`;
   - `<think>` blocks split across chunks.

   Recorded real-server SSE fixtures from LM Studio, llama.cpp `--jinja`, vLLM (hermes and qwen parsers) and Ollama run in CI.
6. **REQ-PRV-106.** **Standalone qualification** (DEC-16; the environment provides no inference path except the gateway).
   - **(a) Live:** Nexus runs in a clean HOME with no homelab configuration, through `eval/standalone/plain_proxy.mjs`. The proxy strips every gateway extension and, in a second profile, emulates the llama.cpp, vLLM and Ollama `/models` and overflow shapes. In both profiles, Nexus passes the standalone T2 subset and the T4 subset at the ACCEPTANCE §4.2 threshold, and turns are recorded with receipts.
   - **(b) Conformance:** server-kind fixtures for llama.cpp, vLLM, LM Studio and Ollama pass in CI.
   - The release notes state the qualified scope exactly.
7. **REQ-PRV-107.** Local receipts: local and appliance requests are recorded in `<ws>/.nexus/inference_receipts.jsonl` in the same format, with `origin_class: local`. Receipts are opt-out with `NEXUS_RECEIPTS=0`. This gives machine-readable evidence for REQ-PRV-106.
8. **REQ-PRV-109.** Docs and code carry no homelab-specific identifiers:
   - the gateway token path becomes configurable (`NEXUS_GATEWAY_TOKEN_FILE`), with the homelab path read only if explicitly configured;
   - `X-Task-Class` is sent only to origins that advertise support (gateway capability) or when configured;
   - docs examples use neutral names.
9. **REQ-PRV-110.** A custom CA is documented through `NODE_EXTRA_CA_CERTS` in `config.env`. The launcher exports it before node starts, and `nexus doctor` validates it.
10. **REQ-TUI-105.** At session start (TUI and REPL) the endpoint is probed with a 3 s `GET /models`. An unreachable or misconfigured endpoint is reported with the URL, the cause, and the fix (`nexus doctor`, `~/.config/nexus/config.env`, `/connect`). A never-reachable endpoint ends the turn with guidance after a bounded wait (default 2 minutes for "never succeeded this session", versus the existing 20-minute recovery deadline for "was working").

## 3. Design notes

- **Discovery.** Add a `ServerKind` probe in `provider_capabilities.ts`: `gateway | vllm | llamacpp | lmstudio | ollama | unknown`. It inspects the `/models` response shape, and the `/props`, `/api/v0/models` and `/api/version` endpoints. Each probe has a timeout of 2 s and is cached per endpoint per session. Report the kind and the context source in `/status` and in doctor.
- **Timeouts.** In `client.ts:744-747,1627-1630`, replace the single `AbortSignal.timeout(total)` with a watchdog that is reset on each chunk. The env keys `LOCAL_LLM_FIRST_BYTE_TIMEOUT_MS`, `LOCAL_LLM_IDLE_TIMEOUT_MS` and `LOCAL_LLM_TIMEOUT_MS` (total, default 0 = off for local, 900 s for cloud) are operator-only (SPEC-03).
- **Error bounding.** A single `boundedProviderText(body)` is used at `client.ts:903,1636,1689`.
- **Empty stream.** The non-stream re-request carries the same `max_tokens`, and the receipt and UI record `executions: 2`.
- **Never-reachable bound.** In `provider_recovery.ts`, add a `everSucceeded` flag per endpoint per session. When it is false, the deadline is `NEXUS_FIRST_CONTACT_DEADLINE_MS` (default 120000).

## 4. Compatibility

- These are additive probes. Servers that 404 the extra endpoints are unaffected, apart from a single debug log.
- Changing the default total timeout for local endpoints to "off" (idle and first-byte only) is a behaviour change. It is beneficial for slow local generation, and the release notes must mention it.

## 5. Acceptance criteria

| ID | Check |
|---|---|
| ACC-INF-01 | Fixture servers emulating the `/models`, `/props`, `/api/v0/models` and `/api/show` shapes give the correct context and source label. |
| ACC-INF-02 | A llama.cpp overflow body and an LM Studio overflow body are both classified CAPACITY_REJECTED. Compaction and retry happen once, then an actionable error. |
| ACC-INF-03 | `prv/err.mts`: the message is ≤ 2100 chars with no `sk-` substring. Repeat for listModels and embeddings. |
| ACC-INF-04 | `prv/probe.mts` hang cases reject within the configured timeouts. A stall after the first chunk hits the idle timeout. A 20-minute trickle stream is not killed when the total timeout is off. |
| ACC-INF-05 | Repeat-name gives `read_file`. Object arguments are accepted. Recorded real-server fixtures pass. |
| ACC-INF-06 | Empty stream: the non-stream body contains `max_tokens`, and the receipt shows 2 executions. |
| ACC-INF-07 | PTY s1a: with the endpoint at 127.0.0.1:9, the startup screen names the endpoint as unreachable with a fix hint, and the first prompt ends with guidance within 2.5 minutes. |
| ACC-INF-08 | `grep -rn "t5820\|engineering/b0\|A770\|18010" cli/src docs/*.md README.md quickstart.md` returns nothing outside `docs/reviews` and `docs/v1.0.0` history. |
| ACC-INF-09 | With `NODE_EXTRA_CA_CERTS` in config.env, a TLS mock with a private CA succeeds. Without it, the request fails with PERMANENT_FAILURE and a hint, and is not retried. |
| ACC-INF-10 | ACCEPTANCE §4.2 passes: the live stripped-proxy profiles (plain, plus emulated llama.cpp/vLLM/Ollama shapes) on the standalone T2 and T4 subsets, and server-kind conformance fixtures in CI. Receipts are archived. |

## 6. Dependencies

- DEC-06 (resolved) sets the provider tiers.
- SPEC-03 handles operator-only env keys.
- SPEC-10 provides the standalone task set and runner.
