# WP-P10-04 Cross-Operation Resource Admission

**Implementation base:** `origin/main` at `65f7cdc97ae57a21a899874ef4ca6f53d68382ba`  
**Scope:** Shared inference-resource slot admission across durable operation IDs and Nexus processes on one host.

## Change

`OperationRunner` now reserves a shared resource slot after its existing local scheduler, resource revalidation, and token-budget checks, and before it marks units running or dispatches them. The slot stays held through executor completion and result persistence. It is released after the executor settles, including a settled cancellation. When no shared slot is available, the operation enters its existing `WAITING` state and retries after a bounded one-second interval; it does not start the unit.

The existing `ResourceDescriptor.maxConcurrentUnits` is the capacity declaration; an absent value remains one. The shared identity combines provider, provider ID, canonical endpoint, model or declared serving pool, and account identity. Endpoint credentials, query strings, fragments, and the identity components themselves are not written to the shared state: the identity is represented by SHA-256. A declared pool replaces the model component so models listed in that pool share its slots.

The shared directory is under the operator's state home at `.local/state/nexus/resource-admission`. A kernel `flock` guard serializes each identity's slot selection. Each active slot is another kernel lock held by the operation process, so process exit releases it without stale PID cleanup. A small private metadata file records the currently agreed capacity. If concurrent operations declare different capacities for the same identity, admission fails closed until the active reservations end; when idle, a new declaration may replace the old one. Missing or malformed metadata while any slot is active also fails closed.

Existing `ResourceRegistry` and `ConvergenceScheduler` behavior remains the per-operation admission layer. This change composes those checks across operation IDs; it does not replace them.

## Verification

The focused test file `cli/test/operation_resource_admission.test.ts` covers independent runner instances, capacity sharing, pool identity, conflicting capacity declarations, canonical identity secret exclusion, corrupted metadata, simultaneous separate processes, process crash release, cancellation release after settlement, and refusal to start a unit when admission state is invalid. The source changes are typechecked by `npm --prefix cli run build`.

On 2026-11-25, using an isolated temporary `HOME`, the focused run passed **27/27 tests**:

```text
node --import tsx --test test/operation_resource_admission.test.ts test/operation_concurrency.test.ts
tests 27, pass 27, fail 0, cancelled 0, skipped 0
```

`npm run build` in `cli/` also completed successfully, running both TypeScript compiler configurations and the package data/build-info steps. `git diff --check` passed. These are local results for this candidate; the required Node 22/24 and Linux CI checks remain pending until a pull request is opened.

## Enforcement scope and limits

- The guarantee is same-host, same-shared-directory admission on a filesystem where the existing `flock` utility provides effective kernel locks. Cross-host admission and network-filesystem semantics are not qualified.
- This bounds declared inference-resource slots only. It does not enforce host CPU or memory consumption, total sessions, disk quotas, provider spend, or requests across different account identities.
- A capacity mismatch during active use stops new work; it does not cancel already admitted units.
- A live process retains its slot while its executor is unsettled, including after a cancellation request. If the process exits, the kernel releases its slot. A remote provider may still have an unknown outcome after client-process death; this mechanism does not promise exactly-once provider execution or measure provider-side work after disconnect.
- Admission-state corruption or lock-tool failure prevents dispatch and surfaces an error. Recovery requires restoring or removing the invalid state only after confirming no Nexus operation is active.

## Deferred package work

This slice does not complete the broader WP-P10-04 inventory for shared session limits, storage write-time quotas, LSP/process budgets, or aggregate host CPU/memory enforcement. Provider token/cost limits remain process-local and depend on available usage data. Those limits need separate ownership boundaries and measurable operator policy; this change does not infer them from operation-local settings.
