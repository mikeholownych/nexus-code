# RC10 OpenRouter provider verification

Disposition: `PASS` for the three provider verification checks performed against the exact installed RC10 artifact. This does not by itself establish provider live-task acceptance; see `../openrouter-live-task/README.md`.

- Candidate: `v1.0.0-rc.10`, source commit `16ee8ca3643824741b6da67936b41f262414fdf0`.
- Installed RC10 reported `1.0.0-rc.10 (16ee8ca36438)` on `ubuntu-desktop` (`10.0.8.3`).
- Provider/model: OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Result time: `2026-10-27T02:27:10.627Z`.
- Passed checks: streamed completion, tool call, and tool-result round trip.
- Three provider receipts are preserved in `openrouter-receipts-20261027T022710Z.jsonl`; each records the exact model and provider-reported cost `$0`.
- Verification JSON and receipt hashes: `3b14fdc568ca9daa6f10582e090bbab447ab230a4aae42d24dac95166374e88e` and `de74a7052f03a63faddacc2dc8bb1cd0288328d633ed203ceecd4d3e0737d9e1`.

These records cover the provider verification path only. The synthetic task and its failed attempts are separately documented, and all held-out, long-task, fault-injection, terminal, cross-runner, independent acceptance, and stable-release gates remain outside this result.
