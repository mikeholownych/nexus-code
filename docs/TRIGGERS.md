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
  "version": 1,
  "triggers": [
    {
      "format": "nexus-trigger",
      "version": 1,
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
| file `version` | `1`. |
| trigger `format` / `version` | Each trigger carries its own `"nexus-trigger"` and `1`. |
| `id` | `[a-z0-9][a-z0-9-]{0,62}`: 1 to 63 characters of lowercase letters, digits and `-`, starting with a letter or digit (the same rule the code enforces). Unique within the file: a duplicate id refuses the whole file. |
| `event.kind` | `file-change` or `webhook`. |
| `event.paths` | Required for `file-change`. Each glob is relative, non-absolute, and contains no `..`. |
| `event.secretEnv` | For `webhook`: the name of an environment variable (`[A-Z][A-Z0-9_]{0,63}`) that holds the shared secret. Preferred: the secret stays out of the repository. |
| `event.secret` | For `webhook`, instead of `secretEnv`: 16 to 128 base64url characters. It sits in the repository file; use `secretEnv`. A webhook needs exactly one of the two. |
| `action.policy` | `read-only` always. `worktree-write` only when the operator has opted the workspace into it. |
| `action.prompt` | 1 to 4096 characters. |
| `rate.maxPerMinute / maxPerHour / maxPerDay` | Per-trigger caps. Each is at least 1; minute ≤ hour ≤ day. |
| `bounds.maxToolInvocations / maxRounds / maxTurnMinutes` | Per-run caps. Each is at least 1. |

An unknown key, a duplicated key (at any depth), a duplicate trigger id, or a value out of range refuses the whole
file: nothing in a file that does not parse in full can be approved.

The file must be a regular file you own and that group and others cannot write. A git checkout's `0644` is accepted;
`0664` is refused, and the CLI says why and gives the `chmod go-w <file>` that fixes it.

## Trust model

Trigger approvals are stored in `~/.config/nexus/trigger_trust.json` (mirroring `~/.config/nexus/hooks.json`), one
entry per trigger, keyed by the workspace's real path and the trigger id, and holding the SHA-256 of that trigger's
canonical serialization (sorted keys, no whitespace; the hash is of the spec, not of the file). Changing any field of a
trigger, or its secret, is a different spec and is not approved; editing another trigger in the file does not affect it.
The store is a protected path (`DEFAULT_PROTECTED_PATHS`): the agent's write, edit, patch and delete tools cannot touch
it. A store that is not mode 0600, is oversized, or has any malformed entry holds no approvals.

Before any trigger can run in a workspace:

1. **The workspace must be in your trusted-workspaces store** (`nexus trust <workspace>`). Triggers use
   `isWorkspaceListed`, the store-only check security.ts uses to resolve a workspace's policy tier.
   `NEXUS_TRUST_WORKSPACE=1` does **not** count: it is a per-process grant for an interactive session, and a trigger is
   a standing authority that runs unattended in other processes. `nexus triggers list` and `status` report this.
2. **The trigger spec must be approved.** `nexus triggers approve` pins each trigger's canonical SHA-256. A later change
   to the trigger needs a new approval (`MISMATCH`).

### `nexus triggers`

- `nexus triggers list [-w <workspace>] [--json]` — show each trigger spec, its event kind and policy, and whether it
  is `approved`, `not_approved` or `changed`, plus whether the workspace is trusted.
- `nexus triggers approve [-w <workspace>] [--sha256 <hex>]` — approve this workspace's
  `.nexus/triggers.json` as it is now. For every trigger it prints the canonical spec as it is hashed: kind, id, every
  path and origin, the full prompt, the verifier, policy, rate, bounds, and whether a secret is configured (never its
  value), with control and non-ASCII characters escaped. Then it asks, per trigger, you to type `yes` for that trigger's
  canonical hash (the question shows its first 12 hex digits). A field over 4,000 characters is not shown in full, so
  the approval is refused. There is no `--yes`: approving requires a person at a terminal. `--sha256` refuses unless it
  matches the file's SHA-256. A file that does not parse in full approves nothing.
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
failure, or a file-change trigger on a file a broken run keeps rewriting, from spinning.

Only admitted firings are recorded, as epoch-millisecond numbers: a denied attempt never extends a lockout. The
per-trigger limiters are keyed on workspace real path plus trigger id; at most 1,024 are held (least recently used is
evicted, and a quarantine survives eviction in a separate bounded map), and the workspace cap is checked in the same
call (`WorkspaceRateLimiter.checkAndRecord`). Persisted limiter state is validated on restore; any invalid field puts
the limiter in quarantine until an operator releases it. There is no `nexus triggers release` command yet: there is no
persisted quarantine for it to clear until the firer exists; `WorkspaceRateLimiter.releaseQuarantine` is the hook it will
call, terminal-only like `approve`.

## What this does and does not stop

Approval needs a person at a terminal, but that is a check on the process, not on the person: any process that has a
shell can run `nexus triggers approve` under a pseudo-terminal it controls (for example
`script -qec "nexus triggers approve"` fed `yes`). This is the same limit as hooks (`nexus hooks approve`). Under
`--sandbox`, whether `~/.config/nexus` is reachable from inside the sandbox has not been tested, so do not rely on it
(the protected-path rule covers the agent's file tools, not an arbitrary shell command). Read what `approve` prints, and
do not run an agent that can reach a shell with your home directory writable if you approve triggers on the same machine.

## What triggers may not do (GG-3)

A trigger cannot approve a denied action, raise a verdict, widen a policy tier, or remove a verification-file
protection. Triggers run unattended (see `docs/UNATTENDED.md`): there is no interactive prompt when a trigger fires, so
a trigger's action must be one the operator has already agreed to by approving the spec.

## Commands summary

```
nexus triggers list        # show specs and approval status
nexus triggers approve     # approve .nexus/triggers.json (terminal required)
nexus triggers revoke <id> # withdraw approval
nexus triggers status <id> # may this trigger run now? (and why not)
```
