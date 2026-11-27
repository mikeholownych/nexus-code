# WP-P10-04 Cross-Operation Resource Admission

**Implementation base:** `origin/main` at `65f7cdc97ae57a21a899874ef4ca6f53d68382ba`  
**Scope:** Shared inference-resource slot admission across durable operation IDs and Nexus processes on one host.

## Change

`OperationRunner` now reserves a shared resource slot after its existing local scheduler, resource revalidation, and token-budget checks, and before it marks units running or dispatches them. The slot stays held through executor completion and result persistence. It is released after the executor settles, including a settled cancellation. When no shared slot is available, the operation enters its existing `WAITING` state and retries after a bounded one-second interval; it does not start the unit.

The operator-owned `NEXUS_MAX_SHARED_RESOURCE_UNITS` setting controls the cross-operation ceiling (default one; valid range 1–64). It is read through the existing operator-setting authority, not from a workspace operation spec or project `.env`. A resource descriptor may lower that ceiling for its identity, but cannot raise it. An absent descriptor value inherits the operator ceiling. If active operations disagree about the resulting capacity for an identity, new admission fails closed until the active reservations end. This keeps a workspace-supplied `maxConcurrentUnits` from defining its own shared provider quota.

## Aggregate active-operation ceiling

The per-identity ceiling does not bound simultaneous work on different providers or models. `OperationRunner` now also acquires a named `durable-operation-unit` lease from that same admission directory before acquiring the provider-identity lease. `NEXUS_MAX_SHARED_OPERATION_UNITS` is an operator-only integer from 1 through 64, defaulting to four. Each lease is held across executor completion and result persistence, and both leases are released from the existing `finally` path. If either lease is unavailable, the assignment remains unstarted and the operation enters its existing bounded wait state. A provider lease is released immediately if the aggregate operation lease was acquired but the provider lease could not be obtained.

This composes an operator-wide same-host work-unit cap with the existing per-provider cap; it does not replace operation-local scheduling. Named leases use the existing kernel lock and capacity metadata, so a capacity change while leases are active fails closed. The cap applies only to durable-operation work units using this shared state directory. Interactive sessions, other state directories, other hosts, provider-side work after disconnect, and non-operation processes are outside its boundary. Older Nexus processes already executing a unit do not hold this new aggregate lease and are not counted until those processes exit; the cap applies to work admitted by versions implementing this setting.

**Verification follow-up (2026-11-27):** `operation_resource_admission.test.ts` includes a separate-process contention test for named operation leases, strict operator-setting bounds, aggregate-slot release after a provider-slot miss, and a two-runner regression using distinct provider endpoints. With the configured operation cap set to one, the second executor remains uncalled and its unit remains runnable while the first lease is held; it starts after the first executor settles and the wait interval elapses. On Node 24.11.1, the admission and adjacent scheduler suites passed 33/33; the CLI build and `git diff --check` passed. Node 22 local execution was unavailable; the hosted matrix is the remaining cross-runtime check. The prior provider-only tests continue to cover per-identity admission and release.

The shared identity combines provider, provider ID, canonical endpoint, model or declared serving pool, and account identity. Endpoint credentials, query strings, fragments, and the identity components themselves are not written to the shared state: the identity is represented by SHA-256. A declared pool replaces the model component so models listed in that pool share its slots.

The shared directory is under the operator's state home at `.local/state/nexus/resource-admission`. A kernel `flock` catalog guard serializes identity registration, which has a hard bound of 1,024 persistent identities. This bounds lock-file growth; at the limit, new identities fail closed while registered identities remain usable. The catalog and per-identity locks use the existing kernel guard. Each active slot is another kernel lock held by the operation process, so process exit releases it without stale PID cleanup. A small private metadata file records the currently agreed effective capacity. Missing or malformed metadata while any slot is active also fails closed.

Existing `ResourceRegistry` and `ConvergenceScheduler` behavior remains the per-operation admission layer. This change composes those checks across operation IDs; it does not replace them.

## Verification

The focused test file `cli/test/operation_resource_admission.test.ts` covers independent runner instances, capacity sharing, refusal of workspace capacity escalation, bounded identity registration under concurrent processes, pool identity, conflicting capacity declarations, canonical identity secret exclusion, corrupted metadata, simultaneous separate processes, process crash release, cancellation release after settlement, and refusal to start a unit when admission state is invalid. The source changes are typechecked by `npm --prefix cli run build`.

On 2026-11-25, using an isolated temporary `HOME`, the corrected focused run passed **30/30 tests**:

```text
node --import tsx --test test/operation_resource_admission.test.ts test/operation_concurrency.test.ts
tests 30, pass 30, fail 0, cancelled 0, skipped 0
```

The test `tool_dispatch_characterization.test.ts` also passed **17/17** on the current main candidate while checking preserved Claude fixture changes. `npm run build` in `cli/` passed both TypeScript compiler configurations and the package data/build-info steps. `git diff --check` passed. GitHub CI for the corrected PR head remains pending.

The first hosted run on head `0416f964ba29338cc169e05473495e60cbe7e847` exposed that three existing durability tests used two distinct resource IDs with the same provider, endpoint, and model while expecting two concurrent workers. Under this change those descriptors correctly identify one shared inference resource, so the second worker stayed `RUNNABLE`; the crash tests then did not reach their intended checkpoint. The fixtures now use distinct inference identities. On Node 24.11.1 with an isolated temporary `HOME`, `operation_release_acceptance.test.ts` and `operation_release_review.test.ts` passed **28/28** after that correction. Commit `1bc1ca42c1834468bb8015ecaa35807bda3ba220` contains only these fixture updates. Its run `45667017208` was cancelled when the evidence update was pushed.

On head `f6808f31d0c82bfabdeaa59910265c6e372290b5`, all required checks passed: Node 22 and 24 test gates and shards, Linux build, TypeScript check, and CodeQL (CI run `45667898645`; CodeQL run `45667899011`). `Entire Gates` failed; repository guidance states that it is advisory and does not count toward merging. The base `main` commit `65f7cdc97ae57a21a899874ef4ca6f53d68382ba`, which includes PR #829, has a successful post-merge CI run `45655098128`.

## Enforcement scope and limits

- The guarantee is same-host, same-shared-directory admission on a filesystem where the existing `flock` utility provides effective kernel locks. Cross-host admission and network-filesystem semantics are not qualified.
- `NEXUS_MAX_SHARED_RESOURCE_UNITS` bounds slots per canonical inference-resource identity; `NEXUS_MAX_SHARED_OPERATION_UNITS` separately bounds active durable-operation work units across identities. Neither enforces host CPU or memory consumption, total session count, disk quotas, provider spend, or work running in older processes that do not acquire the named lease.
- A resource-level declaration can only lower the per-identity operator ceiling. A capacity mismatch during active use stops new work; it does not cancel already admitted units. Changing the aggregate operation capacity while active leases exist also fails closed until those leases are released.
- Resource identity registration is bounded at 1,024 to avoid unbounded lock-file growth. If the limit is reached, new identities are refused; the operator can reset the state directory only after confirming no operation is active. This does not bound unrelated Nexus state or host disk use.
- A live process retains its slot while its executor is unsettled, including after a cancellation request. If the process exits, the kernel releases its slot. A remote provider may still have an unknown outcome after client-process death; this mechanism does not promise exactly-once provider execution or measure provider-side work after disconnect.
- Admission-state corruption or lock-tool failure prevents dispatch and surfaces an error. Recovery requires restoring or removing the invalid state only after confirming no Nexus operation is active.

## Deferred package work

This slice does not complete the broader WP-P10-04 inventory for shared session limits, storage write-time quotas, LSP/process budgets, or aggregate host CPU/memory enforcement. Provider token/cost limits remain process-local and depend on available usage data. Those limits need separate ownership boundaries and measurable operator policy; this change does not infer them from operation-local settings.
