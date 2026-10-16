# Execution convergence: one lifecycle for autonomous work

Branch `fix/inference-transport-cause`, baseline 9f103ee. Code references are to `cli/src`.

```
user workflow/command (/team [experimental], nexus operation [experimental])
  -> orchestration strategy (TeamOrchestrator: roles -> work units)
  -> durable work units + dependencies (DurableOperationState, OperationStore)
  -> convergence scheduler (ConvergenceScheduler decides; OperationRunner owns time, execution, persistence)
  -> agent turn (AgentWorkUnitExecutor -> runTurn) / provider recovery (ProviderRecoveryController) / context admission
  -> tools + inference resources (ResourceRegistry, LocalLlmClient)
```

Interactive turns (REPL, TUI sidecar, `nexus run`) enter at "agent turn" directly; see section 8.

## 1. Execution-path matrix (baseline 9f103ee, before changes)

Read from the code, not from earlier reports. "Turn" = `AutonomousAgent.runTurn`, which owns `ProviderRecoveryController`,
`admitContext` (fail-closed capacity), truthful `TurnResult` and per-step durable checkpoints.

| Path (user-visible) | Work representation | Inference | Provider recovery | Context mgmt | Success determined by | Failure propagation | WAITING | BLOCKED | Durable recovery | Explicit deps | Resource eligibility | Truthful cancel | Restart/resume |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `nexus run` / `ApplicationCore.runTask` | one turn (`agent.run`) | `runTurn` streaming | yes | yes (admission, compaction) | `TurnResult` execution/outcome | `TurnResult` → exit code / JSON | in-turn only (recovery wait) | turn `BLOCKED` (capacity) | task state per step | n/a | primary + failover endpoints | yes (signal) | `run -r <task>` |
| REPL turn (`repl.ts`) | one turn | `runTurn` | yes | yes | `TurnResult` | rendered | in-turn only | turn `BLOCKED` | task state | n/a | primary | yes (Ctrl-C) | `/recover` |
| Sidecar / TUI turn (`sidecar.ts`) | one turn | `runTurn` | yes | yes | `TurnResult` | turn events | in-turn only | turn `BLOCKED` | task state | n/a | primary | yes (signal) | recover command |
| `/tdd`, `run --tdd` | several turns (synthesizer) | `runTurn` | yes | yes | verifier evidence; last turn downgraded if TDD fails | `TurnResult` | in-turn only | turn `BLOCKED` | task state | implicit phase order | primary | yes (signal) | no |
| `nexus eval` | one turn per instance | `agent.run` | yes | yes | benchmark patch/test check | report | in-turn only | turn `BLOCKED` | task state | n/a | primary | no | no |
| **`/team full`** (slash + legacy REPL) | 4 sequential `runSubagent` calls | `chatCompletion` (non-streaming) | **none** | `admitContext` per step | **`success: true` unless an exception escapes** | **inference error returned as report text → SUCCESS** | **no** | **no** | **none** | implicit fixed order, failure does not stop later roles | **none** (base model for every role, task-class header only) | **no** (no signal) | **no** |
| **`/team <role>`** | one `runSubagent` | same | **none** | per step | **same false success** | same | no | no | none | n/a | none | no | no |
| `spawn_subagent` tool | nested `runSubagent` inside a parent turn | same | **none** | per step | **tool `success: true` for any returned string**, incl. inference failure and step-limit exhaustion (historical; see §8) | same false success to the parent model | no | no | none (parent turn is durable) | n/a | parent config | no | no |
| `nexus operation run/resume` | durable operation of work units (`OperationRunner`) | unit = `runTurn` pinned to a resource | yes (+ YIELDED to scheduler) | yes (per-resource limit) | unit `TurnResult` classified by `AgentWorkUnitExecutor.classify` | unit → BLOCKED with decision; operation BLOCKED | **yes** (durable) | **yes** | operation + per-unit task state, driver lock | yes (validated DAG) | yes (registry, conditions, capabilities, independence) | yes | yes (`resume`) |

Contradictions found:

1. `/team` and `spawn_subagent` use a second agent loop (`runSubagent`) that bypasses provider recovery, the
   truthful `TurnResult`, cancellation and durability, and converts inference failure into a successful report.
2. Two "success" meanings: `TurnResult`/work-unit classification (evidence) vs `RoleTaskResult.success`
   ("the function returned").
3. Role → model routing exists twice: `/team` task-class headers vs scheduler requirements/resources.
4. Credential scope: `readLatestAuthToken` (stored aihost token) is attached to any endpoint without an explicit key
   (client constructor, 401 reload) and `buildConfig` bakes it into `config.apiKey`, which derived configs (planner,
   coder, subagents) then send to their own endpoints. Only the scheduler path was guarded (`noAmbientCredentials`).

## 2. The /team false success

Reproduction (`test/team_convergence.test.ts` tests 1–2, failing on 9f103ee): a provider that answers every chat
request with HTTP 400. `/team researcher …` returned `success: true` with the report
`Subagent failed during LLM inference: Inference error (HTTP 400) …`; `/team full …` ran all four roles on the
failed role's missing output and returned success.

Root cause: `TeamOrchestrator.executeRoleTask` built `{ success: true, output: await agent.runSubagent(...) }`, and
`runSubagent` caught inference failure and step-limit exhaustion and *returned* them as the report string. Success
meant "the function returned". `runFullWorkflow` passed each role's text to the next role unconditionally.

## 3. Lifecycle

One model for durable autonomous work, defined in `core/operation.ts` (header) and used by `nexus operation` and
`/team`:

| Unit state | Meaning |
|---|---|
| RUNNABLE | dependencies COMPLETE; waiting for the scheduler |
| RUNNING | a turn is executing on its assigned resource |
| PARKED | a qualified resource will be eligible again at a known time; no model context is held |
| WAITING_ON_DEPENDENCY | some dependency is not COMPLETE (a BLOCKED dependency keeps it here) |
| COMPLETE | the turn completed with an established result: `turnSucceeded(TurnResult)`, the same predicate as `nexus run` exit 0 (outcome `VERIFIED`, or `NOT_REQUIRED`). `UNVERIFIED` work is not complete |
| BLOCKED | no safe autonomous transition; carries one structured decision |

| Operation state | Meaning |
|---|---|
| RUNNING | some unit is runnable or running (the "active" state) |
| WAITING | nothing can run now; required work is parked on a known time |
| BLOCKED | nothing can run or wait; required work needs a decision |
| COMPLETE | every required unit is COMPLETE |
| CANCELLED | the operator stopped it; history preserved |

There is no FAILED state. Terminal execution failure (provider rejection, step limit, unknown execution with its
replay budget spent, interrupted tool, no qualified resource) is BLOCKED with a decision; environmental conditions
(rate limit, capacity, transport outage) park or reroute. `TurnResult` remains the per-turn vocabulary; the unit
state is derived from it in `AgentWorkUnitExecutor.classify`, so no second set of execution enums exists. A turn
that completed without an established result (`UNVERIFIED`: verification not run, no applicable verifier, or
`CONTEXT_EVIDENCE_NOT_RETAINED`) is BLOCKED with a retry/revise decision, never COMPLETE.

`NOT_REQUIRED` means the turn changed nothing *and* every tool output it relied on was still in its context. When
context compaction removes a tool observation (elided or truncated by the detail budget) and the turn does not run
that tool with the same arguments again, the turn is `UNVERIFIED` with reason `CONTEXT_EVIDENCE_NOT_RETAINED`. The
durable record tells the model exactly which outputs left its context (`Output no longer in context (rerun to see it
again): <tool> <args>`), carries which notes still hold full output (`retainedObservations`), and a resumed unit
re-derives what it no longer holds from its recovered conversation. Removal tracking is per turn (plus resumed
conversations); an interactive REPL turn relying on output compacted away in an earlier turn is not flagged.

### Decisions

A BLOCKED unit carries `{ id: "<unit>#<n>", cause, question, options[] }`. Every option is a typed `DecisionAction`:
`retry` (optionally clearing operator-needed resource conditions), `keep_waiting`, `assign` (to a named resource,
listing the requirements it overrides — never independence or trust), `revise` (operator note appended to the unit's
task), `drop` (advisory units only) and `cancel_operation`. `ConvergenceScheduler.resolve` validates the decision id,
the option id and the action against current state and throws `DecisionRejected` otherwise; applying one records
it on `unit.decisions`, emits `DECISION_APPLIED` and resumes the operation under the driver lock. Operators apply
them with `nexus operation decide <operation> <decision> <option> [--note …] [--no-resume]`. Nothing else mutates a
BLOCKED unit.

## 4. /team on the convergence foundation

`TeamOrchestrator` is now a strategy: it maps the request to work units and drives them through `driveOperation`
(the same entry `nexus operation run/resume` uses). `executeRoleTask`, `runFullWorkflow`, `RoleTaskResult` and the
role-specific `runSubagent` prompt plumbing are removed.

| Unit | Role | Depends on | Requirement |
|---|---|---|---|
| research | researcher | — | qualification `research`, capability `tools` |
| design | architect | research | `architecture` |
| implement | implementer | design | `implementation` |
| verify | tester | implement | `verification` |
| review (only with `--independent-review`, or `/team reviewer`) | reviewer | implement | `review`, `independentOf: [implement]` |

`/team <role>` is a one-unit operation. Each unit is an `AgentWorkUnitExecutor` turn (streaming `runTurn` with
provider recovery, context admission and a durable task conversation) run in 15-step segments (with durable checkpoints at segment boundaries; under default continuation units run until completion, stagnation or cancellation, while `--no-continuation` bounds the turn at 15 steps); dependency summaries are
passed to dependents as context. The operation is persisted under `~/.nexus/tasks/team-xxxxxxxx.json`, so
`nexus operation status|resume|decide` work on team operations. `/team` waits in-process up to 60 s; a longer wait
returns `NOT COMPLETE (WAITING)` with the resume command. Ctrl-C in the legacy REPL aborts the operation
(CANCELLED, resumable). The report is derived from operation state: `Result: COMPLETE` only when the operation is
COMPLETE.

Roles are defined once in `core/roles.ts` (`ROLE_PROFILES`, `ROLE_REQUIREMENTS`).

## 5. Capability routing and independence

Resources come from configuration (`resourcesFromConfig`): primary, failover endpoints, and the planner/coder models
when configured. The planner is `preferredFor` research/architecture/review and the coder for
implementation/verification, so roles do not all land on the default model; `ResourceRegistry.select` orders by
preference, then rank. When the chosen resource has a temporary condition the scheduler reroutes to a qualified
eligible alternate; otherwise it parks the unit and continues other eligible work; the operation waits when nothing
can run, and blocks only when no qualified resource exists at all.

`independentOf` is a trust constraint: the review unit can never run on a model that ran `implement`, and `assign`
options never offer a trust-violating resource. If only the implementer's model is available the review parks or
blocks (`NO_QUALIFIED_RESOURCE`); it is never reported as independent.

## 6. Completion propagation

A unit runs only when all of its dependencies are COMPLETE. A BLOCKED dependency leaves its dependents in
WAITING_ON_DEPENDENCY and the operation BLOCKED with the dependency's decision. Advisory units (`required: false`)
are reported but never awaited; `newOperation` rejects a required unit that depends on an advisory one, so advisory
work cannot silently become required.

## 7. Credential boundary

Root cause (9f103ee): `readLatestAuthToken()` read the stored gateway token (`NEXUS_GATEWAY_TOKEN_FILE` / `~/.config/nexus/gateway-token`)
and `LocalLlmClient` attached it to *any* endpoint configured without an explicit key, including failover endpoints
and the 401 reload path; `buildConfig` baked it into `config.apiKey`; planner/coder configs then reused
`config.apiKey` for their own endpoints.

Remediation (no secret-management redesign):

- The stored token and config.env's `LOCAL_LLM_API_KEY` belong to config.env's `LOCAL_LLM_ENDPOINT` origin (else
  `$LOCAL_LLM_ENDPOINT`), plus any origins listed in `LOCAL_LLM_CREDENTIAL_ORIGINS`. `$LOCAL_LLM_API_KEY` belongs to
  `$LOCAL_LLM_ENDPOINT`. An explicit key belongs to `config.credentialOrigin`, else the endpoint it was given for.
- `LocalLlmClient` resolves the credential per request URL (`credentialFor`); a 401 reload re-reads only that
  gateway's stored credential. Endpoints with no credential send `Bearer not-needed`.
- `buildConfig` no longer bakes the stored token into `config.apiKey`; planner/coder configs carry the origin their
  key belongs to; scheduler resources with `apiKeyEnv` get that key scoped to their own endpoint.
- Credential values never appear in operation state, events, reports or errors (test 26 checks all of them).

Origin authority (I6 remediation): only the operator decides where a stored credential may go. `loadEnvironment`
snapshots the process environment before any env file is read and overlays `~/.config/nexus/config.env`; that is
the credential authority (`setCredentialAuthority`). The install `.env` and the working-directory `.env` still
configure endpoints and models, but their `LOCAL_LLM_CREDENTIAL_ORIGINS` / `LOCAL_LLM_ENDPOINT` never widen or
re-home a stored credential (token file, config.env key, or the operator's `LOCAL_LLM_API_KEY`). A key a project
`.env` supplies itself is bound only to that project's endpoint. `mayBindCredential` applies the same rule to a
scheduler resource's `apiKeyEnv`, so a spec cannot point a stored credential at another origin.

## 8. Single-agent boundary

An interactive turn stays a direct `runTurn`: one turn whose `TurnResult` is the outcome, with provider recovery
and context admission inside it. Wrapping it in an operation would add a store and lock but no new truth. Work that
has dependencies, must outlive a resource becoming unavailable, may wait, or must resume after a restart is an
operation. `spawn_subagent` is in-turn delegation: its result is a tool result of the parent's durable turn and is
now truthful (`SubagentResult.completed`; the tool reports `success: false` when the child did not complete). The
child is complete only by `turnSucceeded` on its own turn: its `task_completed` goes through the same receipt
validation as any turn (a rejected receipt keeps it working), and a plain-text report over unverified changes is
not completion. The child's workspace changes count as the parent's, so the parent must verify them before it can
complete; it cannot finish as `NOT_REQUIRED`.

## 9. Restart and reboot

Process restart: proven. Operation state and each unit's task conversation are durable; a driver killed at any
point leaves a lock whose pid is dead, which the next `nexus operation resume` takes over; interrupted RUNNING units
are reconciled (bounded unknown-outcome resumes).

Host reboot: Nexus has no daemon or service lifecycle (the only long-lived child is the per-process Rust RPC
helper), so none was added. After a reboot the state is intact and a lock written before boot is treated as stale
even if its pid number has been reused (`OperationStore.acquire` compares the lock time with boot time). The
smallest integration point is an OS boot hook that runs `nexus operation resume` (with no id it resumes the latest
WAITING or RUNNING operation for the workspace; BLOCKED operations are excluded because they need a decision), e.g.
a user systemd unit or `@reboot` cron entry. That hook is not installed by Nexus.

## 10. Remaining duplication and limitations

- `runSubagent` remains a second, in-turn agent loop for `spawn_subagent`. It now has provider recovery, context
  admission with `measureAdmission` (closing the strict token counting gap per REQ-AGT-111 / AGT-05), matched
  offered and accepted tool sets via `getEffectiveTools()`, token accounting merged into parent stats, and a truthful result.
  Remaining divergences from `runTurn` deferred to post-v1 include: non-streaming responses, in-turn subagents are non-durable
  (no task state records on disk per REQ-AGT-105), no empty-reply retry, no backoff for poll loops, no operator steering queue,
  and no cancellation signal separate from the parent turn. Folding it into a single shared step function remains post-v1.
- The legacy REPL and the slash router each wire `/team` to `TeamOrchestrator` (display only; same operation).
- Roles run sequentially; the scheduler would allow parallel units but no concurrency was added.
- Open (I3): an exhausted 502/504 or ENOTFOUND blocks the unit instead of parking it, and a context-capacity
  block does not reroute to a larger qualified resource. Open (I4): parked advisory work can hide a required unit's
  decision in the report. Open: stale-lock takeover can race between two resumers, and a corrupt lock never
  becomes stale. See `docs/reviews/NEXUS_CONVERGENCE_INVARIANT_REMEDIATION.md`.
- Resource requirements per role are qualification labels; real capability metadata depends on provider catalogs
  (`--discover`), which aihost aliases do not publish beyond the model list.
