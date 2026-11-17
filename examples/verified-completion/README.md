# Verified completion

`run.sh` copies a tiny project whose `add()` is wrong into a scratch repository and asks Nexus to fix it, with
`node --test` as the **authoritative verifier**. Nexus may not report the task complete until that command passes on
the final workspace, so the process exit code is a gate you can rely on in scripts and CI:

```bash
NEXUS=nexus examples/verified-completion/run.sh      # your endpoint and model as for any `nexus run`
```

`--deliverable-file add.js` names the product file the task is meant to change. The verifier's definition is
snapshotted before the task starts; without the declaration, editing a file the verifier reads would void the
verification ("the workspace-resolved verifier definition changed after its baseline"). Repeat the option for each file.

See `docs/USER_MANUAL.md` for the verification model, and `docs/STREAM_JSON.md` to follow the run as events.
