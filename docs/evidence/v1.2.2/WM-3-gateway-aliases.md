# WM-3: what the gateway's five aliases actually are (2026-11-20)

**Finding:** the gateway lists five model aliases, but they are not five different models. A chat completion sent to each alias
returned a `model` field naming the model that served it:

| Alias asked for | `model` in the response | Advertised `max_completion_tokens` |
|---|---|---|
| `engineering/b0` | `engineering/b0` | 8192 |
| `engineering/lead` | `engineering/b0` | 8192 |
| `engineering/lead-reasoning` | `engineering/b0` | 16384 |
| `engineering/interactive` | `engineering/b0` | 1024 |
| `engineering/deep` | `engineering/deep` | 12288 |

So the gateway serves **two distinct models**, `b0` and `deep`. `lead`, `lead-reasoning` and `interactive` are routes to `b0` with
different limits (and, for `lead-reasoning`, a different advertised reasoning behaviour). Per-alias results therefore are not
independent samples of three more models.

## How it was observed

One `POST /v1/chat/completions` per alias (`max_tokens` 8 or 16, prompt "say ok"), reading the response's `model` field; the
catalog from `GET /v1/models` for the advertised limits. Single observation, 2026-11-20, gateway `10.0.8.5`. Nothing was
inferred from timing. The routing could change; it is a snapshot, not a guarantee.

## What it means for the backlog row

- WM-3 ("extend the G1.1-4 matrix to every alias the gateway serves") is **measured** for all five aliases in
  `docs/evidence/v1.2.1/G1.1-4-v1.2.1-other-aliases.md` and the rc.2 run, but that evidence covers two models, not five. Say
  "five aliases, two underlying models" when citing it.
- **Decision (owner, 2026-11-21): keep the runner's strict pass rule.** An alias served with reasoning off cannot satisfy the
  hybrid-reasoning check, and the runner keeps marking it `passed: false` for that check alone; tool-call validity (the G1.1-4
  quantity) is reported separately and stays 200/200 native valid on all five. No reasoning-aware rule was added, so the
  qualification pass rule is not weakened.
- Live eval runs on `lead` and `deep` (`docs/evidence/change-cost-live-2026-11-18/`) are therefore two-model evidence.

## Update, 2026-11-21: seven aliases, three models

The operator added a third model on a separate host. `GET /v1/models` at 20:20Z lists seven aliases, and each entry now names
the workers that serve it (`serving[].worker_id`, `pool`, `model_id`):

| Alias | Served by (pool: model) | Context | Advertised `max_completion_tokens` | Reasoning |
|---|---|---|---|---|
| `engineering/b0` | lead: `Qwen3.6-35B-A3B-UD-Q4_K_M` | 65536 | 8192 | off |
| `engineering/lead` | lead | 65536 | 8192 | off |
| `engineering/lead-reasoning` | lead | 65536 | 16384 | on |
| `engineering/deep` | deep: `Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M` | 65536 | 12288 | on |
| `engineering/interactive` | lead **and** deep | 65536 | 1024 | off |
| `engineering/interactive-rocm` | rocm: `qwen3-coder-30b-a3b-instruct-q8_0` (new) | 16384 | 8192 | off |
| `engineering/auto` | lead, deep **and** rocm | 16384 | 8192 | off |

What follows from it:

- Three distinct models. `auto` and `interactive` can be answered by more than one of them, so a result on either alias is not
  a result for one model unless the response's `model` field is recorded per request.
- `deep` and `lead-reasoning`, the two aliases the release measurement uses, are each served by one worker.
- `auto` advertises a 16384-token context, a quarter of the other routes.
- This is the catalog's own statement, read once. No completion was sent after the change, so the table at the top (which model
  *answered* each alias on 2026-11-20) was not re-observed, and nothing recorded before this date covers the third model.
