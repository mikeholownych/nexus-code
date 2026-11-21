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

## Update, 2026-11-21

The operator reported that a third model, on a separate host, was added to the gateway behind the `engineering/auto` route, so
the gateway now serves three distinct models. `GET /v1/models` on 2026-11-21 still lists the same five aliases with the same
limits; `engineering/auto` is not in the catalog. The table above was not re-observed after the change: which model answers
each alias now is unmeasured, and nothing recorded before this date covers the third model.
