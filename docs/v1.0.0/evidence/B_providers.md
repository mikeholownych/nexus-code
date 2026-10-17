# Scope B — Providers and inference (PRV-)
Snapshot: scratchpad/snap @ db1ca55. Status: COMPLETE.

## 1. Coverage ledger
| File | Method |
|---|---|
| cli/src/client.ts (1699) | full read |
| cli/src/protocols/common.ts, openai_responses.ts, anthropic.ts | full read |
| cli/src/providers.ts, provider_cli.ts, model_catalog.ts, credentials.ts, oauth.ts, config.ts, usage.ts, search_web.ts, onboard.ts | full read |
| cli/src/embeddings.ts (363) | targeted (indexing + client use, lines 200-363) |
| cli/src/core/provider_recovery.ts, provider_capabilities.ts | full read |
| cli/src/core/egress.ts (757) | targeted (classifyDestination 88-160; evaluateEgress not reviewed in depth — Scope security) |
| cli/src/agent.ts | targeted: 3640-3660 (hybrid_search), 3899 (public egress), 4660-4720 (inference failure handling) |
| cli/test/{client_robustness,cloud_providers,credential_boundary,credential_home,egress,output_truncation_recovery,provider_capabilities,provider_connect,provider_recovery,provider_recovery_agent,config}.test.ts | test-name inventory; targeted runs (sec. 8) |
| cli/.env (tracked) | inspected keys only (values: LM Studio default, key "local") |

## 2. Architecture / data flow
- Config (config.ts:16-40): env load order = install `cli/.env` (no override) -> `~/.config/nexus/config.env` (override) -> **cwd `.env` (override:true, any key)**. Credential authority snapshot (operator env + config.env) taken before cwd `.env` (client.ts:77-101); provider selection, provider base URL, disclosure authorization and stored-token binding use that snapshot. Everything else (TLS/Node env, timeouts, recovery policy, LOCAL_LLM_ENDPOINT/FALLBACKS, provider key env vars) reads live `process.env`.
- Two connection kinds: (a) legacy "appliance/endpoint" path (no provider id): OpenAI Chat Completions, `/v1` appended, fallback list, `X-Task-Class`, gateway token file / config.env key scoped by origin (client.ts:123-133), no receipts, no spending limits; (b) provider connections (providers.ts:46-116): openrouter, openai (Responses), anthropic (Messages), compatible, chatgpt (unofficial OAuth), copilot (unofficial OAuth); pinned endpoint, own key only, `redirect:"error"`, receipts in `<ws>/.nexus/inference_receipts.jsonl`, spending limits (usage.ts).
- Trust boundaries: disclosure gate = `disclosureClass` (providers.ts:181) -> `classifyDestination` (egress.ts:107) string-based; cloud destinations require authorization (client.ts:509-520); every outbound body passes `InformationFlowBoundary.evaluateEgress`. Credentials: env -> `~/.config/nexus/credentials.json` (0600, atomic, credentials.ts:68-75) -> other clients' files read-only.
- Failure model: client classifies every failure into kind/condition/execution (client.ts:184-197, provider_recovery.ts:91-131); client does no retry except (i) param-drop 400 retry, (ii) one OAuth refresh on 401, (iii) gateway-token reload on 401, (iv) immediate failover only when NOT_EXECUTED+temporary, (v) empty-stream non-stream re-request. Waiting/backoff/replay is in ProviderRecoveryController (provider_recovery.ts:277-384): 20 min deadline, 1-15 s jittered backoff, Retry-After honoured, probe (`GET /models`) before UNKNOWN replay, max 2 UNKNOWN replays.
- Capability discovery (client.ts:939-965, provider_capabilities.ts): `/models` entry -> gateway (`limits_version`, `/v1/tokenize`) or vLLM `max_model_len`; otherwise operator `--context-limit` or 65536/8192 client defaults. `/tokenize` only for gateway advertisements.
- Streaming: Chat Completions parser inline (client.ts:1326-1483); Anthropic/Responses via `readSse` (protocols/common.ts:63-107) + per-protocol parsers; a result is used only with positive completion evidence (finish_reason/[DONE], message_stop, response.completed).

## 3. Findings
| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| PRV-01 | S2 | config / cloud credentials | cli/src/config.ts:36-39 (cwd `.env` loaded with `override:true`, no key filter) | RUNTIME R2: a project `.env` with `NODE_TLS_REJECT_UNAUTHORIZED=0` turns a self-signed-cert rejection into HTTP 200 with the Authorization header delivered. | Opening an untrusted repo silently disables TLS verification for every later fetch, including cloud API keys/OAuth tokens -> MITM credential theft. Same channel sets LOCAL_LLM_TIMEOUT_MS, recovery policy, provider key vars (credentials.ts:243 reads live env), LOCAL_LLM_FALLBACK_ENDPOINTS. | Fix before v1: allowlist the keys a project `.env` may set (endpoint/model/task-class) or load it into a separate map; never let it set `NODE_*`, `*_PROXY`, `HOME`, credential vars. Add regression test. |
| PRV-02 | S2 | disclosure gate | cli/src/core/egress.ts:134-139 (`host.startsWith("10.")`, `"192.168."`, 172.16-31 regex, `.endsWith(".local")`) | RUNTIME R1: `http://10.attacker.example/v1` and `http://192.168.evil.com/v1` classify LOCAL_APPLIANCE/local; an unauthorized `http://10.attacker.invalid/v1` client attempts the request (network_error) whereas `http://attacker.invalid/v1` gets policy_denied. | Documented guarantee "a cloud endpoint that only a project `.env` chose is refused" (CLOUD_PROVIDERS.md Authority section) is bypassable with a DNS name; task content (prompts, file excerpts) goes to an internet host; egress quarantine also treats it as local. | Fix before v1: classify only IP literals by range (`net.isIP` + CIDR), treat hostnames as external unless loopback/`localhost` or operator-listed. |
| PRV-03 | S3 | error reporting / redaction | cli/src/client.ts:1636 (`shown = providerId ? redact+bound : body`); also 903, 1689 | RUNTIME R3: local endpoint 500 with 200 KB body -> InferenceError.message length 200095, contains `sk-ant-api03…` verbatim; agent prints it (agent.ts:4684-4686) and stores it in the failure record. | Huge HTML/proxy error pages flood the terminal/state; secrets echoed by a proxy/gateway reach logs. | Apply the same bound+redact to the legacy path and to listModels/embedding errors. |
| PRV-04 | S3 | streaming tool calls | cli/src/client.ts:1406 (`current.name += tc.function.name`) | RUNTIME R1 (`repeat-name`): server repeating the name in a later delta yields `read_fileread_file`. Prevalence across servers: INFERENCE (not verified on real LM Studio/llama.cpp/Ollama builds). | Unknown-tool error / wasted step with some OpenAI-compatible servers. | Assign name when empty, ignore if equal to current; add fixture. |
| PRV-05 | S3 | discovery / startup / search | client.ts:890-898 (listModels, no signal/timeout), 913 (listModelCatalog timeout only via caller signal), 1676 (generateEmbedding no timeout/signal); config.ts:214 autoDetectModel; embeddings.ts:299-305 per-chunk embedding loop; model_catalog.ts:93-100 race does not abort fetch | RUNTIME R1: listModels and generateEmbedding still pending after 3 s against an accepting-but-silent server. | A hung local server hangs model auto-detect and `hybrid_search` indefinitely (cancel cannot interrupt); an endpoint without embeddings gets up to one failing request per 40-line chunk (300 files). | Add AbortSignal.timeout + operator signal to all fetches; disable embeddings after first 404/501 for the session. |
| PRV-06 | S2 | standalone local inference | core/provider_capabilities.ts:29,72 (only `context_length`/`max_model_len` parsed; default 65536); agent.ts:4684-4689 (CAPACITY_REJECTED ends the turn) | SOURCE; INFERENCE on server behaviour: LM Studio `/v1/models` and llama.cpp `/v1/models` do not carry `max_model_len`, so standalone sizing is the 65536 default unless `--context-limit` is set. | On LM Studio/llama.cpp with a smaller loaded context the first large turn fails with a context error instead of compacting; user must know `--context-limit`. | Release-required: discover llama.cpp `/props` n_ctx and LM Studio `/api/v0/models` loaded context, or on CAPACITY_REJECTED compact and retry once with an actionable message. |
| PRV-07 | S3 | failure classification | core/provider_recovery.ts:82,106 | RUNTIME R1: llama.cpp body (`type: exceed_context_size_error`, "exceeds the available context size") -> REQUEST_REJECTED; vLLM body -> CAPACITY_REJECTED. | llama.cpp overflow not recognised as capacity (no `capabilitiesStale`, wrong guidance). | Add `exceed_context_size_error` and /context size/ to capacity rules. |
| PRV-08 | S3 | locality classification | egress.ts:129-141 | RUNTIME R1: `127.0.0.2`, bare LAN host `gpubox`, Tailscale `100.101.102.103` -> cloud. IPv6 ULA / `host.docker.internal` same by SOURCE. | Legit LAN/Tailscale/docker inference servers show a "Cloud inference" notice, are refused when chosen by project `.env`/fallback, and get EXTERNAL_PUBLIC egress handling; no "mark local" setting (NEXUS_CLOUD_DISCLOSURE_ORIGINS only authorizes). | Add `NEXUS_LOCAL_ORIGINS` (operator-only) and full loopback/CGNAT/ULA handling; document. |
| PRV-09 | S3 | empty stream | client.ts:1472-1476 (re-request), 1118-1135 (non-stream payload has no `max_tokens`) | RUNTIME R1 `empty`: chatHits=2, nonStream=1. Covered by provider_recovery test 16 (intentional). | A server that streams an empty completion is executed twice; the second request is uncapped on local endpoints (runaway generation possible). | Keep but send the same `max_tokens`; record it as a second execution in receipts/UI. |
| PRV-10 | S3 | timeouts | client.ts:744-747, 1627-1630 | SOURCE + RUNTIME (stall aborted at 1519 ms with LOCAL_LLM_TIMEOUT_MS=1500). | Single 900 s whole-request timeout: a stalled stream blocks 15 min; a legitimate >15 min local generation is killed and classified timeout/UNKNOWN -> replayed up to 2x (provider_recovery.ts:331-337). | Add idle (inter-chunk) and first-byte timeouts; make total timeout optional. |
| PRV-11 | S4 | homelab assumptions | client.ts:63-69 (`~/.config/opencode/t5820-client-token`), providers.ts:161 + client.ts:644-647 (X-Task-Class to every endpoint), client.ts:947 (`X-Nexus-Purpose`), CLOUD_PROVIDERS.md (`/model appliance engineering/b0`) | SOURCE | Harmless for standalone (token scoped to config.env origin; servers ignore headers) but homelab names leak into product/docs. | Rename/genericise before v1 docs; make gateway token path configurable. |
| PRV-12 | S4 | error typing | client.ts:1091-1094, 1110-1113, 1226-1229, 1490-1494 (plain `Error` on egress denial) ; 865 | SOURCE | Egress denial is failover-eligible (plain Error) and surfaces as protocol_error instead of policy_denied. | Throw InferenceError("policy_denied"). |
| PRV-13 | S4 | config | client.ts:785-793 (`addFallbackEndpoint` always appends /v1, ignores provider/pin) | SOURCE | Inconsistent with constructor normalisation; could add a fallback to a pinned provider connection if called. | Reuse normalizeEp + pin check. |
| PRV-14 | S4 | picker | model_catalog.ts:128-136, 170 | SOURCE | Key-less `compatible` (NEXUS_COMPATIBLE_AUTH=none, e.g. plain vLLM) never appears in the picker. | Honour declared auth=none. |
| PRV-15 | S3 | web search tool | search_web.ts:49,94 (DuckDuckGo default), 143-152 (returns success with a placeholder "result") | SOURCE | Queries leave to a public service by default; on no results the model receives a fabricated result object marked success. | Return success:false/empty; document the default destination; gate by disclosure policy. |
| PRV-16 | S4 | Responses parsing | protocols/openai_responses.ts:108 | SOURCE | `response.incomplete` with reason other than `max_output_tokens` (e.g. content_filter) is typed stream_incomplete/TEMPORARILY_UNAVAILABLE and may be replayed. | Map non-length incomplete reasons to REQUEST_REJECTED/refusal. |
| PRV-17 | S4 | docs | docs/CLOUD_PROVIDERS.md Limitations ("No model catalog cache") vs model_catalog.ts:51,86; Credentials ("error bodies are bounded and redacted") true only for provider connections (PRV-03); Authority claim (PRV-02); USER_MANUAL.md:3 "direct parity with OpenAI Codex and Anthropic Claude Code" | DOC-CLAIM vs SOURCE | Docs overstate guarantees. | Correct docs. |
| PRV-18 | S4 | TLS custom CA | no code path (grep NODE_EXTRA_CA_CERTS only in mcp.ts:62); docs silent | SOURCE; Node reads NODE_EXTRA_CA_CERTS only at process start (INFERENCE from Node behaviour) | HTTPS gateway with private CA: undocumented; the only "working" knob users will find is NODE_TLS_REJECT_UNAUTHORIZED=0. | Document NODE_EXTRA_CA_CERTS in launcher/config; optionally `NEXUS_CA_FILE`. |

## 4. Reproductions (mock servers on 127.0.0.1 only; HOME pointed at an empty scratch dir)
Scripts: scratchpad/prv/{probe.mts,tls.mts,err.mts}; run with `HOME=$PWD/home ../snap/cli/node_modules/.bin/tsx <script>`.

R1 probe.mts (LocalLlmClient.chatCompletionStream against mock OpenAI-compatible SSE server):
```
split OK "héllo wörld" (3-byte chunks, UTF-8 split)          no-done OK (finish_reason=stop, no [DONE])
no-finish ERR stream_incomplete TEMPORARILY_UNAVAILABLE       malformed ERR malformed_event PERMANENT_FAILURE
err-frame ERR provider_error_frame TEMPORARILY_UNAVAILABLE    drop ERR network_error (UND_ERR_SOCKET other side closed)
repeat-name OK tool_calls[0].function.name = "read_fileread_file"        <-- PRV-04
empty OK content "nonstream" chatHits=2 nonStream=1                        <-- PRV-09 (second execution)
stall (LOCAL_LLM_TIMEOUT_MS=1500) ERR timeout after 1519ms    slow-abort ERR aborted after 327ms
listModels hang: STILL PENDING after 3000ms                                <-- PRV-05
generateEmbedding hang: STILL PENDING after 3000ms                         <-- PRV-05
llama.cpp ctx overflow body -> REQUEST_REJECTED (vLLM body -> CAPACITY_REJECTED)   <-- PRV-07
dest http://10.attacker.example/v1 LOCAL_APPLIANCE local; http://192.168.evil.com/v1 LOCAL_APPLIANCE local   <-- PRV-02
dest http://127.0.0.2:8000, http://gpubox:8000, http://100.101.102.103:8000 -> EXTERNAL_PUBLIC cloud           <-- PRV-08
unauthorized http://10.attacker.invalid/v1 -> network_error (request attempted; no disclosure denial)
unauthorized http://attacker.invalid/v1   -> policy_denied
```
R2 tls.mts (project .env containing only `NODE_TLS_REJECT_UNAUTHORIZED=0`, then config.loadEnvironment()):
```
before loadEnvironment -> rejected: DEPTH_ZERO_SELF_SIGNED_CERT
NODE_TLS_REJECT_UNAUTHORIZED now: 0
server saw auth header: present
after loading project .env -> HTTP 200 (TLS NOT verified)                  <-- PRV-01
```
R3 err.mts (legacy endpoint returns HTTP 500 with 200 KB body containing an sk-ant-… string):
```
message length: 200095 contains sk-ant: true kind: http_error TEMPORARILY_UNAVAILABLE UNKNOWN   <-- PRV-03
```

## 5. Strengths (with evidence)
- Positive completion evidence required before any tool call runs: Chat Completions needs finish_reason or [DONE] (client.ts:1436-1443); Anthropic needs message_stop and all blocks closed (anthropic.ts:218); Responses needs response.completed and completed function_call items (openai_responses.ts:101,152). RUNTIME R1 (no-finish -> stream_incomplete) + TEST (cloud_providers "stream cut inside a tool call").
- SSE robustness: split chunks incl. inside UTF-8 sequences, CRLF, comments, multi-line data (common.ts:63-107; client.ts inline parser). RUNTIME R1 `split` (3-byte chunks) + TEST (Anthropic 3-byte fragmentation).
- output_truncated never executes partial tool calls and the agent asks for content in parts once (client.ts:1459-1468, agent.ts:4671-4682). TEST output_truncation_recovery (6/6), client_robustness.
- Cancellation propagates: AbortSignal combined with timeout on all inference fetches (client.ts:1627-1630), reader cancelled on error; RUNTIME R1 slow-abort -> `aborted` in 327 ms; recovery sleep/probe cancellable (provider_recovery.ts:203-219, 356-370).
- Well-specified failure taxonomy and bounded recovery: NOT_EXECUTED vs UNKNOWN, Retry-After/retry-after-ms/x-ratelimit-reset parsing, 20 min deadline, max 2 UNKNOWN replays, probe before replay, iteration bound (provider_recovery.ts). TEST provider_recovery 23/23, provider_recovery_agent 15/15.
- Credential scoping: stored gateway token bound to config.env origin; provider keys bound to provider origin; no cross-provider borrowing; redirects refused on provider connections; credentials.json 0600 atomic write; other clients' tokens never refreshed. TEST credential_boundary 4/4, credential_home 1/1, cloud_providers, provider_connect 12/12.
- Project `.env` cannot select a cloud provider / base URL (config.ts:53-63, 66-72); TEST cloud_providers.
- Standalone default works without the gateway: default endpoint `http://localhost:1234/v1` (config.ts:12; tracked cli/.env = LM Studio defaults, key "local"); `/tokenize`, admission headers and gateway advertisement are optional and absent-safe (provider_capabilities.ts:184-195; client.ts:977). TEST provider_capabilities "standalone" case.
- Cloud spend controls with honest cost confidence (usage.ts:85-101; refused rather than guessed).

## 6. Qualification gaps (not proven either way) + procedure
| Gap | Procedure |
|---|---|
| G1 No live evidence of standalone LM Studio / llama.cpp / vLLM / Ollama runs. `.nexus/inference_receipts.jsonl` (HISTORICAL, 2026-10-11..14) contains only provider-connection receipts: chatgpt 284 (281 completed), openrouter 12; local/appliance requests are never receipted (client.ts:561-569), so there is no machine-readable local evidence. | On a clean host with no `~/.config/nexus`, run each server with a small tool-capable model; `nexus run` a fixed 3-step edit task; capture `/status` context source, turn status, and transcript; repeat with the server's context set to 4096 to exercise PRV-06. |
| G2 Live cloud qualification limited to openrouter + chatgpt (docs/reviews/NEXUS_CLOUD_PROVIDERS_LIVE_QUALIFICATION_2026-10-11.md, HISTORICAL). openai, anthropic, copilot, compatible: mock-only. | `nexus providers verify --provider {openai,anthropic,copilot,compatible} --model <m> -j` with operator keys; archive JSON. |
| G3 Tool-call delta shapes of real servers (index omission, name repetition, arguments as object) — only synthetic fixtures. | Record raw SSE from LM Studio, llama.cpp (`--jinja`), vLLM (hermes/qwen parsers), Ollama; replay through chatCompletionStream as fixtures. |
| G4 Mid-stream transport drop after headers flushed: R1 `drop` surfaced as network_error (headers likely not flushed before destroy), so stream_interrupted path not re-proven here (unit-tested in provider_recovery_agent). | Mock that flushes headers + 1 chunk, waits 50 ms, then destroys; expect kind=stream_interrupted, partialText retained. |
| G5 HTTPS gateway with private CA. | Start node with NODE_EXTRA_CA_CERTS=<ca> against a local TLS mock; verify success, and failure without it (PERMANENT_FAILURE, not retried). |
| G6 Egress quarantine content effects on local vs "cloud"-classified LAN endpoints (PRV-08) — egress.ts evaluateEgress not reviewed in depth here. | Covered by security scope; diff outbound bodies for 192.168.x vs 100.64.x endpoints with a seeded secret. |

## 7. Proposed v1.0.0 requirements
| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| PRV-R1 | A project `.env` may only set an allowlisted set of non-security keys; `NODE_*`, `*_PROXY`, `HOME`, credential and timeout/recovery vars from it are ignored with a warning. | safety | BLOCKER | tls.mts (R2) must show TLS still rejected after loadEnvironment(); unit test per denied key. |
| PRV-R2 | Locality classification uses parsed IP ranges; hostnames are external unless `localhost`/operator-listed. | safety | BLOCKER | `10.attacker.example`, `192.168.evil.com` -> cloud + policy_denied when unauthorized; 10.0.0.5, 192.168.1.2 -> local. |
| PRV-R3 | All provider/endpoint error text is bounded (<=2000 chars) and redacted on every path. | safety/failure | RELEASE-REQUIRED | err.mts (R3): message <=2100 chars, no `sk-` substring. |
| PRV-R4 | Every network call (models, catalog, embeddings, tokenize, inference, oauth) has a timeout and honours operator cancel. | failure | RELEASE-REQUIRED | probe.mts hang cases reject within configured timeout; cancel test. |
| PRV-R5 | Standalone LM Studio, llama.cpp and vLLM complete a scripted tool-using task with no homelab config; context limit discovered or a context overflow yields compaction-and-retry or an actionable `--context-limit` message. | workflow/compat | BLOCKER (evidence) | G1 procedure, archived transcripts per server. |
| PRV-R6 | Streaming parser tolerates repeated tool names and object-typed arguments; recorded real-server SSE fixtures in CI. | compat | RELEASE-REQUIRED | G3 fixtures pass; repeat-name yields `read_file`. |
| PRV-R7 | Idle/first-byte stream timeout separate from total timeout; replays of timed-out long generations bounded and visible. | failure | RELEASE-REQUIRED | Mock stalls after first chunk -> timeout at idle limit; 20-min trickle stream not killed when total timeout disabled. |
| PRV-R8 | Context-overflow classification covers vLLM, llama.cpp, LM Studio, Ollama messages. | compat | RELEASE-REQUIRED | classifyHttpFailure table test with recorded bodies -> CAPACITY_REJECTED. |
| PRV-R9 | Live `providers verify` PASS for each provider listed as supported in docs, or the doc lists it as mock-only/experimental. | compat/docs | RELEASE-REQUIRED | Archived verify JSON per provider. |
| PRV-R10 | Docs match behaviour: remove homelab ids, fix catalog-cache and redaction claims, document custom CA and LAN/Tailscale locality setting. | docs | RELEASE-REQUIRED | Doc review checklist against PRV-11/17/18. |
| PRV-R11 | Empty-stream re-request sends the same output cap and is reported as a second execution. | failure | POST-V1 | probe.mts `empty`: non-stream body contains max_tokens; receipt/UI shows 2 executions. |

## 8. Commands run
- Reads: `cat -n`/`sed -n` of scope files in scratchpad/snap/cli/src (see ledger); grep for TLS/CA/proxy, callers of executeWebSearch/HybridSearchEngine, CAPACITY_REJECTED.
- `git ls-files cli/.env cli/.env.example` + keys-only/redacted inspection of tracked `cli/.env` (in /home/mike/nexus-code, read-only).
- Receipt summary: `python3 -I -c '<count by provider/origin/outcome>' .nexus/inference_receipts.jsonl` (no values printed beyond ids/origins).
- Probes (scratchpad/prv, mock servers on 127.0.0.1 ephemeral ports, HOME=scratch empty dir): `tsx probe.mts`, `tsx tls.mts` (self-signed cert via `openssl req -x509 ... -subj /CN=127.0.0.1`), `tsx err.mts`.
- Targeted tests (snap/cli, HOME=scratch): `tsx --test test/<f>.test.ts` for client_robustness 8/8, cloud_providers 44/44, provider_recovery 23/23, provider_recovery_agent 15/15, credential_boundary 4/4, credential_home 1/1, provider_capabilities 10/10, provider_connect 12/12, output_truncation_recovery 6/6, config 2/2 — 125/125 pass (fixture/mock evidence only).
- No requests sent to 10.0.8.5 or any cloud provider.
