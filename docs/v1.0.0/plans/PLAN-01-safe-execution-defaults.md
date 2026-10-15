# PLAN-01: Safe execution defaults and approval integrity

Implements [SPEC-01](../specs/SPEC-01-safe-execution-defaults.md). Milestone **M1**. Requirements: REQ-SEC-101, 102, 103, 104, 108, 109 and 119; REQ-TUI-102. Decision: DEC-01 option C.

## Preconditions

- PLAN-08 task 1 (test HOME isolation) is merged. Without it, the test changes below write into the real `~/.nexus`.
- Work in a branch or worktree off `main`. Run long suites on a snapshot copy (tasks/lessons.md, 2026-10-13).

## Safe change boundary

These files are in scope:

- `cli/src/core/capabilities.ts`
- `cli/src/core/tool_groups.ts`
- `cli/src/agent.ts` (dispatch gate ~3936-3975; verifier call sites 1602-1630, 3432-3436, 4034, 4067-4090)
- `cli/src/repl.ts`
- `cli/src/sidecar.ts`
- `cli/src/index.ts`
- `cli/src/config.ts`
- `cli/src/types.ts`
- `cli/src/security.ts`
- `cli/src/sandbox.ts`
- `cli/src/core/authority.ts`
- `cli/src/tester.ts` (runner routing only)
- `cli/src/slash/workspace_commands.ts`
- `core/src/runner.rs` (tripwire only)
- `core/src/bin/nexus_tui/{protocol.rs,live_view.rs,live_state.rs}` (posture banner, arrow direction, narrow hints)
- `eval/run.mjs`
- `demo/lib/real-agent-runner.mjs` (`--yes`)

Do not touch the parser, which belongs to PLAN-11, or the runner process registry, which belongs to PLAN-02.

## Tasks (ordered)

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | Add `EffectClass` type and `effect` field. Classify every built-in capability per SPEC-01 §5.1. MCP and plugin registration defaults to `exec`. Registry validation throws on a missing class. | `core/capabilities.ts:22-45` + each declaration; `mcp.ts` (registration); `plugins.ts` (custom tools) | — |
| 2 | Add `ApprovalPolicy`: `requiresDecision(effect, {mode, trusted, sandbox, egressOrigins})`. Unit test it with the full matrix. | new `cli/src/core/approval_policy.ts` | 1 |
| 3 | Replace `onConfirm && isMutating` with the policy. If no handler is available and a decision is required, return DENIED with reason `DECISION_REQUIRED_NO_OPERATOR`. Egress per-origin memory lives on the agent and is cleared on `/mode` change and on resume. | `agent.ts:3945-3975`; subagent dispatch `agent.ts:5384` | 2 |
| 4 | Replace the `autoApprove` booleans with `HarnessConfig.approvalMode`. Default resolution per DEC-01 C: `--yes`/`NEXUS_APPROVAL_MODE` → explicit, else trusted → auto, else review. CLI flags: `--approve`, `--yes`, `--read-only`, `--mode <m>`. | `config.ts:107`, `types.ts`, `index.ts:93,115`, `repl.ts:69,281,644-648`, `sidecar.ts:53,66,478,638,935` | 3 |
| 5 | Route verifier executions through the policy as `exec`. When not trusted and no prior approval exists, emit the approval with `kind: "verifier"`, the command, and the resolved script body (read `package.json` `scripts.test`, the Makefile `test:` recipe, `Cargo.toml`/`pytest.ini` presence). Cache the approval per (workspace, command, script digest) for the session. | `agent.ts:1602-1630,3432-3436,4034`; `tester.ts:113-136` (add `describeVerifier()`); `approval_review.ts` (new kind) | 3 |
| 6 | `/test` and `nexus eval` use the bridge runner instead of `execSync`. | `tester.ts:143-163`; `repl.ts:1357`; `slash/workspace_commands.ts:160`; `evaluator.ts` | 5 |
| 7 | REPL approval hardening: clear the line buffer, 400 ms grace, `[y/N/d/a]` with empty input = No, confirm for `a`. | `repl.ts:270-276,353,385,497-501` | 4 |
| 8 | Update the eval runner to pass `--yes`. Do **not** edit `demo/` while contest judging is open (DEC-13): the demo is covered by `NEXUS_APPROVAL_MODE=auto`, which must therefore be honoured by `nexus run`. Update test fixtures that assumed auto: grep `new InteractiveRepl(`, `SidecarServer(` and `mode:` in `cli/test`. | `eval/run.mjs`, `demo/lib/real-agent-runner.mjs`, `cli/test/**` | 4 |
| 9 | Read-only HOME masking: bwrap `--tmpfs $HOME --ro-bind <ws> <ws>`. Without bwrap, path-confine the allowlisted commands (reject `~`, `$`, absolute paths, and `..` that escapes). | `sandbox.ts:131-181`; `core/authority.ts:44-136` | — |
| 10 | Build the sandbox argv as an array; spawn without a shell. | `sandbox.ts:131-158,181`; caller in `tools.ts` | 9 |
| 11 | Tripwire: shell-words tokenization in TS and Rust; fix false positives; rename in UI and docs; tests for false positives plus documented bypasses. | `security.ts:12-23,78-89`; `runner.rs:64-107` | — |
| 12 | Posture banner: add `posture` to the sidecar `session.state`; render the TUI header line; add a REPL banner line; add `posture` to doctor JSON. | `sidecar.ts`; `protocol.rs`; `live_view.rs` header; `repl.ts` banner; `doctor.ts` | 4 |
| 13 | Approval panel polish: make arrow keys match the button layout; add short-form hints under 60 columns. | `live_state.rs:1329-1335`; `live_view.rs:540-542` | — |
| 14 | Docs: USER_MANUAL approvals/modes, quickstart "review requested actions", ARCHITECTURE §3 controls-and-limits, release notes entry. | docs | 1-13 |

## PR slices

1. **PR-1a** (tasks 1-3): effect classes, policy and gate, with the matrix test. No behaviour change yet: the default is still auto via a temporary constant.
2. **PR-1b** (tasks 4, 8, 12): posture resolution, the DEC-01 C default, fixture updates, banner. This is the behaviour change.
3. **PR-1c** (tasks 5-6): verifier gating and runner routing.
4. **PR-1d** (task 7): REPL approval hardening, with PTY tests.
5. **PR-1e** (tasks 9-11): read-only masking, argv sandbox, tripwire.
6. **PR-1f** (tasks 13-14): TUI polish and docs.

## Tests and fixtures

- **Unit:**
  - `approval_policy.test.ts`: registry × mode × trust matrix; fails on an unclassified capability.
  - `security.test.ts`: tripwire false positives and documented bypasses.
- **Integration:**
  - `verifier_gating.test.ts`: untrusted fixture with a sentinel `scripts.test`, covering ACC-SAFE-09.
  - `readonly_home.test.ts`: fixture HOME with `.ssh/id_rsa`, covering ACC-SAFE-04.
  - `sandbox_quoting.test.ts`, covering ACC-SAFE-05.
- **PTY:**
  - Port `evidence/D_pty/r1_repl.py` and `r1d.py` into `cli/test/repl_approval_e2e.test.ts`, using the existing PTY helper in `cli/test/helpers/fixtures.ts`. Covers ACC-SAFE-03.
  - Add a startup-banner assertion to `tui_surface_e2e`. Covers ACC-SAFE-06.
  - Keep `tui_approval_input_e2e` green (ACC-SAFE-08).
- **Live (M5):** one standalone session per server kind verifies the banner and the first-verifier approval.

## Documentation and packaging

- Add a release-notes entry for the default change and for `--yes` in scripts and CI.
- The quickstart gains a "Trust your own repository" step: `nexus trust .`.

## Rollback

- Each PR reverts independently.
- PR-1b is the only behaviour flip. Reverting it restores the auto default while keeping the classes and gate.
- The `NEXUS_APPROVAL_MODE=auto` escape hatch remains for users after release.

## Definition of done

- ACC-SAFE-01 to ACC-SAFE-10 pass in CI. The PTY tests run in CI (they already run in `linux-x86_64`).
- REQUIREMENTS.md rows REQ-SEC-101/102/103/104/108/109/119 and REQ-TUI-102 show status `tested`, with test references.
- `make test` passes on a clean snapshot.
- The docs checklist items for SPEC-01 are done.
