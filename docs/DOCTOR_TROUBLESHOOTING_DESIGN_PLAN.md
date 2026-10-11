# Nexus troubleshooting system — design and implementation (as built)

- **Original request (verbatim, unedited):** `docs/reviews/NEXUS_DOCTOR_RECOVERED_REQUEST.md`
- **Requirement status with test evidence:** `docs/reviews/NEXUS_MATURITY_FIXES_2026-10-11.md`, rows D.1–D.14, 8.1–8.6
- **User guide:** `docs/DOCTOR_TROUBLESHOOTING.md`

## History

The first iteration (dogfooding session `nexus-session-session_20261011_162349_6lvu.json`) shipped a schema-1 doctor
that checked home-directory access instead of the state directories, reported a configured shell without checking it
existed, built a generic `/models` URL that could drop `/v1`, accepted `--deep` and `--fix` as no-ops, skipped engine
and extension checks, and was not reachable as `nexus doctor` (the launcher sent `doctor` to `nexus run`). Its plan
recorded those gaps as deferred. This revision replaces that implementation; the gaps are closed as listed below.

## Design

1. **One engine, two contexts.** `runDoctor(options)` takes the configuration to diagnose. The CLI builds it with
   `buildConfig` (catching the error, which becomes `config.valid: fail`); `/doctor` passes the session's live
   configuration. Both render the same report; `context` says which was diagnosed.
2. **Reuse, not re-implementation.** Endpoint evidence comes from `LocalLlmClient` (`probeAvailability`,
   `listModels`, `chatCompletion` for `--deep`), so URLs, credentials-per-origin and provider protocols are exactly
   the session's. Paths come from exported resolvers: `resolveCoreBinary`, `defaultSessionsDir`,
   `defaultTaskStateDir`, `credentialsPath`, `mcpConfigFiles`, `pluginDirs` (each runtime caller now uses the same
   function).
3. **Layered endpoint states.** configured → reachable → authenticated → model available → inference verified; a later
   state is skipped (not guessed) when an earlier one fails.
4. **Bounded and independent.** Every check runs concurrently with its own deadline and a shared abort signal; a
   throw or timeout becomes that check's finding.
5. **Redaction at the boundary.** The finished report is redacted field by field, including exact configured key
   values, before any renderer sees it; exception messages travel inside the report and are covered too.
6. **Repairs as data.** Findings carry an optional repair id; `runRepairs` plans from them, asks once, refuses under
   read-only policy, takes a lock, records a backup manifest, re-checks each precondition, applies, and re-runs the
   checks to verify.
7. **Interactive surfaces.** The sidecar lets read-only `/doctor` run beside a turn (it touches no turn state) and
   refuses `--fix` while busy; in review mode a session repair goes through the approval prompt.

## Files

- `cli/src/doctor.ts` — engine, checks, repairs, renderers.
- `cli/src/index.ts` — `doctor` / `check` commands, help text, exit code 3 path, SIGINT cancellation.
- `cli/src/slash/session_commands.ts`, `cli/src/slash/catalog.ts` — `/doctor`.
- `cli/src/sidecar.ts` — busy-safe `/doctor`.
- `cli/src/repl.ts` — REPL `/doctor` and completion.
- `harness.sh` — routes `doctor`.
- `cli/test/doctor.test.ts` — 21 deterministic tests (isolated homes, local mock endpoints, packaged launcher).
