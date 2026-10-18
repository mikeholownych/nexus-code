# PLAN-02: Process ownership, cancellation and resource bounds

This plan implements [SPEC-02](../specs/SPEC-02-process-ownership-and-bounds.md) in milestone **M1**. It covers REQ-AGT-109 and 109a, REQ-SEC-106 and 107 (including the timeout clamp), and REQ-TUI-107.

## Safe change boundary

- `core/src/runner.rs`
- `core/src/main.rs` (RPC loop, signals)
- `core/src/file_ops.rs` (read cap)
- `cli/src/tools.ts` (bridge)
- `cli/src/agent.ts` (signal plumbing into `executeTool`; notify/BEL gating at 773-780 and 4932)
- `core/src/bin/nexus_tui/live_state.rs` (cancel feedback)
- `cli/src/sidecar.ts` (shutdown ordering)

The JSON-RPC protocol version bump is shared with PLAN-06, task 3.

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | `ProcessRegistry` (request_id→pgid, services). Insert after spawn, remove on reap. | `runner.rs:116-167` | — |
| 2 | `cancel` RPC: killpg TERM, then KILL after 2 s, then reply. ESRCH counts as success. | `main.rs:194-203`, `runner.rs` | 1 |
| 3 | Shutdown sweep on stdin EOF, SIGTERM and SIGHUP (`tokio::signal`). `prctl(PR_SET_PDEATHSIG, SIGTERM)` at startup (Linux, `nix` or `libc` crate). | `main.rs` | 1 |
| 4 | Bounded capture: head buffer plus tail ring buffer, and a byte counter in the truncation notice. | `runner.rs:177-193` | — |
| 5 | PTY path kills the pgid. | `runner.rs:319-323` | 1 |
| 6 | `read_file` cap at 8 MB, with an `offset`/`length` paging hint in the error. Same for `batch_read`. | `file_ops.rs:205-277`; capability schema in `capabilities.ts` | — |
| 7 | Clamp `timeout_secs` to `NEXUS_MAX_TOOL_TIMEOUT_SECS` (default 1800) and tell the model it was clamped. | `tools.ts` (args), `runner.rs` | — |
| 8 | Bridge: `executeTool(name,args,{signal})`. On abort or timeout, send `cancel` and await the reply (≤ 5 s). On shutdown, close stdin, wait 3 s, then SIGKILL. | `tools.ts:247-256,338-347,432+` | 2,3 |
| 9 | Agent passes the turn signal to every `executeTool`. A killed tool's result is `status: CANCELLED`, `signal`. | `agent.ts` dispatch, spine call | 8 |
| 10 | `run_command {background:true, service_name}` registers a service. Services are listed in `/status`, killed on exit, and do not survive the turn's cancel unless registered. | `capabilities.ts`, `runner.rs`, `slash/session_commands.ts` | 1 |
| 11 | TUI: Esc sets `cancel_requested` and the footer shows "cancelling — waiting for <tool> (<n>s)". | `live_state.rs:1566`, `live_view.rs` footer | — |
| 12 | Gate notify-send and BEL on an interactive TTY and REPL/TUI surface. | `agent.ts:773-780,4932` | — |
| 13 | Docs: USER_MANUAL cancellation section; ARCHITECTURE runner section; residual risk of `setsid` escape without the sandbox. | docs | all |

## PR slices

1. **PR-2a** (tasks 1-5, Rust only). Registry, cancel RPC, shutdown sweep, bounded capture. Rust unit tests in `runner.rs` follow the style of the existing descendant test (`runner.rs:479-500`).
2. **PR-2b** (tasks 8-9). Bridge and agent plumbing, plus the ACC-PROC PTY tests.
3. **PR-2c** (tasks 6, 7, 10). Read cap, timeout clamp, services.
4. **PR-2d** (tasks 11-13). TUI feedback, notification gating, docs.

## Tests

- **Rust:**
  - `cancel_kills_group`
  - `shutdown_on_eof_kills_all`
  - `pdeathsig_sweeps` (spawn harness-core under a parent that exits)
  - `bounded_capture_400mb`, which measures RSS through `/proc/self/status`
- **TS:** a `process_lifecycle_e2e.test.ts` PTY test that ports `evidence/D_pty/s8_cancel_tool.py` and `s9_quit_tool.py`. After each scenario it asserts there are no survivors, using `ps -eo pid,ppid,args` filtered by a unique sleep duration token.
- **Headless:** `nexus run --json` with a PATH shim for `notify-send` that records calls (ACC-PROC-08).
- **Load:** ACC-PROC-07, 30 iterations under `stress`. Runs nightly or in M5; it is not in per-PR CI.

## Rollback

- The registry and sweep are additive.
- If PDEATHSIG causes trouble in containers, it can be disabled with `NEXUS_NO_PDEATHSIG=1`. Keep the env escape hatch.

## Definition of done

- ACC-PROC-01 to ACC-PROC-08 pass.
- Ledger rows updated.
- The ISSUE12 EXEC-009 and SUBP-004/005 historical rows are annotated as superseded by REQ-AGT-109 and REQ-SEC-106 (PLAN-09).
