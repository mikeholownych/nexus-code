# A9 / WP-1105: cgroup limits on evaluator commands, verified on a real cgroup v2 host

Date: 2026-11-12. Base: `origin/main` `4415cdc8`. Owner decision (2026-11-12): verify the cgroup limits on a
cgroup-capable host before release. Result: every check below passed on this host. Limits of the verification are in
"What this does not show".

## Host facts

| Fact | Value |
|---|---|
| Kernel (`uname -r`) | `6.8.0-149-generic` |
| `stat -fc %T /sys/fs/cgroup` | `cgroup2fs` |
| `/sys/fs/cgroup/cgroup.controllers` | `cpuset cpu io memory hugetlb pids rdma misc` |
| `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers` | `cpu memory pids` (user delegation) |
| systemd (`systemctl --version`) | `systemd 255 (255.4-1ubuntu8.18)` |
| Node | `v24.11.1` |
| Workspace tmpfs (`NEXUS_EVAL_TEST_WORKSPACE_ROOT=/srv/nexus-qual/ws`) | `tmpfs rw,nosuid,nodev,relatime,size=20971520k,mode=711,uid=1000,gid=1000` (dedicated mount, 20 GiB) |
| sudo | not available (no `make test-ci` fixture mount; the existing dedicated qualification tmpfs was used) |

## Code under test

The evaluator-command path is `eval/evaluators/code/command.mjs` `createContainedRunner` (what `runArgv`,
`evaluateBuild` and `evaluateTypecheckClean` call) -> `eval/isolate.mjs` `runIsolatedProcess` ->
`eval/resources.mjs` `spawnContained` -> `systemd-run --user --scope -p Delegate=yes` -> `eval/cgroup_supervisor.mjs`,
which creates `supervisor` and `payload` leaves, writes `memory.max`, `memory.swap.max=0`, `memory.oom.group=1`,
`pids.max`, `cpu.max`, reads them back, and refuses to start the command if they differ. The implementation lives under
`eval/` (reserved for codex-root), so this change adds a test and evidence only and edits nothing there.

## Existing tests on this host (step 1)

Command: `cd cli && NEXUS_EVAL_TEST_WORKSPACE_ROOT=/srv/nexus-qual/ws npx tsx --test --test-name-pattern=resource test/eval_integrity.test.ts`

| Test | Result |
|---|---|
| qualification remains fail-closed without enforced aggregate resource controls | pass |
| resource supervisor preserves SIGTERM grace for descendants after the main payload exits | pass |
| resource supervisor stops its payload when the parent's control channel closes before a final report | pass |
| resource contract: candidate memory, processes, storage and CPU are kernel-bounded and every process is reaped | FAIL: `compiler exposure could not be checked; refusing qualification` (`eval/isolate.mjs:582`, `isolatedArgv`) |
| candidate sandbox and resource supervisor compose around a staged repository | FAIL: same error (`agentSandboxArgv`, `eval/isolate.mjs:711`) |

The two failures happen before any cgroup is created, in the shell-sandbox compiler-exposure scan. This host has
`/usr/bin/gcc` in the mounted system directories, which is a candidate cause, but the scan swallows the underlying exception, so the
trigger was not diagnosed here. They are host-environment refusals, not limit failures, and they exercise
`runIsolated`, not the evaluator-command path. They are not counted as verification. The evaluator-command path itself
(`runArgv` -> `isolatedProcessArgv`) starts normally on this host. No test was skipped in this run.

## New harness (step 2)

`cli/test/evaluator_cgroup_limits.test.ts` (9 tests). It calls `createContainedRunner` with only a pass-through spy on
`runIsolatedProcess` (to keep the supervisor report the runner reduces to status/signal/error). Resources:
`memoryBytes` 64 MiB, `tasks` 16, `cpuPercent` 50 (20 and 50 in the CPU checks), `workspaceRoot` the dedicated tmpfs;
the gate runs the production `resourceProbeProblem` first.

When `NEXUS_EVAL_TEST_WORKSPACE_ROOT` is set (CI, `make test-ci`) an unmet prerequisite FAILS the checks instead of skipping, as `eval_integrity` does, so a lost delegation cannot turn CI green by skipping. Without it, skips are each printed with a reason, when: not Linux; no `/sys/fs/cgroup/cgroup.controllers`; the user manager does not
delegate cpu, memory and pids; `XDG_RUNTIME_DIR` unset; `NEXUS_EVAL_TEST_WORKSPACE_ROOT` unset; Bubblewrap or prlimit
missing; pgrep missing; no `cgroup.kill` (kernel before 5.14); `resourceProbeProblem` non-null. A kernel without `memory.peak` or `pids.peak` (probed on the user manager cgroup) runs the checks but prints that the peak bounds were not checked; that branch was not exercised on this 6.8 host. If the nested-bwrap read-only-cgroup simulation cannot start, the test skips, or fails when the fixture variable is set. Checks 1 to 5 require that the sampler saw the run's scope (runs of 1 s or more), so the scope-directory check is not vacuous; the 0.3 s control does not. Verified on this host (the other skip conditions were not exercised):

```
$ env -u NEXUS_EVAL_TEST_WORKSPACE_ROOT npx tsx --test test/evaluator_cgroup_limits.test.ts
ℹ SKIPPED: NEXUS_EVAL_TEST_WORKSPACE_ROOT is unset: no dedicated capped tmpfs for the resource contract (run `make test-ci`)
ℹ tests 9 / pass 1 / fail 0 / skipped 8
$ NEXUS_EVAL_TEST_WORKSPACE_ROOT=/srv/nexus-qual/ws env -u XDG_RUNTIME_DIR npx tsx --test test/evaluator_cgroup_limits.test.ts
ℹ pass 1 / fail 8 / skipped 0   (fixtures configured but no user manager: the checks FAIL rather than skip)
```

Results below were produced at the pre-round-2 commit `54f28245` unless marked; the round-2 hardening (snapshot cleanup, wall-time CPU bound, tolerant peaks, strict host probes) was re-run 3 times at the final head, all 9 passing (`pass 9, fail 0, skipped 0` each time, 2026-11-12, `NEXUS_EVAL_TEST_WORKSPACE_ROOT=/srv/nexus-qual/ws`); the transcripts below were not regenerated.

Real run: `cd cli && NEXUS_EVAL_TEST_WORKSPACE_ROOT=/srv/nexus-qual/ws npx tsx --test test/evaluator_cgroup_limits.test.ts`
-> `tests 9, pass 9, fail 0, skipped 0`. The first test only reports the gate; the other eight are the checks.

### Check results

| # | Check | Test | Result |
|---|---|---|---|
| 1 | Memory hog (`/usr/bin/tail /dev/zero`, unbounded buffer) OOM-killed at 64 MiB; operator told | `a memory hog is OOM-killed inside its cgroup, reported as a memory-limit kill, and never exceeds its limit` | PASS |
| 2 | Shell fork loop gets EAGAIN at `pids.max` 16 | `a shell that forks past pids.max gets EAGAIN and the supervisor records it` | PASS |
| 3 | Real fork bomb (bash respawn loop) bounded at 16 pids, killed by the wall clock (the test also accepts a group OOM kill ending it first), `/usr/bin/true` still forks outside it (every probe exits 0) | `a real fork bomb is bounded by pids.max and killed with its cgroup; fork keeps working outside it` | PASS |
| 4 | CPU burner throttled at `cpu.max` 20% | `a CPU burner is throttled to cpu.max at 20% ...` | PASS |
| 5 | CPU burner throttled at `cpu.max` 50% | `a CPU burner is throttled to cpu.max at 50% ...` | PASS |
| 6 | Ordinary command under the same limits succeeds, no events | `a clean command under the same limits succeeds untouched ...` | PASS |
| 7 | No user manager at runtime (`XDG_RUNTIME_DIR` unset; pointing at a dir with no bus): refuses, command never ran | `without a usable systemd user manager ... (fails closed)` | PASS |
| 8 | Unwritable cgroup parent (`/sys/fs/cgroup` read-only bind): supervisor refuses before the command, command never ran | `when the cgroup parent is not writable ... (fails closed)` | PASS |
| 9 | After every contained run: scope cgroup directory gone, no shell (argv carrying the run's marker) left, supervisor `cleaned: true` | `assertCleanedUp` in checks 1 to 6 | PASS |

Raw output of the passing run (`console` lines are `t.diagnostic` output; the `supervisor-report` is the
supervisor's final read of the payload cgroup's kernel files `memory.events`, `pids.events`, `cpu.stat`; the `raw` lines
are mid-run samples of the same files taken every 15 ms, so they can lag the final value).

Memory hog (limit 67108864):
```
result={"status":137,"signal":"SIGKILL","timedOut":false,"error":"candidate command was killed by the memory limit",...}
supervisor-report={"limits":{"memory.max":"67108864","memory.swap.max":"0","memory.oom.group":"1","pids.max":"16","cpu.max":"50000 100000"},"memoryPeakBytes":67108864,"oomKills":3,"memoryMaxEvents":21,"pidsPeak":3,"pidsMaxEvents":0,...,"cleaned":true,"exitCode":null,"signal":"SIGKILL"}
raw memory.events="low 0\nhigh 0\nmax 21\noom 1\noom_kill 0\noom_group_kill 0"   (mid-run sample, before the kill)
```
(an earlier run of the same test recorded `raw memory.events="low 0\nhigh 0\nmax 18\noom 1\noom_kill 3\noom_group_kill 1"`.)

Fork loop (pids.max 16, dash):
```
result={"status":2,...,"error":null,"stderr":"nexus-a9-<uuid>: 0: Cannot fork\n"}
supervisor-report={...,"pidsPeak":16,"pidsMaxEvents":1,...,"cleaned":true,"exitCode":2}
```

Fork bomb (`b() { b | b & }; while :; do b 2>/dev/null; done`, 4 s wall clock):
```
result={"status":137,"signal":"SIGKILL","timedOut":true,"error":null,...}
supervisor-report={...,"pidsPeak":16,"pidsMaxEvents":41,"cpuThrottledUsec":164720,...,"cleaned":true,"signal":"SIGKILL"}
raw pids.events="max 41"
```
The test also runs `/usr/bin/true` from the test process (outside the cgroup) every 250 ms during the bomb and requires every probe to exit 0 (at least one probe). The statuses are printed as the `fork-bomb host-side ... probes` diagnostic. This shows the test process could still fork; it is a weak signal about the host, not a latency measurement. The probe list of the earlier runs was not recorded.

CPU burner at 20% (2 loops x 2 s, demand 4,000,000 us; quota over 2 s = 400,000 us):
```
supervisor-report={"limits":{...,"cpu.max":"20000 100000"},...,"cpuUsageUsec":424753,"cpuThrottledUsec":3611431,...,"cleaned":true}
raw cpu.stat="usage_usec 417293\nuser_usec 398386\nsystem_usec 18906\n...nr_periods 20\nnr_throttled 20\nthrottled_usec 3431877\n..."
```
CPU burner at 50% (3 loops x 2 s, demand 6,000,000 us; quota 1,000,000 us):
```
supervisor-report={"limits":{...,"cpu.max":"50000 100000"},...,"cpuUsageUsec":1052959,"cpuThrottledUsec":5088045,...,"cleaned":true}
raw cpu.stat="usage_usec 1049072\n...nr_periods 20\nnr_throttled 20\nthrottled_usec 4845720\n..."
```
Usage is 1.06x and 1.05x the quota in the earlier run (the test asserts usage above 0 and at most `quota x run wall time x 1.1 + 100 ms`, where run wall time includes sandbox start-up and kill); the unthrottled run would use the full demand.

Control (`echo ok; sleep 0.3`): `status 0`, `error null`, `oomKills 0`, `pidsMaxEvents 0`, CPU usage within the quota over the run's wall time (asserted); the earlier run's raw `cpu.stat` showed `nr_throttled 0`.

Fail closed:
```
XDG_RUNTIME_DIR unset:        {"status":null,"error":"resource containment needs the systemd user manager (XDG_RUNTIME_DIR is unset)"}
XDG_RUNTIME_DIR with no bus:  {"status":1,"error":"no containment report from the resource supervisor","stderr":"Failed to connect to bus: No such file or directory\n"}
read-only /sys/fs/cgroup:     {"status":125,"error":"could not apply resource limits: EROFS"}
```
In all three the command's witness file (`touch /workspace/ran`) does not exist, so it never ran unlimited.

Cleanup after the real runs: `systemctl --user list-units --all 'run-*.scope'` empty, `/srv/nexus-qual/ws` empty,
`pgrep -f nexus-a9` finds nothing.

## What this does not show

1. One host: kernel 6.8, systemd 255, Ubuntu, cgroup v2 only. No cgroup v1 host, no container without delegation, no
   other kernel or systemd version. This test has not run on a hosted CI runner; CI behaviour (fixtures, 128 MiB tmpfs, runner delegation) is unverified.
2. CPU throttling was measured at two quota ratios (20% with 2 loops, 50% with 3 loops) over 2 s windows only, on a
   shared host with other work running; the test asserts throttling occurred, usage above 0 and at most `quota x run wall time x 1.1 + 100 ms`. It is an upper bound, not a precision measurement (observed 1.05x to 1.06x).
3. The workspace tmpfs here is 20 GiB (not the 128 MiB CI fixture), so the storage-cap (ENOSPC) path was not exercised; disk
   quota is the tmpfs size, not a cgroup limit, and is out of scope of this check.
4. "Host unaffected" is evidenced by: the limits read back before the command, bounded `memory.peak` and `pids.peak` (when the kernel exposes them),
   and host-side `fork` of `/usr/bin/true` from the test process still working during the bomb (every probe, every 250 ms). It is not a
   measurement of host latency under the bomb, and host memory was not sampled during the hog.
5. Fail-closed without delegation was simulated (no user manager, no bus, read-only cgroup mount). A real host whose
   user manager lacks cpu/memory/pids delegation was not available; `scripts/ensure-ci-user-cgroups.sh` is the CI
   preparation and was not changed.
6. Operator diagnostics are uneven (finding, not fixed here because the code is under `eval/`): a memory kill sets
   `error` ("candidate command was killed by the memory limit"); a wall-clock kill sets `timedOut`; hitting `pids.max`
   sets no `error` and no flag in `createContainedRunner`'s result (the command just sees EAGAIN and exits with its own
   status, here 2 with `Cannot fork` on stderr; `pidsMaxEvents` stays only in the supervisor report that the runner
   drops); CPU throttling is silent by design. The finding is for the `eval/` owner: surface `pidsMaxEvents > 0` from
   `eval/evaluators/code/command.mjs` the way `oomKills` is.
7. The two failing existing `eval_integrity` tests (above) were not fixed or diagnosed further.
