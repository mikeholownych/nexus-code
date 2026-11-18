# VC-9: headless needs-input audit

Date: 2026-11-18. Base: origin/main `b1b74858` (file:line below are at that commit; the glue added by this change is listed in the last column).
Reference: Anthropic 2026 agentic coding trends report, trend 4 (agents that learn when to ask for help).

A headless run has no operator (`onConfirm` absent). This lists every place it needs a human decision, what happens today, and what this change does about it. Outcomes today: **stalls** = the model gets a plain error and carries on or the turn ends with nothing structured; **guesses** = a decision is made on the operator's behalf. No path ended BLOCKED with a question before this change (`grep needs_input cli/src` found nothing).

The shared shape added: turn `execution=BLOCKED`, `reason=NEEDS_INPUT`, `needsInput = { id, kind, prompt, subject, options[approve|decline] }` (`cli/src/core/needs_input.ts`, `cli/src/core/turn.ts`), and `nexus run --resume <task> --answer <id>=approve|decline`.

| # | Path | Where the decision is needed (base) | Today | After this change |
|---|---|---|---|---|
| 1 | Tool needs approval (write, exec, egress) in review mode (the headless default) | `cli/src/core/dispatch_tool_call.ts:258-293` | stalls: receipt `DENIED / DECISION_REQUIRED_NO_OPERATOR`, plain error to the model, which works around it | BLOCKED / NEEDS_INPUT `tool_approval`; `--answer` approves that exact call once |
| 2 | Egress approval | same site, `effect === "egress"` (`dispatch_tool_call.ts:259-264`) | stalls (as 1); under `--yes` it is approved without asking, by explicit opt-in | as 1 |
| 3 | Verification-file or test edit (Makefile, CI, test files, package scripts) | `cli/src/security.ts:811` (`ctx.operator ? "ask" : "deny"`), refused at `dispatch_tool_call.ts:198-227` | stalls: `VERIFICATION_CONFIG_PROTECTED`, "none was given", model continues | BLOCKED / NEEDS_INPUT `verification_edit` for the decision case (not for policy mode `block`, which is a rule, not a decision); `--answer` approves that path for that call |
| 4 | Verifier approval at `task_completed` | `cli/src/core/spine_handlers.ts:180-197`, gate `cli/src/core/completion_oracle.ts:37-40` (`if (!onConfirm) return false`) | stalls: tool error to the model | BLOCKED / NEEDS_INPUT `verifier_approval` (id binds command and script digest). The pre-change baseline captures do not ask |
| 5 | Requirement-declared verifier approval | `completion_oracle.ts:213-216` | stalls: string returned, verifier skipped | as 4 |
| 6 | Type-check approval (CG-4, VC-6) | `completion_oracle.ts:84-87` | stalls: enforce mode blocks with text; record mode silently skips | as 4, for an enforced type-check; a record-only one is still just not run |
| 7 | Steering that negates a requirement | `cli/src/agent.ts:1912-1921` (`conflict.status = "unresolved"` when no `onConfirm`), reachable only through the sidecar (`cli/src/sidecar.ts:376`) | stalls: conflict stays `unresolved`, steering not applied (no guess), nothing at turn level | **not done**: see "Not done" |
| 8 | Requirement marked `blocked` by the model | `cli/src/core/objective.ts:500,561`; turn at `cli/src/core/run_turn.ts:1308,1349` | stalls: `COMPLETED / NOT_ESTABLISHED / REQUIREMENTS_INCOMPLETE`, reason only in a note | **not done**: see "Not done" |
| 9 | Egress secret block | `cli/src/tools.ts:1226` (`EGRESS_SECRET_BLOCKED`) | policy denial, not a decision (allow-list is operator config) | out of scope by design |
| 10 | Injection-suspicion approval | `dispatch_tool_call.ts:228` (`Boolean(onConfirm) && ...`) | not asked headless; the normal policy applies | no change: it is an extra prompt, not a missing decision |
| 11 | Workspace trust | `cli/src/startup_trust.ts:136-141` | non-TTY: continues `untrusted` (instructions and integrations unloaded, noted) | no change: degraded, not blocked; trust never widens authority |
| 12 | Verifier not converging / tool-call loop | `run_turn.ts:1244-1252` | already BLOCKED, but no question or answer path | no change here (a decision to stop, not a yes/no) |
| 13 | Operation work unit BLOCKED | `cli/src/core/scheduler.ts:360-440`, `nexus operation decide` | already BLOCKED + question + resume (reference implementation) | no change |
| 14 | Subagent hits 1-6 | `spine_handlers.ts:482`, `cli/src/synthesizer.ts:243-307` | stalls inside the child | `spawn_subagent`: the child stops at the question and returns it in its result (same id and shape as a parent-originated one, plus `subagent: { depth, objective }`); the parent ends BLOCKED / NEEDS_INPUT with it. Other child paths (`/team`, operations) already run as scheduled work units, not in-turn: no change |

No ask-the-user tool, plan approval, git push confirmation or MCP elicitation exists in `cli/src` (searched), so there is no further path.

## Behaviour notes

- A question stops the turn at the call that raised it; later calls in the same batch are reported as not executed.
- An answer is bound to the decision: the id is a digest of the tool and arguments (1, 2), the path and tool (3), or the command and script digest (4-6). A different action gets a different id and asks again.
- `approve` covers the one action. `decline` is recorded for the run and the action is refused without asking again.
- Exit code stays 1 for BLOCKED; machine consumers read `turn.reason` and `turn.needsInput` (`--json`, stream-json `result`).
- Answers live in the invoking process. Resuming without `--answer` asks again.

## Not done (needs a design decision)

- **7 (steering conflict)** only occurs through the sidecar, which already has a client that can resolve the conflict. Ending the turn BLOCKED requires deciding what the sidecar protocol does with a BLOCKED turn and whether an `unresolved` conflict may be resolved after the fact (`resolveSteeringConflict` accepts only `pending`).
- **8 (blocked requirement)** currently ends `COMPLETED / REQUIREMENTS_INCOMPLETE`, and operations, continuation and several tests depend on that. Changing it to BLOCKED / NEEDS_INPUT changes an existing contract (reason, execution, exit code) and the answer is free text (what to do about the blocker), not approve/decline.

## Subagents (row 14)

A headless in-turn subagent (`spawn_subagent`, depth 1) that needs a decision records the question on itself (`subagentQuestions`), stops at the call that raised it (it does not wait, take the decision or route around it) and returns it in `SubagentResult.needsInput`. The parent records it through `acceptSubagentQuestions`: the first becomes `TurnResult.needsInput`; further distinct questions go to `TurnResult.furtherNeedsInput` in order, never overwriting the first; a parent-originated question already recorded stays first. The turn ends BLOCKED / NEEDS_INPUT as for any question. On `--answer`, the parent hands its answers to each subagent it spawns (`setOperatorAnswers`), so the re-spawned child meets the same id and proceeds (approve) or is refused without asking (decline). Interactive runs pass the operator's confirm handler to the child as before and record nothing.

Limits, stated plainly: the child is not resumed, it is spawned again from the model's next `spawn_subagent` call, so work it did before the question is redone (workspace changes it already made stay); resume depends on the model delegating the same way again. Questions are listed only when one call raised several (a batch stops at the first recorded question, so a second `spawn_subagent` in the same batch does not run). Subagents cannot spawn subagents, so there is no deeper level. Tests: `cli/test/vc9_subagent_needs_input.test.ts`, which also covers the requirement-verifier approval (`runRequirementVerifier`) on its own.
