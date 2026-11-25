# AC-2 — ACP client conformance

Status: **complete for the AC-2 acceptance criteria at the recorded candidate revision.** Two independently implemented real ACP clients completed the basic flow against the Nexus ACP adapter. Their normalized exchanges are committed as replayable fixtures. No live model/provider was used. This is protocol/client conformance evidence; it is not a claim that every ACP capability or production deployment configuration is verified.

## Scope and baseline

- Repository: `https://github.com/mikeholownych/nexus-code`
- Branch: `codex/ac2-acp-conformance`
- Candidate revision used by both real client captures: `2e84942207a79a697637ffcdd70ae7b9257417f3`
- AC-2 acceptance in `docs/v1.3.0/PLAN.md`: fixture suite plus two real ACP client runs; both complete the basic flow; fixtures committed.
- Selected under D14's Linux/account-free criterion: Zed and Neovim with CodeCompanion.nvim.
- Both clients ran on Linux and connected to `node cli/dist/index.js acp`. Each was launched in a disposable temporary workspace and isolated user-data/config directory.

## Client runs

| Client | Exact build/source | Observed flow | Result |
|---|---|---|---|
| CodeCompanion.nvim 20.3.0 in Neovim 0.12.6 | CodeCompanion commit `0ba3b39a9c21ae1d6e93bb3e1c39aeaad3fadf12`; Plenary `74b06c6c75e4eeb3108ec01852001636d85a932b`; Neovim archive SHA-256 `474430d53e6264f6d6dd18db42d6dc9df3a1b56ca9e88a325bbf860e1a811d87` | `initialize`, `session/new`, `session/prompt`, streamed `session/update`, prompt result `end_turn` | PASS |
| Zed 1.29.3 | build `d01b134cddf5e4f71964deb2d6f81cdb38fcf1e7`; archive SHA-256 `44b0f350aa7bf4551d1b0aaa2d3b673a6de2c03bc5e979b3592fd2180b4f77c1` | `initialize`, `session/new`, `session/prompt`, streamed `session/update`, prompt result `end_turn` | PASS |

Each completed response was `AC2 local fixture completed.` from a deterministic OpenAI-compatible mock bound to loopback. The isolated Nexus configuration named only the loopback endpoint and fixture model; it contained no API key and no hosted endpoint. The mock recorded three HTTP requests total: an exploratory discarded CodeCompanion turn, the corrected CodeCompanion turn, and the Zed turn. No provider account or paid inference was used. The request capture did not record HTTP headers, so this evidence does not make a claim about the presence or absence of an Authorization header.

The successful client conversations each contain nine JSON-RPC messages across client-to-agent and agent-to-client directions. Raw-capture SHA-256 values are recorded in the fixture metadata. The committed fixture files contain normalized message IDs/session IDs and replace workspace paths with a placeholder:

- `cli/test/fixtures/acp/clients/codecompanion-20.3.0.json` — SHA-256 `8265b539bb0ba25180183dd736a4d44a36807810cda127735578bf9a04cf0bbc`
- `cli/test/fixtures/acp/clients/zed-1.29.3.json` — SHA-256 `f5f9d8e5e3a293173312fe21716ea4a8f72330f772a0cd12e4817f2836c746b6`

## Reproduction and automated replay

The temporary client installations, disposable workspace roots, raw captures, local mock service, and isolated HOME directories were under `/tmp/nexus-acp-ac2.BYqqFx`; they are not project data. The committed test replays each captured client-to-agent request sequence through the real `AcpStdioServer`, with a deterministic local gateway and a fresh temporary workspace/config. It checks request/response IDs, protocol version, session creation, streamed assistant content, completed verification metadata, `end_turn`, one inference request, and no response after closing the adapter.

Focused replay command, run from `cli/` with a disposable HOME:

```sh
test_home=$(mktemp -d /tmp/nexus-acp-ac2-test-home.XXXXXX)
mkdir -p "$test_home/.config"
HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" node --import tsx --test test/acp_client_conformance.test.ts
```

Observed focused result: **2 tests, 2 passed, 0 failed**, exit status 0. `npm --prefix cli run build` also completed successfully after adding the test. The focused replay is independent of the two real GUI client runs: it exercises the committed captures through the adapter but does not replace those client sessions.

## Safety and deviations

- No production source or configuration was changed for this work; the additions are the evidence document, two fixtures, and the replay test.
- One initial CodeCompanion probe inherited the AC-2 checkout as its working directory, so that client loaded the checkout's `AGENTS.md` rather than the disposable fixture workspace. That capture was discarded. It made no tool calls and changed no files. The client was rerun with its process launched in a disposable workspace; only the corrected capture was committed.
- Zed required a temporary software Vulkan driver extracted under `/tmp`; no system package was installed. The isolated Zed user-data settings disabled telemetry and automatic updates for the successful run. A prior setup attempt had placed settings in a directory Zed did not use; the telemetry log under the corrected user-data directory was empty at final inspection. This does not establish what the earlier setup attempt transmitted.
- No hosted inference, credentials, or live user workspace was used. The loopback mock was the only inference endpoint for the successful captures.

## Verification environment limitation

A separate CI-equivalent `make test` run in `/home/mike/nexus-wt/context-maturity-v130` completed its security lifecycle gates but failed the CLI suite in two unrelated tests: `cli/test/dv2_convergence.test.ts` (“an ENVIRONMENT failure repeated never trips it”) and `cli/test/dv1_structured_attempts.test.ts` (“an ENVIRONMENT failure is not skipped on unchanged inputs and the model sees the classification”). That run was on another branch/worktree and is not evidence of an AC-2 regression or a green full-suite result for this candidate. Full-suite acceptance on this exact AC-2 revision therefore remains unestablished.

## Reference coding

XERJ was queried for ACP wire-fixture patterns. OpenCode's local reference at `packages/cli/test/acp/wire-fixture.ts:38-60` records wire forms and drives the actual protocol implementation with a deterministic backend. Goose's `test_acp_client.py:192-214` checks initialization, capabilities, session creation, and a prompt using a real ACP client. These patterns informed the separation between captured traffic and deterministic replay; no peer code was copied.

Public protocol/client references:

- ACP client catalog: <https://agentclientprotocol.com/get-started/clients>
- Zed external ACP agents: <https://zed.dev/docs/ai/external-agents>
- CodeCompanion ACP behavior: <https://codecompanion.olimorris.dev/agent-client-protocol>
- CodeCompanion adapter configuration: <https://codecompanion.olimorris.dev/configuration/adapters-acp>
