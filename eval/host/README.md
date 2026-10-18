# Qualification host

This directory is the reviewable procedure for preparing the host that runs `eval/run.mjs` for v1 qualification
(ACCEPTANCE §6). The host is `mike-dev`: 12 cores (Xeon X5650, no SMT), 46 GiB RAM, 16 GiB swap, kernel 6.8,
systemd 255, cgroup v2 with `cpu memory pids` delegated to the operator's user manager. Inference is remote (the
homelab-ai gateway, DEC-16), so this host's CPU and memory serve only the agents, their builds and the tests.

Nothing here touches the inference appliance, the gateway, the firewall, model workers, credentials or other
services. The changes are limited to the following:

| Change | File or object | Why |
|---|---|---|
| Install `acl` | apt package | `setfacl` grants the evaluator uid access to each disposable run directory (`grantRunAsAccess`). |
| System account `nexus-eval` | `/etc/passwd`, `/var/lib/nexus-eval` (0700), shell `nologin` | The candidate and validators run as a uid that cannot read the operator's files or the held-out store. |
| One sudoers rule | `/etc/sudoers.d/90-nexus-eval`: `<operator> ALL=(nexus-eval) NOPASSWD: /usr/bin/bwrap` | The harness's only privilege. No `env`, no shell, no other command. |
| Size-capped tmpfs | `srv-nexus\x2dqual-ws.mount` at `/srv/nexus-qual/ws`, `size=storageBytes,mode=0700,uid=<operator>,nosuid,nodev` | The resource contract's `workspaceRoot`: the hard cap on what a run keeps, across all phases. |
| Runtime directory | `/opt/nexus-qual` (root, 0755) | `sandboxRuntimeRoots` for the installed RC and the peer agents. It is filled per RC. |

- `provision.sh` applies these changes and is idempotent. It never remounts an active tmpfs.
- `rollback.sh` removes them. It keeps `/opt/nexus-qual` unless you pass `--purge-runtime`, and it leaves `acl` installed.
- `validate.mjs`, run as the operator, proves the result using infrastructure fixtures only.

```sh
sudo OPERATOR=mike bash eval/host/provision.sh
node eval/host/validate.mjs --json docs/reviews/evidence/v1-qualification/host/validate-$(date -u +%Y%m%dT%H%MZ).json
# undo: sudo bash eval/host/rollback.sh
```

The harness's `asUser` invokes `/usr/bin/sudo -n -u nexus-eval -- /usr/bin/bwrap …` directly. sudo's `env_reset`
and Bubblewrap's `--clearenv` clear the environment, so the rule names only `/usr/bin/bwrap`. This host's sudo PAM
stack (`common-session-noninteractive`) does not load `pam_systemd`, so a process switched to `nexus-eval` stays in the
run's cgroup. `validate.mjs` checks this.

## Resource profile

`resource-profile.json` holds the values. The three frozen T2 configs and every T3/T4 config embed them as their
`resources` object, byte-identical. `score.mjs --pairs` refuses comparisons whose manifests differ.

| Key | Proposed | Exact kernel meaning |
|---|---|---|
| `cpuPercent` | 800 | `cpu.max = 800000 100000`. The payload's processes may together use at most 8 CPUs' worth of runtime per wall-clock second. This is **rate throttling, not a total budget**. Total CPU time is bounded only by the phase's wall-clock limit times 8, and each phase's `cpuUsageUsec` and `cpuThrottledUsec` are recorded. |
| `memoryBytes` | 16 GiB | `memory.max`, with `memory.swap.max = 0` and `memory.oom.group = 1`. The charge counts the phase's anonymous memory, the page cache it faults in (reclaimable before OOM), **and the tmpfs pages it writes**. A phase that writes 6 GiB of build output therefore has about 10 GiB left for its processes. Exceeding the limit OOM-kills the whole phase, and this is recorded. |
| `tasks` | 4096 | `pids.max`. This counts threads, not just processes: Go test binaries, `cargo` with parallel `rustc`, and Node/Bun worker threads all consume tasks. |
| `storageBytes` | 20 GiB | The size of the dedicated tmpfs. It caps everything a run holds in its workspace and home **across phases**, because when a phase's cgroup is removed, its tmpfs charges move to the unlimited parent. Writes beyond the cap fail with `ENOSPC`. Runs are serial, and each run's directories are removed afterwards. |

### Why these values

- **Fairness.** Nexus, Goose and OpenCode get identical limits. Each agent's own process is small next to them: OpenCode
  about 1.1 GiB RSS, the others less, as observed on this host. No agent is systematically starved.
- **CPU.** Eight of the twelve cores leave four for the harness, the model proxy, the OS and the box's other tenants.
  Then load from those tenants cannot change a run's available CPU. The X5650 is slow, so the throttle is set
  high enough not to bind on a normal build.
- **Memory and threads.** Sized for the heaviest language class in the corpus, Rust test builds, where parallel `rustc`
  plus a multi-GiB target directory on tmpfs both count. The measurement below records this repository's own
  `core` crate under the contract as a lower-bound reference.
- **Storage.** The worst-case RAM is a full tmpfs plus a phase at its memory limit: 20 + 16 = 36 GiB. Together with
  about 7 GiB of other host use, that stays below the 46 GiB of physical memory, so qualification cannot push the
  box into swap.

### Freezing

1. **Calibration (custodian, before freeze).** The custodian validates every sealed task's reference solution under
   this profile and reports only aggregates: pass count; maximum `memoryPeakBytes`, `pidsPeak` and workspace bytes
   across phases; and any OOM, pids or ENOSPC event. If a reference fails because of a limit, the limit is raised, the
   change is recorded, and calibration is repeated. No candidate result is involved.
2. **Freeze.** Set `"status": "frozen"`, commit, and record the profile's SHA-256 in the frozen run record
   (ACCEPTANCE §6.1) before the first qualification run.
3. **After freeze.** Values never change in response to qualification outcomes. A change for any reason after the
   first scored run invalidates the affected runs. They are kept as evidence and rerun.
