# RC10 provider verification

## OpenRouter

Disposition: `PASS` for the three provider verification checks performed against the exact installed RC10 artifact. This does not by itself establish provider live-task acceptance; see `../openrouter-live-task/README.md`.

- Candidate: `v1.0.0-rc.10`, source commit `16ee8ca3643824741b6da67936b41f262414fdf0`.
- Installed RC10 reported `1.0.0-rc.10 (16ee8ca36438)` on `ubuntu-desktop` (`10.0.8.3`).
- Provider/model: OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Result time: `2026-10-27T02:27:10.627Z`.
- Passed checks: streamed completion, tool call, and tool-result round trip.
- Three provider receipts are preserved in `openrouter-receipts-20261027T022710Z.jsonl`; each records the exact model and provider-reported cost `$0`.
- Verification JSON and receipt hashes: `3b14fdc568ca9daa6f10582e090bbab447ab230a4aae42d24dac95166374e88e` and `de74a7052f03a63faddacc2dc8bb1cd0288328d633ed203ceecd4d3e0737d9e1`.

## ChatGPT sign-in

Disposition: `PASS` for the three provider verification checks performed against the exact installed RC10 artifact. This is provider verification only and does not establish standalone task acceptance.

- Candidate: `v1.0.0-rc.10`, source commit `16ee8ca3643824741b6da67936b41f262414fdf0`.
- Installed RC10 reported `1.0.0-rc.10 (16ee8ca36438)` on `ubuntu-desktop` (`10.0.8.3`).
- Artifact: Linux x86-64 RC10 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`; the installed path and provenance verification are recorded in the [RC10 terminal installation preflight](../terminal-manual-preflight/README.md).
- Provider/model: ChatGPT sign-in, `gpt-6-luna`, using the Codex CLI sign-in path.
- Result time: `2026-10-28T19:03:04.954Z`.
- Passed checks: streamed completion, tool call, and tool-result round trip. The command sent no workspace content.
- Provider-reported usage was recorded; cost confidence is `unknown`, so no cost amount is claimed.
- Verification JSON and receipt records are preserved in `chatgpt-verify-20261028T190304Z.json` and `chatgpt-receipts-20261028T190304Z.jsonl`. Verification JSON SHA-256: `9715c7bce7d88f8dca36ee62d3cecdf27842a19b7b5fd5d74f531198085d5993`.

These records cover the provider verification path only. The synthetic task and its failed attempts are separately documented, and all held-out, long-task, fault-injection, terminal, cross-runner, independent acceptance, and stable-release gates remain outside this result.
