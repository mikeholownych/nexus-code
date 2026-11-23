# PA-4 goal ledger propagation

**Status:** implemented in PR #713; hosted qualification pending.

## Change

The parent goal's `ObjectiveLedger` is now copied into fresh durable implementer and tester tasks before their first turn. `AutonomousAgent.initializeFreshObjectiveLedger` validates the ledger version and objective digest, persists it, and confirms the saved copy. It is restricted to a fresh durable conversation and does not restore a session, so the constructor-captured workspace baseline remains available for verification.

The goal executor gives implementers a copy of the root ledger. Before a tester starts, it folds persisted implementation evidence into the root ledger and gives the tester that updated copy. Child mutations remain isolated from the root acceptance record; only the existing evidence-folding rules update the root.

Relevant code: `cli/src/agent.ts` (`initializeFreshObjectiveLedger`), `cli/src/core/operation_runner_execution.ts` (`AgentWorkUnitExecutor.run`), and `cli/src/goal.ts` (`objectiveLedgerForGoalUnit`, `foldUnitLedgers`).

## Focused evidence

All commands below ran in the isolated `pa4-provider-neutral-workflows` worktree with a temporary `HOME` and state directory.

| Command | Result |
|---|---|
| `npm --prefix cli run build` | Passed (`tsc`, data copy, build info). |
| `node --import tsx --test test/goal_ledger_propagation.test.ts` | 2 passed, 0 failed. |
| `node --import tsx --test test/goal_lifecycle.test.ts` | 5 passed, 0 failed. |
| `node --import tsx --test test/workflow_provider_neutral.test.ts` | 3 passed, 0 failed; 382.5s total. |
| `git diff --cached --check` | Passed before commit. |

The workflow fixture runs the bounded loop over a minimal OpenAI-compatible chat/tool endpoint, then through the existing Anthropic Messages adapter, and runs a durable goal through the standard endpoint. Each uses a real workspace write, deterministic `npm test` verifier and independent reviewer receipt. The fixture deliberately offers no token-counting extension; it does not claim to qualify local or hosted production providers.

The first fixture run used a 60-second loop duration and returned `EXHAUSTED` after the iteration's deterministic verifier and independent review passed at 118s and 156s. This confirmed the duration limit is enforced. The fixture bound was raised to 300 seconds; the corrected run passed. Product loop limits were not changed.

## Reference coding

The required XERJ search queried the indexed `opencode` peer corpus for fresh-task objective-ledger initialization. That corpus is marked incomplete; its returned passages were unrelated lifecycle tests, so no peer design or code was used. The implementation follows Nexus's existing `ObjectiveLedger`, durable task checkpoint, and goal evidence-folding APIs.

## Limits

This is a PA-4 implementation slice, not completion of the full delegation assignment. Hosted checks for PR #713 at head `672c08d425989c474e4f732c734f7f24c603e8df` were still running when this evidence was recorded. Provider compatibility beyond the two deterministic adapter fixtures, the full security/adversarial matrix, comparative evaluation, and remaining PA-4 acceptance items are not claimed here.
