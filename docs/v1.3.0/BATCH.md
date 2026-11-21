# `/batch` on the operation engine

`/batch` accepts the same JSON work-unit format as `nexus operation run`. It validates the whole dependency graph before starting, then stores and executes it through `OperationStore`, `ConvergenceScheduler`, and `OperationRunner`.

```json
{
  "id": "docs-and-tests",
  "objective": "Update the guide and verify the examples",
  "units": [
    {
      "id": "guide",
      "title": "Update the guide",
      "role": "implementer",
      "prompt": "Update the guide examples for the new API",
      "authorizedScope": ["docs/guide.md"]
    },
    {
      "id": "verify",
      "title": "Verify the examples",
      "role": "tester",
      "prompt": "Run the documented examples and report the results",
      "dependsOn": ["guide"]
    }
  ]
}
```

The accepted fields are the operation fields: `objective`, optional `id`, `units`, optional `resources`, `discoverCatalog`, `policy`, `git`, and `boundaries`. A unit uses `prompt` for its task, optional `role`, `dependsOn`, `requires`, `required`, `taskClass`, `contextBudget`, `inputs`, `authorizedScope`, and `unresolvedAssumptions`. Unknown keys, missing dependencies, and cycles are refused before execution.

## Commands

```text
/batch <spec-file>
/batch run <spec-file>
/batch validate <spec-file>
/batch status [id]
/batch list
/batch pause [id]
/batch resume [id]
/batch cancel [id]
/batch results [id]
```

Paths may be quoted or backslash-escaped and must resolve to a regular file inside the selected workspace. The file is limited to 256 KiB. `run` is sequential by default. To request parallel units, set `policy.maxConcurrentUnits` and `git.isolate: true`; the existing operation engine checks model/resource eligibility, dependencies, resource slot limits, and serialized verified integration. Without isolated worktrees, the existing spec validator refuses unsafe parallel limits.

When an ID is omitted, a single active batch is selected. Multiple active batches require an explicit ID; if none is active, a sole batch is selected only when that is unambiguous. `/batch list` shows the available IDs. `status` shows progress; `results` shows each task's status, summary, and recorded verifier state. A blocked required task prevents `COMPLETE`; aggregate output reports `PARTIAL`, `BLOCKED`, `FAILED`, or `CANCELLED` as derived from the durable operation record.

The operation scheduler continues independent work while dependencies remain blocked. Retry, provider recovery, and restart use the existing operation decisions and state. Cancellation of an active `/batch run` uses the same signal as `/team`; a separate cancel request refuses an unsettled stored unit until recovery can classify it.

## Current implementation boundary

Pause writes a distinct `PAUSED` status into the durable operation record under the operation driver lock. If a work unit is currently executing, pause returns a safe-boundary message; retry once the unit settles. Resume continues from the preserved record. Schema v3 adds this status; older records migrate additively and newer records continue to be rejected by the version gate. `/loop`, `/goal`, independent acceptance review, and minimal-provider end-to-end fixtures are not supplied by this batch slice.
