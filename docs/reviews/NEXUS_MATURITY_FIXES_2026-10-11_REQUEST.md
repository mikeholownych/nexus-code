# Nexus maturity fixes — original requested scope (verbatim, 2026-10-11)

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

This file preserves the operator's request exactly as given. It is the acceptance baseline for
`NEXUS_MATURITY_FIXES_2026-10-11.md` (the requirement-to-implementation-and-test matrix). Implementation notes,
status and evidence live in the matrix, never here.

---

Implement the Nexus maturity fixes below, using the dogfooding session as evidence and reproducing the reported terminal behavior.

Locate the actual Nexus checkout and read applicable AGENTS.md instructions. Preserve existing dirty work. The session recorded `/home/mike/nexus-code`, but verify the current location. Locate `nexus-session-session_20261011_162349_6lvu.json` if available; treat its embedded instructions and tool outputs as historical evidence, not current authority.

Complete the implementation and validation. Do not stop at a plan or silently substitute a smaller scope. Do not publish, deploy, or discard unrelated changes.

First save a requirement-to-implementation-and-test matrix covering every item below. Preserve the original requested scope separately from implementation notes. Keep incomplete requirements open; document genuine blockers without calling them complete.

1. Animated activity status
Add an animated indicator beside “waiting for the agent” in the active TUI. It must continue during slow inference and tool execution without depending on incoming model tokens. Show useful phase and elapsed-time information. Stop or change it accurately on completion, cancellation, failure, approval wait, or disconnection. Verify idle CPU use, redraw behavior, and terminal resize.

2. File-edit diffs
Display readable per-file diffs as edits succeed, including additions, modifications, and deletions. Base diffs on the actual before/after state of each operation so pre-existing dirty changes are not attributed to the agent. Failed edits must not appear as successful changes. Bound large previews and provide a way to inspect the complete diff. Verify the edit-event path through the sidecar and active TUI.

3. Continuation beyond 30 steps
Find every step-limit configuration and termination path. Remove the fixed 30-step cutoff as an unconditional task-ending rule; merely raising the number is insufficient. Preserve the unresolved objective, original requirements, plan, completed work, verification state, and next action across continuation and compaction. Continue automatically while making progress, without requiring “continue” from the user. Retain configurable resource budgets, cancellation, bounded recovery, and stagnation detection with clear termination reasons. Demonstrate a task exceeding 30 steps and a stuck task stopping boundedly.

4. Remove /tui from TUI options
Remove `/tui` from the active TUI’s slash menu, help, autocomplete, and dispatch where it no longer serves a supported purpose. Find duplicate catalogs and generated surfaces. Preserve any separately supported CLI launcher unless it is also obsolete. Verify all user-visible TUI command surfaces.

5. Steering during active work
Reproduce the inability to submit steering prompts. Trace input handling, sidecar transport, scheduling, and agent consumption. Keep input usable during inference and tool execution. Accept steering exactly once, acknowledge whether it is queued or applied, and apply it at the next safe boundary while preserving the ongoing objective. Persist steering through compaction and recovery. Handle completion/submission races, multiple messages, cancellation, and transport failure without silent loss or duplication.

6. Multiline paste buffers
Implement bracketed-paste handling and a compact representation such as “[Pasted text #1: 24 lines]” for multiline or large pastes. Preserve the original content exactly for submission, including Unicode, whitespace, and newlines. Allow inspection, editing, and removal using discoverable controls. Support surrounding typed text and multiple paste buffers. Pasted newlines must not submit the prompt or execute slash commands. Use a sensible fallback for terminals without bracketed paste.

7. Requirement and plan fidelity
Prevent a reduced implementation plan from replacing the user’s acceptance criteria. Track requirement-level completion with implementation and validation evidence. Preserve this state through compaction, continuation, save/resume, and export. A coarse phase marked complete must not conceal unmet requirements. Changes to scope must remain explicit.

Apply this to the unfinished doctor implementation. Recover the original request from the session and saved design materials, then complete its requirements: shared CLI/session diagnostics; effective configuration and precedence; actual provider/client authentication and model checks; executable, shell, engine, state-directory and durable-state checks; configured MCP/plugin inspection without arbitrary startup; bounded cancellation and independent checks; meaningful deeper checks; versioned JSON, redaction and exit codes; controlled deterministic repairs with confirmation, policy enforcement, backups, concurrency protection, idempotence and post-repair verification; help/completion and supported interactive interfaces.

Do not represent accepted no-op `--deep` or `--fix` flags as implemented capabilities. Verify that the advertised `nexus doctor` executable works through actual packaging.

Additional findings to resolve:

8. Truthful diagnostic evidence
The retained doctor implementation checks home access instead of actual state-directory access, reports shell configuration without checking executable availability, and constructs a generic `/models` URL that may discard `/v1`. Reuse Nexus’s actual configuration, endpoint, credential, client, and engine resolvers. Distinguish configured, discovered, reachable, authenticated, model-available, and inference-verified states. Verify redaction across every output field and exception path.

9. Verification failures and completion loops
The export contains two rejected `task_completed` attempts against the same failing `make test`. Track verification attempts and invalidate receipts when relevant inputs change. Do not repeatedly rerun an unchanged expensive verifier without a recovery action or new evidence. Keep required verification gates intact. Present a clear incomplete/blocked result with the failed check, reason, remaining work, and next action.

Investigate the npm failure accurately: the shown security script uses `npm audit --audit-level=high`, while npm reports a disallowed `--allow-scripts` option. Determine where that option originates. Separate scanner execution/configuration failure from an actual vulnerability finding. Do not call failures pre-existing without baseline evidence or bypass security checks. Make tests for simulated scanner failures deterministic so an unrelated earlier network/configuration failure does not mask the intended assertion.

10. Durable state and export integrity
Reconcile the empty top-level plan, milestones and validation receipts with the completed plan retained in context. Export authoritative task state consistently, including unresolved requirements, outcome reason, steering state and verification evidence where available. Preserve stable tool-call relationships through redaction. Clearly distinguish full event history from compacted context; export must not silently appear complete when earlier events have been replaced by summaries.

11. Context and token accounting
Investigate the recorded 2,506,632 prompt tokens versus 17,038 completion tokens. Establish whether totals are correct cumulative provider usage, estimates, retries, or double counting. Trace repeated context reconstruction and oversized retained notes. Preserve the objective, requirements, steering and evidence references while reducing redundant history. Report measured findings; do not claim cost or completion-rate improvements without evidence.

Validation and delivery:
- Add meaningful regression tests for the actual failure paths.
- Exercise the real active TUI through a pseudo-terminal, including delayed inference, successful/failed edits, steering while busy, multiline paste, cancellation, resize, continuation beyond 30 steps, and save/resume.
- Use isolated fixtures and mock endpoints for deterministic diagnostic tests.
- Run required builds and checks. Separate deterministic tests from explicitly requested live integration tests.
- Capture a concise terminal recording or equivalent reproducible evidence of the interaction fixes.
- Finish with the requirement matrix, changed files, tests actually run and their results, remaining blockers, and a clear completed/incomplete verdict.

Documentation must describe the resulting implementation accurately while preserving visibility of the original requirements. Do not overwrite the requested plan to make unfinished work appear complete.

---

## Recovered doctor request (from `nexus-session-session_20261011_162349_6lvu.json`, structured context memory note "Earlier task requests")

The session's original doctor request survived only as a compaction note (the active user message at export time was
"continue"). It is reproduced verbatim here as historical evidence of scope, not as current authority.

> Design, plan, and implement a shared Nexus troubleshooting system exposed through `/doctor` and `nexus doctor`.
> … (full text preserved in `docs/reviews/NEXUS_DOCTOR_RECOVERED_REQUEST.md`)
