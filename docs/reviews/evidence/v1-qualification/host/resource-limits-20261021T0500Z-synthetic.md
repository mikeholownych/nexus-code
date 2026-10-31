# Synthetic evaluator resource and sandbox preflight

This evidence exercises the production `isolatedArgv` → `asUser` → `spawnContained` path and its cgroup-v2 supervisor at source revision `dc65f35f8367f67b2b5c9dd33d195c116d409be6`. It uses only synthetic commands and a temporary 128 MiB tmpfs; no corpus, task payload, solution, validator, or qualification output was accessed.

| Control | Applied limit | Deliberate violation | Observed evidence | Cleanup |
|---|---:|---|---|---|
| CPU | 10% CPU rate | `timeout 3s yes` busy loop | `cpu.throttled_usec=3009849` | cgroup empty |
| Memory | 64 MiB, swap 0, OOM group enabled | Fill a 512 MiB buffer | 3 OOM kills; process exited 137 | 3 survivors observed; cgroup empty |
| Processes | 128 tasks | Attempt 128 long-lived child processes | `pids.events max=10`; 37 survivors observed | cgroup empty |
| Workspace storage | 128 MiB dedicated tmpfs | Write 160 MiB | `ENOSPC` | workspace removed |
| Host-path boundary | Bubblewrap user/PID/net namespaces | Direct paths and `/proc/1/root` paths to operator home, held-out location, and root-owned canary | All paths inaccessible | canary, HOME, mount, and workspace removed |

The temporary mount was operator-owned (`uid=1000`, mode `0711`, `nosuid,nodev`) so the evaluator could traverse to the explicitly ACL-granted workspace while the mount root remained non-listable and non-writable to it. No evaluator processes or fixture files remained after teardown.

This is host infrastructure evidence, not held-out qualification or custody acceptance. The path-canary test exercises the production candidate Bubblewrap sandbox but does not exercise end-to-end `eval/run.mjs` task staging with Git object canaries. Those custody and runner-path gates remain open.
