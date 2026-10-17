# SPEC-02: Process ownership, cancellation and resource bounds

| | |
|---|---|
| Status | Ready. No open decision. |
| Release class | **BLOCKER** (cancel/exit cleanup); RELEASE-REQUIRED (memory bounds, cancel feedback) |
| Requirements | REQ-AGT-109, REQ-SEC-106, REQ-SEC-107, REQ-TUI-107 |
| Findings | TUI-01, SEC-07, SEC-08, TUI-08, TUI-11, AGT-16, PRV-05 (fetch side, see SPEC-05) |
| Historical requirement | EXEC-009 / SUBP-004 / SUBP-005 (Issue #12, marked "DEMONSTRATED" with "setpgid deferred"; contradicted at HEAD) |
| Plan | [PLAN-02](../plans/PLAN-02-process-ownership-and-bounds.md) |
| Acceptance | ACC-PROC-01 to ACC-PROC-06 |

## 1. Problem

Each `run_command` runs in its own process group (`core/src/runner.rs:164-167`). Only the runner's own timeout kills that group (`runner.rs:245-264`). Nothing else connects the operator's actions to the process:

- **Cancel does not reach the runner.** Operator cancel (Esc/Ctrl-C) aborts the agent's turn controller (`cli/src/agent.ts:4179-4190`). Nothing reaches harness-core, because `cli/src/tools.ts` has no abort path for an in-flight RPC (TUI-01, reproduced: `sleep 23.7` kept running after Esc).
- **Shutdown orphans running commands.** When the bridge kills the RPC daemon (`tools.ts:247-256,338-347`), every running command group is orphaned to PID 1. Reproduced: after the TUI quit, `bash -c sleep 23.7` was reparented to PID 1 (TUI-01). A `kill -TERM` of `harness-core rpc` left `sleep` running (SEC-07, R5).
- **Bridge-side timeouts do not reach the runner.**
- **The model chooses `timeout_secs` with no upper bound.**

Output and reads are buffered without bound before truncation:

- Run output: 400 MB of output reached 785 MB RSS (`runner.rs:177-193`).
- File reads: a 200 MB file reached 590 MB RSS and was returned whole over RPC (`file_ops.rs:205-277`).

The PTY path kills only the child, not its group (`runner.rs:319-323`) (SEC-08).

Feedback gaps:

- Esc sends Cancel without showing "cancelling" (`live_state.rs:1566`; TUI-08).
- One run showed "cancelling…" for 11 s or more after Ctrl-C (TUI-11, not reproduced in 3 reruns).

Every turn end spawns `notify-send` through a shell and writes BEL to stdout, including in headless and sidecar modes (`agent.ts:773-780,4932`; AGT-16).

## 2. Requirements

1. **REQ-AGT-109.** Cancel (Esc, Ctrl-C, `prompt.cancel`, SIGINT to `nexus run`) terminates the process group of every in-flight tool within 5 s: SIGTERM, then SIGKILL after a 2 s grace.
2. **REQ-SEC-106.** On a normal exit, crash of the client, SIGTERM or SIGHUP, harness-core leaves no surviving task-owned processes. This includes background processes the model started with `&`, unless they were explicitly registered as long-lived services (see §5.4).
3. **REQ-SEC-107.** Peak memory of harness-core and the sidecar is bounded for these inputs:
   - command output: ≤ 64 MB RSS for 400 MB of output;
   - file reads: `read_file` refuses or pages files larger than 8 MB;
   - `fetch_web` bodies: capped at 5 MB, streamed (shared with SPEC-03).
4. **REQ-SEC-107 (timeout clamp).** `timeout_secs` is clamped to an operator-configurable maximum (default 1800 s). The clamp is reported to the model.
5. **REQ-TUI-107.** Every cancel request is acknowledged on screen within one frame. The acknowledgement names what is being waited for. The turn reaches an idle state within 5 s of the tool group being killed.
6. **REQ-AGT-109a.** Desktop notification and BEL happen only when stdout is an interactive TTY and the surface is the REPL or TUI.

## 3. Proposed design

### 3.1 Runner registry (Rust)

Add `ProcessRegistry` to `core/src/runner.rs`. It maps `request_id → pgid`, plus a set of registered services.

- **Spawn.** Insert the pgid after `setpgid`. Remove it on reap.
- **New RPC `cancel { request_id }`.** `killpg(pgid, SIGTERM)`, then SIGKILL after 2 s, then reply `cancelled`.
- **Shutdown.** On stdin EOF, SIGTERM or SIGHUP (`core/src/main.rs:194-203` RPC loop), killpg every registered group with the same TERM → KILL sequence, then exit. Install the handlers with `tokio::signal`.
- **Parent death.** On Linux, call `prctl(PR_SET_PDEATHSIG, SIGTERM)` in harness-core. If the node sidecar dies without closing stdin, harness-core gets a signal and runs the shutdown path. The command children are in their own groups, so the registry sweep is what cleans them up.
- **Bounded capture.** Replace the `Vec<u8>` accumulation with a head buffer and a tail ring buffer, sized to the existing truncation limits (32 KiB each), plus a byte counter. The truncation notice reports the counted total.
- **PTY path.** Kill the pgid, not only the child (`runner.rs:319-323`).

### 3.2 Bridge (TS)

In `cli/src/tools.ts`, `RustCoreBridge.executeTool(name, args, { signal })`:

- On `signal` abort, send `cancel { request_id }` and wait for the reply (bounded at 5 s), then reject with `AbortError`.
- On bridge-side timeout, do the same.
- On `shutdown()`, close stdin first and wait up to 3 s for the daemon to exit, then SIGKILL the daemon. With the registry sweep in place, the runner cleans its children on stdin EOF.

In `cli/src/agent.ts`, pass the turn's abort signal into every `executeTool` call. The spine already has the signal (`agent.ts:4359-4372`). The existing cancellation-record semantics (synthetic tool results for undispatched calls) are kept. A tool that was killed reports `status: CANCELLED`, `exit_code: null` and `signal: SIGTERM|SIGKILL`.

### 3.3 Cancel feedback (Rust TUI)

In `live_state.rs:1566`, Esc sets `cancel_requested` exactly as Ctrl-C does. The footer shows `cancelling — waiting for <tool> (<n>s)`. A second Esc while cancelling has no effect. A second Ctrl-C keeps its current meaning (quit), and quitting now also triggers the shutdown sweep through the sidecar.

### 3.4 Background processes

The model starts dev servers with `cmd &`. Today these outlive the call by design. For v1:

- They are tracked in the registry as part of the call's group.
- They are killed on turn cancel and on client exit.
- A new optional tool argument, `run_command { background: true, service_name }`, registers a service. Services survive the turn but **not** client exit, and they are listed in `/status`. This replaces the deferred SUBP-005 "background registration" with a concrete mechanism.

## 4. Interfaces and state

- **JSON-RPC.** New `cancel` method. A `run_command` result gains `cancelled: bool` and `signal: string|null`. The harness-core protocol version is bumped. The bridge checks the version at startup and refuses a mismatched core with an actionable error, which also fixes the cause class of REL-04.
- **Durable state.** An in-flight tool killed by cancel records `operationEnd { status: CANCELLED }`. A crash still leaves `operationStart` with no end, and recovery treats it as interrupted, as today.

## 5. Failure handling

- A cancel RPC failure is logged. The bridge then kills the daemon, which triggers the shutdown sweep.
- `killpg` with ESRCH is treated as already gone.
- A zombie or stuck process in D state is reported after the KILL grace as `cancel incomplete: pid N did not exit`. The turn still ends.

## 6. Security

The orphan problem is also a safety issue: a prompt-injected long-running process survives the operator's attempt to stop it. Killing by pgid recorded at spawn means a changing process tree cannot hide from the sweep, short of a `setsid` escape by the command itself. For v1 that is mitigated by the bwrap sandbox (`--die-with-parent`) when the sandbox is active. Document the residual risk for unsandboxed mode.

## 7. Alternatives

| Alternative | Why not chosen |
|---|---|
| cgroups v2 per call | The strongest containment, but needs systemd delegation or root on many hosts. Post-v1 option behind `--sandbox`. |
| Kill the daemon on cancel | Loses the other in-flight read-only calls, and still orphans grandchildren without the registry. |

## 8. Acceptance criteria

| ID | Check |
|---|---|
| ACC-PROC-01 | PTY s8: Esc during `sleep 30` leaves no `sleep` process ≤ 5 s later. The footer shows "cancelling" within 200 ms. |
| ACC-PROC-02 | PTY s9: Ctrl-C ×2 during `sleep 30` exits the TUI. `ps -eo pid,ppid,args` shows no process from the call 3 s later. |
| ACC-PROC-03 | `kill -9 <sidecar pid>` during `sleep 30` leaves no survivors ≤ 5 s later (PDEATHSIG path). |
| ACC-PROC-04 | `nexus run` SIGINT during `sleep 30 & sleep 30` kills both. |
| ACC-PROC-05 | `head -c 400000000 /dev/zero \| tr '\0' a` keeps harness-core max RSS ≤ 64 MB, and the reported byte count is 400000000. |
| ACC-PROC-06 | `read_file` on 200 MB returns a bounded, paged response with RSS ≤ 64 MB. |
| ACC-PROC-07 | Cancel latency under `stress -c $(nproc)`, 30 iterations: p100 ≤ 5 s (qualifies TUI-11). |
| ACC-PROC-08 | Headless `nexus run --json` stdout contains no `\x07`, and no `notify-send` is spawned (strace or a PATH shim). |

## 9. Dependencies

- None blocking.
- Coordinate the protocol version bump with SPEC-06 (version single-sourcing).
