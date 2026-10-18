# Evaluation harness (qualification assessment §9)

`run.mjs` runs tasks against one agent configuration and appends a JSON line per run; `score.mjs` reports the scores
separately (never combined), per task and configuration, with 95 % Wilson intervals.

`docs/v1.0.0/READINESS.md` is a historical checkpoint at source revision `6151a23`; use this file and the current
runner source for evaluator behavior added after that revision. Neither document represents completed M5 qualification.

```bash
node eval/run.mjs --config eval/configs/gateway-engineering-deep.json --out eval/out/<label> [--only id,id] [--runs N]
node eval/score.mjs eval/out/<label>/results.jsonl          # markdown table; --json for machine output
node eval/score.mjs --pairs "$NEXUS_RESULTS" "$GOOSE_RESULTS" "$OPENCODE_RESULTS"
```

Each run uses a frozen copy of the task tree, a fresh workspace and `HOME`, and a unique output directory. The agent
receives only its workspace, isolated home, selected read-only runtime files, and a run-scoped token for a local proxy;
the real gateway credential stays in the harness process. The candidate runs in Bubblewrap user, PID and network
namespaces, with nested user namespaces disabled. Legacy development tasks may still use `hidden: { dir, into, command }`;
those commands execute against the candidate workspace after the agent exits and are **not safe for qualification**, because
validator code can inspect or modify files in that workspace. Qualification requires `hidden: { protocol: "blackbox-v1",
casesFile, runtime, argv, timeoutMs, totalTimeoutMs, maxOutputBytes }`. Its private JSON cases contain only `input` and
`expected`; the host evaluator keeps expected values in its process and launches the candidate runtime separately for each
input using a fresh top-level Bubblewrap boundary. The candidate receives one input on stdin and returns one JSON value on
stdout. Its workspace is read-only; private oracle files are not mounted. Candidate output and diagnostics are discarded,
and result logs contain only case counts and failed indexes. Supported runtimes are explicitly allowlisted (`node`,
`python3`); the only argument is a validated relative candidate entrypoint (no runtime flags, eval expressions, or extra
arguments), and per-case/aggregate time and output bounds are enforced. Oracle files must be outside the copied fixture.
Absolute paths, traversal, symlinks and unsupported fixture entries are rejected. `manifest.json` records the harness source-file hashes, model fingerprint, corpus/task
hashes when qualification is configured, executable version, budgets, host and Node version. Each result records the
executable version and effective step/minute budget; per-run logs go to `logs/<task>-<run>/`. The runner refuses an
existing output directory so a retry cannot append to or replace prior evidence.

Qualification runs require `nexusExecutable` to name the absolute path of the installed RC,
`expectedAgentVersion` to pin its version, and `nexusPackageSha256` to record the expected release-asset digest from checksum verification. The runner checks `nexus --version` and refuses the checkout
`cli/dist/index.js` or a version mismatch before starting an agent. Peer versions are read using each adapter's
`--version` command inside the same Bubblewrap filesystem/network boundary, with a cleared environment and bounded
output/time; executable paths and SHA-256 hashes are archived alongside the RC package
digest. `score.mjs --pairs` takes exactly the Nexus,
Goose and OpenCode result files and refuses mismatched model fingerprints, sampling declarations, context/output
limits, explicit per-task request and aggregate requested-output ceilings, run pairs, executable identities, or
effective step/minute budgets. The proxy permits only model-catalog and inference routes, strips client-supplied
authorization and control-plane headers, and enforces configured request/body/output ceilings. These are requested
completion-token ceilings, not exact usage accounting. It reports peer hidden-test results
separately; scores are never combined. The Nexus adapter passes the recorded temperature and step/minute limits;
OpenCode receives a primary evaluation agent with the recorded step limit, temperature and seed; Goose receives the
matching `--max-turns`, context/output limits and temperature settings. Qualification mode currently requires
`sampling.temperature` to be `0` across all three adapters; seed metadata remains recorded when configured.

## Task format (`eval/tasks/<id>/task.json`)

| Field | Meaning |
|---|---|
| `id`, `tier` | T1 smoke (scripted model, CI), T2 standard, T3 long-task, T4 fault-injected |
| `fixture` or `repo` | a directory in the task, or `{ "url", "commit" }` (external repositories at pinned commits) |
| `setup` | shell commands run in the workspace before the agent (e.g. `npm ci`) |
| `objective` | the operator text given to the agent |
| `steps`, `minutes` | budgets (defaults from the configuration: 300 steps, 120 min) |
| `hidden` | `{ dir, into, command, timeoutSec }` — tests the agent never sees; pass = artifact correct |
| `regression` | `{ command }` — the repository's own suite after the run |

## Scores

completion claimed · artifact correct (hidden tests) · false VERIFIED (VERIFIED while hidden tests fail) · regressions
introduced · timed out / harness errors · wall time, steps, tokens (median). Context qualifier (`contextNotRetained`) is
recorded per run.

## Scoring integrity

- **Model proxy.** Every agent reaches the model through a per-run forwarder (`eval/model_proxy.mjs`) that `run.mjs`
  starts. Each record carries `model: { requests, answered, upstreamFailures, firstRequestAt, firstAnswerAt }`. Set
  `"proxy": false` in a config to connect agents directly; such runs are then scored only by the legacy rule below.
- **Infrastructure reruns** (`eval/infra.mjs`). A run is rerun only when the model never answered *and* the endpoint
  was observed failing, or when the harness itself errored. The rule is the same for every agent. A run in which the
  model answered is always scored: a crash is a failure (and counts towards the crash rate), not a rerun. Records from
  before the proxy fall back to each agent's own connection-failure message, and the script says how many it judged
  that way.
- **Contamination.** Contaminated runs (the task directory changed, or its path appeared in the agent's output) are
  left out of pooled pass rates and counted separately.
- **Reruns are listed.** `score.mjs` lists every replaced run with what it showed and what the rerun showed.
- **Pooled metrics.** Pooled rows report crash rate, regressions, tokens per correct result and wall seconds per
  correct result. The cost of failed runs counts towards these.

## Fault injection (T4)

A task or config may list `faults: [{ kind, atRequest }]`. The run's model proxy then injects that fault into the Nth
chat request (counted from 1):

| kind | Fault |
|---|---|
| `refuse` | The connection drops without an answer |
| `overloaded` | 503 with `Retry-After: 1` |
| `stream_cut` | The stream is cut after its first tool-call fragment |
| `truncate` | `finish_reason` becomes `length` |
| `context_overflow` | llama.cpp's HTTP 400 `exceed_context_size_error` |
| `malformed_tool_json` | The first tool call's arguments are no longer valid JSON |

What was injected is recorded in `model.faultsInjected`. Such runs are never treated as infrastructure reruns.
`score.mjs` reports, per fault kind:

- runs;
- **truthful** (the run ended with its own result, did not hang past its budget, and never claimed VERIFIED while the
  hidden tests failed);
- **recovered** (the hidden tests pass);
- hung past budget.

The remaining T4 classes come from task fixtures (a hanging test command, a full disk) and from the SIGTERM-then-resume
runner case. `make test` includes a T4 smoke test with two injected faults (`cli/test/eval_harness.test.ts`).

## Qualification runs

A config with `"qualification": true` is the v1.0.0 evidence run (docs/v1.0.0/ACCEPTANCE.md §6). `run.mjs` refuses to start
one, before any agent runs, unless every item below holds:

- **Tasks are well formed** (`eval/validate.mjs`): one source (fixture, or a repo pinned to a full commit id), a hidden
  command, and `class` (bugfix · feature · refactor · debug) and `difficulty` (easy · medium · hard). Development runs check
  everything except class and difficulty.
- **The model is identified, not just named.** `fingerprint: { weightsSha256, serverBuild }` and
  `sampling: { temperature, seed }` are set in the config, and the endpoint lists the model. The fingerprint (with the
  listed owner and context) is written to `manifest.json`.
- **Hidden tests are out of the agent's reach.** `runAs` names a separate evaluator user. Candidate execution occurs
  inside the Bubblewrap mount namespace and does not bind the task store or validator sources; its `HOME`, `/tmp`,
  `/run`, and network namespace are isolated. Runtime files are explicit read-only binds. The harness grants the
  evaluator UID ACL access only to the disposable workspace, home and per-run proxy directory. Before qualification,
  verify the account and these existing operating-system permissions through the approved local setup procedure:
  1. `sudo useradd --system --create-home nexus-eval`
  2. A narrowly constrained sudoers rule permitting only the required Bubblewrap invocation as `nexus-eval`; do not
     grant arbitrary `env` command execution.
  3. Keep task stores unreadable to the evaluator account; the runner does not mount them into the candidate namespace.
  4. A Nexus install, Node and the peer agents that `nexus-eval` can read and execute.

  Development runs may omit `runAs`; Bubblewrap isolation still applies. Qualification is refused without a separate
  evaluator account, `setfacl`, explicit `sandboxRuntimeRoots`, and read-only `sandboxRuntimePaths` contained by those
  roots. Protected roots such as `/etc`, `/dev`, `/proc`, `/sys`, `/run`, `/var`, `/tmp`, and sensitive user-cache paths
  are rejected. No setup procedure is applied by the runner.

- **Repository workspaces carry no history beyond the pinned commit.** `eval/workspace.mjs` stages a repo task as a
  fresh `git init` that fetches only the pinned commit and its ancestors from the local cache (`--no-tags`, no
  FETCH_HEAD), then checks out that commit detached. There is no `--shared` clone, alternates link, remote, tag or
  descendant object, so the upstream fix that follows a held-out baseline is not reachable from the workspace. Staging
  verifies this and refuses the run otherwise.

- **Corpus binding is integrity evidence, not approval authentication.** The qualification config pins the exact
  corpus-manifest SHA-256; the manifest binds each task's JSON and full task-tree digest; the run manifest repeats those
  hashes. This detects stale or modified content. The manifest's `custody.status` and `custodian` strings are claims,
  not signatures. Independent custody acceptance, pre-RC commit timing, and configuration freeze must be verified and
  archived by the acceptance reviewer before any qualification run. The current candidate task package has not been
  independently accepted.

### Isolation limits

Bubblewrap plus the current runner enforces separate mount/user/PID/network namespaces, a cleared task-command
environment, a bounded wall clock, bounded captured output, per-run process-group teardown, and read-only runtime
binds. Black-box qualification keeps oracle expectations outside candidate namespaces. Legacy hidden commands share a
process with candidate code; in qualification they run only in the hardened form below. Aggregate CPU, memory, process-count and writable-storage limits come from the
resource contract below, not from request/token ceilings. Appliance-specific Bubblewrap enforcement is a separate,
unverified condition.

### Hardened legacy hidden tests

The sealed T2 corpus uses legacy hidden tests (`hidden: { dir, command }`, for example `pytest` or `go test` over copied
test files). Those run candidate code in the same process as the oracle. Owner decision, 2026-10-18: qualification runs
them hardened, in the style of SWE-bench. Development configs opt in with `"hardenedChecks": true`.

1. The agent's workspace is never tested. After the agent finishes, the harness stages the task again (the same pinned
   commit or fixture, the same setup commands) into a fresh workspace. It checks that the fresh tree equals the agent's
   baseline tree.
2. Only the agent's **source** changes are copied in: added, modified and deleted paths since the baseline commit
   (`eval/hardened_check.mjs`).
   - Test infrastructure is discarded. That covers test files and directories, `conftest.py`, `pytest.ini`, `tox.ini`,
     `setup.cfg`, `sitecustomize.py`, `.pth`, jest/vitest/mocha/karma/babel config, Go `_test.go` (and therefore
     `TestMain`), `build.rs`, `.cargo/`, `.github/`, `Makefile` and `.env*`.
   - Symlinks and special files are also discarded.
   - A change to test-runner configuration inside a dependency manifest refuses both checks. That means `package.json`
     test/install scripts and runner keys, `pyproject.toml` `[tool.pytest*]`/coverage/tox/hatch-env sections, and
     `Cargo.toml` test, bench, build and dev sections. The refusal is recorded.
3. The hidden command runs in that workspace with the hidden directory bind-mounted **read-only**. The regression
   command runs in a separate byte-identical copy, so candidate code executed by one check cannot prepare the other.
4. In qualification, hidden-test output is kept only as a status, byte count and SHA-256, so evidence does not disclose
   the sealed tests. Each run record carries
   `hardened: { baseline, applied, discarded, configChanges }`.

What remains, and is accepted: candidate source code still executes inside the hidden test process and could detect
the test environment. That is the same residual risk as other SWE-bench-style evaluations. Black-box (`blackbox-v1`)
oracles avoid it and need no hardening.

The sealed corpus is bound through its own manifest schema (`eval/heldout-manifest.json`, `hash_scheme`). The runner
recomputes each selected task's `task_sha256` (raw `task.json`) and `hidden_sha256`. The latter is computed over the
regular files of `hidden.dir`, with `/`-separated relative paths sorted byte-wise, each line `<path>  <sha256>\n`. The
selected population must equal the manifest's. That manifest carries no custody fields, so the frozen config states
`corpusCustody: { custodian, approvedAt, reportSha256 }`, which the acceptance reviewer checks against the committed
custody report.

### Resource contract

A config's `resources` object — `{ "cpuPercent", "memoryBytes", "tasks", "storageBytes", "workspaceRoot" }` — applies to every
task-controlled execution: setup commands, the candidate agent, legacy hidden and regression commands, every black-box
oracle case and the agent version probe. Qualification refuses to start without it.

- Each execution runs under `eval/cgroup_supervisor.mjs` as the only process of its own delegated transient
  `systemd-run --user --scope`. The supervisor writes cgroup v2 `cpu.max` (`cpuPercent`% of one CPU), `memory.max`
  (`memoryBytes`), `memory.swap.max` (0), `memory.oom.group` (1) and `pids.max` (`tasks`) on a `payload` leaf, reads them back, and refuses to
  run on any mismatch. The command joins that leaf before `exec`, so nothing task-controlled runs outside the limits.
  The limits are aggregate over the whole process tree, whatever its uid (`runAs`), session or process group.
- `workspaceRoot` must itself be a dedicated tmpfs mount, not a directory on a shared mount or a bind mount. It must be
  owned by the evaluator harness uid, with owner `rwx` and no group/other read or write permission. Group/other execute
  permission is allowed so a separate evaluator uid can traverse to its per-run ACL-protected directory. For example:
  `mount -t tmpfs -o size=<storageBytes>,mode=0711,uid=<harness-uid>,gid=<harness-gid> tmpfs <dir>`.
  The preflight checks `/proc/self/mountinfo`, the mount root and options, the effective tmpfs size, and the cgroup
  probe. A shared tmpfs such as `/dev/shm` fails even when `storageBytes` is set to its full size. Workspaces and homes
  are created on this mount. Its filesystem size hard-caps files retained across phases; writes beyond it fail with
  `ENOSPC`. Runs are serial and each workspace is removed afterwards; `--keep` is refused under the contract.
- Within that cap, tmpfs pages, including the sandbox's own `/tmp`, are charged to the writing phase's memory cgroup and
  cannot be swapped. A phase therefore also cannot hold more than `memoryBytes` of memory and new writes together. When
  it reaches that bound the whole phase is OOM-killed (`memory.oom.group`), and this is recorded. When a phase's cgroup
  is removed, the kernel moves its charges to the unlimited parent cgroup. Later phases get their own `memoryBytes`,
  which is why the filesystem cap, not the memory limit, is the cross-phase storage bound. An OOM in a hidden or
  regression check is the candidate's outcome, a failed check, not an infrastructure error.
- CPU is bounded in rate by `cpu.max` and in total by the phase's wall-clock timeout.
- This contract is supported only on Linux with cgroup v2 CPU, memory and pids controllers, a delegated systemd user
  manager, Bubblewrap and the dedicated tmpfs described above. Missing controllers, mount metadata, user-manager
  delegation or any read-back mismatch fail preflight. Other operating systems and container hosts that cannot expose
  these controls are unsupported for qualification; they must not fall back to process-only or best-effort limits.
- After the command exits or times out, the supervisor records the remaining processes, empties the cgroup with
  `cgroup.kill` (which reaches daemonized processes and other uids), and waits for `populated 0`. A timeout or output
  overflow empties the payload leaf, repeatedly until the supervisor exits, so a stop that arrives before the command
  has joined the leaf is not lost. It also sends the supervisor `SIGTERM` so that it can still report. If the supervisor
  does not exit within 10 s it is killed, and the run fails for lack of a report.
- Each run record carries `resources.{agent,hidden,regression}`: the applied limits, `memoryPeakBytes`, `oomKills`,
  `memoryMaxEvents`, `pidsPeak`, `pidsMaxEvents`, `cpuUsageUsec`, `cpuThrottledUsec`, `survivorsAfterExit` and
  `cleaned`. A missing report, a failed limit read-back or `cleaned: false` makes the run an error. It is never scored
  as a pass or fail.
- Preflight runs a contained probe and refuses qualification unless this host applies and cleans up the contract. CI
  provisions delegation with `scripts/ensure-ci-user-cgroups.sh`, and the fixture tests in
  `cli/test/eval_integrity.test.ts` show OOM, process-cap, tmpfs-storage, CPU-throttle, timeout and escaped-daemon
  behaviour, using infrastructure fixtures only.

The frozen qualification config sets the limit values. They must be recorded before the first scored run and must not
be tuned against held-out results.

The evaluator proxy allows one in-flight inference request at a time and destroys the upstream HTTP request/response
when the candidate-side request is cancelled or its connection closes. This bounds proxy concurrency and propagates
transport cancellation, but it does not prove that a remote provider or model runtime stopped generation after the
connection closed; that behavior requires runtime-specific evidence. The total request limit remains a separate cap.

## Pre-registered thresholds (from the assessment, fixed before any live run)

- false VERIFIED = 0 across all runs;
- T2 hidden-test pass rate (pooled over all T2 runs of a configuration, point estimate, 95 % intervals reported) ≥ the
  best matched peer on the same local model **minus 10 percentage points**; and no task where that peer passes ≥ 4/5
  runs while Nexus passes ≤ 1/5. (Fixed 2026-10-13, before the first scored run. Rationale: at ~50 runs per
  configuration the 95 % interval half-width near 50 % is ~13 points, so a tighter margin is not distinguishable from
  noise and a looser one would accept a clear loss; the per-task guard stops a pooled rate hiding a task class Nexus
  cannot do.) The 6-task pilot is directional only; qualification needs the full task set;
- T3: false-absence claims = 0 and steering constraints honoured in ≥ 95 % of runs;
- T4: truthful bounded outcome in 100 % of fault runs;
- ≥ 5 runs per task-configuration, per-task results with 95 % intervals.

## Status

| Part | State |
|---|---|
| Runner, scorer, manifest, per-run logs | done |
| T1 self-test (`selftest-add`, scripted model, in `make test` via `cli/test/eval_harness.test.ts`) | done |
| Nexus adapter | done |
| Peer adapters and matched comparison (OpenCode, Goose, Aider; paired scoring requires Nexus, Goose, OpenCode) | adapter versions and effective budgets recorded; `--pairs` verifies the fixed model, limits, sampling, and 5× task/run pairing (Codex CLI excluded: gateway does not serve `/v1/responses`) |
| T2 task set (pilot fixture tasks `t2-*`) | done |
| T3 task set (fact-sheet scorer / steering checks) | not started |
| T4 fault injector | in progress |
| Qualification runs | blocked on independent corpus custody, enforced aggregate sandbox resource limits, completed T3/T4 workloads, exact-RC/provider evidence, and the required operational approvals; the earlier pilot's inference-hour, cloud-budget, and peer-install decisions also remain separate prerequisites |

## Pilot 2026-10-13 (4 h appliance window)

Configurations `configs/pilot-*.json`: Nexus, Aider 0.86.2, OpenCode 1.18.35, Goose 1.27.2, all on
`engineering/lead` (Qwen3.6-35B-A3B Q4_K_M, llama.cpp b11347) through the appliance gateway, 64k context. Six T2
fixture tasks (`t2-*`; each hidden test checked to fail on the fixture and pass on a reference fix kept outside the
repo). Budgets 60 steps / 20 min per task (Nexus steps; others by wall clock). The four agents run concurrently on the
same worker, so wall times include queueing.

Deviations from §9, recorded before the run: fixture tasks rather than external repositories at pinned commits; T2
only (no T3/T4 — the window is too short); Codex CLI excluded (the gateway does not serve `/v1/responses`); Aider runs
one `--message` exchange with `--yes-always` (its non-interactive mode); no cloud configuration (operator decision);
runs per task as many as the window allows, run-major, target 5.
