# WP-P10-04 Cross-Operation Resource Admission

**Implementation base:** `origin/main` at `65f7cdc97ae57a21a899874ef4ca6f53d68382ba`  
**Scope:** Shared inference-resource slot admission across durable operation IDs and Nexus processes on one host.

## Change

`OperationRunner` now reserves a shared resource slot after its existing local scheduler, resource revalidation, and token-budget checks, and before it marks units running or dispatches them. The slot stays held through executor completion and result persistence. It is released after the executor settles, including a settled cancellation. When no shared slot is available, the operation enters its existing `WAITING` state and retries after a bounded one-second interval; it does not start the unit.

The operator-owned `NEXUS_MAX_SHARED_RESOURCE_UNITS` setting controls the cross-operation ceiling (default one; valid range 1–64). It is read through the existing operator-setting authority, not from a workspace operation spec or project `.env`. A resource descriptor may lower that ceiling for its identity, but cannot raise it. An absent descriptor value inherits the operator ceiling. If active operations disagree about the resulting capacity for an identity, new admission fails closed until the active reservations end. This keeps a workspace-supplied `maxConcurrentUnits` from defining its own shared provider quota.

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

The first hosted run on head `0416f964ba29338cc169e05473495e60cbe7e847` exposed that three existing durability tests used two distinct resource IDs with the same provider, endpoint, and model while expecting two concurrent workers. Under this change those descriptors correctly identify one shared inference resource, so the second worker stayed `RUNNABLE`; the crash tests then did not reach their intended checkpoint. The fixtures now use distinct inference identities. On Node 24.11.1 with an isolated temporary `HOME`, `operation_release_acceptance.test.ts` and `operation_release_review.test.ts` passed **28/28** after that correction. Commit `1bc1ca42c1834468bb8015ecaa35807bda3ba220` contains only these fixture updates. Its hosted run `45667017208` is in progress; no result is claimed yet.

## Enforcement scope and limits

- The guarantee is same-host, same-shared-directory admission on a filesystem where the existing `flock` utility provides effective kernel locks. Cross-host admission and network-filesystem semantics are not qualified.
- This bounds declared inference-resource slots only. It does not enforce host CPU or memory consumption, total sessions, disk quotas, provider spend, or requests across different account identities.
- The operator setting is a ceiling per canonical resource identity, not a host-wide total across all identities. A resource-level declaration can only lower it. A capacity mismatch during active use stops new work; it does not cancel already admitted units.
- Resource identity registration is bounded at 1,024 to avoid unbounded lock-file growth. If the limit is reached, new identities are refused; the operator can reset the state directory only after confirming no operation is active. This does not bound unrelated Nexus state or host disk use.
- A live process retains its slot while its executor is unsettled, including after a cancellation request. If the process exits, the kernel releases its slot. A remote provider may still have an unknown outcome after client-process death; this mechanism does not promise exactly-once provider execution or measure provider-side work after disconnect.
- Admission-state corruption or lock-tool failure prevents dispatch and surfaces an error. Recovery requires restoring or removing the invalid state only after confirming no Nexus operation is active.

## Deferred package work

This slice does not complete the broader WP-P10-04 inventory for shared session limits, storage write-time quotas, LSP/process budgets, or aggregate host CPU/memory enforcement. Provider token/cost limits remain process-local and depend on available usage data. Those limits need separate ownership boundaries and measurable operator policy; this change does not infer them from operation-local settings.
