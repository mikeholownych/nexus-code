# Sandbox profiles

A named profile (`--sandbox :workspace`, `:read-only`, `:network`) is a name for confinement settings that already
exist; it grants nothing and cannot change approvals, verification-path protection or managed policy. The contract and
the residual holes of each profile are in [`docs/SANDBOX_PROFILES.md`](../../docs/SANDBOX_PROFILES.md).

`run.sh` prints the effective profile of each one as `nexus doctor` reports it (the profile, what decided it and the
sandbox text of the status line), then the refusal of `--sandbox-network` together with a profile that has no network.
It needs no model, runs no command and uses a throwaway `HOME`.

```console
$ ./run.sh
--- nexus --sandbox :workspace doctor
profile: :workspace (--sandbox :workspace)
sandbox: :workspace (auto, network off, --sandbox :workspace)
sandbox.confinement: Effective sandbox profile: :workspace.
…
--- a profile that has no network refuses --sandbox-network
refused: --sandbox-network conflicts with --sandbox :workspace: this profile has no network. Use --sandbox :network.
```

The doctor takes the profile as a global option placed before it: `nexus --sandbox :workspace doctor`.
