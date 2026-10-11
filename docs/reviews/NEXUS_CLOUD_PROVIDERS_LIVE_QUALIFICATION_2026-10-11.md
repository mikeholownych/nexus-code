# Cloud providers — live qualification (2026-10-11)

Build: branch `feat/cloud-providers` at `1310e3a` (cli/dist). Command: `nexus providers verify --provider <id> --model <m> -j`
(streamed completion, a tool call with a nonce, and a tool-result round trip; no workspace content sent).
Credentials were the operator's existing connections, read in place by Nexus; neither file was modified
(`~/.codex/auth.json` mtime 2026-10-02, `~/.local/share/crush/crush.json` mtime 2026-03-29) and no Nexus credential
store was written.

| Provider | Connection source | Protocol | Model | Result (UTC) |
|---|---|---|---|---|
| openrouter | crush `providers.openrouter.api_key` | OpenAI Chat Completions | `openai/gpt-4o-mini` | PASS 3/3, 2026-10-11T16:14:12Z |
| chatgpt (unofficial sign-in) | Codex CLI `~/.codex/auth.json` | OpenAI Responses, ChatGPT Codex backend | `gpt-5.6-luna` | PASS 3/3, 2026-10-11T16:14:17Z |

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
