# v1.2.2 backlog (written 2026-11-18, after v1.2.1 shipped)

What the v1.2.1 plan ([`docs/v1.2.1/PLAN.md`](../v1.2.1/PLAN.md)) did not finish, with the reason and the first step for each. Nothing here is scheduled by date; the owner chooses what ships. Units marked **needs** cannot be finished by writing code alone.

## Needs a resource or an owner decision

| Unit | Not done | Needs | First step |
|---|---|---|---|
| MQ-1, MQ-2 | Benchmark adapter (Harbor / Terminal-Bench) and the false-completion report (pass rate, claimed-done-but-wrong, verified-but-wrong, Wilson intervals, peer comparison) | Containers, a pinned task subset, a model-cost budget (decisions D3, D4) | Pick the subset and budget; build the adapter against a mock gateway first. No external measurement is published for v1.2.1. |
| MQ-4 | Scheduled gateway conformance: the job script, claim protocol and alert path are built and tested (`scripts/gateway_conformance.mjs`, `docs/GATEWAY_CONFORMANCE.md`) | A local scheduler on the host that can reach the gateway (a timer unit example is documented, nothing is installed) and a first live run with a prepared config | Install the timer (via Ansible if the host is managed that way), keep a `last-good-result.json` baseline, run once by hand |
| RD-1, RD-2 | macOS and arm64/musl artifacts | A macOS runner and an arm64 or musl runner (decision D6, runner cost) | Decide runner cost; reuse `release.yml` packaging |
| PC-1 | Median PR CI under 40 minutes (measured 37 to 45 minutes) | Time on the runners | Shard the CLI suite and cache toolchains; the parallel `linux-x86_64` job is already in place |

## Partly done: what is left

| Unit | Done in v1.2.1 / since | Left |
|---|---|---|
| VC-2 | Operator-authorised regression obligations (`/requirements obligate|minimise|retire|reference`), replay recording, completion gated on unmet obligations, weakening-edit recording for file tools and the shell | Remaining after the completion gate and shell-edit recording landed: a shell edit to a test file larger than 64 KiB, or outside the 20000-entry scan, is not recorded; nothing forces the verifier to run the obligated test (a vacuous pass is invisible); weakening is recorded, never blocked |
| VC-3 | Per-attempt parent and a hash of the step between candidate identities; operator-only gate for naming a reference | The behavioural differential against a declared reference (needs a design decision on how references are run and normalised); the hash is not a content diff |
| VC-6 | Baseline for untouched callers, shell-changed files, `go vet`, pyright and mypy, `UNAVAILABLE` for a missing tool | One check runs per project (tsc, then cargo, go, python); a resumed task has no baseline; cargo is excluded from the baseline as not cheap |
| VC-9 | Audit with file:line for 14 paths; BLOCKED/NEEDS_INPUT with a machine-readable question and `--answer` resume for tool approvals, verification-file edits and the verifier or type-check at completion (top-level run only) | A requirement marked blocked (changes the `REQUIREMENTS_INCOMPLETE` contract and needs a free-text answer); an unresolved steering conflict (sidecar protocol decision); a subagent's question is not propagated to the parent; the requirement-verifier approval path is not tested on its own |
| CX-4 | Opt-in masking (`NEXUS_TOOL_OUTPUT_MASK_TOKENS`) with ids resolved through `read_archive` | A default threshold (not shown safe); a dedicated id-read tool; measurement of masking on real tasks |
| CX-6 | Opt-in Anthropic cache breakpoints (`NEXUS_PROMPT_CACHE=1`, provider declares `promptCache: "anthropic"`) and a cached-token share in the usage summary | Verification against the live Anthropic API; default-on; Bedrock `cachePoint`; declaring the capability from an operator `providers.json`; a share column in the provider matrix doc |
| CX-7 | `@path` imports for AGENTS.md, CLAUDE.md, CODEX.md and .nexusrules (trusted workspaces, real-path containment) | Loading more than the first non-empty instruction file; `~/` and absolute imports |
| RD-6 | `SessionManager.forkSession` and `/fork [n]` (source never mutated, compaction archive verified on resume); `--fork-session`/`--fork-at` on `run`, `repl` and the top level; a worktree-bound session is refused | Carrying a worktree binding into a fork (today it is refused: a fork would share the checkout; needs a decision on making a second checkout); `forkedFrom` is lost once the fork's own turns are saved; the REPL `/fork` worktree refusal has no automated test (the `--fork-session` flag is done: run, repl, top level) |
| CS-6 | Test `cli/test/lsp_real_servers.test.ts`, weekly non-required workflow `lsp-real-servers.yml`, `docs/LSP_REAL_SERVERS.md`; typescript-language-server and pyright validated locally (pass; mutation-checked); fixed the missing `--stdio` for TS/JS/Python | The workflow has not yet run on a hosted runner; rust-analyzer and gopls cases are written but have run nowhere (not installed on the dev host), so treat them as unvalidated; hover, definition, the trust and sandbox gates and multi-file projects are not exercised against real servers; versions of rust-analyzer and gopls are not pinned by the test |
| MT-3 | One `redactPlain` and one `safeTerminal` use in place of 7 and 3 inline copies; each deliberately different variant has a row in `docs/v1.2.1/REDACTION_VARIANTS.md` | The remaining variants that are field-aware wrappers or classifier entry points |
| MQ-7 | Slices B and C | Slices D (installed-evaluator adapter), E (request-context manifests), F (recovery reference checker), G (bounded campaigns) |
| WM-3 | All five gateway aliases measured (single runs) | A reasoning-aware pass rule for aliases with reasoning off (the runner marks them `passed: false` for the hybrid-reasoning check); repeats, to see run-to-run variation |

## Not started / deferred in their rows

CS-9 (per-command approval rules), CS-10 (RPC worker isolation), VC-8 (per-role tool allowlists beyond reviewer and researcher), VC-10 (steering semantic judge, gated), RD-5 (superseded by v1.3 AC-1), RD-7 (`nexus uninstall`), MT-2 (split the two ~5.4k-line TUI files), PC-5 (settled by v1.3 GV-4).

## Release-note items for the next release

- Headless review-mode runs that need an approval nobody can give now end `BLOCKED` with `NEEDS_INPUT` and a machine-readable question (resume with `nexus run --resume <task> --answer <id>=approve|decline`); before, the model could route around the refusal. `--yes` and auto runs and subagents are unchanged.
- `main` CI now runs `check_requirements --enforce` in the `test-matrix` job.
- The compiler-exposure scan no longer kills its enumeration child after EOF (a race that failed scans under load).

## Process lessons from v1.2.1

- A release workflow runs tests that pull-request CI skips (host-conditional ones); run those under a flooded environment before tagging.
- A background agent's reported test subset is not the suite: two failures in the VC-9 PR were found only by CI.
- An agent's own mutation report is not evidence until re-run; one PR had a surviving mutation, another reported a mutation as caught when it was not.
