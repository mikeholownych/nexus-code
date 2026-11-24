# Unattended schedules

`run.sh` adds a read-only schedule for the current Git checkout, starts one run of it by hand with `nexus schedule run-now`, waits for the job and prints `nexus schedule status`: the outcome, the receipt, and the runs the schedule missed (none here). It starts a runner if none is running, and removes the schedule and stops that runner when it ends.

```sh
cd /path/to/a/git/checkout
NEXUS_RUNNER_ENDPOINT=http://localhost:8080/v1 NEXUS_RUNNER_MODEL=my-model bash /path/to/examples/schedules/run.sh
```

The script runs `nexus trust` on the checkout: a schedule is a standing order, so Nexus adds one only for a workspace you trust. Read the repository first. Without the two variables it uses your configured endpoint and model.

A schedule fires a background job exactly as `nexus job start` would. It is read-only unless you add `--allow-worktree-write`, which is fixed when the schedule is added; nothing a run does can change it, and no run ever approves a command, a network call or a grant. See [docs/SCHEDULES.md](../../docs/SCHEDULES.md) for the triggers (`--cron`, `--every`, `--at`, all UTC), missed runs and overlap.
