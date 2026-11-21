# CS-10 design note: isolating the RPC worker (`harness-core`)

Status: **design, written before the code. What was built since is in section 10.** No code in the change that added this note. The backlog row (`docs/v1.2.1/PLAN.md`, CS-10) asks for the design to
merge first, then tests that a compromised worker cannot reach anything outside its allowed paths. Decisions the owner must
make are in section 7; the recommended answers are marked.

Evidence tags: **READ** = read in the source at `origin/main` `19e306e9` (2026-11-21); **INFERRED** = reasoning from what was
read, not run; **UNKNOWN** = not established here. Nothing in this note was executed against a sandboxed worker.

## 1. The problem

The CLI starts one long-lived native worker, `harness-core --workspace <dir> rpc`, and sends it JSON-RPC requests over
stdin/stdout for every file, search, git and command tool. The worker is the process that opens, parses and writes workspace
content. If a bug in it is reachable from workspace content (a crafted file for the symbol parser, the trigram index, `git2`
reading a hostile repository, the patch applier), the attacker gets everything the **operator** can do, not just the
workspace.

"Compromised worker" is also the right model for a plainer reason: the worker can run any shell command (`run_command`), so
today its confinement is exactly the confinement of that command, which is none unless the operator passed `--sandbox`.

## 2. What exists today (READ)

| Fact | Where |
|---|---|
| The worker is spawned with `cwd` = the workspace, `stdio` pipes, and the scrubbed environment from `buildCommandEnvironment()` (credentials removed). It is **not** run under any sandbox. | `cli/src/tools.ts` (`spawn(command, ["--workspace", ws, "rpc"], …)`) |
| RPC surface: `read_file write_file edit_file patch_file delete_file list_dir file_info batch_read file_tree find_files search_code search_symbols cst_symbols outline_file trigram_search git_status git_diff git_log run_command cancel end_background list_services hello`. | `core/src/main.rs` |
| `run_command` executes inside the worker (`Command::new(shell)` in `runner.rs`), with a registry that tracks process groups and kills them on cancel and on parent death. | `core/src/runner.rs` |
| With `--sandbox`, the **CLI** rewrites `args.command` (and `args.argv`) into a `bwrap` (or Docker) invocation before sending it, so the *command* is confined while the worker that launches it is not. | `cli/src/tools.ts` ~1620–1650, `cli/src/sandbox.ts` `wrapSandboxedCommand` |
| Read-only mode does not use the worker for shell commands at all: the CLI spawns `bwrap` itself against a pinned workspace descriptor (`runReadOnlySandbox`). | `cli/src/tools.ts` ~1580–1615 |
| Path confinement for file tools is application code in the worker (`resolve_safe_path`, "path traversal prevention"). It is a check inside the process it protects against. | `docs/ARCHITECTURE.md` §1 (not re-read in Rust here) |
| Containment is **opt-in** (owner decision D1, 2026-11-17): the default stays off; `nexus doctor` reports the effective containment. | `docs/v1.2.1/PLAN.md` CS-1 |
| The sandbox profile: synthetic read-only root, workspace bind, home masked, `--unshare-pid`, network off unless `NEXUS_SANDBOX_NETWORK` or `--sandbox-network`. | `cli/src/sandbox.ts` |

## 3. Threat model for this unit

In scope: a compromised or exploited worker, and a model-issued command running inside it. The attacker controls workspace
content and the model's tool arguments; they do not control the CLI process or the operator's terminal.

Goal: the worker (and everything it spawns) cannot read the operator's secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.config/nexus`), cannot write outside the workspace (and its temp area), and cannot use the network unless the operator
allowed it.

Out of scope here: kernel and bubblewrap vulnerabilities, a compromised CLI, the model provider, side channels, Windows and
macOS (the release target is Linux x86_64, decision D6).

## 4. Options

| | Idea | Gains | Costs and risks |
|---|---|---|---|
| **A. Run the whole worker under the existing bwrap profile** | Spawn `bwrap … harness-core --workspace <ws> rpc` using the same argv builder as `wrapSandboxedCommand`. One containment model for the worker and every command it launches. | Same kernel mechanism and profile operators already know; a worker exploit lands in the same box as a sandboxed command; no new dependency. | Commands inside the worker are already in the box, so the per-command wrap must be skipped (nesting bwrap needs user namespaces inside a user namespace, which some hosts and the eval harness disable: **UNKNOWN** on CI runners). The worker needs the runtime it uses (`git2` is linked, but commands need `git`, `node`, `python`) mounted read-only. If the worker's sandbox allows network (for `npm install`), a compromised worker has it too. |
| **B. Two workers** | A confined "files" worker (read, search, parse, git, patch) with no network and a narrow mount set, and the existing command path left as is. | Strongest for the parsing attack surface: the part that touches hostile bytes never needs a shell or the network. | Two processes to supervise, version-handshake and fault-handle; the RPC split is a larger change; commands remain a separate containment story. |
| **C. Self-confinement in the worker (Landlock + seccomp)** | The worker restricts itself at startup. | No external binary; fine-grained. | Landlock and seccomp are inherited by the commands it spawns, so `run_command` would lose network and paths unless it re-execs through a helper; new Rust dependencies; the Landlock ABI varies by kernel (**UNKNOWN** on the supported floor). |
| **D. Status quo plus guidance** | Document that `--sandbox` confines commands only. | Free. | Leaves the worker unconfined; fails the row's acceptance. |

## 5. Recommendation

**A, in two phases, opt-in like CS-1 (D1), with B recorded as the stronger follow-up.**

Phase 1: `--sandbox` (and `--sandbox-worker` for the worker alone) spawns the worker through the bwrap profile.
- Mounts: workspace read-write (read-only in read-only mode, where the worker does no writes), runtime read-only, a tmpfs
  home and `/tmp`, `--unshare-pid --unshare-net --die-with-parent --new-session`, environment already scrubbed.
- The per-command bwrap wrap is **skipped when the worker is itself sandboxed**, and the command's network allowance
  becomes the worker's: `NEXUS_SANDBOX_NETWORK` decides whether the whole worker has a network, stated plainly in `doctor`.
- If the sandbox cannot be set up, the worker is **not started unsandboxed silently**: the session fails closed with the same
  "filesystem-isolated execution is unavailable" error as today, unless the operator did not ask for containment.

Phase 2 (separate row, only if phase 1 proves out): split a no-network, no-shell files worker (option B).

Why not C first: it silently changes what `run_command` can do and adds a per-kernel capability matrix we cannot test
across the support floor yet.

## 6. Acceptance tests (what "a compromised worker cannot reach outside its allowed paths" means, testably)

Because the worker can run commands, a test can **act as the compromised worker** through the real RPC, with no exploit:

1. With the worker sandboxed, `run_command` `cat <canary outside the workspace>` fails; the canary is in a path under the real home
   that the sandbox masks. The same command succeeds with the sandbox off (the test must prove it is not vacuous).
2. `run_command` writing `<outside>/x` fails and the file does not exist afterwards; writing inside the workspace succeeds.
3. `run_command` reading `~/.config/nexus/config.env` and `~/.ssh/*` finds nothing (masked), including via `/proc/self/environ`
   and `/proc/1/…`.
4. With network off, a connect to a local listener the test opened fails; with `--sandbox-network` it succeeds.
5. Killing the CLI kills the worker and its children (`--die-with-parent`): no orphan survives.
6. Fail closed: with `bwrap` forced unavailable (path override), `--sandbox` produces the refusal, not an unsandboxed worker.
7. The existing worker RPC suite (`harness`, `fault_kill_mid_tool_call`, `operation_*` that use the core) passes with the
   worker sandboxed, so confinement does not break the tool surface.

Tests that need `bwrap` and user namespaces skip with a recorded reason where the host lacks them (as the other sandbox tests
do), and a non-required CI job runs them where bubblewrap is installed (the hosted `ubuntu` image is set up by
`scripts/ensure-ci-bubblewrap.sh`).

## 7. Decisions needed from the owner

1. **Option.** Go with A then B (recommended), B directly, or C. (A reuses the profile you already trust; B is the stronger
   endpoint.)
2. **Default.** Keep opt-in (D1, recommended) or make a sandboxed worker the default when `bwrap` is available. The default
   flip is a release-notes-level change and needs `doctor` to explain it.
3. **Network inside a sandboxed worker.** One switch for worker and commands (recommended for phase 1, simple to explain) or
   a separate allowance for commands.
4. **Scope of the v1.2.2 gate.** Is phase 1 required for the release, or is the design note plus phase 1 behind an
   experimental flag enough? (The row is sized M, P2.)

## 8. Open questions (UNKNOWN until tried)

- Does nested user-namespace setup work on the hosted runner and on the owner's host with the worker inside the box? A
  five-line spike (`bwrap … harness-core hello`) answers it; it was not run for this note.
- Which runtime directories the worker needs read-only beyond those `wrapSandboxedCommand` already mounts (for example the
  packaged core directory, certificates, locale data).
- Whether any test or tool relies on the worker seeing the real home (for example credential-store reads happen in the CLI,
  not the worker, per `command_env.ts`; the worker is believed not to need them).
- Startup cost: one extra `bwrap` exec per worker start (INFERRED as small; unmeasured).

## 9. Not changed by this note

No code, no default, and no existing control. `--sandbox`, read-only mode and the per-command confinement behave as before.

## 10. What was built after this note (2026-11-21)

The owner chose option A, opt-in, required for v1.2.2 (phase 1, PR #664), and then made Docker and phase 2 part of the
v1.2.2 gate. State of the code:

| Piece | Behaviour | Tests |
|---|---|---|
| Phase 1, Bubblewrap | `--sandbox bwrap` (and `--sandbox` where Bubblewrap exists) runs the worker in the profile; fails closed. | `cli/test/worker_isolation.test.ts` |
| Docker | On Linux, `--sandbox docker` runs the worker as the long-lived process of one hardened container (`docker run --interactive --init`, same profile as a sandboxed command). The host-built worker is mounted read-only at `/nexus-worker` with its ELF interpreter and the libraries `ldd` reports, and started through that interpreter (`ld.so --library-path /nexus-worker`), so the image (Alpine/musl by default) is not modified and its own programs are unaffected. Commands run inside the container with the image's `sh`. Fails closed. The container carries the label `io.nexus-code.worker-of=<cli pid>`. | same file, "the worker inside a Docker container" |
| Phase 2, files worker (option B) | With a sandboxed worker, every method except `run_command`, `cancel`, `end_background` and `list_services` goes to a second worker started with `--files-only`. The core refuses those four methods in that mode (`core/src/main.rs`) and says so in `hello`; the CLI refuses a files worker whose `hello` does not. Its sandbox is built with the network off regardless of `--sandbox-network`. The command worker starts on the first command. | `core/tests/files_only_worker.rs`; same TypeScript file, "CS-10 phase 2" |

Answers to the open questions in section 8: nested user namespaces work with the worker in the Bubblewrap box on the
owner's host and on the hosted runner (phase 1 CI). The worker needs no runtime directory beyond its own (Bubblewrap) or
its loader and four libraries (Docker). No test relied on the worker seeing the real home.

Limits, stated plainly:

- The files worker's refusal of commands is a check inside the process (as path confinement is). What holds if that
  process is compromised is its sandbox: no network, no path outside the workspace. It can still execute programs present
  in its sandbox; it cannot be made to by a request.
- The two workers share the workspace. A compromised files worker can write files the command worker later runs. Phase 2
  narrows the network exposure of the parsing surface; it does not separate the workers' authority over the workspace.
- Docker on a non-Linux host confines commands only (the worker is not a Linux binary there); `nexus doctor` says so.
- With a containerised worker, commands in a session share one container (and its `/tmp`), where each used to get a new one.
- Option C (Landlock and seccomp in the worker) is not built.
