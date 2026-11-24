# Detached jobs

The detached runner is an experimental Linux feature. A foreground runner owns durable job records and starts one worker process per job. A job continues after the command that submitted it exits. Jobs are not merged automatically: completed operation results stay on their integration branch for review.

## Start the runner

Check that the `nexus` launcher is on `PATH`, then create a systemd user unit:

```sh
nexus runner install-unit --print
nexus runner install-unit
```

Review the generated `~/.config/systemd/user/nexus-runner.service`. The command only writes the file; it does not enable or start the service. After reviewing it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now nexus-runner
```

To start at boot and survive logout, enable user lingering with `loginctl enable-linger "$USER"`. Without systemd, run `nexus runner serve` under a supervisor. Only one runner may own a state directory. `nexus runner status` reports the lock-backed liveness; the JSON record is informational.

The runner and its workers hold Nexus client leases. Stop the unit before upgrading Nexus, then start it again after the upgrade. A normal stop asks workers to cancel and leave their operations resumable. If the runner is killed, workers continue; the next runner adopts them. If a worker dies, the runner applies the operation recovery path and permits at most three crash resumes. Reboots and orderly runner stops do not use that crash allowance.

## Submit and inspect a job

```sh
nexus job start --prompt "Explain the failing test" --verifier "npm test"
nexus job list
nexus job status job-0123456789ab
nexus job logs job-0123456789ab
nexus job logs --follow job-0123456789ab
nexus job stop job-0123456789ab
```

Use `--wait` with `job start` when the submitting command should wait for the final result. Ending that client does not stop the job. `job resume` requeues a `BLOCKED` job before its deadline; first answer or resolve the operation's recorded question as shown by `job status`.

A job captures the repository's current `HEAD` and runs in a new operation worktree from that commit. Uncommitted changes in the operator checkout are not included. The default `read-only` policy does not permit workspace writes, shell commands, or network access. `--allow-worktree-write` permits writes only in the fresh worktree and requires a usable sandbox. It never enables automatic approval. Approval-required actions are denied and leave a `BLOCKED` job for the operator.

Each job has objective-wide step, tool, and inference budgets that persist across resumes; a per-attempt turn limit; and a whole-job deadline. Defaults are conservative (200 steps, 300 tool calls, 300 inference submissions, 60 minutes per turn, and a 120-minute total deadline). The queue is bounded at 32 jobs and the runner starts one job at a time by default (up to four with `runner serve --max-jobs`).

Receipts record the starting commit, policy, verifier, budgets, attempts, unattended status, and final outcome. The runner reports `COMPLETE` only when the worker's durable operation record is also `COMPLETE` and every required unit is complete; a worker's success report by itself is insufficient. It does not mean the job was merged. A blocked, failed, cancelled, or timed-out job is not successful.

## State and limits

Runner state is stored in `${NEXUS_STATE_DIR:-~/.nexus}/runner`, in owner-only directories and files. JSON records are size bounded, versioned, strictly parsed, refuse duplicate keys, symbolic links, unexpected keys, and unsafe permissions, and are atomically replaced with file and directory syncs. Event logs are redacted and capped at 16 MiB; worker stderr is capped at 32 MiB. Ended jobs keep their record and receipt; event and stderr logs are pruned after 30 days. Same-user programs can alter this state, so it is not a security boundary against the account that runs Nexus.

The runner requires Linux `/proc` process identity and `flock`. It is experimental and does not support Windows or macOS, multi-user scheduling, automatic result merging, or running jobs without a supervising process. Keep the runner on the same Nexus version as its workers; stop it before upgrading.
