# v1.1.0 decisions and known-solution log

Status: normative for decisions; descriptive for research. Every decision names its evidence. Every external
approach names what was adopted, what was rejected, and why.

Spec: [`SPEC.md`](SPEC.md). Review: [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md).

---

## 1. How xerj is configured and invoked for this repository

There is **no in-repository xerj configuration**. `grep -rl xerj` over the tracked tree (Markdown, JSON, TOML,
shell, YAML; excluding `node_modules` and `.git`) returns no matches. xerj is an operator-level tool, not a project
dependency. The identity and invocation path were established before use:

| Aspect | Finding | Evidence |
|---|---|---|
| Binary | `xerj` v1.0.0-rc.99 at `/home/mike/.local/bin/xerj` | `which xerj`; `xerj --version` |
| MCP registration | server `xerj`, command `/home/mike/.local/bin/xerj`, args `["mcp"]` | `~/.config/nexus/mcp.json` |
| Engine | XERJ's own ES-compatible node at `http://localhost:9200`, `cluster_name: "xerj"`, `cluster_uuid: xerj-cluster-…` | `curl http://localhost:9200/` |
| Index refresh | `~/.local/bin/xerj-refresh-nexus` indexes a **clean `git archive` of `origin/main`** — only `cli/src`, `core/src`, `cli/test`, `docs` — with `eval/` excluded; `--replace-prefix --fresh --disable-feedback` | script source |
| Index names | `nexus-cli-docs` (2726), `nexus-core-docs` (1057), `nexus-test-docs` (1064), `nexus-docs-docs` (9927) | `xerj_map` |
| Freshness | Export directory stamped 2026-10-31T16:56Z; the `.origin-main-sha` marker was absent, so the indexed commit is **inferred from the export timestamp, not asserted by the tool** | `stat ~/xerj-sources/nexus-code` |
| Peer indices used | `opencode-docs` (48663), `goose-docs` (25448), `codex-docs` (103381) | `xerj_map` |
| Hub | `serverless-workflow-spec` pinned at `13b6a625`, Apache-2.0; `argo-workflows` could not be pulled (87.5 MB > 50 MB cap, hosted answers disabled in a git repo) | `xerj hub pull`; `xerj_hub_ask` errors |

**Limitation that matters for every citation below:** xerj sees committed `origin/main`, never this worktree. Code
questions answered through xerj describe the v1.0.0 baseline. Uncommitted v1.1 work is invisible to it, so xerj was
used to find *established approaches* and to confirm the baseline, never to check a v1.1 change.

## 2. Research log

Each entry records the query, what came back, what was adopted, and what was rejected.

### R-1 — Keyed concurrency and reservation

- **Query:** `opencode-docs` / "run-coordinator acquire concurrency limit" (also via `xerj_batch_search`).
- **Result:** `packages/core/src/session/run-coordinator.ts` — "Serializes execution for each key while allowing
  different keys to run concurrently." The coordinator exposes `active`, `isActive`, `run`, `wake`, `interrupt`,
  `awaitIdle`; one execution is a "busy period for one key", and `pendingWake` is a doorbell that closes the gap
  between the last eligibility check and the idle transition.
- **Adopted:** the core idea that concurrency is **per key**, and that a key which is busy is *not a failure*. In
  Nexus the key is a resource slot; a unit whose resource is busy stays `RUNNABLE` and is considered again next
  iteration (SPEC §3.4). The "doorbell" gap is the same problem as our `decide()` → `start()` window, and is closed
  by re-running `decide()` after every completion rather than by a separate primitive.
- **Rejected:** the Effect/Fiber implementation. Nexus's runner is a single async loop with synchronous persistence;
  adopting a fiber runtime would change the durability model and the failure classification, which v1.1 explicitly
  must not do.
- **Limitation:** opencode's coordinator owns process-local state only; it does not solve durable recovery, which is
  why our batch is reconciled from persisted state (`reconcileInterruptedRuns`) rather than from coordinator memory.

### R-2 — Schema migration discipline

- **Query:** `opencode-docs` / "database migration list apply version table".
- **Result:** `packages/core/src/database/migration.ts` — a `migration` table of applied ids; apply is idempotent;
  each migration runs in a transaction that also records its id; a legacy journal is seeded once so old migrations do
  not replay; an unmatched legacy timestamp is a hard error (`Effect.die`), not a guess; start/finish are logged with
  duration.
- **Adopted:** idempotence; record the applied version on the durable object; fail closed on an unknown/legacy shape
  rather than reinterpret it; never replay a migration that already applied. In Nexus this becomes: one version step,
  a `.pre-migration-v1` backup created once and verified byte-for-byte, and `UnsupportedOperationSchemaError` for a
  version this build does not know (SPEC §4.2–§4.3).
- **Rejected:** a migration journal table. The operation record is a single JSON document written atomically; a
  journal would add a second durable object with its own corruption modes.
- **Limitation:** without per-migration transactions, atomicity comes from the existing temp-file + fsync + rename
  (`durable_file.ts:120-162`) and from the backup-before-write rule. That is weaker than a transactional journal and
  is why the backup creation is itself fail-closed.

### R-3 — Parallel subagents, isolation, and serialisation

- **Query:** `goose-docs` / "subagent parallel tasks concurrency".
- **Result:** goose's subagent/subrecipe docs state that subagents "run their tasks in isolation and do not share
  state"; sharing requires explicit prompt instruction; concurrency is capped (10, not user-configurable); a
  `sequential_when_repeated: true` flag exists for work that must not run in parallel (their example: database
  migrations); a failure in one parallel subagent yields no output from it but does not cancel the rest.
- **Adopted:** (a) isolated per-unit worktrees under concurrency — no two write units share a tree (SPEC §2.2,
  §8); (b) the typed message channel as the *only* way knowledge crosses units, because shared state is what
  isolation forbids (SPEC §6.3); (c) a serialised integration queue, which is exactly the
  "sequential_when_repeated" case for a shared worktree (SPEC §5.3); (d) failure isolation — one unit's failure does
  not touch a batch-mate (SPEC §3.5).
- **Rejected:** importing goose's numeric cap or its prompt-based sharing. A prompt instruction is not a contract;
  ours is a persisted, typed record with at-most-once delivery.
- **Limitation:** goose does not describe crash recovery, so it says nothing about the hardest part of our problem.

### R-4 — Parallel state semantics and error model

- **Query:** hub `serverless-workflow-spec` / "State types, transition rules, and how error and retry handling are
  declared in a durable workflow" (`xerj_hub_ask`, `mode: how`, answered from the local pack).
- **Result:** the state-type table defines a **Parallel** state that "causes parallel execution of branches (set of
  states)" and, like every other state, "handles errors? yes (includes retries)". The DSL separates `try` (catch) from
  retry, and retry is described for transient faults such as `503 Service Unavailable`.
- **Adopted:** the batch is the Parallel-state analogue; retry stays **per unit** (existing `maxRunsPerUnit` and the
  `unknownResumeBudget`) rather than being a batch-level construct; an error is an escalation the operator resolves,
  matching the existing `DecisionAction` vocabulary. A transient provider fault is already classified as
  `resource_unavailable` and reroutes or parks, which is the correct analogue of "retry on 503".
- **Rejected:** a declarative workflow DSL. Nexus operations are imperative specs executed by TypeScript; adding a
  second authoring language would duplicate the scheduler.
- **Limitation:** the specification defines authoring semantics, not runtime crash recovery, so it cannot validate
  our durability claims. Licence: Apache-2.0, adapt-with-attribution; nothing was copied verbatim.

### R-5 — Unavailable reference

- **Query:** `xerj_hub_find` "durable workflow engine with parallel task scheduling, retries, and crash recovery"
  surfaced `argo-workflows` (Apache-2.0) as the closest match.
- **Result:** `xerj hub pull argo-workflows` was refused (87.5 MB exceeds the 50 MB auto-pull cap, and hosted answers
  are off inside a git repository). No content was retrieved.
- **Consequence:** no Argo claim is made anywhere in this specification. Its DAG-parallelism model was **not** used
  as evidence; the parallel design rests on R-1, R-3 and the repository's own scheduler semantics.

### R-6 — Baseline verification through xerj

- **Query:** `nexus-cli-docs` / "operation_view buildOperationView".
- **Result:** `operation_view.ts` with `buildOperationView` at line 337, matching the merged source.
- **Use:** confirmed that the indexed baseline is the post-v1.0.0 code and that definition-first retrieval points at
  the defining file. Every substantive baseline claim in `ROADMAP-REVIEW.md` was then re-verified against the
  worktree source or an executed command, not against xerj alone.

## 3. Decisions

### DEC-V11-00 — v1.1.0 inherits the v1.0.0 gates; it does not declare them met

**Decision.** v1.1.0 keeps every v1.0.0 gate. It may add evidence and must not relax a gate. Publication of a stable
v1.1.0 with the v1.0.0 qualification gaps still open requires an explicit owner decision naming each gap.

**Evidence.** `docs/releases/v1.0.0.md` (published body) still says acceptance is `IN_PROGRESS`; `CHANGELOG.md:9` says
`Unreleased (Release Candidate)`; `check_requirements --enforce` reports 7 open rows and 12 exact-RC deferrals; issues
#1, #2, #5, #6, #7, #49 are open.

**Alternative rejected.** Treat the published v1.0.0 artifact as qualification. Rejected because publication is not
acceptance under `ACCEPTANCE.md` §1.1, and the artifact's own notes say so.

**Unresolved.** Whether the owner authorizes stable v1.1.0 under inherited gaps. This is a genuine blocking decision
for the release gate, not for implementation.

### DEC-V11-01 — Operation state schema 2, fail closed on unknown versions

**Decision.** `CURRENT_OPERATION_SCHEMA_VERSION = 2`. A record with an unknown integer version throws
`UnsupportedOperationSchemaError` and is **not** quarantined. A v1 record migrates in memory and gets a
`.pre-migration-v1` backup of the whole record before its first v2 write.

**Evidence.** `docs/v1.1.0/README.md:28` already requires this for any `DurableOperationState` change; the rule was
violated by the merged git/checkpoint/context work (D-V11-01). R-2 supports the discipline.

**Alternatives rejected.** (a) Keep version 1 and rely on optional fields — rejected: it makes a future record
indistinguishable from a current one and cannot ever fail closed. (b) Bump the envelope version instead — rejected:
the envelope (`CURRENT_STATE_SCHEMA_VERSION = 2`) is shared with every task, so a bump would force a migration of all
sessions for an operation-only change.

### DEC-V11-02 — Concurrency is opt-in, default 1, capped at 64

**Decision.** `policy.maxConcurrentUnits` defaults to 1; `resource.maxConcurrentUnits` defaults to 1; valid range
`[1, 64]`.

**Evidence.** SPEC §3.3; the v1.1 README risk "concurrency must default to 1 and require explicit opt-in"; R-3's
bounded-worker precedent. The cap is a cost bound: parallel agents multiply provider spend.

**Alternative rejected.** Automatic sizing from task complexity or discovered provider capacity. Rejected for v1.1:
a discovered number is an observation, and the risk note in the proposal says changing the model shifts every
qualification timing.

### DEC-V11-03 — Deterministic order: required, critical path, declaration order

**Decision.** Sort by required-first, then longest unfinished dependent chain descending, then the operation's declared
unit order.

**Evidence.** SPEC §3.2; the view already computes the same chain (`operation_view.ts:265-304`) and the task requires
that concurrency not change outcomes for independent units, which needs a total order that ignores arrival timing.
`localeCompare` is banned because it is locale-dependent.

**Alternatives rejected.** (a) Completion order — arrival timing would change the choice between runs. (b) Unit id as
the final tie-break — equally deterministic, but it reorders an existing v1.0.0 operation's independent units after
upgrade with no benefit; declaration order is durable state and preserves the pre-v1.1 order. `localeCompare` is
banned in the comparator because it is locale-dependent.

**Known cost.** The scheduler has its own chain-length function rather than importing the view's. A shared helper would
invert the module dependency (`operation_view.ts` already imports `operation.ts`). The two measure different things on
purpose: the view reports the chain of *unfinished* units for display, the scheduler measures the unfinished chain
*downstream* of a candidate. Divergence in the scheduler's version is caught by the ordering test.
**Revision (2026-10-31):** the first implementation measured the chain *upstream* (dependencies), which made a unit
with a long tail tie with an unrelated leaf. The test "the longest unfinished dependency chain is scheduled before
independent work" caught it and the direction was corrected before the slice was committed.

### DEC-V11-04 — Resource slots are reserved per batch

**Decision.** Greedy reservation over the deterministic order; a unit whose resource is full stays `RUNNABLE` and is
retried next iteration; it is never parked or blocked for being busy.

**Evidence.** SPEC §3.4; R-1 (keyed serialisation, busy is not failure); the acceptance requirement that two units on
one single-slot resource serialise.

**Revision (2026-10-31):** the first implementation took the registry's single best resource and skipped the unit when
that slot was busy. That serialised two units even when a second qualified resource was free — caught by the
concurrency test before commit. Selection is now reservation-aware: a unit takes its next qualified, eligible resource
whose slot is free.

**Alternative rejected.** Letting `registry.select` be concurrency-aware. Rejected: the registry models resources, not
run state; teaching it about running units would put scheduling policy in the wrong component.

### DEC-V11-05 — One writer; the batch is intra-process

**Decision.** The whole batch runs inside one `driveOperation` under the existing per-operation lock. No second
driver process, no lease change.

**Evidence.** `operation_runner.ts:404-412`; `operation_persistence` lock semantics; CONCURRENCY §3.

**Consequence.** Parallelism does not increase throughput across processes, only across in-flight units within one
operation. This is honest scope, not a limitation to be worked around silently.

### DEC-V11-06 — Integration is a serialised queue, not inline

**Decision.** Completed units enqueue integration; a per-runner promise chain performs one merge at a time in arrival
order; the queue drains before the runner returns; a queued integration for a cancelled/dropped unit is skipped and
logged.

**Evidence.** SPEC §5.3; R-3 (`sequential_when_repeated` for shared resources); `operation_git.ts:235-382` mutates one
shared integration worktree and cannot run concurrently.

**Alternative rejected.** A dependency-ordered queue. Dependency order is already enforced by the scheduler (a
dependent cannot start before its dependency is complete); adding a second ordering would create two sources of truth
for merge order.

### DEC-V11-07 — Typed messages replace shared memory

**Decision.** `OperationMessage` records live in the operation state, are typed (`request`, `observation`, `artifact`,
`verdict`), delivered at most once, addressed to a unit or `"*"`, bounded to 4,000 characters and 200 retained
messages.

**Evidence.** SPEC §6.3; R-3 (isolation forbids shared state; sharing must be explicit). The v1.1 proposal's own
constraint: "No shared mutable memory."

**Alternatives rejected.** (a) A shared scratchpad on the operation — rejected: it is shared mutable state and would
let a unit's unverified claim become another unit's input without a delivery record. (b) A `send_unit_message` tool in
v1.1 — deferred: it adds a tool surface, an approval effect and a capability definition; the channel is useful
without it and the tool is additive later.

### DEC-V11-08 — Cancellation aborts the whole batch and leaves every unit resumable

**Decision.** One shared `AbortSignal`; every in-flight unit settles as `cancelled`; each is applied to `RUNNABLE`
before `scheduler.cancel()`; all worktrees are preserved on the cancel path.

**Evidence.** SPEC §3.5; v1.1 acceptance "Cancel stops both, and both are resumable"; existing single-unit cancel
semantics (`operation_runner.ts:159-162`) generalised.

### DEC-V11-09 — Receipts carry candidate and tests

**Decision.** Add `candidate {digest, scope}`, `tests {command, status, hasExecutedTests}` and monotonic `sequence`
to `IntegrationReceipt`; omit `tests` when the unit produced none.

**Evidence.** SPEC §5.2; the proposal claims receipts record "the candidate identity, the tests run" but they do not
(D-V11-05). An omitted field is honest; a fabricated one would be evidence fraud.

### DEC-V11-10 — Replay is a read-only projection

**Decision.** `--replay` renders the persisted event log chronologically; mutually exclusive with `--dag`; `--json`
adds a `replay` object; no re-execution, no provider, no lock, no write.

**Evidence.** SPEC §7.2; the v1.1 proposal's constraint "The view reads only the operation store and the event
stream" and "Replay of a finished operation from its event log and unit conversations (read-only)".

**Alternative rejected.** Replay from unit conversations. Conversations are large, may be compacted, and reading
them would break the "never hold every turn in memory" constraint. Events are the right granularity.

### DEC-V11-11 — The view document version bumps to 2

**Decision.** `OPERATION_VIEW_SCHEMA_VERSION = 2` and the checked-in schema's `const` becomes 2.

**Evidence.** SPEC §4.5; the schema uses `additionalProperties: false`, so adding `replay` *is* a breaking change for
a strict consumer. Keeping the version at 1 while adding a field would make the version meaningless.

### DEC-V11-12 — `git.publish` is rejected, not silently ignored

**Decision.** v1.1.0 does not implement PR publication. The spec validator rejects `git.publish` and any other
unknown key with exit 2 and a one-line message.

**Evidence.** D-V11-02 (silent ignore); the proposal marks publication as "not in slice 2"; a shell `git push` runs
under the `exec` effect and would bypass `InformationFlowBoundary` (verified: `capability_definitions/proc.ts:8,57`
vs `net.ts:3-8`), so a correct implementation needs a dedicated operation-level egress action.

**Unresolved (v1.2).** The authorization record shape, the egress recorder in the test harness, and whether repository
content may leave the machine at all.

### DEC-V11-13 — Semantic retrieval is deferred

**Decision.** No semantic retrieval over operation records in v1.1.0.

**Evidence.** SPEC §6.2. The existing `HybridSearchEngine` is workspace-scoped (`embeddings.ts:206-320`); nothing
indexes operation records. A retrieval feature that can surface unverified claims needs a local index with deletion
semantics and an embedding-egress policy. Adding it inside a scheduling release would put an unqualified data path
next to the verification gates.

**Alternative rejected.** Reuse the workspace index by pointing it at `~/.nexus/tasks` — rejected: that mixes
operator state into a workspace index, breaks deletion semantics, and has no egress story.

### DEC-V11-14 — TUI pane and in-view decisions are deferred

**Decision.** The CLI view and the printed `nexus operation decide …` command remain the only surfaces in v1.1.0.

**Evidence.** SPEC §7.3–§7.4. A TUI pane needs PTY qualification and couples this release to the Rust TUI; in-view
decisions would create a second mutation path into `applyOperatorDecision`.

### DEC-V11-15 — v1.1 acceptance has its own ledger

**Decision.** `docs/v1.1.0/REQUIREMENTS.md` is added and enforced with `check_requirements.mjs --ledger …`; the v1.0
ledger is not repurposed.

**Evidence.** `scripts/check_requirements.mjs` validates that each `test:<file>::"<name>"` reference exists; the v1.0
ledger's 12 deferrals are exact-RC semantics that must not be disturbed. Reusing it would either relax v1.0 rows or
bury v1.1 rows in a deferral list.

## 4. Assumptions

1. The store is safe for multiple synchronous `save()` calls interleaved between `await`s in one process. This must be
   proven (WP-3 blocker) before the batch persists per unit; if it is false, the batch persists once per iteration
   instead and the durability claim is restated.
2. `AbortSignal` propagation into the executor already works per turn (`UnitRunContext.signal`); concurrency does not
   change it.
3. Git operations are fast enough that a serialised queue does not dominate a two-unit batch. Measured, not assumed,
   in the performance test.
4. The v1.0.0 operation record shape is stable enough to check in as a fixture. **Resolved:** a real record was
   produced by running the `v1.0.0` tag's own `OperationStore.save` (no inference involved) and is checked in as
   `cli/test/fixtures/operation-v1.json`; its only edit is the embedded workspace path, which the store binds a
   record to. See that directory's README.

## 5. Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| Q1 | **Resolved 2026-10-31:** the owner directed release to proceed after the inherited v1.0.0 gaps were disclosed. Stable publication is authorized with those items open and named; this does not waive any v1.1.0 gate or constitute v1.0.0 acceptance. | Closed with disclosure | Owner |
| Q2 | **Resolved 2026-10-31:** correct the current-tree v1.0.0 notes and published release body to distinguish artifact publication from unfinished qualification; preserve the v1.0.0 tag and artifact and fold the correction into v1.1.0 preparation. | Closed | Owner |
| Q3 | Should `resource.maxConcurrentUnits` be auto-populated from provider discovery? | Future design | Lead, v1.2 |
| Q4 | Should units be able to send messages directly (a `send_unit_message` tool)? | Future design | Lead, v1.2 |
| Q5 | **Resolved 2026-10-31:** `repro.yml` accepts `vX.Y.Z-rc.N` tags across release lines and rejects stable or malformed tags, with a regression test. | Closed | Release lead |
| Q6 | **Resolved 2026-10-31:** the four implemented operation proposals are v1.1.0. The WP-11xx observability/evaluation roadmap is deferred and is not claimed by this release. | Closed | Owner |
