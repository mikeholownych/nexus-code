# VR-3 — sandbox denial and violation events

Branch: `v1/vr-3-sandbox-denials` (from `origin/release/v1.3.0` at `10942d41`). Slice claim: `VR-3`.

## What was added

- A profile-agnostic `SandboxDenialEvent` in `cli/src/sandbox_events.ts`: `kind` (`denied | unavailable | violation`), `engine`, `profile` (`"default"` until SB-1 names profiles), `operation`, `category` (`filesystem | network | engine | policy`), `reason`, `at`. A classifier turns only errors that actually name confinement into an event; unrelated approval/read-only/verification-file denials keep their existing paths.
- The verify result (`--json` and `--receipt`) has an optional `sandboxEvents` array. Both engine-unavailable refusals — no usable engine, and a box that cannot be built — append an event before raising the unchanged `SANDBOX_UNAVAILABLE` / `BLOCKED` / exit 3 result. No refusal means no member. The generated v3 schema and its additive version-decision ledger entry were regenerated after merging `release/v1.3.0` (the independent-reviewer change had already bumped the verify schema to v3).
- `ExecutionReceipt` has the same optional member. Tool-level sandbox errors are classified once in `cli/src/core/dispatch_tool_call.ts`, attached to the receipt, and written as a typed, sanitized, hash-chained flight event (`sandbox_denial`, `sandbox_violation`, `sandbox_unavailable`) by `FlightRecorder.recordSandboxDenial`.
- The live receipt projection can show a dedicated `Sandbox denials` section (`receiptSections` optional argument); the text verify receipt names each denial with engine, profile, category, operation and reason.
- GV-2 needs no new artefact role: `nexus audit export` copies named verify receipts byte for byte and copies chained flight logs whole. Tests now put a typed event in both and read it back from the bundle. `docs/AUDIT.md`, `docs/USER_MANUAL.md` and `docs/VERIFY_IN_CI.md` state that these events are evidence, never a verdict, approval or proof of a successful run.

## Authority boundary

No path was added from a denial to `VERIFIED`. `verifyVerdictFor` still maps `SANDBOX_UNAVAILABLE` to `BLOCKED`; the event type has no verdict, approval or success member; flight replay only dispatches recorded events and delays. The explicit trusted `--sandbox none` opt-out is unchanged.

## Reference coding (XERJ)

Local node was active; XERJ `v1.0.0-rc.104`. Loaded corpora do not include `openai/codex`, so the roadmap's Codex re-read remains the source of the violation-event idea; no Codex code was copied.

- `xerj code openbsd-faq "sandbox violation audit log denial"` and `"log violations source request reason"` → `openbsd-faq/66.html:258`, `openbsd-faq/openssh/releasenotes.html:215`: sshd added remote host and port to `PermitOpen`/`PermitListen` violation logs so the source of the request can be identified. **TAKEN:** a denial record names the request and the reason, not just "denied".
- `xerj code r2r-enforce "evidence admission accept hold reject mutation"` → `r2r-jev/docs/architecture.md:63`, `r2r-jev/README.md:219`, `r2r-jev/SECURITY.md:43,72`: only `Accept` mutates governance state; `Hold`/`Reject` are non-authoritative and outcome reports are untrusted audit input. **TAKEN:** the denial event is evidence for receipts/flights/audit only and cannot raise a verdict or grant an approval.
- `xerj code r2r-enforce "failed command evidence obligation receipt"` → weak lexical match in `r2r-jev/tests/cli_contract.rs:4`; nothing concrete borrowed.
- `xerj code etcd-docs "audit event log request response"` → structured-logging noise for this question. **REJECTED** as an analogue.
- `xerj feedback --dry-run` inspected. No field report was submitted: the earlier publication blocker (missing GitHub credential) still applies, and no submission is claimed here.

## Measured results (unaltered)

Results below are after merging `origin/release/v1.3.0` into the slice (the independent-reviewer and AC-1 slices had landed since the branch was cut).

- `npm --prefix cli run build` (tsc + copy + build info): pass.
- `node cli/scripts/gen_verify_result_schema.mjs --check` and `node cli/scripts/gen_run_result_schema.mjs --check`: current.
- Focused suite on Node v22.22.1, isolated `HOME`: `sandbox_denial_events`, `verify_sandbox`, `verify_schema`, `evidence`, `audit_export` — **44 tests, 44 pass, 0 fail** (4 suites; the real Docker box suite skipped because the daemon is not usable here).
- Same focused suite on Node v24.22.3 (`npx node@24`), isolated `HOME`: **44 tests, 44 pass, 0 fail**.
- Wider Node 22 regression set, isolated `HOME`: `verify_hostile`, `verify_review`, `independent_verification`, `verify_command`, `flight_sanitization`, `flight_exclude`, `verify_action`, `audit_bundle`, `audit_schema`, `audit_command` — **160 pass / 5 fail**. All five failures are in `independent_verification.test.ts`; the same file on pristine `origin/release/v1.3.0` in a temporary detached worktree showed **18 pass / 19 fail** on this host. They are pre-existing/host-dependent, not introduced by VR-3, and are recorded unaltered rather than hidden.
- The earlier pre-merge focused run was 43/43 on Node 22 and Node 24; the earlier pre-merge wider set (`verify_hostile`, flight, verify-action and audit suites) was 86/86 on Node 22.
- `worker_isolation` is not claimed as a gate in this slice. With no built core, one subtest failed with `Core engine handshake failed: Rust core RPC daemon disconnected`; after building the core, that suite hung in a real bwrap/core RPC case on this host and was stopped by its own pids. No result is inferred from it.
- On PR #745, the `Entire Gates` check reported `failure`: "No reviewers have approved this trail", "No CI checks reported for the head commit" and "30 commits behind". The release merge addresses the staleness; the gate is recorded as observed and, per repo policy, is not a merging gate.
- `git diff --check`: clean.

Host state recorded, not treated as a defect: the Docker daemon is unavailable; the worktree uses a shared `cli/node_modules` symlink for local checks and that symlink is not part of the change.
