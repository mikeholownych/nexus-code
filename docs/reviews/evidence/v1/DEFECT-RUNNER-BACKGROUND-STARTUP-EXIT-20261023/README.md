# DEFECT: a background service that exits during startup is reported registered

| | |
|---|---|
| Base revision | `6383623d94b771f3a61d4337132d34e30e98fe50` (`origin/main`) |
| Branch | `v1/defect-runner-service-exit` |
| Affected behavior | `run_command` with `background: true` and a `service_name` registers the process group before the 150 ms startup grace. If the command exits during that grace, the dead group stays in the service registry and the tool reports `Background service '<name>' registered (pgid …)` even though no service exists. |
| Severity | Medium-low: misleading process status; the stale PGID is included in the engine shutdown sweep, so a reused process-group ID could be signalled. |

## Reproduction

A focused Rust test runs `true` as a named background service:

```rust
run_command_tracked(RunCommandArgs {
    command: "true".into(),
    background: true,
    service_name: Some("gone_service".into()),
    ..Default::default()
}, &cwd, Some("svc_req_gone"))
```

Pre-fix output contains `Background service 'gone_service' registered (pgid …)`; `list_services()`
hides the entry because the process is dead, but the `services` map still holds the PGID and
`end_all_commands` drains it into the shutdown kill list.

## Root cause

`registry::register_service` is called immediately after spawn, before the grace loop. The early-exit
branch only adjusted the message (`if code == 0`), and never removed the entry.

## Fix

Add `registry::unregister_service(name, pgid)`, which removes the entry only when the recorded PGID
matches. On an early exit, unregister and report:

`Background service '<name>' exited during startup (pgid …)`

The pre-grace registration is kept so a shutdown during startup still sees the group.

## Verification

- New test: `runner::tests::test_background_service_that_exits_during_startup_is_not_registered`.
  It fails on the pre-fix source (`registered` is reported; assertion at the startup-exit message) and
  passes after the fix.
- `cargo test --bin harness-core runner::tests` with isolated `HOME`: 14/14 pass.
- `git diff --check`: pass.
