# Nexus doctor

`nexus doctor` (CLI) and `/doctor` (live TUI and REPL) run the same diagnostic engine (`cli/src/doctor.ts`). Neither
starts an agent, sends conversation history to a model, or starts an MCP server or plugin. The original request this
implements is preserved verbatim in `docs/reviews/NEXUS_DOCTOR_RECOVERED_REQUEST.md`; the requirement-by-requirement
status is in `docs/reviews/NEXUS_MATURITY_FIXES_2026-10-11.md` (rows D.1–D.14 and 8.1–8.6).

## Entry points

| Command | Configuration diagnosed |
|---|---|
| `nexus doctor` | A fresh configuration built from flags and environment by the same `buildConfig` a session uses. Works when that configuration is invalid (the error becomes `config.valid: fail`). |
| `nexus check` | Compatibility alias for `nexus doctor` (same options, same engine). |
| `/doctor` (TUI, REPL) | The running session's own configuration, including `/model` switches and `/cd`. Read-only `/doctor` runs while a turn is in progress; `/doctor --fix` waits until the session is idle. |

The packaged `nexus` launcher enters the CLI directly. In a source checkout, run `node cli/dist/index.js doctor` or use
the `harness.sh` launcher when it is configured.

## Flags

```
nexus doctor [-e URL] [-m MODEL] [-k KEY] [--provider ID] [--base-url URL] [-w DIR] [--shell SHELL]
             [--json] [--deep] [--fix [--yes]] [--read-only] [--timeout MS]
/doctor [--deep] [--fix [--yes]]
```

- `--json` prints only the versioned JSON report (`schemaVersion: 2`) on stdout.
- `--deep` adds checks that cost more: **one minimal inference request** (`inference.verified` — it costs model work,
  and tokens on paid providers), a read-only engine tool call in the workspace, write probes in the state directories,
  and integrity checks over every saved record instead of the newest 300.
- `--fix` proposes the supported repairs and applies them only after confirmation. `--yes` confirms without asking
  (unattended use). `--read-only` refuses every repair.
- `--timeout` is the per-check limit in milliseconds (default 4000). Ctrl-C cancels; the report then says
  `CANCELLED (incomplete)`.

## Checks

Checks are independent: each has its own deadline, and a check that fails, throws or times out becomes a finding
without stopping the others.

| Id | What is checked (and with which Nexus resolver) |
|---|---|
| `install.build` | The packaged CLI build exists; in a source checkout, `cli/dist` is not older than `cli/src`. |
| `tui.build` | The packaged TUI binary and `cli/dist/sidecar.js` exist; in a source checkout, they are newer than `core/src/bin`. |
| `runtime.node` | Node.js 22 or later. |
| `runtime.launcher` | The `nexus` on PATH resolves to this packaged install or the configured source checkout launcher. |
| `config.valid` | `buildConfig` succeeds with the flags given (provider selection, base URLs, budgets). |
| `endpoint.configured` | An endpoint is configured; whether a credential is present (never shown). |
| `endpoint.reachable` | `LocalLlmClient.probeAvailability`: the endpoint answers `GET <endpoint>/models` (the `/v1` path is kept). |
| `endpoint.authenticated` | That answer is not 401/403 with the credential the client would send. |
| `model.available` | `LocalLlmClient.listModels` lists the configured model. |
| `inference.verified` | `--deep` only: one inference request completes. A listed model is never reported as proof of inference. |
| `shell.executable` | The configured shell resolves on PATH and runs `printf`. |
| `engine.binary` | The Rust engine the bridge would run (`resolveCoreBinary`, or `coreBinaryPath`) runs, matches the CLI version, and is not older than `core/src/*.rs`. |
| `engine.tool` | `--deep` only: the engine runs `list_dir` in the workspace. |
| `workspace.access` | The workspace is a readable, writable directory; whether it is a git repository. |
| `state.sessions`, `state.tasks` | `~/.nexus/sessions` and `~/.nexus/tasks` (the directories `SessionManager` and `DurableStateManager` use) exist, are writable, and are not writable by other users. |
| `state.integrity` | Saved session and task records parse and have an id and a message list; interrupted `.tmp` writes. |
| `credentials.store` | `~/.config/nexus/credentials.json` is valid JSON and not readable by other users. |
| `mcp.config` | The MCP config files Nexus reads (`mcpConfigFiles`): valid JSON, each server's command resolves or URL parses. Servers are **not** started. |
| `plugins.config` | Plugin modules in the directories Nexus loads (`pluginDirs`): listed and checked for world-writable files. Modules are **not** imported. |

The text report also lists the effective configuration with each value's source, following Nexus's precedence:
command-line flag → working-directory `.env` → `~/.config/nexus/config.env` → shell environment → installation
`cli/.env` → default. Credential values are never printed.

## Statuses and exit codes

| Status | Meaning |
|---|---|
| `pass` | Verified to work. |
| `warn` | Works, but degraded or at risk (stale build, permissive permissions, an optional capability with a problem). |
| `fail` | Prevents normal operation; the finding names the next action. |
| `skip` | Not applicable, depends on a failed check, or not run (for example inference without `--deep`). |

| Exit code | Meaning |
|---|---|
| 0 | No warnings or failures. |
| 1 | Warnings only. |
| 2 | At least one failure. |
| 3 | The doctor itself could not run (for example an invalid `--timeout`); with `--json` the error is printed as JSON. |

## JSON

```json
{
  "schemaVersion": 2,
  "tool": "nexus doctor",
  "nexusVersion": "1.2.1",
  "context": "cli",
  "deep": false,
  "generatedAt": "…",
  "durationMs": 1341,
  "summary": { "pass": 14, "warn": 3, "fail": 0, "skip": 1 },
  "effectiveConfig": [{ "key": "LOCAL_LLM_ENDPOINT", "value": "https://…/v1", "source": "~/.config/nexus/config.env" }],
  "findings": [
    {
      "id": "state.sessions",
      "category": "state",
      "status": "warn",
      "explanation": "The saved sessions directory is writable by other users (mode 775); others could alter saved state.",
      "evidence": ["/home/user/.nexus/sessions"],
      "repairAvailable": true,
      "repair": { "id": "state.permissions", "description": "chmod /home/user/.nexus/sessions from 775 to 700" },
      "durationMs": 2
    }
  ],
  "repairs": []
}
```

Every string in the report — evidence, explanations, configuration values and error messages — passes through
redaction before output, and the configured API keys are removed by exact value as well as by pattern
(authorization headers, `key=`/`token=` parameters, URL user-info).

## Repairs

Supported, deterministic repairs:

| Repair | When | Change |
|---|---|---|
| `state.create` | `~/.nexus/sessions` or `~/.nexus/tasks` is missing | create it with mode 0700 |
| `state.permissions` | a state directory is group- or world-writable | `chmod 700` |
| `credentials.permissions` | the credential store is group- or world-readable | `chmod 600` |

Safeguards, in order: the proposed changes are shown; nothing is applied without confirmation (`--yes`, the
interactive prompt, or in the session the review-mode approval prompt); read-only policy refuses repairs; a lock file
(`~/.nexus/doctor.lock`) serialises concurrent runs; previous modes are recorded in `~/.nexus/doctor-backups/<time>.json`
before any change; each target is re-checked just before its change and left alone if it changed since the diagnosis;
afterwards every check runs again and each repair is reported as `applied`, `failed`, `skipped`, `declined`, `refused`
or `unresolved` (applied but the check still does not pass). A second run proposes nothing. Changes cannot be redirected
by links: no repair is offered when any component of the path below the home directory is a symbolic link or owned
by another user (`~/.nexus -> elsewhere` included); each change is made through a descriptor opened without following
links and proven — by its real location and device/inode — to be the object the diagnosis saw (`cli/src/safe_fs.ts`).
The lock file and backup manifest are created exclusively and verified the same way. A path that became a link after
the diagnosis is skipped, and nothing is written outside the home.

Never done by the doctor: resetting configuration, deleting sessions, checkpoints or corrupt records, rotating
credentials, installing dependencies, rebuilding, changing TLS settings, restarting services or touching remote
infrastructure. Findings outside the repair set name the manual step instead.

## Examples

```sh
nexus doctor                         # readable report, exit 0/1/2
nexus doctor --json | jq .summary    # machine-readable
nexus doctor --deep                  # also sends ONE short inference request
nexus doctor --fix                   # shows proposed repairs and asks before applying
nexus doctor --fix --yes             # unattended: applies only the supported repairs
nexus doctor -e http://127.0.0.1:1234/v1 -m qwen   # diagnose a different endpoint/model without changing config
```

In the TUI: `/doctor` (allowed while the agent works), `/doctor --deep`, `/doctor --fix --yes` (when idle; in review
mode `/doctor --fix` asks through the approval prompt).

## Limitations

- MCP servers and plugins are inspected from configuration only; a server that would fail during its handshake, or a
  plugin that throws on import, is not detected without starting it.
- Credential source detail is limited to present/absent; per-provider sign-in freshness is visible only through the
  endpoint's authentication answer.
- `nexus doctor` diagnoses this installation; a different `nexus` on PATH is reported, not followed.
