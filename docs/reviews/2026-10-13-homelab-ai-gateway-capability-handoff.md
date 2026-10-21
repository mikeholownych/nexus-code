# Gateway capability handoff: request counting equivalent to admission

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

**From:** nexus-code (`feat/compaction-continuity`, base `a58f860`). **To:** homelab-ai maintainers.
**Status:** read-only finding; nothing in homelab-ai was changed, deployed or promoted. Nexus works without any of
this. It is an integration improvement, not a dependency.

## Contract inspected

- homelab-ai `/home/mike/Projects/aihost` at `fb1a2cd95a53d3f084e1c98042f2212906622a9e` (`main`, clean).
- Deployed release `t5820-gateway-b72a4f5` (`inventory/production/host_vars/ai-5820-01.yml:257`); no later commit
  touches `orchestrator_runtime/` or `orchestrator_gateway/`.
- Verified live on 2026-10-13 from the development host (10.0.8.95) through Nexus's own client:
  - `GET /v1/models` for `engineering/b0` advertised:
    - `context_length` 65536 and `max_completion_tokens` 8192;
    - `limits_version` `a3c2fcbc2f2b977c`;
    - one serving worker, `b0-live-llama-worker1`.
  - `POST /v1/tokenize` returned `source: "exact"` with the worker id: 4420 prompt tokens with Nexus's tool
    definitions, 23 without them.

## What Nexus uses today

Nexus uses each part of the contract as it stands:

- **Capacity and output allowance**: from `/v1/models`. They are refreshed when the model, `limits_version`, the
  serving workers or the observed capacity change.
- **Pre-dispatch counting**: Nexus `POST`s the exact chat body it is about to send (messages, tools, `tool_choice`,
  temperature, `max_tokens`) to `/v1/tokenize`, on the same endpoint and with the same bearer as inference.
- **Post-dispatch evidence**: Nexus reads the admitted count and route from the inference response headers
  (`X-AIHost-Prompt-Tokens`, `-Prompt-Tokens-Source`, `-Route`, `-Context-Limit`, `-Limits-Version`).

## Requirement the current contract cannot satisfy

> For supported request counting, distinguish an exact count on the sampled worker from an exact count for the
> subsequently admitted inference request.

`/v1/tokenize` cannot give the second.

- **How tokenize picks a worker**: the first worker in the alias's `serving` list that is not capacity-blocked
  (`orchestrator_runtime/runtime.py:1070-1075`).
- **What it skips**: the router (`X-Task-Class`, attempt and previous-outcome escalation, canary, affinity, load),
  drain, circuit-breaker and model-RBAC checks.
- **What it counts**: the **raw** request, without `reasoning_policy.apply`.
- **What inference does instead** (`runtime.py:1441-1497`, `_plan` at `1109-1141`):
  1. It routes.
  2. It picks an eligible worker, with affinity.
  3. It rewrites `chat_template_kwargs.enable_thinking` and `thinking_budget_tokens` (`reasoning.py:96-107`).
  4. Only then does it count and admit, re-planning if admission grants a different worker (`runtime.py:1539-1547`).

**Consequences:**

- A count can come from a different worker than the one that serves the request. For example, `X-Task-Class: review`
  routes `engineering/b0` to the deep pool while tokenize counts on lead.
- A count can come from a different template input (`enable_thinking`).
- Nexus therefore labels a pre-dispatch count `exact_sampled_worker`, never "exact for this request".
- Only the post-dispatch header count (`exact_admitted`) is exact for the admitted request, and it arrives after the
  fact.
- Strict counting (`--strict-token-count`) can require a worker count, but cannot require an admission-equivalent one.

### Related gaps found while reading

1. The vLLM adapter's tokenize omits `tool_choice` and `response_format` (`engines.py:162-170`); llama.cpp includes
   them (`engines.py:18`).
2. `limits_version` in `/v1/models` is an alias-level hash of per-worker versions that does not include the reasoning
   policy (`runtime.py:1050`). The `X-AIHost-Limits-Version` inference header carries the **per-worker** version. The
   two cannot be compared directly: live, the alias was `a3c2fcbc2f2b977c` and the per-worker header was
   `15ce8141d79a3260` for the same worker.
3. `POST /v1/tokenize` answers 404 `{"status":"not_found"}` both for an unknown model and when every worker of the
   alias is blocked (`runtime.py:1080`). A client cannot tell "unsupported" from "temporarily unavailable". Nexus
   treats a 404 that mentions blocking or capacity as unavailable, and other 404s as unsupported.
4. The tokenize response has no field saying which policy produced the count.

## Capability that would close it (proposal for homelab-ai to decide)

A counting mode equivalent to admission, as an optional addition. Existing clients keep working.

- `POST /v1/tokenize` with an opt-in (for example `"plan": "inference"`, or a header) that runs the same `_plan`
  inference would run: route with the request's `X-Task-Class` and other routing inputs, select the worker with the
  same eligibility checks, apply the reasoning policy, then count. It would return:
  - `worker_id` and `pool`;
  - the per-worker `limits_version`;
  - the effective `chat_template_kwargs` (or a digest of them);
  - `source`: `exact` / `estimated_conservative`;
  - a field such as `planned: true` stating the count used the inference plan.
- Optionally, a short-lived plan token returned by tokenize and accepted by `/v1/chat/completions` (or the existing
  `X-AIHost-Worker` pin, extended to tokenize) so the counted plan is the admitted plan.
- Distinct statuses for "unknown model" and "no eligible worker now" (for example 404 and 503).
- The vLLM tokenize adapter passing `tool_choice` and `response_format`, like llama.cpp.

**What Nexus would do with it:** label such counts `exact` (admission-equivalent) and allow strict counting to require
them. The change would sit in `cli/src/core/provider_capabilities.ts` (`parseTokenizeResponse`) and
`cli/src/client.ts` (`countRequestTokens`). Without it, Nexus keeps the current labels and the post-dispatch
comparison. Standalone operation is unaffected either way.
