# Event triggers (BG-3)

Event triggers let a workspace declare that Nexus should start a run when an event fires. v1.3.0 ships the **trust
and abuse model** for triggers; the trigger firer itself (watching files and HTTP) is deferred to v1.4. Nothing runs
automatically until you approve it.

Two event kinds:

- **`file-change`** — run when files matching glob paths change. `paths` is required; `secret` must not be set.
- **`webhook`** — run when an HTTP webhook is delivered. `secret` is required to authenticate the caller; `paths` must not be set.

## Where triggers are declared

| File | Who writes it | When it runs |
|---|---|---|
| `<workspace>/.nexus/triggers.json` | the repository | only while its exact bytes are the ones you approved with `nexus triggers approve` |

```json triggers-file
{
  "format": "nexus-trigger",
  "version": 1,
  "triggers": [
    {
      "id": "lint-on-save",
      "event": { "kind": "file-change", "paths": ["src/**/*.ts"] },
      "action": { "prompt": "run lint", "policy": "read-only" },
      "rate": { "maxPerMinute": 5, "maxPerHour": 60, "maxPerDay": 500 },
      "bounds": { "maxToolInvocations": 200, "maxRounds": 5, "maxTurnMinutes": 30 }
    }
  ]
}
```

| Key | Rule |
|---|---|
| `format` | `"nexus-trigger"`. |
| `version` | `1`. |
| `id` | 1 to 64 characters of `a-z 0-9 _ -`, must start with a letter. Unique within the file. |
| `event.kind` | `file-change` or `webhook`. |
| `event.paths` | Required for `file-change`. Each glob is relative, non-absolute, and contains no `..`. |
| `event.secret` | Required for `webhook`. 1 to 128 characters. |
| `action.policy` | `read-only` always. `worktree-write` only when the operator has opted the workspace into it. |
| `action.prompt` | 1 to 4096 characters. |
| `rate.maxPerMinute / maxPerHour / maxPerDay` | Per-trigger caps. Each is at least 1; minute ≤ hour ≤ day. |
| `bounds.maxToolInvocations / maxRounds / maxTurnMinutes` | Per-run caps. Each is at least 1. |

An unknown key, a duplicated key (at any depth), or a value out of range refuses the whole file.

## Trust model

Trigger approvals are stored in `~/.config/nexus/trigger_trust.json` (mirroring `~/.config/nexus/hooks.json`), keyed
by the SHA-256 of the trigger file's exact bytes. Changed bytes are a different spec and are not approved.

Before any trigger can run in a workspace:

1. **The workspace must be trusted.** Trust it with `nexus trust <workspace>` (or `NEXUS_TRUST_WORKSPACE=1` when
   managed policy permits it). `nexus triggers list` reports whether the workspace is trusted.
2. **The trigger spec must be approved.** `nexus triggers approve` pins the file's current SHA-256. A later change to
   the file needs a new approval (`MISMATCH`).

### `nexus triggers`

- `nexus triggers list [-w <workspace>] [--json]` — show each trigger spec, its event kind and policy, and whether it
  is `approved`, `not_approved` or `changed`, plus whether the workspace is trusted.
- `nexus triggers approve [-w <workspace>] [--sha256 <hex>]` — approve this workspace's
  `.nexus/triggers.json` as it is now. Shows you exactly what would run and asks for confirmation on the terminal.
  There is no `--yes`: approving requires a person at a terminal. `--sha256` refuses unless it matches the file.
- `nexus triggers revoke <id> [-w <workspace>]` — withdraw approval for a trigger.
- `nexus triggers status <id> [-w <workspace>]` — show whether one trigger may run right now (exit 0 when it may, 1
  otherwise).

A trigger may run only when the workspace is trusted **and** the spec's SHA-256 matches the approval (`MATCH`). `NEW`,
`MISMATCH` and `REMOVED` all mean "does not run."

## Abuse model (rate limits and quarantine)

Each trigger spec carries rate caps (`maxPerMinute / maxPerHour / maxPerDay`). The firer checks them before starting a
run and denies anything over the cap. A workspace also has its own caps (`30/min, 300/hr, 2000/day`) so a workspace
with many triggers cannot flood the runner.

A trigger that hits its rate limit, crashes, or is denied by the gates three times in a row is **quarantined** for 15
minutes: every firing is denied immediately until the cooldown passes. This stops a webhook caller retrying on every
failure, or a file-change trigger on a file a broken run keeps rewriting, from spinning. `nexus triggers release`
(operator action) ends a quarantine early.

## What triggers may not do (GG-3)

A trigger cannot approve a denied action, raise a verdict, widen a policy tier, or remove a verification-file
protection. Triggers run unattended (see `docs/UNATTENDED.md`): there is no interactive prompt when a trigger fires, so
a trigger's action must be one the operator has already agreed to by approving the spec.

## Commands summary

```
nexus triggers list        # show specs and approval status
nexus triggers approve     # approve .nexus/triggers.json (terminal required)
nexus triggers revoke <id> # withdraw approval
nexus triggers status <id> # may this trigger run now?
```
