# Evidence manifest and limitations

**Audit:** 2026-10-14. **Revision tested:** `db1ca55` (`main`; `git describe`: `v0.1.0-alpha.2-2-gdb1ca55`).

Every conclusion in this package carries one of these evidence labels, as defined in REQUIREMENTS §1:

- SRC: source inspection
- TEST: automated test
- RT: live runtime observation
- MEAS: measurement
- DOC: documentation claim
- HIST: historical or reported evidence
- INF: inference
- UNV: unknown or unverified

This file records what was actually run, on which build, with which outputs, and what each result does and does not prove.

## 1. Build and runtime identity

| Item | Identity |
|---|---|
| Source | `db1ca55`. Exported with `git archive` to `<scratch>/snap` (non-git), and separately cloned to `<scratch>/clone`, checked out at `db1ca55`. |
| Toolchain | node v24.21.0, npm 11.19.0, cargo/rustc 1.95.0 (2026-03/04), Ubuntu with kernel 6.8.0-142, glibc 2.39, Intel Xeon X5650 (12 threads), 46 GB RAM |
| `harness-core` (release build from HEAD) | sha256 `cbea89b952c923a2f41529a7b13374a6e60b60c151b9ed9e4aaaead33101112f`. Identical in the snap and clone builds. |
| `nexus-tui` (release build from HEAD) | sha256 `17bc19f69a154ceeab5c4bee01b1ed69462545d878e3d52f4c097086ab3641da`. Identical in the snap and clone builds. |
| Checkout `cli/dist` | `node cli/dist/index.js --version` gives `0.1.0-alpha.2 (db1ca5580860, main)`. It is byte-identical to a fresh build, except the untracked `build-info.json` (E §4). |
| Published package used for installer checks | `v0.1.0-alpha.2` (`a2e94f3`). Assets: `nexus-linux-x86_64-v0.1.0-alpha.2.tar.gz` and `SHA256SUMS`. Installed in scratch HOMEs, plus the operator's existing `~/.local/lib/nexus/v0.1.0-alpha.2` (read only). |
| Live cloud client | Checkout build `db1ca55` (`/home/mike/nexus-code/cli/dist`), using the operator's existing provider connections: ChatGPT via the Codex CLI sign-in; OpenRouter via the crush credential. |

## 2. Baseline build and test runs

| Run | Environment | Commands | Outcome | Archive |
|---|---|---|---|---|
| B1 | `<scratch>/snap` (non-git export) | `npm ci`, `cargo test --locked`, `npm run build`, `npm test`, `security_gates.sh`, `cargo build --release` (that order), 09:34–10:01 UTC | Rust 266/266 pass. CLI 893/905: **12 failures, all environmental**. The PTY suites ran before the release binary existed (failing in about 5 ms each). The git-dependent tests had no `.git`. The security gate failed on `git diff` outside a repository. | `evidence/baseline/baseline.log` |
| B2 | `<scratch>/clone` (git, `db1ca55`), CI order: release build before CLI tests | `npm ci`; build; `cargo test --locked`; `cargo build --locked --release --bin harness-core --bin nexus-tui`; `npm test`; `security_gates.sh`, 12:42–13:06 UTC | **Rust 266/266, CLI 905/905, security gates PASS**, working tree clean afterwards. CLI suite duration 1,169 s. | `evidence/baseline/baseline2.log` |
| CI (historical, read only) | GitHub Actions run 38540767677 | — | 905/905. Real `cargo audit` ran (1,310 advisories, 152 crates). | E §4 |

**What this proves:** the code at `db1ca55` passes its own suites when run in CI order.

**What it does not prove:** that the suites cover the defects listed in AUDIT §5. Most of those defects pass the existing suites.

## 3. Live runs (owner-authorized small spend, 2026-10-14, on `db1ca55`)

| Run | Command | Result | Request ids | Archive |
|---|---|---|---|---|
| L1 | `nexus providers verify --provider chatgpt -m gpt-6-luna -j` | PASS: streamed completion, tool call, tool-result round trip | `8e910140…`, `1e6c5946…`, `d8595745…` | `evidence/live/verify_chatgpt.json` |
| L2 | `nexus providers verify --provider openrouter -m openrouter/free -j` | PASS. The effective model varied per request (nemotron-3-super, then laguna-xs-2.1, then laguna-s-2.1), which shows `openrouter/free` is unsuitable for matched evaluation. | `49b71fc3…`, `b05711f6…`, `2b9cc6c5…` | `evidence/live/verify_openrouter.json` |
| L3 | Throwaway git repo with a broken `add` and a `node:test` test. `NEXUS_PROVIDER=chatgpt NEXUS_MODEL=gpt-6-luna nexus run "...fix it so the existing test passes. Do not modify the test."` | `TASK COMPLETED - VERIFIED (npm test)`. The fix is correct and the test is unmodified, so the label is truthful. It took 7 requests, 83,331 input and 376 output tokens, 18 s. The run also showed: `npm test` executed without approval (SEC-01/VER-01 confirmed live); `.nexus/` left untracked in the workspace (PER-06); `context_limit=65536 (client_default)` (PRV-06b). | see log | `evidence/live/run1_chatgpt_bugfix.log` |

No request was sent to the homelab gateway. All other inference behaviour in this package comes from mocks and fixtures (B §4, D, A2) or from historical records (labelled HIST).

## 4. Scoped audit evidence

| File | Scope | Notable runs |
|---|---|---|
| `evidence/A_core_agent.md` | Agent loop, continuity | `repro/agt_repro.test.ts` (R1, R2, R4) |
| `evidence/A2_verification.md` | Parser, verifier, tokens | `a2probe/{parser,tester,tokens,stager}_probe.ts`; 8 targeted test files (53/54; the 1 failure is environmental) |
| `evidence/B_providers.md` | Providers and inference | `prv/{probe,tls,err}.mts` against 127.0.0.1 mocks; 125/125 targeted tests |
| `evidence/C_tools_security_persistence.md` | Tools, security, persistence | harness-core path-jail calls; classifier probes (`probes/p1.mjs`); SSRF probe (`probes/p2.mjs`); orphan test; memory measurements; read-only stat of `~/.nexus` |
| `evidence/D_terminal.md` + `evidence/D_pty/` | Terminal | Real-PTY scripts s1–s9 and r1a–r1d against `mockgw.py`; `pyte` screen dumps |
| `evidence/E_distribution.md` | Distribution and doctor | 6 scratch-HOME installs; docker `ubuntu:22.04` (no node, node 12); upgrade and rollback; doctor and repair runs; CI log |
| `evidence/F_requirements_history.md` | Requirement provenance | 19 claim spot-checks against HEAD; `gh issue list` (0 issues) |
| `evidence/G_contest_eval.md` | Contest and eval | `npm test --prefix demo`; slice and Worker builds; broker tests; `sha256sum -c` (bundle FAILED, experiment archives OK); `gpgv` |
| `evidence/BRIEF.md` | Instructions given to the scoped auditors | — |

The probe and repro scripts contain absolute paths into the audit scratchpad. Re-point `SNAP` / `S` at a fresh export of the commit to re-run them.

## 5. Side effects of the audit (disclosed)

1. **The real `~/.nexus/tasks` grew** from 52,687 files (measured during the audit) to 53,208. Most of this came from baseline runs B1 and B2: the suite writes into the real HOME (PER-03). Live run L3 also added records. These records point at `/tmp/nexus-*-test-*` or scratchpad workspaces and are safe to remove (owner action X8).
2. **Live provider receipts** were written to `<scratch>/live/.nexus/` and `<scratch>/live/ws1/.nexus/`, not to the repository.
3. **Files created or changed in the repository.** The audit created `docs/v1.0.0/**`. At the owner's request, it appended a short "v1.0.0 work and concurrent agents" section to the root `AGENTS.md`, without changing the existing content. Nothing else in the repository was modified.
   - `nexus-continuity-validation/` (untracked, the operator's) and both stashes are untouched.
   - The stale local tags were deleted by the **owner**, not by the audit (X1).
   - The package also updated the agent memory note about which `nexus` binary is first on PATH. That note lives outside the repository.
4. **Processes.** Scoped auditors started mock servers and test `sleep` processes and stopped them by PID. One orphaned `sleep 23.7` from PTY run s9 exited on its own. No process was killed by pattern.
5. **Nothing was committed, pushed, tagged, deployed or published by the audit.**
6. **Concurrent foreign changes were observed and left untouched.** Between 22:53 and 23:10 UTC another actor, apparently a Nexus session (`nexus-session-session_20261014_091558_9m78.json` appeared at the repository root), changed the working tree:
   - modified `cli/src/agent.ts` (+3 lines);
   - modified `cli/test/compaction_continuity.test.ts`;
   - added `cli/test/agent_prompt.test.ts`.

   These changes are uncommitted. HEAD stayed at `db1ca55`. All tests and builds in this audit ran on clean exports of `db1ca55` (B1, B2), and the live runs used the checkout's prebuilt `cli/dist`, which matched `db1ca55` source (E §4). So these edits are **not** part of the tested revision. Whoever owns them must decide whether to keep or discard them.

## 6. What must be re-run after implementation

| Evidence | Re-run when | How |
|---|---|---|
| B2 baseline | Every gate (G0–G6) | CI order, clean clone, HOME isolated (after PLAN-08 task 1) |
| All RT and MEAS rows in AUDIT §5 | On the RC (G5) | The scripts in `evidence/` are ported into `cli/test` by the plans. The remaining manual probes (installer, doctor, memory) follow ACCEPTANCE §7 and ACC-PROC-05/06. |
| L1–L3 | On the RC | With pinned models (ACCEPTANCE §4.3) |
| PTY scenarios | On the RC | ACCEPTANCE §5.2, against the installed package |
| Contest evidence | After judging | ACCEPTANCE §9 |

## 7. Limitations of the conclusions

- **No product qualification exists.** "Blocked" is established, from reproduced defects. "Qualified" cannot be: there is no held-out, fault-injection or standalone evidence, and the tasks used in the historical pilot were tuned.
- **Local inference behaviour is unverified live.** That covers gateway runs, plain servers, context discovery on real servers, and real tool-call delta shapes. By owner constraint, the gateway is the only inference path, and it was not used during the audit.
- **Terminal evidence** comes from `pyte` emulation plus the repository's PTY suites. Real emulators (kitty keyboard protocol, tmux, VS Code) were not exercised.
- **Unreviewed regions** are listed in AUDIT §4: file_ops.rs:400-575, MCP remote transports, browser.ts and lsp.ts at depth, the rendering modules line by line, and `PHASE2S_SECURITY_AND_DATA_REVIEW.md`. These are open qualification gaps.
- **Inferred items** need their procedures before they are treated as facts: AGT-09, PRV-06 (server `/models` shapes), VER-08 (RED-phase refusal), VER-09 (real tokenizer ratios) and TUI-11 (intermittent slow cancel).
- **Platforms:** only Linux x86-64 was exercised. Other distributions only had their installer failure messages checked in docker.
- **Severity ratings** are reviewer judgement. The release classes are this package's decisions, made under the owner's delegated authority (DECISIONS.md).
- **Independence:** this audit is one reviewer's evidence pass, assisted by scoped sub-audits from the same reviewer. It is **not** an independent acceptance.

## 8. Artifact hashes

The `SHA256SUMS` file in this directory covers every file under `docs/v1.0.0/` (except itself). Generated at the end of the audit:

```
cd docs/v1.0.0 && sha256sum -c SHA256SUMS
```
