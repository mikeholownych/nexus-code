# PA-1 explicit execution resource admission

Status: **partial implementation verified on the PA-1 resource-admission slice**. CPU/memory admission and compatibility behavior are implemented; worktree owner receipts and broader host-resource governance remain open.

## Contract

Durable operations may opt into parallel execution with `policy.maxConcurrentUnits > 1`. Every such operation must declare an operation-local `policy.executionBudget` and every work unit must declare `executionResources`:

```json
{
  "policy": {
    "maxConcurrentUnits": 3,
    "executionBudget": { "cpuMilli": 3000, "memoryBytes": 2147483648 }
  },
  "units": [
    { "id": "one", "prompt": "...", "executionResources": { "cpuMilli": 1000, "memoryBytes": 536870912 } }
  ]
}
```

`cpuMilli` is an operator-provided reservation in thousandths of a core. `memoryBytes` is an operator-provided reservation in bytes. These values are admission declarations, not provider telemetry, observed usage, or enforced operating-system quotas. A unit is admitted only when its declared CPU and memory fit alongside currently running declarations, the unit-count limit, provider concurrency slots, capability qualification, dependencies, and workspace isolation.

The operation count limit, provider request slots, and declared CPU/memory reservations are separate constraints. The scheduler does not infer CPU or memory limits from provider names, model identity, hardware count, or absent metadata. Serial execution remains available without resource declarations.

## Compatibility and failure behavior

Operation schema v4 records explicit resource reservations. Older operation records migrate additively; if they requested parallel execution without reservations, their effective concurrency is clamped to one with a warning. New parallel operation specifications missing a budget or any unit reservation are rejected before state creation. A request larger than the operation budget is also rejected. Single-unit operations do not need reservations.

These reservations cannot protect the host from a subprocess that exceeds its declared demand. Hard CPU or memory limits require a separately implemented execution boundary and are not claimed here.

## Verification record

On branch `v1/pa1-resource-admission`, 44 focused tests passed across operation concurrency, operation schema, isolated concurrency, and batch spec validation; 28 operation release/review regression tests also passed. `npm run build` passed in `cli/`. The tests cover separate CPU and memory budget exhaustion, provider slot limits, malformed/missing reservation rejection, migration of old records, legacy serial behavior, and prior operation/batch regression cases. The release acceptance tests use an ephemeral local mock provider; no live inference endpoint was used. These results qualify this slice only, not the full PA-1 roadmap item.
