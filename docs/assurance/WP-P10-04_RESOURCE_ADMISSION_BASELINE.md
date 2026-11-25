# WP-P10-04 Aggregate Resource Admission Baseline

**Inspected revision:** `e65439de136af22ac3b99c14c843d706efa173b9` (`release/v1.3.0`)

## Finding

The scheduler enforces resource slots and CPU/memory reservations within one durable operation. The inspected path does not share those reservations across distinct `OperationRunner` instances or operation IDs. Two operations can therefore each admit work against the same configured one-slot provider resource. This is a confirmed cross-operation admission gap, not evidence that the per-operation scheduler is unbounded.

## Source evidence

- `cli/src/core/operation_runner.ts:134-141` constructs a fresh `ResourceRegistry` and `ConvergenceScheduler` from each operation's state.
- `cli/src/core/scheduler.ts:284-329` builds `used`, CPU, and memory reservations from that scheduler's `this.state.units`, then admits assignments against those local counters.
- `cli/src/core/operation_schema.ts:119-141` derives concurrency and validates explicit CPU/memory reservations for one operation.
- `cli/src/core/operation_runner_persistence.ts:193-206` describes and creates a driver lock named `${id}.lock`; the lock prevents duplicate drivers for the same operation ID, not concurrent operations with different IDs.
- `cli/src/core/resources.ts:194-204` stores resource condition records on each `ResourceRegistry` instance. It does not own cross-operation active-slot reservations.
- `cli/src/core/client_lease.ts:51-78` uses one shared kernel lease per canonical home for normal client invocations. The shared lease coordinates client lifetime with exclusive state maintenance; it does not meter operation or provider capacity.

## Executed evidence

On Node 24.11.1, `cli/test/operation_concurrency.test.ts` passed **17/17** at the inspected revision with an isolated `HOME` and `XDG_CONFIG_HOME`. These tests establish the existing per-operation bounds, including one slot per resource and explicit CPU/memory reservations.

A disposable probe constructed two independent schedulers with distinct operation IDs and the same resource descriptor (`maxConcurrentUnits: 1`). Both returned a runnable assignment for resource `shared`:

```json
{"a":["shared"],"b":["shared"]}
```

The probe used `newOperation`, `ResourceRegistry`, and `ConvergenceScheduler` directly. It demonstrates that their local reservations do not coordinate. It did **not** launch two CLI processes or invoke a live inference provider; those remain required to verify the integrated cross-process behavior after an enforcement boundary is implemented.

## Scope and limits

The scheduler probe confirms only the provider/resource slot gap across operation instances. It does not measure aggregate host CPU or memory consumption, or test end-to-end provider inference. Session, storage, and provider-accounting boundaries are inventoried below; the source review and ledger probe do not amount to host-capacity qualification. Provider cost must not be presented as enforced without a reliable token/cost source.

## Broader ownership inventory

The following controls exist, but their scope is narrower than a host-wide resource envelope:

| Resource | Existing bound and owner | Remaining limit |
|---|---|---|
| Operation work slots / requested CPU and memory | Each `ConvergenceScheduler` counts running units in its own durable operation (`cli/src/core/scheduler.ts:284-329`; `cli/src/core/operation_schema.ts:119-141`). | No shared reservation across operation IDs. CPU/memory values are operator-supplied scheduling reservations, not OS-enforced consumption ceilings. |
| Provider requests, tokens, and cost | `UsageLedger.global()` shares receipts and in-flight reservations within one Node process (`cli/src/usage.ts:113-139`). Its request/token admission checks are at `141-183`; completed receipts are appended to a workspace file at `192-213`. | The authoritative arrays and reservations are process memory; the workspace receipt file is not loaded into the ledger. Multiple processes and restarts do not share request/token/cost totals. Cost is enforceable only when a provider reports it or a provider-specific model snapshot price is available; the code refuses a cost cap when it cannot determine cost. |
| Receipt opt-out versus limits | With `NEXUS_RECEIPTS` unset, `record()` retains the receipt and the one-request limit rejects the next request. | With `NEXUS_RECEIPTS=0`, `record()` removes the in-flight reservation and returns before adding the receipt to `receipts` (`cli/src/usage.ts:192-196`). A repeated request therefore sees zero prior requests and is admitted under `maxRequests: 1`; reproduced below. This makes the telemetry opt-out disable the in-process request/token/cost accounting used by admission. |
| Interactive sessions | ACP limits active sessions to four **per connection**, and in-flight requests to 32 per connection (`cli/src/acp/types.ts:112-114`; enforcement at `cli/src/acp_stdio.ts:290-320`). | These are adapter-local limits. The ordinary durable `SessionManager` enumerates persisted session records without a product-wide active-session admission limit (`cli/src/session.ts:560-630`). Separate clients/processes are not counted together. |
| Language-server memory/processes | One LSP manager limits itself to eight servers and bounds per-document, message, and diagnostic retention; the source estimates roughly 153 MiB retained by one worst-case client, explicitly as a judgement (`cli/src/lsp.ts:75-109`). | The cap is per manager/client, not shared across sessions or processes; it is not an OS memory limit and does not bound other child processes. |
| Sandboxed subprocesses | Docker sandbox mode sets `--pids-limit 512` and a 256 MiB `/tmp` tmpfs per container (`cli/src/sandbox.ts:164,1008-1017`). | This is per Docker container. It does not cap host CPU/memory or total concurrent containers. No equivalent host-wide admission guarantee is established by this evidence. |
| Unattended jobs and output | One runner defaults to one active job, supports at most four, and has a 32-job queue (`cli/src/core/job_runner.ts:36-41`; `cli/src/core/runner_store.ts:18-26`). Worker stderr is capped at 32 MiB; ended-job event/stderr logs are pruned after 30 days while records and receipts remain (`cli/src/core/job_runner.ts:38-41,778-787`). | This bounds the runner queue and selected logs, not all durable operation/session records or aggregate work across multiple runner state directories. |
| Sessions, archives, checkpoints, and flight logs on disk | Existing retention GC targets 90-day age and a 2 GiB state-store size (`cli/src/core/retention.ts:9-11`). It can run daily after acknowledgement or `NEXUS_GC=auto`, with a default two-second scan/cleanup budget (`1401-1447`). Traces separately default to 30-day retention (`cli/src/core/trace.ts:27-30`). | These are cleanup targets, not write-time quotas: they do not refuse writes when storage is full or prove the directory remains below 2 GiB. Automatic GC may be unacknowledged or disabled; a bounded pass can leave work for later. Session compaction archives append durably (`cli/src/session.ts:433-456`) and have no per-archive admission cap in that path. |

### Reproduced provider-limit bypass

**Hypothesis:** Disabling receipt storage should not disable configured request limits.

**Setup:** At the inspected revision, instantiate `UsageLedger`, set `limits = { maxRequests: 1 }`, admit `r1`, record a completed cloud receipt for `r1`, then request admission for `r2`. Run once with `NEXUS_RECEIPTS=0` and once with the variable unset. The isolated probe used `HOME=/tmp`, a dummy `example.invalid` endpoint, no workspace, and no network call.

**Command:**

```sh
HOME=/tmp node --import /home/mike/nexus-code/cli/node_modules/tsx/dist/loader.mjs --input-type=module -e 'import { UsageLedger } from "./cli/src/usage.ts"; process.env.NEXUS_RECEIPTS = "0"; const ledger = new UsageLedger(); ledger.limits = { maxRequests: 1 }; const receipt = (requestId) => ({ at: new Date().toISOString(), requestId, role: "main", providerId: "p", selectedModel: "m", endpointOrigin: "https://example.invalid", protocol: "test", disclosure: "cloud", outcome: "completed", usageConfidence: "provider", costConfidence: "unknown" }); const first = ledger.admit("r1", 10, false, "p", "m"); ledger.record(receipt("r1")); const second = ledger.admit("r2", 10, false, "p", "m"); process.stdout.write(JSON.stringify({ limit: ledger.limits.maxRequests, firstAdmission: first ?? "admitted", receiptsAfterFirst: ledger.all().length, secondAdmission: second ?? "admitted", totalsAfterFirst: ledger.cloudTotals().requests }) + "\n");'
```

**Observed with opt-out:** `{"limit":1,"firstAdmission":"admitted","receiptsAfterFirst":0,"secondAdmission":"admitted","totalsAfterFirst":0}`.

**Control with `delete process.env.NEXUS_RECEIPTS` in the same harness:** `{"firstAdmission":"admitted","receiptsAfterFirst":1,"secondAdmission":"cloud request limit reached (NEXUS_CLOUD_MAX_REQUESTS=1; 1 recorded, 0 in flight)","totalsAfterFirst":1}`.

**Result:** `FAIL` — the opt-out path bypasses the configured in-process request limit. This probe did not exercise provider inference or billing. The separate-process/restart reset follows from the process-static singleton and in-memory arrays; it was not represented as an executed cross-process experiment here.

### Local remediation evidence

Commit `77430b996` on branch `codex/p10-04-admission-baseline` changes `UsageLedger` to keep aggregate-only request/token/cost counters for opted-out cloud receipts. `NEXUS_RECEIPTS=0` still leaves `all()` and user-visible `cloudTotals()` empty and writes no receipt file; admission uses the private aggregates. The counters retain only totals globally and by provider, not request ids, endpoints, model names, or prompt data. They remain process-local and are not durable.

On Node 24.11.1, `cli/test/provider_limits.test.ts` passed **10/10**, including request, token, and snapshot-cost limits with receipt opt-out. `cli/test/provider_robustness.test.ts` passed **27/27**, including the existing local-receipt opt-out behavior. TypeScript check `./cli/node_modules/.bin/tsc --noEmit -p cli/tsconfig.json` exited **0**. The first robustness-test attempt could not resolve `dotenv` because the isolated worktree had no installed dependencies; it passed after the existing dependency directory was made available to the isolated worktree. No production configuration or shared source checkout was changed.

### Ownership conclusion

Nexus has useful local bounds and cleanup mechanisms: operation-local scheduling, the process-wide in-process usage ledger, ACP's per-connection cap, per-manager LSP limits, per-container Docker limits, bounded unattended-job queues/output, and state-retention GC. They do not compose into one cross-session resource budget. The receipt-opt-out bypass is fixed on this branch. Separate processes and restarts still reset provider usage limits, and operation schedulers still admit independently against the same resource identity. The next implementation step is to decide and implement which operator-configured resource identities and scopes need atomic cross-process leases. It should not claim host-wide CPU/memory or exact provider spend containment without OS isolation or authoritative provider accounting.

No production files were changed for this baseline. The root checkout and the existing P10-03 and P10-02 worktrees were not modified.

## Implementation direction

Keep `ResourceRegistry`, `ConvergenceScheduler`, per-operation locks, and `client_lease`. Add the smallest shared admission boundary at operation dispatch, keyed by a canonical non-secret resource identity (provider, endpoint, model, and known pool/account scope). The boundary must atomically reserve capacity before a unit starts and release or reconcile it after completion, cancellation, process exit, and restart. Reuse existing file-guard and process-identity primitives where they provide the needed cross-process ownership; do not add a second scheduler.

Before selecting a global capacity default, define operator-owned limits and how conflicting resource descriptors across operations combine. Do not infer a provider-wide quota from operation-local `maxConcurrentUnits` alone.

### Required failure-injection cases

1. Two operation IDs compete for one shared slot; only one side effect starts.
2. Simultaneous admissions cannot both pass a check-then-write race.
3. A completed unit releases its slot for the next operation.
4. Cancellation and an unknown outcome retain or release capacity according to an explicit reconciliation rule; they never silently create extra capacity.
5. Process termination and restart reclaim a dead owner's reservation without taking over a live one.
6. A failed reservation write starts no unit.
7. Different resource identities remain independent, while equivalent endpoint/model identities converge to one key without storing credentials.

### Acceptance evidence still needed

- An integration test with two real runner instances and separate operation IDs against a shared temporary state directory.
- A cross-process test proving the atomic admission boundary under simultaneous starts.
- Restart, cancellation, failed persistence, and dead-owner recovery tests.
- Verification that existing operation-local scheduling tests remain green and that a single operation's behavior is unchanged.
- A documented statement of enforcement scope: in-process, same-host cross-process, or broader. No claim beyond the tested boundary.
