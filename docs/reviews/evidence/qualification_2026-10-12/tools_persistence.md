# Nexus Code — Tool/Execution Quality (Area 3) and Persistence/Auditability (Area 7)

STATUS: COMPLETE (2026-10-12). Findings T1-T16 (Area 3) and P1-P6 (Area 7).

Scope and method: independent, read-only review. Primary commit main 3727938, extracted with `git archive` to
`scratchpad/assess/tp/main` (engine built there with `cargo build --release`; node_modules symlinked). All probes ran
in throwaway workspaces under `scratchpad/assess/tp/ws*` with `HOME=scratchpad/assess/tp/home`. Below, `HC` =
`tp/main/core/target/release/harness-core`.

Branch applicability: `git diff --stat main feat/tui-surface` and `main fix/context-convergence` show **no changes** to
`core/src/file_ops.rs`, `core/src/runner.rs`, `core/src/main.rs`, `cli/src/tools.ts`, `cli/src/sandbox.ts`,
`cli/src/tester.ts`, `cli/src/file_diff.ts`'s callers in the tool path. fix/context-convergence changes only
`cli/src/core/state.ts` (+4) and `cli/src/session.ts` (+1/-8) among the persistence files. So every Area 3 finding
applies to main, feat/tui-surface, fix/context-convergence, and the installed runtime (which runs the
feat/tui-surface checkout).

---

## Area 3 — Tool and execution quality

### T1 edit_file silently applies to non-matching text (fuzzy 0.85 fallback) and deletes code the model never named
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: main / feat/tui-surface / fix/context-convergence / installed runtime
- Trigger: `edit_file` whose `old_content` is not in the file (e.g. stale model view), but a same-sized window is
  >= 85% line-similar.
- Expected: the edit is refused ("old_content not found"), or at minimum the result discloses that a fuzzy match
  replaced different text.
- Observed: main core/src/file_ops.rs:243-322 (`fuzzy_find_and_replace`, threshold `best_ratio = 0.85f32` at :299)
  is the fourth fallback in `edit_file` (:558-560). It replaces the most similar window and returns
  `replacements: 1` with no indication that a fuzzy match occurred. Reproduction:
  ```
  printf 'fn f() {\n    let a = 1;\n    let b = 2;\n    audit_log(a);\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let g = 6;\n}\n' > f.rs
  $HC -w . call --tool edit_file --args '{"path":"f.rs","old_content":"    let a = 1;\n    let b = 2;\n    check_permissions(a);\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let g = 6;","new_content":"    let a = 1;\n    let b = 2;\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let g = 7;"}'
  -> exit 0, "replacements": 1, diff "-    audit_log(a);" ... "+    let g = 7;"
  ```
  `check_permissions(a)` never existed; the line `audit_log(a);` was deleted. The only test of this path
  (file_ops.rs:1168, "fuzzy indentation mismatch") covers the benign case.
- Impact: silent semantic corruption of source on a stale or hallucinated snippet; the transcript and receipt say
  the edit succeeded as asked.
- Remediation: remove the TextDiff-ratio fallback (keep exact, CRLF-normalised and per-line-trim matching); if any
  non-exact strategy matched, return `match: "exact"|"newline_normalized"|"trimmed_lines"` in `EditFileResult` and
  refuse when the matched region's text differs from `old_content` beyond whitespace.
- Acceptance test: Rust unit test with the file above asserts `edit_file` returns `Err` and the file is byte-identical.
- Dependencies: none. Not addressed on any branch.

### T2 edit_file replaces the first of several matches and reports the total as `replacements`
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Trigger: `old_content` occurs more than once.
- Expected: refusal for ambiguity (model must add context), or replace all and say so.
- Observed: file_ops.rs:540-543 — `count = matches().count()` but `replacen(.., 1)`; same at :551-552 and :557-558.
  ```
  printf 'a = 1\nb = 2\na = 1\n' > dup.txt
  $HC -w . call --tool edit_file --args '{"path":"dup.txt","old_content":"a = 1","new_content":"a = 9"}'
  -> "replacements": 2 ; file afterwards: "a = 9\nb = 2\na = 1"
  ```
  The tool description (capabilities.ts:265-297) says "Exact snippet"; the system prompt asks for "unique snippets"
  (agent.ts:1968) but nothing enforces it. `flight.ts:191-195` records `replacements` from the *args* (always
  undefined -> 1), not from the result.
- Impact: wrong occurrence edited; result claims two replacements when one happened — misleading receipts.
- Remediation: when count > 1 return `Err("old_content matches N locations; include more context")`; add optional
  `replace_all: bool`. Report the number actually replaced.
- Acceptance test: unit test above expects `Err` and unchanged file; with `replace_all:true` expects 2 replacements.

### T3 edit_file / write_file are non-atomic, have no stale-content guard, and edit_file can rewrite line endings
- Priority: P1
- Label: REPRODUCED DEFECT (CRLF rewrite; status field) / SOURCE-SUPPORTED RISK (atomicity, staleness)
- Affects: all branches / installed runtime
- Observed:
  - In-place truncate-then-write, no temp file, no fsync: write_file file_ops.rs:213-225 (`set_len(0)` at :223),
    edit_file :600-609 (`set_len(0)` at :607). A crash, kill, ENOSPC or EIO after `set_len(0)` leaves an empty or
    partial file; the error path returns `Failed to write...` but the original is already gone. Because the receipt
    is unsuccessful, the per-operation diff is not recorded either (agent.ts:2638 requires `receipt.success`).
  - No stale-content detection: edit_file reads the file at call time (:530-537) and there is no expected-hash /
    mtime parameter anywhere (grep for `expected_hash|mtime|stale|lastRead` over core/src/file_ops.rs, cli/src/agent.ts,
    cli/src/file_diff.ts finds only the verifier fingerprint). Combined with T1, an operator edit made between the
    model's read and its edit can be overwritten by a fuzzy match.
  - CRLF rewrite: when the exact match fails, the newline-normalised fallback returns the whole file normalised
    (:545-552), converting every CRLF in the file to LF:
    ```
    printf 'line1\r\nline2\r\nline3\r\n' > crlf.txt
    $HC -w . call --tool edit_file --args '{"path":"crlf.txt","old_content":"line1\nline2","new_content":"LINE1\nline2"}'
    od -c crlf.txt -> "L I N E 1 \n l i n e 2 \n l i n e 3 \n"   (all \r removed)
    ```
  - Non-UTF-8 files: `read_to_string` (:535) fails, so Latin-1 files cannot be edited at all (fails closed; acceptable).
  - write_file always reports `"status": "overwritten"`, even for a new file, because it tests `target.exists()`
    after writing (:231). Reproduced: `write_file brand_new.txt` -> `"status": "overwritten"`.
- Impact: data loss on interruption; line-ending churn producing whole-file diffs in Windows-authored repos;
  misleading created/overwritten audit status.
- Remediation: write to a sibling temp created with `tempfile::NamedTempFile::new_in(parent)`, copy the original's
  permissions, `sync_all`, `persist` (rename), fsync parent dir; detect the file's dominant EOL and BOM and
  re-apply them to `new_content`; compute status before writing; add optional `expected_sha256` to edit/patch/write
  and have the agent pass the hash of the content it last read.
- Acceptance test: (a) CRLF file edited with LF snippet keeps `\r\n` on every line; (b) `write_file` new path ->
  `created`; (c) fault-injection test (write to a file on a full tmpfs or a read-only bind of the temp dir) leaves the
  original byte-identical; (d) edit with wrong `expected_sha256` -> `Err`, file unchanged.

### T4 patch_file clobbers `<stem>.tmp_patch`, drops the executable bit, replaces symlinks, strips CRLF, ignores hunk line numbers
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: patch_file (file_ops.rs:943-1088) is all-or-nothing in memory (returns before writing if any hunk fails,
  :1043-1047 — good) and commits by rename, but:
  - temp path is `target.with_extension("tmp_patch")` (:1054), a fixed, predictable sibling: an existing
    `run.tmp_patch` is truncated, overwritten and renamed away.
  - the temp is created with default mode and renamed over the target (:1056-1069): permissions are not preserved.
  - rename replaces a symlink with a regular file; the link target is left unpatched.
  - `original_content.lines()` (:1017) strips `\r`; the file is re-joined with `\n`.
  - `@@` headers are discarded (:974-984); each hunk applies at the **first** matching context anywhere in the file
    (:1030-1036), so a hunk aimed at the second of two identical blocks patches the first.
  ```
  printf '#!/bin/sh\necho old\n' > run.sh; chmod 755 run.sh; printf 'IMPORTANT USER DATA\n' > run.tmp_patch
  $HC -w . call --tool patch_file --args '{"path":"run.sh","patch":"@@ -1,2 +1,2 @@\n #!/bin/sh\n-echo old\n+echo new\n"}'
  ls -l -> "-rw-rw-r-- run.sh" (was -rwxr-xr-x); run.tmp_patch: No such file or directory
  printf 'x\ny\n' > real.txt; ln -s real.txt link.txt
  $HC ... patch_file link.txt "-x\n+X\n y\n" -> link.txt is now a regular file; real.txt still "x\ny"
  printf 'a\r\nb\r\n' > c.txt; patch "-a\n+A\n" -> diff "-a\r\n-b\r\n+A\n+b\n"; od: "A \n b \n"
  ```
- Impact: user data destroyed; scripts stop being executable; symlinked config silently forked; whole-file EOL churn;
  misplaced hunks.
- Remediation: random temp name in the same dir (NamedTempFile), copy metadata (mode) from the original, resolve the
  symlink and patch the real path (after confinement check), preserve EOL, honour `@@ -l` as the search start and
  require a unique match (or the nearest to the stated line).
- Acceptance test: the four commands above produce: run.tmp_patch intact, run.sh mode 755, real.txt patched with
  link.txt still a symlink, c.txt keeps CRLF; plus a two-identical-blocks fixture where `@@ -10` patches the second.

### T5 delete_file recursively removes directories without an approval gate and records no detail
- Priority: P2
- Label: SOURCE-SUPPORTED RISK
- Affects: all branches / installed runtime
- Observed: `delete_file` on a directory calls `fs::remove_dir_all` (file_ops.rs:640-641). The agent's approval
  prompt covers only `edit_file|write_file|patch_file|run_command` (agent.ts:2503-2508); `delete_file` is not in that
  list. The per-op diff snapshot treats a directory as `unreadable: not a regular file` (file_diff.ts:31-34), so the
  change is recorded as one "deleted" entry with no file list. The name and description suggest a file.
- Impact: one model call can delete a whole subtree (e.g. `src`) with no prompt in review mode and no record of what
  was removed.
- Remediation: refuse directories unless `recursive: true`; include `delete_file` in the approval set; record the
  list of removed paths (and sizes) in the receipt; snapshot-to-checkpoint before deleting.
- Acceptance test: agent test with an onConfirm that denies: `delete_file {path:"src"}` is DENIED and `src` exists;
  engine test: directory without `recursive` -> Err.

### T6 run_command child inherits the RPC daemon's stdin and consumes queued tool requests
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Trigger: any command that reads stdin (`cat`, `read`, `head`, prompts from `npm init`, `apt`, `git` credential
  prompts, `python` REPL...) while another RPC request is sent to the same daemon (parallel read-only tools, MCP,
  sub-agents sharing the bridge, a retried/timed-out request).
- Expected: commands get `/dev/null` (or a closed pipe) as stdin; requests are never lost.
- Observed: runner.rs:151-153 sets stdout/stderr only; `Command` defaults stdin to *inherit*, and in RPC mode fd 0 is
  the JSON-RPC request pipe that the tokio reader also reads (main.rs:185). Reproduction with a 30-line driver
  (`tp/scripts/rpc.py`, sends JSON lines to `harness-core rpc`):
  ```
  python3 -I rpc.py $HC ws2 '[[0,"run_command",{"command":"timeout 3 cat > stolen.txt; echo done","timeout_secs":10}],
                              [0.5,"list_dir",{"path":"."}],[0.5,"write_file",{"path":"x.txt","content":"x"}]]' 5
  [ 0.5s] RESP {"id":2,...list_dir result...}
  [ 3.1s] RESP {"id":1,..."stdout":"done\n","timed_out":false}
  (no response for id 3)
  stolen.txt: {"id": 3, "method": "write_file", "params": {"path": "x.txt", "content": "x"}}
  ls x.txt -> No such file or directory
  ```
  A first run with `head -c 60` similarly swallowed request 3 (`list_dir`), which never got a reply. The bridge then
  reports `RPC request ... timed out ... (result unknown)` after 35 s (tools.ts:324-335). Interactive commands also hang
  for the whole timeout instead of failing at EOF.
- Impact: lost tool calls, spurious 35 s stalls with "result unknown", interactive prompts hanging to timeout.
- Remediation: `cmd.stdin(Stdio::null())` in `run_command` (runner.rs) and in the PTY path; keep the RPC pipe private
  (dup fd 0 to a high fd at daemon start and reopen 0 as /dev/null).
- Acceptance test: the rpc.py scenario above returns responses for ids 1-3, `x.txt` exists, `stolen.txt` is empty;
  `run_command {"command":"read x; echo rc=$?"}` returns immediately with `rc=1`.

### T7 run_command timeout does not bound the call once the shell exits; background children hold it open
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: the deadline loop (runner.rs:184-199) only watches the shell. After the shell exits, the reader threads
  are joined unconditionally (:202-203) and block until every descendant holding the pipes exits; the process group is
  not killed on normal exit.
  ```
  /usr/bin/time $HC -w . call --tool run_command --args '{"command":"(sleep 8; echo late) & echo early","timeout_secs":3}'
  -> "stdout": "early\nlate\n", "timed_out": false, "exit_code": 0, wall=8.03s
  ```
  With a server started in the background (`npm run dev &`) the call never returns; the bridge gives up after
  `timeout_secs + 5` with "result unknown" (tools.ts:113-120) while the daemon thread and the server live on.
- Solid by contrast: on a real timeout the whole group is SIGTERM'd then SIGKILL'd (runner.rs:226-246). Verified: a
  SIGTERM-ignoring grandchild (`exec -a nxprobeign sleep 300` with `trap "" TERM`) is gone 1 s after a 2 s timeout
  (`pgrep -x nxprobeign` -> none); PTY-mode timeout also left no survivor. `setsid -f` children escape (expected).
- Remediation: apply the deadline to the pipe drain too (read with a deadline, or after shell exit wait at most a short
  grace then `killpg` and mark `background_children_killed`); document/offer a `background: true` mode that redirects
  output to a log file and returns a handle.
- Acceptance test: the command above returns within `timeout_secs + 1` s with `timed_out: true` (or a
  `children_killed` flag) and no `sleep 8` survives.

### T8 run_command panics on large multi-byte output; result (and exit code) are lost after the side effects ran
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: `truncate_output` slices `&s[..half]` / `&s[s.len()-half..]` at byte offsets (runner.rs:42-53); any output
  > 32 000 bytes whose byte 16 000 is inside a UTF-8 character panics.
  ```
  $HC -w . call --tool run_command --args '{"command":"python3 -c \"print(chr(8364)*12000)\"","timeout_secs":10}'
  thread 'main' panicked at src/runner.rs:47:15: end byte index 16000 is not a char boundary; it is inside '€'
  ```
  In RPC mode the panic is caught by `spawn_blocking` and returned as `Task execution failed` (main.rs:200-222), so
  the agent sees a failed command although it ran to completion (e.g. a migration or `git commit`). Panic text goes to
  the daemon's stderr, which the bridge pipes but never reads (tools.ts:209-212, no stderr listener): enough panics
  would fill the pipe and block the daemon.
- Remediation: truncate on char boundaries (`s.floor_char_boundary`, or truncate the byte buffer before lossy
  decoding); drain or `ignore` daemon stderr in the bridge.
- Acceptance test: the command above returns success with a `[TRUNCATED N BYTES]` marker; unit test with 3-byte chars.

### T9 run_command buffers unbounded output in memory before truncating
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Observed: reader threads `read_to_end` into a `Vec` with no cap (runner.rs:166-178); truncation to 32 000 chars
  happens only at the end (:208-214). A noisy command (`yes`, verbose build) for 60 s can allocate GBs in the engine.
  The truncation marker itself is good (`... [TRUNCATED n BYTES] ...`, head+tail kept).
- Remediation: ring-buffer head (16 KB) + tail (16 KB) while streaming, counting dropped bytes.
- Acceptance test: `yes | head -c 2000000000` keeps engine RSS < 100 MB and reports the dropped byte count.

### T10 Commands inherit the full environment; arbitrary-format secrets reach the model provider
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: no `env_clear`/`env_remove` in core/src or cli/src (grep `env_clear|env_remove|clearenv` -> none); the
  bridge spawns the daemon with the sidecar's env (tools.ts:209-212) and the runner passes it on; bwrap wrapping also
  keeps the env (sandbox.ts, no `--clearenv`).
  ```
  OPENAI_API_KEY=sk-test-PROBE-0123456789abcdef LOCAL_LLM_API_KEY=probe-local-key-123 \
    $HC -w . call --tool run_command --args '{"command":"env | grep -E \"API_KEY\"","timeout_secs":5}'
  -> "stdout": "OPENAI_API_KEY=sk-test-PROBE-...\n<another real key from the reviewer's shell, redacted here>\nLOCAL_LLM_API_KEY=probe-local-key-123\n"
  ```
  The egress boundary tokenises only pattern-matched secrets before the provider call. Probe through
  `InformationFlowBoundary.evaluateEgress` (tp/main/cli/probe_egress.mts):
  `OPENAI_API_KEY=[NEXUS_SEC_REF_…]` but `LOCAL_LLM_API_KEY=probe-local-key-123` and
  `DATABASE_URL=postgres://admin:hunter2pass@db/prod` pass through unchanged (quarantinedCount 1).
- Impact: the operator's gateway key (`LOCAL_LLM_API_KEY`, used by Nexus itself), DB URLs and other unquoted env
  secrets are one `env`/`printenv` away from the transcript, the provider and the session file.
- Remediation: build the child env from an allow-list (PATH, HOME, LANG, TERM, USER, SHELL, TMPDIR, project-declared
  vars) and strip Nexus's own credential vars (`LOCAL_LLM_API_KEY`, `*_API_KEY`, `*_TOKEN`) unless the operator opts in;
  also tokenise values of env vars whose names match `KEY|TOKEN|SECRET|PASSWORD` in tool output.
- Acceptance test: with `LOCAL_LLM_API_KEY=x123456789` set, `run_command env` output does not contain `x123456789`.

### T11 run_tests: filter is shell-injected, executes without approval, and is scheduled as a parallel "read-only" tool
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: `detectTestCommand` interpolates the model-supplied `filter` into a shell string — unquoted for Cargo
  (`cargo test -- ${filterPattern}`, tester.ts:37) and inside naive double quotes for make/npm/pytest/go (:30, :47, :55,
  :60). `run_tests` calls `this.executeTool("run_command", …)` directly (tools.ts:556-561), bypassing the agent's
  approval prompt, which never includes `run_tests` (agent.ts:2503-2508). `run_tests` is also in `READ_ONLY_TOOLS`
  (agent.ts:378-389) and capabilities marks it `mutating: false` (capabilities.ts:788-790), so it runs concurrently with
  other tools via `Promise.all` (agent.ts:3186-3194) and does not bump `mutationSeq` (agent.ts:744-749).
  ```
  ws3/package.json: {"scripts":{"test":"echo tests-ran"}}
  tsx probe_runtests.mts ws3   (RustCoreBridge(ws3).executeTool("run_tests", {filter: 'x" ; touch INJECTED_BY_FILTER ; echo "'}))
  command: npm test -- -t "x" ; touch INJECTED_BY_FILTER ; echo ""
  success: true
  ls ws3 -> INJECTED_BY_FILTER  package.json
  ```
  The trailing `echo ""` also makes the exit status 0, so a failing suite can be recorded as a PASSED verifier
  attempt (agent.ts:2623-2634 records status from `parsed.passed && receipt.success`).
- Impact: approval bypass for arbitrary shell; forged verifier passes; test runs that write files racing with
  parallel reads, unnoticed by staleness tracking.
- Remediation: pass the filter as an argv element (no shell) or reject anything outside `[A-Za-z0-9_:./ -]`; treat
  run_tests as mutating/proc (remove from READ_ONLY_TOOLS; bump mutationSeq); route it through the same approval policy
  as run_command; record verifier attempts only for the configured, unfiltered command.
- Acceptance test: the probe above leaves no `INJECTED_BY_FILTER` and returns an argument-validation error; agent test
  shows `run_tests` + `read_file` in one response are executed sequentially.

### T12 Parallel read-only path skips the cancellation check and output folding
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Observed: the sequential path checks `signal.aborted` before each dispatch (agent.ts:3225-3235) and folds voluminous
  run_command/run_tests output (:3261-3268); the parallel path (:3186-3218) does neither, so a cancelled turn still
  dispatches every parallel call and an unfolded `run_tests` result goes to context. The RPC daemon has no cancel verb
  (acknowledged in agent.ts:2707), so in-flight commands always run to their own timeout after cancel.
- Remediation: check `signal.aborted` before `Promise.all`; apply `foldVoluminousOutput` identically; add a `cancel`
  RPC that `killpg`s the request's process group.
- Acceptance test: cancel during a 2-call parallel batch -> both calls get `cancelledToolMessage`; cancel during
  `run_command sleep 30` returns within 1 s and no `sleep` survives.

### T13 Dry-run executes "read-only-looking" commands unsandboxed; the allow-regex is prefix-only
- Priority: P2
- Label: REPRODUCED DEFECT
- Observed: in dry-run, commands matching `SAFE_READONLY_COMMAND_REGEX` (tools.ts:31-32, anchored only at the start)
  fall through to real execution (tools.ts:524-532); `echo x > file`, `ls; rm -rf build`, `find . -delete`,
  `git diff --output=f` all match. Read-only mode is protected by the sandbox requirement (tools.ts:695-716), but dry-run
  is not wrapped unless a sandbox is configured.
  Reproduced (tp/main/cli/probe_dryrun.mts, `new RustCoreBridge(ws4, "bash", undefined, true)`):
  `echo x > DRYRUN_WROTE_THIS -> success, real run_command JSON result`; `touch NOT_ALLOWED -> [DRY-RUN SIMULATION]`;
  `ls ws4 -> DRYRUN_WROTE_THIS`.
- Remediation: in dry-run, never execute; or require the sandbox with `readOnlyHost` as read-only mode does.
- Acceptance test: dry-run `run_command "echo x > f"` -> simulated, `f` absent.


### T14 spawn_subagent: "isolated" helper shares the workspace and its tool calls skip the approval prompt
- Priority: P1
- Label: SOURCE-SUPPORTED RISK
- Affects: all branches / installed runtime (REPL review mode and TUI approvals)
- Observed: without an active worktree the subagent config is `{...this.config}` with the same workspace
  (agent.ts:2195-2210) although the spinner says "Spawning isolated subagent". `runSubagent` dispatches every call as
  `dispatchToolCall(call, currentStep, "subagent")` with no `onConfirm` (agent.ts:3648), and the approval gate only runs
  when `onConfirm` is passed (agent.ts:2502-2508). So in review mode (`autoApprove=false`, repl.ts:282) or with TUI
  approvals (sidecar.ts:391-421), the parent's `spawn_subagent` call is not prompted (not in the gate list) and the
  child's `write_file`/`edit_file`/`run_command` run unprompted. Child edits also do not bump the parent's
  `mutationSeq` or call `invalidateVerified` (only `turnMutations`/`unverifiedChanges` are propagated, agent.ts:2238-2246),
  so a requirement already marked `verified` keeps that status in the ledger (and export) after a child edits the
  deliverable; a *new* verification is still blocked because the candidate identity changes (agent.ts:1480-1490).
- Impact: approval policy bypass by delegation; ledger shows "verified" for a changed deliverable until a later parent
  mutation demotes it.
- Remediation: pass the parent's `onConfirm` to the child (or force the child read-only unless a worktree is
  bound); include `spawn_subagent` in the approval gate; on child mutations call `invalidateVerified` and bump
  `mutationSeq` in the parent's `finally`.
- Acceptance test: mock-gateway agent test (pattern of cli/test/context_capacity_runtask.test.ts): parent calls
  `spawn_subagent`, child calls `write_file`; with an `onConfirm` that denies, the file is absent; with a requirement
  previously `verified`, after the child write its status is `implemented`.

### T15 list_dir, file_tree and cst_symbols are not confined to the workspace
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: these use `base_dir.join(&args.path)` (core/src/search.rs:67 list_dir, :387 file_tree; core/src/cst.rs:146)
  instead of `resolve_safe_path` (used by read/write/edit/delete/patch/file_info/batch_read and outline_file). The TS
  bridge's protected-path check covers only write/edit/patch/delete/read (tools.ts:432-441).
  ```
  $HC -w ws5 call --tool list_dir  --args '{"path":"../outside_secret"}' -> entries: "../outside_secret/creds.txt"
  $HC -w ws5 call --tool list_dir  --args '{"path":"/etc/ssh"}'          -> "/etc/ssh/ssh_host_ecdsa_key", ...
  $HC -w ws5 call --tool file_tree --args '{"path":"../outside_secret"}' -> tree "../outside_secret\n└── creds.txt"
  $HC -w ws5 call --tool outline_file --args '{"path":"../outside_secret/creds.txt"}' -> Security Violation (confined, for contrast)
  ```
  These are read-only parallel tools, so they also run without approval.
- Impact: host filesystem enumeration (names, sizes) outside the jail; inconsistent confinement contract.
- Remediation: route every path argument through `resolve_safe_path` and add the tools to the bridge path check.
- Acceptance test: the three calls above return "escapes workspace jail" errors.

### T16 search_code/list_dir: no truncation disclosure, unbounded line and entry sizes
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all branches / installed runtime
- Observed: search_code stops at `max_results` (default 50, search.rs:48-50, :139, :167) and reports
  `total_matches: matches.len()` (:191-195), so a capped result is indistinguishable from "exactly 50 matches";
  `line_text` is the whole line (:173-177). list_dir and file_tree have no entry cap at all (search.rs:79-115).
  Gitignore handling uses the `ignore` crate (`.hidden(true).git_ignore(true)`), which applies .gitignore only inside a
  git repository (crate default `require_git`), so in a non-git workspace `node_modules` etc. are walked.
  ```
  80 lines "needle i" in sub/n.txt: search_code {"query":"needle"} -> "total_matches": 50   (no truncated flag)
  one 200 KB minified line containing needleX: search_code output = 200156 bytes for one match
  ```
  No generic tool-output cap was found in the agent path (grep `MAX_TOOL_OUTPUT|truncateToolOutput|capToolOutput`
  over cli/src -> none; `foldVoluminousOutput` applies only to run_command/run_tests, agent.ts:3261-3268).
- Remediation: return `truncated: true` and a `scanned_files`/`more_available` hint; clip `line_text` to ~300 chars
  around the match with a marker; cap list_dir/file_tree entries with a disclosed limit; set `require_git(false)` so
  .gitignore applies in non-git workspaces.
- Acceptance test: the two probes return `truncated: true` and output < 10 KB respectively.

---

## Area 7 — Persistence and auditability

Context: durable task state is one JSON file per task (`~/.nexus/tasks/<taskId>.json` via ApplicationCore; sessions dir
for SessionManager), `schemaVersion` 1 (core/state.ts:27), saved by temp+rename (state.ts:360-380), loaded fail-closed
on corrupt JSON / future versions (state.ts:400-419) with legacy v0 migration (state.ts:810-847). Redaction for
persistence is applied on save and re-applied on load (state.ts:335-350, 446-460).

### P1 Persistence failures are silently swallowed; the turn reports success-shaped results while nothing is saved
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: main / feat/tui-surface / fix/context-convergence (same code; convergence only adds `findings`)
- Observed: every durable write in the agent loop is wrapped in an empty catch: `persistProgress` (agent.ts:1160-1171),
  `recordOperationStart`/`recordOperationEnd` (agent.ts:2583-2593, 2605-2614), milestone recording in update_plan
  (agent.ts:2438-2452). Reproduction (mock gateway, test file tp/main/cli/test/zz_probe_persistfail.test.ts: construct
  ApplicationCore, chmod the task-state directory 0500, run a turn that writes a.txt and calls task_completed):
  ```
  PROBE result: {"success":false,"exitCode":2,"outcome":"UNVERIFIED","execution":"COMPLETED","warnings":null}
  PROBE a.txt exists: true state bytes before/after: 517 517
  PROBE state messages: 0
  ```
  The workspace changed, the durable record still has 0 messages and no operation record, and neither the TurnResult
  nor stderr mentions it (the UNVERIFIED outcome is from missing verification, not from the persistence failure).
- Impact: a crash later loses the whole session, interrupted-operation detection (PERS-002) silently stops working, and
  `/resume` offers stale state — while the UI implies it is saved.
- Remediation: count persistence failures in the agent; surface the first one as a TurnResult warning / TUI banner
  ("session is not being saved: <reason>") and in `nexus doctor`; fail the turn closed when `recordOperationStart`
  fails for a mutating tool (cannot guarantee interrupted-op detection).
- Acceptance test: the probe above yields a turn warning/flag `persistence: "failed"` and a non-zero/explicit exit
  reason; TUI shows a banner.

### P2 update_plan re-records every completed phase as a new milestone on each call
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all branches
- Observed: the update_plan handler loops over all phases and calls `recordMilestone` for each `completed` one
  (agent.ts:2435-2452); `recordMilestone` always appends with a fresh `randomUUID()` (state.ts:549-585). Mock-gateway
  probe (tp/main/cli/test/zz_probe_milestones.test.ts: three update_plan calls, Research completed in all three,
  Implement completed in calls 2-3):
  ```
  PROBE milestones: ["Research#0","Research#0","Implement#1","Research#0","Implement#1"]
  ```
- Impact: the milestone ledger (exported verbatim via `...session` in session_export.ts:75-77) overstates progress and
  timestamps mean "plan re-sent", not "reached"; any consumer counting milestones is wrong.
- Remediation: record a milestone only on a status transition (previous plan phase not completed -> completed), keyed by
  (phaseIndex, name); make `recordMilestone` idempotent on that key.
- Acceptance test: the probe yields `["Research#0","Implement#1"]`.

### P3 Durable state is written without fsync, with default file mode, and without a writer lock
- Priority: P2
- Label: SOURCE-SUPPORTED RISK (fsync, lock) / REPRODUCED (mode)
- Observed:
  - `fs.writeFileSync(tempPath, …)` then `fs.renameSync` (state.ts:369-372): no `fsync` of the temp file or directory.
    The comment says "synchronous flush"; writeFileSync does not fsync. On power loss the rename can survive with
    empty/old data on some filesystems.
  - No `mode` is passed: the probe's state file was `664` (`PROBE mode: 664`), whereas the sidecar's diff files and the
    compaction archive are written 0600 (sidecar.ts keepOperationDiff on main; session.ts appendArchivedHistory).
    The state file holds the (redacted) conversation, tool outputs and objective.
  - No lock: two processes resuming the same session (`/resume`, `nexus --resume`, a TUI and a REPL) each do
    load-modify-save (state.ts:490-540); last writer wins silently. grep for `lockfile|acquireLock|withLock|flock` in
    cli/src finds only doctor.ts.
  - Each tool call rewrites the whole file three times (start, end, progress), each with a full parse + redaction pass
    (state.ts:481-540) — cost grows with conversation size.
- Remediation: open temp with mode 0600, `fsync` file then directory before/after rename; take an advisory lock file
  (pid+boot id, as operation_runner.ts:337-360 already does for operations) for the lifetime of a session writer and
  refuse/attach read-only on contention; append operation start/end to a small per-session journal instead of
  rewriting the whole record.
- Acceptance test: state file mode is 0600; a second `ApplicationCore` resuming the same task gets a "session is open in
  pid N" error; strace shows fsync on save.

### P4 Single-slot `currentOperation` cannot represent parallel calls; crash during a parallel batch under-reports
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Observed: `recordOperationStart` overwrites the single `currentOperation` (state.ts:481-504). The parallel path
  starts several calls at once (agent.ts:3189-3194) — including `run_tests`, which executes repository code (T11). After
  the first call ends, `recordOperationEnd` matches by `seq` (state.ts:515-520), so only the last-started call is
  tracked. A crash while an earlier-started `run_tests` is still running is recovered without naming it.
- Remediation: `inFlightOperations: Record<invocationId, …>`; recovery marks every entry interrupted.
- Acceptance test: state test starting two operations then recovering reports both as interrupted.

### P5 Session lookup by substring and catch-all null hide which session is resumed and why a load failed
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Observed: `loadSession`/`recoverSession` fall back to the first session (most recent mtime) whose id *contains* the
  argument (session.ts:114, :141); `loadSession` converts every error — corrupt JSON, unsupported schema, workspace
  mismatch, redaction failure — into `null` (session.ts:126-128), i.e. "not found". The typed errors from
  `loadTaskState` (CorruptStateError, UnsupportedSchemaVersionError, …; state.ts:400-419) are lost at this boundary.
- Remediation: exact or unique-prefix match only (error listing candidates when ambiguous); return a typed result
  (`not_found | corrupt | unsupported_version | workspace_mismatch`) and print it.
- Acceptance test: two sessions `…_ab12` and `…_cd12`, `resume 12` -> ambiguity error; a session file with
  `schemaVersion: 2` -> "unsupported schema version 2" rather than "not found".

### P6 Cross-branch schema drift without a version bump; older builds drop new fields on save
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Affects: fix/context-convergence vs main / installed runtime
- Observed: fix/context-convergence adds `findings?: string[]` to DurableTaskState and SessionManager.saveSession
  (`git diff main fix/context-convergence -- cli/src/core/state.ts cli/src/session.ts`) with `schemaVersion` still 1.
  `saveSession` builds the record from an explicit field list (session.ts:70-98 on main), so a main/feat build that
  loads and re-saves a convergence-written session drops `findings` silently. The same branch removes
  `SessionManager.operationDiffPath` (and the sidecar's on-disk full-diff copies, sidecar.ts:567-580 on main), so the
  complete-diff audit artifact exists on main/feat but not on fix/context-convergence.
- Remediation: bump `schemaVersion` when adding durable fields, or preserve unknown top-level fields on save; decide
  explicitly whether full diffs are kept and carry that decision into the merge.
- Acceptance test: load+save a record with an unknown top-level field preserves it byte-for-byte in that field.

### Note on verifier staleness (requested check) — mostly solid
A verifier PASS is reused only if candidate identity (tracked + untracked non-ignored files), process epoch,
`mutationSeq` and an ignored-inputs fingerprint (PATH, lockfile markers, .env mtimes) all match
(objective.ts:410-432, agent.ts:1470-1490, 425-455); every mutating capability bumps `mutationSeq` and demotes
`verified` requirements (agent.ts:744-753). Gaps: `run_tests` is non-mutating (T11), so a test run that rewrites
snapshots does not invalidate; subagent edits do not demote already-verified requirements (T14); an attempt is recorded
PASSED from the filtered/injected command string (T11). Existing tests: cli/test/objective_continuation.test.ts covers
priorAttempt / SKIPPED_UNCHANGED_INPUTS.

---

## What is solid (with evidence)
- Process-group timeout cleanup: `process_group(0)` + killpg TERM -> 500 ms -> KILL (runner.rs:158, 226-246). Verified:
  a TERM-ignoring grandchild is gone after a 2 s timeout; PTY-mode timeout left no survivor.
- run_command output truncation keeps head and tail with an explicit `[TRUNCATED n BYTES]` marker (runner.rs:41-53),
  apart from the UTF-8 bug (T8). `timed_out` and `duration_ms` are reported; the bridge deadline is derived from the
  runner deadline + 5 s grace so the runner's structured result wins (tools.ts:104-120).
- cwd confinement for run_command (canonicalised, must be under the workspace; runner.rs:107-126) and descriptor-level
  confinement for file reads/writes including a symlink-race test (file_ops.rs:57-86, tests at :1107, :1239, :1291).
- patch_file is all-or-nothing in memory: any unmatched hunk returns before touching the file (file_ops.rs:1043-1047).
- Pre-flight syntax validation rejects JSON/brace-breaking writes and edits before writing (file_ops.rs:188-203, 568-584).
- Per-operation diffs (file_diff.ts) diff the operation's own before/after snapshot, not `git diff`, handle missing
  final newline like git (`NO_EOL` sentinel), cap large/binary files with an explicit note, and neutralise terminal
  control characters (`visibleControls`).
- Durable state: temp+rename, fail-closed load on corrupt JSON and future schema versions, legacy v0 migration,
  identity binding to task and workspace, interrupted in-flight operation detection on recovery, offline candidate
  mutation invalidates validation receipts — all covered by cli/test/state.test.ts (PERS-001..004, "Corrupt state and
  unsupported schema fail closed", "Restart idempotence", "SessionManager migration").
- Durable redaction keeps audit identifiers: probe through `redactForPersistence` left a 40-hex git SHA, a sha256, a
  UUID and a candidate id intact while redacting a base64 blob; long provider tool-call ids are mapped to stable
  `call_<sha256[:12]>` (persistence_protection.ts:28-31; probe: `call_ecf037f30284`) so call/result pairing survives.
- Export `nexus-session-export/2` states explicitly whether the history is complete or compacted and includes archived
  originals when present (session_export.ts:29-58).
- RPC daemon runs requests concurrently (`tokio::spawn` + `spawn_blocking`, main.rs:194-222) and converts a panicking
  tool into an error response instead of dying.

## Checks actually run
| Command / probe | Result |
|---|---|
| `git archive 3727938` -> tp/main; `cargo build --release` (RUSTUP_HOME/CARGO_HOME of the user, HOME temp) | built, exit 0 |
| `git diff --stat main feat/tui-surface` / `main fix/context-convergence` over the tool and persistence files | no tool-layer changes; convergence: state.ts +4/+9, session.ts -8/+1 |
| edit_file duplicate snippet (dup.txt) | replacements 2, only first replaced (T2) |
| edit_file CRLF file with LF snippet | all CRLF -> LF (T3) |
| edit_file stale snippet `check_permissions` vs `audit_log` | succeeded, deleted audit_log line (T1) |
| write_file new file | status "overwritten" (T3) |
| patch_file with existing run.tmp_patch, mode 755, symlink, CRLF | tmp clobbered, mode 664, symlink replaced, CRLF stripped (T4) |
| run_command 12000 x '€' | engine panic runner.rs:47 (T8) |
| rpc.py: run_command `timeout 3 cat > stolen.txt` + list_dir + write_file | write_file request found in stolen.txt, never answered, x.txt absent (T6) |
| run_command `(sleep 8; echo late) & echo early`, timeout 3 | wall 8.03 s, timed_out false (T7) |
| run_command TERM-ignoring grandchild, timeout 2; PTY variant | no survivors (solid) |
| run_command `setsid -f` child | survives (expected; noted) |
| run_command `env` with probe keys | keys printed (T10); egress probe: only sk- key tokenised |
| tsx probe_runtests.mts (filter injection) | INJECTED_BY_FILTER created, success true (T11) |
| tsx probe_dryrun.mts | `echo x > F` executed in dry-run (T13) |
| list_dir / file_tree outside workspace; outline_file contrast | listed outside; outline_file refused (T15) |
| search_code 80 matches; 200 KB line | total_matches 50 no flag; 200156-byte output (T16) |
| mock-gateway zz_probe_milestones.test.ts | duplicated milestones; state file mode 664 (P2, P3) |
| mock-gateway zz_probe_persistfail.test.ts | state unchanged, no warning (P1) |
| tsx probe_redact.mts | SHAs/UUIDs kept, base64 redacted, stable call id (solid) |

## Limitations
- Probes ran on main 3727938 only; branch applicability is by source diff (no tool-layer changes on either branch), not
  by re-running on each branch. The installed runtime was not exercised (read-only rule).
- Crash/power-loss atomicity (T3, P3) and concurrent-writer clobbering (P3) were assessed from source; no kill-mid-write
  or two-process race was executed.
- T14 (subagent approval bypass, stale verified status) and P4 were not reproduced through the agent loop.
- TUI banner vs authoritative state agreement, checkpoint.ts, mcp.ts, plugins.ts and evidence-ledger eviction were not
  reviewed in depth; T12's cancellation latency was not measured.
- No generic tool-output cap was found under the names searched (T16); a cap under a different name in context admission
  cannot be fully excluded.
- Probe files were added only inside the private extract (tp/main/cli/probe_*.mts, tp/main/cli/test/zz_probe_*.test.ts).
  The fixture's `repo()` created throwaway git repos under the system temp dir (`nexus-capacity-*`), which were not
  deleted. During T10 the reviewer's own shell environment leaked an unrelated real API key into probe output; it is
  redacted in this report and appears in no file written here.
