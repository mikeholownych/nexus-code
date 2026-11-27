# WP-P10-04 Aggregate Resource Admission Baseline

**Inspected revision:** `e65439de136af22ac3b99c14c843d706efa173b9` (`release/v1.3.0`)

## Finding at inspected baseline

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

**Result:** `FAIL` — the opt-out path bypassed the configured in-process request limit at the historical baseline; the local remediation below closes that path. This probe did not exercise provider inference or billing. The separate-process/restart behavior is tested in the cross-process probe below.

### Local remediation evidence

Commit `77430b996` on branch `codex/p10-04-admission-baseline` changes `UsageLedger` to keep aggregate-only request/token/cost counters for opted-out cloud receipts. `NEXUS_RECEIPTS=0` still leaves `all()` and user-visible `cloudTotals()` empty and writes no receipt file; admission uses the private aggregates. The counters retain only totals globally and by provider, not request ids, endpoints, model names, or prompt data. They remain process-local and are not durable.

On Node 24.11.1, `cli/test/provider_limits.test.ts` passed **10/10**, including request, token, and snapshot-cost limits with receipt opt-out. `cli/test/provider_robustness.test.ts` passed **27/27**, including the existing local-receipt opt-out behavior. TypeScript check `./cli/node_modules/.bin/tsc --noEmit -p cli/tsconfig.json` exited **0**. The first robustness-test attempt could not resolve `dotenv` because the isolated worktree had no installed dependencies; it passed after the existing dependency directory was made available to the isolated worktree. No production configuration or shared source checkout was changed.

## Post-merge integration status (measured 2026-11-26)

The baseline finding above was reproduced at `e65439de` on 2026-11-25. The following changes are now present on `release/v1.3.1` at `5061a3e83ce6daf34f34785bd3753f11604ba77d`; this supersedes the baseline's proposed next step to add cross-operation admission.

### Implemented and verified

- **Receipt opt-out no longer bypasses configured provider limits.** PR #829 merged the aggregate-only accounting fix as `65f7cdc9`. On the current release tree, `cli/src/usage.ts` retains private request/token/cost totals when `NEXUS_RECEIPTS=0`, while keeping detailed receipts hidden and unwritten. The totals are still process-local and are not durable across process restarts; this is not cross-process usage accounting.
- **Inference-resource slots are admitted across operation IDs and Nexus processes on the same host/shared directory.** PR #830 merged as `b5dc77b73871fdfeda9576c592b48a8c74ad340b`. `SharedResourceAdmission` is used after the existing per-operation scheduler and before dispatch. Capacity is operator-owned (`NEXUS_MAX_SHARED_RESOURCE_UNITS`, default 1, bounded to 1–64); workspace declarations may lower it but cannot raise it. Identity is canonicalized and hashed, including provider/account/model or pool scope without persisting endpoint credentials. Kernel locks hold active slots until executor settlement or process exit; inconsistent or corrupt admission state fails closed. PR CI run `45671930702` and CodeQL run `45671930709` passed on the merge commit. `operation_resource_admission.test.ts` covers independent runners, simultaneous processes, capacity conflicts, cancellation, process crash release, corrupted state, and no dispatch on admission failure.
- **Language-server process slots are shared across Nexus clients using the same credential home.** PR #831 merged as `ffddb53a796dd407fbf83f1a60a8a25d3818374d`. A supervisor retains the admission descriptor so the slot remains held if the Nexus parent exits while the server is alive. PR CI run `45681423228` and CodeQL run `45681423318` passed on the merge commit. The focused lifecycle test uses a fake server; the process-death case is skipped on Windows.
- **The current release head is green.** Post-merge CI run `45896185332` and CodeQL run `45896185330` both passed on `5061a3e83ce6daf34f34785bd3753f11604ba77d`.

### Remaining P10-04 scope

These merges close the reproduced cross-operation provider-slot gap and add same-home LSP process admission. They do **not** complete WP-P10-04's broader resource envelope:

- CPU and memory reservations remain scheduling declarations enforced within one operation; they are not shared across operation IDs and are not OS consumption ceilings.
- No product-wide active-session limit is established for ordinary CLI sessions. ACP limits remain per connection.
- State GC remains an age/size cleanup target rather than a write-time disk quota. Compaction archives can continue to grow; no hard per-archive or aggregate archive admission cap is established here.
- LSP admission is limited to clients sharing one credential home and a local filesystem with working kernel locks. Cross-host, network-filesystem, and independent-home coordination is not established; fake-server tests do not qualify every real server or Windows process-death behavior.
- Provider request/token/cost totals are still process-local. The receipt opt-out fix preserves limits within a process, but does not make them durable or shared across processes. Track the remaining accounting with WP-P10-02; do not duplicate its active work.
- Docker PID/tmpfs limits, unattended-job queue/output bounds, and retention GC retain their narrower per-container, per-runner, or cleanup-target scope from the baseline inventory. They do not establish a host-wide resource ceiling.

The next P10-04 implementation decision is therefore not whether to add another scheduler. It is which remaining resource classes need an operator-owned, measurable cross-session bound, and which can be handled by existing per-operation, per-container, or cleanup controls. Any new bound must preserve user data, fail before the protected side effect, and state its enforcement scope. Do not claim host-wide CPU/memory containment without OS enforcement or exact provider-spend containment without authoritative provider accounting.

### Cross-process provider-limit probe (2026-11-26)

**Inspected revision:** `5061a3e83ce6daf34f34785bd3753f11604ba77d`; `cli/src/usage.ts` has blob `ff414f866048f39cbc9e8bcc31268f94d0a7aae2`.

**Hypothesis:** If `NEXUS_CLOUD_MAX_REQUESTS=1` is intended to bound usage across concurrent or resumed Nexus processes sharing a credential home, the second process must observe the first process's completed request before admission.

**Setup:** On Node 24.11.1, two separate Node processes each constructed a fresh `UsageLedger`, used the same isolated temporary `HOME` and workspace, admitted one cloud request with `maxRequests=1`, and recorded a synthetic receipt. The endpoint was `https://example.invalid`; no provider request, credential, network access, or live workspace was used. `NEXUS_RECEIPTS` remained enabled so each process wrote its receipt to the same workspace file.

**Observed:** Both processes returned `admitted`; each new process saw one in-memory receipt after its own request; the shared receipt file contained two lines. Expected host-aggregate behavior would deny the second admission. The experiment therefore confirms that the provider limit counters do not survive process boundaries even when receipt records are present on disk.

**Classification:** `FAIL` against the P10-04 cross-session aggregate-resource requirement; `NOT TESTED` for provider billing or actual inference. This confirms the implementation scope only. Existing environment-limit semantics may be process-local by design; no time window or reset contract exists, so do not silently persist these totals across unrelated future invocations. Durable operation inference counters remain the existing task-scoped control and are separate from `UsageLedger` provider limits.

**Reproduction:** From `cli/` with dependencies installed, run this exact isolated probe. It launches two independent Node processes against the same temporary home and workspace; it never calls the example endpoint.

```sh
probe_home=$(mktemp -d /var/tmp/nexus-p1004-XXXXXX)
mkdir -p "$probe_home/workspace"
for request in first second; do
  HOME="$probe_home" XDG_CONFIG_HOME="$probe_home/.config" NEXUS_CLOUD_MAX_REQUESTS=1 PROBE_WORKSPACE="$probe_home/workspace" node --import tsx --input-type=module -e 'import { UsageLedger } from "./src/usage.ts"; const ledger = new UsageLedger(); const requestId = process.argv[1]; const admitted = ledger.admit(requestId, 10, false, "groq", "test-model"); if (admitted) throw new Error(admitted); ledger.record({at:new Date().toISOString(),requestId,role:"main",providerId:"groq",selectedModel:"test-model",endpointOrigin:"https://example.invalid",protocol:"test",disclosure:"cloud",outcome:"completed",usage:{inputTokens:1,outputTokens:1},usageConfidence:"provider",costConfidence:"unknown"}, process.env.PROBE_WORKSPACE); process.stdout.write(JSON.stringify({process:requestId,admission:admitted??"admitted",receiptsInNewProcess:ledger.all().length})+"\n")' "$request"
done
wc -l < "$probe_home/workspace/.nexus/inference_receipts.jsonl"
```

Observed on release `5061a3e`: each process printed `admission:"admitted"` and `receiptsInNewProcess:1`; the final line count was `2`.
