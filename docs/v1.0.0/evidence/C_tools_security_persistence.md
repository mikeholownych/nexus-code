# Scope C: Tools, security boundaries, persistence
Nexus Code v1.0.0 readiness audit, 2026-10-14. Snapshot `scratchpad/snap` @ db1ca55. harness-core = `snap/core/target/release/harness-core` (built from HEAD).

## 1. Coverage ledger
| File | Method |
|---|---|
| cli/src/tools.ts | full read |
| cli/src/security.ts, sandbox.ts, core/authority.ts | full read |
| cli/src/safe_fs.ts, core/durable_file.ts, core/persistence_protection.ts, session.ts | full read |
| cli/src/flight.ts | full read |
| cli/src/core/capabilities.ts | targeted (mutating/backend flags of every capability) |
| cli/src/core/state.ts (out of scope, persistence backbone) | targeted 278-460, 820-860 |
| cli/src/agent.ts (dispatch, approval) | targeted 643-660, 3880-4080 |
| cli/src/workspace_trust.ts | full read |
| cli/src/checkpoint.ts | targeted 20-70, 125-200 |
| cli/src/plugins.ts | targeted 240-300, grep for loaders |
| cli/src/skills.ts | targeted 20-60; consumers in agent.ts grepped |
| cli/src/mcp.ts | targeted 55-85 (env), 505-545 (trust); rest skimmed via grep |
| cli/src/git.ts, worktree.ts, evidence.ts, browser.ts, lsp.ts | grep for exec/spawn/write/mode only (skim) |
| cli/src/session_export.ts, file_diff.ts, syntax.ts, diagnostics.ts, core/resources.ts | grep only: no exec/fs-write/permission calls found; not reviewed further |
| core/src/main.rs, runner.rs | full read |
| core/src/file_ops.rs | full read of 1-400, 576-1100 (jail, write, edit, delete, batch, patch parse); 400-575 (delimiter validator) skipped |
| core/src/search.rs, trigram.rs, cst.rs, git_ops.rs | grep (walker flags, Command use, git2 use) + runtime probes |
| core/tests/*.rs | function list only (2 integration tests) |
| docs/ARCHITECTURE.md sec. 3 | full read |
| docs/SKILLS_AND_PLUGINS.md, MCP_GUIDE.md | grep (trust/discovery) |
| docs/PERS002_*, WP05_*, CRED003_* | grep for verdicts/claims; PHASE2S review not read (63KB). Excluded for budget. |

## 2. Architecture / data-flow notes
- Model tool call -> `agent.dispatchToolCall` (agent.ts:3880). Vault `restore()` puts real secrets back into args for non-egress tools (agent.ts:3899-3906). Flight recorder logs args. The **approval gate runs only when an `onConfirm` handler exists and the capability is `mutating`** (agent.ts:3946-3947). The handler auto-approves unless `--approve` / `/mode review` is set: repl.ts:69,281; index.ts:93,115; sidecar.ts:935.
- Non-mutating, so never prompted even in review mode: fetch_web, search_web, browser_navigate, browser_click, browser_screenshot, spawn_subagent, activate_skill, every read/search tool (capabilities.ts:514,576,772,824,1164,1215).
- `ExecutionSpine` hands off to the authority engine (authority.ts). With no grants it admits everything at "workspace" scope (authority.ts:264), then lexically confines path args (authority.ts:318-334). Then `RustCoreBridge.executeTool` (tools.ts:432) runs the TS checks: substring command denylist, name-pattern protected paths, read-only allowlist, and optional bwrap/docker wrap. Then JSON-RPC to `harness-core rpc`, which runs every request on a blocking thread with no concurrency limit (main.rs:194-203).
- Rust boundary: `resolve_safe_path` does lexical normalisation plus canonicalize of the target or nearest existing ancestor (file_ops.rs:731-791). Reads and writes recheck via `/proc/self/fd` (file_ops.rs:59-87). `run_command` is `bash -c <string>` with only a cwd jail (runner.rs:116-157). The shell itself is unconfined unless the sandbox is enabled.
- Trust boundaries:
  - Workspace MCP configs and plugin JS are gated by `~/.config/nexus/trusted_workspaces.json` (workspace_trust.ts:35).
  - Workspace **skills are not gated**. They are loaded from `./skills`, `./.nexus/skills` and `./.claude/skills` (skills.ts:31-33) and injected into the system prompt (agent.ts:3301).
  - `.nexus-security.json` is read from the untrusted workspace (security.ts:48). It can only add entries, except that `allowedDomains` narrows egress and `allowExternalSymlinks` is never consumed.
- Persistence:
  - Sessions and tasks: `~/.nexus/{sessions,tasks}/<id>.json` via `writeFileDurably`. This is a temp file + rename with mode 0600; fsync only inside `withDurableSync` (durable_file.ts:49-74).
  - Schema: `schemaVersion` = 1. Future versions fail closed. Legacy v0 is migrated on load (state.ts:425-431, 823-858).
  - Compaction archive: `.history.jsonl` lines appended with fsync.
  - Flight logs: `<workspace>/.nexus/flights/*.flightlog`, appendFileSync with default mode.
  - Checkpoints: `~/.nexus/checkpoints/<hash>/`, writeFileSync with default mode, plus git refs `refs/nexus/checkpoints/*`.
  - Audit: `~/.nexus/audit.log`. REPL history: `~/.nexus_history`.

## 3. Findings
| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| SEC-01 | S1 | every interactive/sidecar run | repl.ts:69,80,281; index.ts:93,115; sidecar.ts:935; tools.ts:755 | SOURCE. Default = autonomous: no approval for any tool, and no sandbox (`sandbox` is undefined unless `--sandbox`; config.ts:107). `run_command` executes arbitrary `bash -c` on the host as the user. The only guard is a substring denylist (SEC-02). | A prompt injection (file contents, fetched page, skill, MCP output) can run any host command without the operator seeing a prompt. The documented posture (ARCHITECTURE sec. 3) implies containment that does not exist by default. | BLOCKER for v1: either default to review mode for run_command/egress, or default to an enforced sandbox, and document the default plainly at startup. |
| SEC-02 | S2 | run_command | security.ts:12-23,78-89; runner.rs:64-107 | RUNTIME (Repro R2/R3). Both "dangerous command" filters are substring denylists. Bypassed by `rm -r -f /`, `rm -rf -- /`, `rm -rf "$HOME"`, `find / -delete`, `/bin/rm  -rf /`, `python3 -c shutil.rmtree`. They also produce false positives: `rm -rf ./build`, `rm -rf /tmp/x`, `chown -R me /srv` (Rust); `grep -rn reboot src`, `echo shutdown` (TS). | Gives false assurance and blocks legitimate build cleanup. ARCHITECTURE sec. 3 item 2 presents it as a boundary. | RELEASE-REQUIRED: re-label it as a convenience tripwire in docs and UI, fix the `-rf .` / `-rf /` prefix false positives, and rely on approval/sandbox for safety. |
| SEC-03 | S2 | fetch_web (unapproved even in review mode) | tools.ts:52-111, 653-658 | RUNTIME (Repro R4). The SSRF guard is a hostname-string check with no DNS resolution and no redirect control (`fetch` follows redirects). `http://localtest.me:18731/` and `http://[::ffff:127.0.0.1]:18731/` both fetched a loopback-only server. Also not blocked: fd00::/8, fe80::/10, 100.64/10. The response body is read fully before truncation (tools.ts:662). | The model can reach loopback and LAN services (homelab gateway, admin UIs) and exfiltrate data in the URL query. There is no approval prompt, because fetch_web is non-mutating. | RELEASE-REQUIRED: resolve and pin the IP, check every redirect hop (`redirect: "manual"`), block all of v4/v6 private, ULA, link-local and mapped ranges, and cap the body size. Consider requiring approval for egress in review mode. |
| SEC-04 | S2 | read-only mode | authority.ts:44-136; tools.ts:485-495, 755-779 | RUNTIME (Repro R2). `isSafeReadOnlyCommand` allows `cat ~/.ssh/id_rsa`, `cat /etc/passwd`, `tail -f /dev/null`. The allowlist does not confine paths. The sandbox runs `--ro-bind / /` with the network unshared, so host secrets are readable and returned to the (possibly cloud) model. | `--read-only` reads like "safe to point at an untrusted repo", but it still discloses home-directory secrets. | RELEASE-REQUIRED: in read-only/sandbox mode, mask `$HOME` (tmpfs over home, then ro-bind the workspace only), or path-confine the allowlisted commands. |
| SEC-05 | S2 | untrusted repo opened | skills.ts:31-33; agent.ts:3301,3789 | SOURCE. Workspace skills (SKILL.md) are loaded and advertised in the system prompt with no workspace-trust check, unlike MCP and plugins (workspace_trust.ts:5-24). `activate_skill` is non-mutating, so it is never approved. | Persistent prompt injection from a cloned repo. Combined with SEC-01 this gives command execution. | RELEASE-REQUIRED: gate workspace skill directories on workspace trust, or show them as untrusted and require approval to activate. |
| SEC-06 | S3 | protected paths | security.ts:25-32, 91-108; tools.ts:446-469 | RUNTIME (Repro R2). The name-pattern check misses `.env.local`, `.env.production`, `secrets/.npmrc`, and `.GIT/config` (case-insensitive FS). A symlink to `.env` inside the workspace is not checked. `run_command cat .env` is not checked. `notes.env` is over-blocked. | Protection of `.env`-style secrets is advisory only. | POST-V1 hardening. Document it as advisory. Match `.env*` and canonical target names. |
| SEC-07 | S2 | cancel / exit / timeout | tools.ts:247-256, 338-347; runner.rs:164-167, 218-223 | RUNTIME (Repro R5). Each command runs in its own process group. When the bridge kills the RPC daemon (shutdown/exit), running commands are orphaned (`sleep` survived with ppid 1). A bridge-side timeout or turn abort sends nothing to the runner. Background jobs (`server &`) are deliberately left running after the call. The model chooses `timeout_secs` with no upper bound. | Stray processes after Ctrl-C or exit: dev servers, test runners, possibly a prompt-injected long-running job. | RELEASE-REQUIRED: track pgids in the runner, killpg them on daemon shutdown/stdin EOF and on a cancel RPC, wire AbortSignal into the bridge, and cap `timeout_secs`. |
| SEC-08 | S3 | run_command / read_file output | runner.rs:177-193, 40; file_ops.rs:205-277 | MEASUREMENT (Repro R6). Output is buffered without bound before the 32k truncation: 400 MB of stdout reached 785 MB RSS. read_file has no size cap: a 200 MB file gave 590 MB RSS and the whole content was returned over RPC. The PTY path also kills only the child, not the group (runner.rs:319-323). | A runaway command or large file can OOM the core and stall the TUI. | RELEASE-REQUIRED: keep a ring buffer bounded at the head/tail limits, cap the read_file byte budget, and use killpg on PTY timeout. |
| SEC-09 | S3 | plugins | plugins.ts:254-300 | SOURCE. `executeSandboxed` ("Execute untrusted ... plugin code inside an isolated Worker") uses eval in a worker_thread. That is not an isolation boundary (full Node API). It is unused: grep found no callers. | A misleading security claim in code. A future caller would trust it. | POST-V1: delete it or rename it. |
| SEC-10 | S3 | sandbox | sandbox.ts:131-158, 181 | SOURCE. The bwrap command line is built by `join(" ")` and then re-parsed by a shell. Workspace paths with spaces or quotes break it (unquoted `absWorkspace`). The Docker sandbox uses `alpine:latest` (unpinned, networked by default). The bwrap sandbox shares the network unless read-only. | Sandbox fails or misbehaves on paths with spaces. Isolation is filesystem-only. | RELEASE-REQUIRED (quote args / use an argv array), and document network exposure. |
| SEC-11 | S4 | git tools | git_ops.rs (git2) | SOURCE. git_status/diff/log use libgit2, with no shell and no external diff/fsmonitor drivers. Good. `checkpoint.ts:142-145` interpolates an internally generated id into a shell string (safe today). | none | Note |
| PER-01 | S2 | persistence permissions | checkpoint.ts:31,47,61,183; flight.ts:57,101; persistence_protection.ts:131-147; session.ts:41; state.ts:290 | RUNTIME (operator's real `~/.nexus`). Checkpoint and flight dirs/files, `audit.log`, `~/.nexus_history` and knowledge are created with default umask modes. Measured: `~/.nexus` 775, `checkpoints/` 775 with 1604 files o+r (fallback snapshots copy workspace file contents), `audit.log` 664, `~/.nexus_history` 664, 1233 of 1277 session JSONs 664 (inside a 700 dir). Only `writeFileDurably` uses 0600. | On multi-user hosts, other local users can read prompts, history, audit and checkpoint copies of code. | RELEASE-REQUIRED: create ~/.nexus with 0700 and every file with 0600. Have `doctor --fix` tighten existing files. |
| PER-02 | S2 | retention | state.ts (no pruning); ~/.nexus | MEASUREMENT. No retention or rotation anywhere: `tasks/` 52,687 files / 916 MB, `sessions/` 1332 files / 66 MB, `checkpoints/` 8104 dirs, `audit.log` 27 MB (doc: "permanently recorded"), git refs `refs/nexus/checkpoints/*` never pruned. | Unbounded disk growth. listSessions reads and parses every file on each call (session.ts:211-239), so it slows down. | RELEASE-REQUIRED: retention policy plus `nexus gc`, audit rotation, and an index for listing. |
| PER-03 | S2 | test hygiene / persistence | state.ts:278-288; cli tests | RUNTIME. 52,660 `task-*.json` in the operator's real `~/.nexus/tasks` with `workspacePath` like `/tmp/nexus-app-test-*/repo`. The test suite writes to the real HOME through `defaultTaskStateDir()`. | Test runs pollute and grow user state, and could clobber it. | RELEASE-REQUIRED: tests set HOME / baseDir to a tmpdir. Add a guard test that asserts nothing is written under the real home. |
| PER-04 | S3 | crash durability | durable_file.ts:49-62; file_ops.rs:101-188 | SOURCE. Routine saves outside `withDurableSync` skip fsync (documented trade-off). The Rust atomic write fsyncs the file but never fsyncs the parent dir after rename. Checkpoint metadata, flight logs and `writeProtectedTextFile` have no fsync. | After power loss, a recent edit or checkpoint can be lost. A torn file is not possible (rename). | POST-V1, except add a dir fsync in Rust (cheap). |
| PER-05 | S3 | resume / corruption | session.ts:113-130, 211-239 | SOURCE. A corrupt or unsupported session makes `loadSession` return null ("not found"), and listing silently skips it. Partial-id resume uses `includes` and can pick the wrong session. There is no quarantine or `.bak`. | The user is not told that a session is corrupt or comes from a newer schema. | RELEASE-REQUIRED: surface CorruptStateError/UnsupportedSchemaVersionError, and use an exact or prefix-unique id match. |
| PER-06 | S3 | flight logs in repo | flight.ts:55-59; worktree.ts:84 | SOURCE. Flight logs are written inside the workspace (`.nexus/flights`). They are added to `.git/info/exclude` only when a worktree is created. Otherwise they can be committed, and they include prompts and 1000-char output snippets (redacted by classifier only). | Accidental commit of session telemetry. | RELEASE-REQUIRED: always add the exclude, or store under ~/.nexus. |
| DOC-01 | S3 | docs accuracy | docs/ARCHITECTURE.md:55-58 | DOC-CLAIM vs RUNTIME. "requests targeting /etc/shadow, ~/.ssh are rejected" is true only for file tools (`run_command cat ~/.ssh/...` runs, and is allowed even in read-only). The "Dangerous Command Filter" is presented as prevention. Audit "permanently recorded" has no rotation. WP05 DISC-003 "never contain unredacted secrets" rests on a pattern classifier: non-pattern data in a fetch_web URL is not covered (INFERENCE). | Overstated guarantees. | RELEASE-REQUIRED doc correction. |

## 4. Reproductions
Workspace: `scratchpad/repro/ws` containing `linkdir -> ../outside`, `linkfile -> ../outside/x.txt`, `.env`, `.env.local`.

R1. Path jail holds for file tools (strength):
```
harness-core --workspace ws call --tool read_file --args '{"path":"../outside/x.txt"}'   -> Security Violation: Symlink/path escapes workspace jail
  same for absolute path, linkfile, linkdir/x.txt, sub/../../outside/x.txt; write_file linkdir/new.txt and linkdir/deep/new.txt -> Parent directory symlink escapes; delete_file linkfile, list_dir linkdir -> rejected
run_command '{"command":"cat ../outside/x.txt"}' -> stdout "SECRET-OUTSIDE"  (shell is unconfined)
```
R2. TS classifiers (`node probes/p1.mjs` importing snap/cli/dist; nothing executed):
```
isPathProtected: .env true | .env.local false | .env.production false | .GIT/config false | secrets/.npmrc false | notes.env true
isCommandBlocked: "rm -r -f /" false | "rm -rf -- /" false | 'rm -rf "$HOME"' false | "find / -delete" false | "grep -rn reboot src" TRUE | "echo shutdown is a word" TRUE
isSafeOutboundUrl: [::ffff:127.0.0.1] safe | [::ffff:7f00:1] safe | [fd00::1] safe | [fe80::1] safe | 100.64.0.1 safe | localtest.me safe
isSafeReadOnlyCommand: "cat ~/.ssh/id_rsa" true | "cat /etc/passwd" true | "tail -f /dev/null" true
```
R3. Rust guard (only `echo` is executed):
```
echo rm -r -f /       -> runs (prints)        echo rm -rf "$HOME" -> runs (prints rm -rf /home/mike)
echo find / -delete   -> runs                 echo rm -rf ./build -> "Dangerous command blocked ... (rm -rf)"
echo rm -rf /tmp/x    -> blocked              echo chown -R me /srv -> blocked
```
R4. SSRF: `python3 -I -m http.server 18731 --bind 127.0.0.1` serving "LOOPBACK-ONLY-CONTENT". `RustCoreBridge.executeTool("fetch_web", ...)`:
```
http://localtest.me:18731/          {"success":true,"output":"LOOPBACK-ONLY-CONTENT"}   (getent: localtest.me -> ::1)
http://[::ffff:127.0.0.1]:18731/    {"success":true,"output":"LOOPBACK-ONLY-CONTENT"}
```
The server was stopped by its PID afterwards.

R5. Orphaned child: start `harness-core rpc`, send `{"method":"run_command","params":{"command":"sleep 41.789","timeout_secs":120}}`, then `kill -TERM <rpc pid>`:
```
ps: 2707485 pgid=2707485 ppid=1 sleep 41.789   (survived; then killed by PID)
```
R6. Memory:
```
run_command 'head -c 400000000 /dev/zero | tr "\0" a'  -> maxrss_kb=785664 (baseline echo: 4608)
read_file on 200 MB single-line file                   -> maxrss_kb=590464, full content returned
```
R7. State on the operator's real home (read-only stat/find):
```
~/.nexus 775; audit.log 664 27M; checkpoints 775, 1604 files o+r, 8104 dirs; tasks 52,687 files 916M (52,660 task-*, workspacePath /tmp/nexus-app-test-*/repo); sessions 1233x664 + 44x600; ~/.nexus_history 664; ~/.config/nexus 775 (config.env 600, mcp.json 664)
```

## 5. Strengths (with evidence)
- The Rust file-tool jail is sound against `..`, absolute paths, symlinked files and dirs, and symlinked parents of new files (R1). There is a descriptor-level recheck via `/proc/self/fd` after open (file_ops.rs:59-87). Atomic temp+rename writes keep permissions, refuse read-only files, and write hard-linked files in place (file_ops.rs:101-188).
- `delete_file` refuses the workspace root and `.git` on both the canonical and lexical path (file_ops.rs:705-716). TS pre-check: tools.ts:43-50.
- Commands run in their own process group, and timeout uses killpg TERM then KILL (runner.rs:164-167, 245-264). There is a test for descendants (runner.rs:479-500).
- No shell is used for git (git2) or for worktree ops (execFileSync argv). MCP children get an env allowlist (mcp.ts:56-77). Workspace MCP and plugins require explicit trust, and never get it in read-only mode (workspace_trust.ts:35-53, mcp.ts:509-531).
- Session state: schema version with fail-closed on future versions, legacy migration, identity and workspace binding on load, redaction before persist, and a fsync'd append-only compaction archive with a commit protocol (state.ts:338-460; durable_file.ts). The trust store is written atomically with 0600/0700 (workspace_trust.ts:71-76).
- `safe_fs.ts` (doctor --fix) is a careful O_NOFOLLOW + fd-verified mutation design.
- The read-only sandbox probe exercises the real mount boundary instead of trusting that bwrap is present (sandbox.ts:55-73).

## 6. Qualification gaps
- **Egress classifier coverage (WP05 DISC-003).** Not tested against non-pattern secrets in URLs, browser_type or search_web. Procedure: call `fetch_web` with `?d=<base64 of a fixture file>` against a local capture server, after adding the host to an allowlist or using a public test sink. Assert that it is blocked or that approval is required.
- **TOCTOU in `resolve_safe_path` -> rename** (file_ops.rs:156-182) under a concurrent symlink swap by a background process. Not raced. Procedure: run a loop swapping `ws/d` between a dir and a symlink to outside while calling write_file `d/f` 10k times. Assert that no file appears outside.
- **macOS / case-insensitive FS.** `.GIT` and `.ENV` handling, and the non-Linux branch of `verify_descriptor_confinement`, which is a no-op (file_ops.rs:81-85). Requires a macOS CI run of `core/tests` plus new case tests.
- **Concurrency.** Unbounded `tokio::spawn` + `spawn_blocking` per RPC line (main.rs:194-203), with parallel writes to the same file. Not exercised. Procedure: fire 200 concurrent edit_file calls on one file and assert the final content is one of the serial outcomes.
- **PTY path** (`pty:true`) process-group cleanup: not tested.
- **browser.ts / lsp.ts / mcp.ts** remote transports: only skimmed. Remote MCP egress and LSP server spawn (lsp.ts:49, a server command chosen by config) need a dedicated review.
- **PHASE2S_SECURITY_AND_DATA_REVIEW.md** was not read (budget). Cross-check its open items against SEC-01..10.

## 7. Proposed v1.0.0 requirements
| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| R-SEC-1 | By default, run_command and network egress need approval OR run in an enforced sandbox. The startup banner states the mode. | safety | BLOCKER | A fresh `nexus repl` with no flags gets a prompt/denial for run_command `echo x > /tmp/y` and for fetch_web. |
| R-SEC-2 | Docs and UI describe the command filter as a non-boundary. Fix the false positives for `rm -rf ./x` and `rm -rf /tmp/x`. | workflow/safety | RELEASE-REQUIRED | Unit tests for both lists cover R3 bypass and false-positive cases with documented expectations. |
| R-SEC-3 | fetch_web resolves DNS and rejects private, loopback, link-local, ULA, CGNAT and v4-mapped addresses on every redirect hop. Body capped (e.g. 5 MB). | safety | RELEASE-REQUIRED | R4 URLs plus a 302 to 127.0.0.1 all fail. A 50 MB body is truncated without RSS above 100 MB. |
| R-SEC-4 | Read-only mode does not expose `$HOME` secrets (`~/.ssh`, `~/.config/nexus/config.env`). | safety | RELEASE-REQUIRED | `--read-only` run_command `cat ~/.ssh/id_rsa` (fixture HOME) fails. |
| R-SEC-5 | Workspace skills are subject to workspace trust. | safety | RELEASE-REQUIRED | An untrusted fixture repo with `skills/x/SKILL.md` does not appear in the system prompt or `/skills` without trust. |
| R-SEC-6 | No orphaned processes after cancel, exit or daemon shutdown. `timeout_secs` capped. | failure | RELEASE-REQUIRED | R5 leaves zero survivors. Abort mid-`sleep 30` kills it within 2 s. |
| R-SEC-7 | Bounded memory for command output and file reads. | failure | RELEASE-REQUIRED | R6 commands stay under 64 MB RSS. |
| R-SEC-8 | Sandbox command built with correct quoting. | compat | RELEASE-REQUIRED | A workspace path with spaces and a `'` runs sandboxed `pwd` correctly. |
| R-PER-1 | `~/.nexus` 0700. All persisted files (sessions, tasks, checkpoints, audit, history, flights, knowledge) 0600. `doctor --fix` repairs existing ones. | safety | RELEASE-REQUIRED | Under umask 002, a run then `find ~/.nexus ~/.nexus_history -perm /077` is empty. |
| R-PER-2 | Retention and GC for tasks, sessions, checkpoints (incl. git refs) and audit rotation, with a configurable cap. | failure | RELEASE-REQUIRED | Seed 10k records. `nexus gc` (or automatic) brings them under the cap. Listing 1k sessions takes under 500 ms. |
| R-PER-3 | The test suite never writes to the real HOME. | workflow | RELEASE-REQUIRED | Run `npm test` with HOME pointing to a read-only dir and confirm it passes, or diff ~/.nexus before and after. |
| R-PER-4 | Corrupt and future-schema sessions are reported, not shown as "not found". Resume id matching is unambiguous. | failure/compat | RELEASE-REQUIRED | Truncated JSON gives an explicit corrupt message. A schemaVersion 2 file gives an "upgrade Nexus" message. An ambiguous prefix is refused. |
| R-PER-5 | Flight logs are never committable by default. | safety | RELEASE-REQUIRED | Fresh git repo, one turn: `git status --porcelain` shows no `.nexus/`. |
| R-PER-6 | Rust atomic write fsyncs the parent dir. | failure | POST-V1 | Code review plus strace shows fsync on the dir fd. |

## 8. Commands run
- `cat -n`/`sed -n` reads of the files in the ledger; `/usr/bin/grep -n` scans (listed by region in sec. 1).
- `harness-core --workspace repro/ws call --tool {read_file,write_file,delete_file,list_dir,search_code,find_files,file_tree,trigram_search,run_command}` with traversal and symlink payloads (R1, R3).
- `node probes/p1.mjs` (classifier-only, R2). `node probes/p2.mjs` + local `python3 -I -m http.server 18731 --bind 127.0.0.1` (R4, killed by PID).
- RPC orphan test via FIFO + `kill -TERM <pid>`; the orphan was killed by PID (R5).
- `/usr/bin/time -f %M harness-core ...` (R6).
- `stat`/`find`/`du` on `~/.nexus`, `~/.config/nexus`, `~/.nexus_history` (R7, read-only, no contents printed except one task title/workspacePath).
