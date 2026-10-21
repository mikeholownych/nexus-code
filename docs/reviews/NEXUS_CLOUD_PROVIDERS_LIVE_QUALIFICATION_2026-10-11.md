# Cloud providers — live qualification (2026-10-11)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Build: branch `feat/cloud-providers` at `1310e3a` (cli/dist). Command: `nexus providers verify --provider <id> --model <m> -j`
(streamed completion, a tool call with a nonce, and a tool-result round trip; no workspace content sent).
Credentials were the operator's existing connections, read in place by Nexus; neither file was modified
(`~/.codex/auth.json` mtime 2026-10-02, `~/.local/share/crush/crush.json` mtime 2026-03-29) and no Nexus credential
store was written.

| Provider | Connection source | Protocol | Model | Result (UTC) |
|---|---|---|---|---|
| openrouter | crush `providers.openrouter.api_key` | OpenAI Chat Completions | `openai/gpt-4o-mini` | PASS 3/3, 2026-10-11T16:14:12Z |
| chatgpt (unofficial sign-in) | Codex CLI `~/.codex/auth.json` | OpenAI Responses, ChatGPT Codex backend | `gpt-5.6-luna` | PASS 3/3, 2026-10-11T16:14:17Z |
| chatgpt (unofficial sign-in) | Codex CLI `~/.codex/auth.json` | OpenAI Responses, ChatGPT Codex backend | `gpt-6-luna` | PASS 3/3, 2026-10-11T16:23:15Z (after the temperature fix below) |

Model discovery before the checks: OpenRouter listed 458 models; the Codex backend listed 7.

Receipts (sanitized request ids, provider-reported usage):

| Provider | Step | Request id (prefix) | In / out tokens | Cost |
|---|---|---|---|---|
| openrouter | completion | `gen-1791735250-M9c2Mdz1` | 14 / 1 | $0.0000027 (provider-reported) |
| openrouter | tool call | `gen-1791735251-J6liJSuG` | 92 / 18 | $0.0000246 (provider-reported) |
| openrouter | round trip | `gen-1791735252-nmLxYEBi` | 125 / 15 | $0.00002775 (provider-reported) |
| chatgpt | completion | `resp_018faf0aac359a8c` | 13 / 5 | unknown (plan; not reported) |
| chatgpt | tool call | `resp_054955e09d2ef5dd` | 96 / 23 | unknown |
| chatgpt | round trip | `resp_0b3ce98e945a2905` | 138 / 17 | unknown |

Not qualified live: `openai` and `anthropic` (no API keys configured), `copilot` (no Copilot sign-in on this machine),
`compatible`. A connectivity check is not evidence of task-completion quality.

## Defect found in operator use: `temperature` sent to `gpt-6-luna`

`/model chatgpt gpt-6-luna` then a task failed with `HTTP 400 {"detail":"Unsupported parameter: temperature"}`.
`temperature` was decided by a model-name pattern (`o\d|gpt-5`) that `gpt-5.6-luna` matched and `gpt-6-luna` did not.
Fix: the `chatgpt` provider declares `temperature` and `max_output_tokens` as never sent; the name rule covers every
generation from gpt-5 on and Codex models; and a provider connection that is told an optional parameter is
unsupported (400, request not executed) drops it, remembers it for the session, and resends once. Regression tests
fail on the previous source (3/5) and pass after; live re-check on `gpt-6-luna` passed (receipts
`resp_00448a85a9bf…`, `resp_09fe100a817d…`, `resp_07b5b4d3b6e6…`).
