# Event triggers

`triggers.json` declares two triggers: `example-readme` (a change to `README.md` starts a read-only job) and `example-hook` (a signed webhook delivery starts one). `run.sh` fires one of them and prints the job's receipt; `deliver.mjs` sends a signed delivery.

```sh
cd /path/to/a/git/checkout
nexus trust "$(pwd)"                                   # after you have read the repository
mkdir -p .nexus && cp /path/to/examples/triggers/triggers.json .nexus/triggers.json && chmod 600 .nexus/triggers.json
nexus triggers approve                                  # prints every field of each trigger; you type "yes", in a terminal
bash /path/to/examples/triggers/run.sh file
NEXUS_TRIGGER_EXAMPLE_HOOK=0123456789abcdef0123 bash /path/to/examples/triggers/run.sh webhook   # the runner, started by the script, reads the secret from this environment
```

Nothing here is approved for you: approving is a person at a terminal reading what the trigger may do. A trigger starts the same unattended job as `nexus job start` (a fresh worktree, read-only here, nothing approved by the run), and the event's details reach the job as untrusted data, never as instructions. See [docs/TRIGGERS.md](../../docs/TRIGGERS.md).
