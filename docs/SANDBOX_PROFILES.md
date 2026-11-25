# Sandbox profiles (SB-1)

A sandbox profile is a name for a bundle of confinement settings that already exist: `--sandbox`, `--sandbox-network` and `--read-only`. A profile **selects among them and grants nothing**. It does not decide an approval, switch on full access, switch off verification-path protection or override managed policy, and no code reads a profile to decide any of those. The profile you see in `nexus doctor`, `/status` and the sidecar `session.state` event is always derived from the settings that are in force, so it cannot claim more confinement than the session has.

The source of truth is `cli/src/sandbox_profile.ts` (`PROFILE_SPECS` holds the table and the residual holes below; `describeSandboxPosture` is the one describer every surface uses). The sandbox itself is described in the [user manual](USER_MANUAL.md) (the `--sandbox` bullets under the security section).

## The three profiles

```
nexus run --sandbox :workspace  "..."
nexus run --sandbox bwrap:read-only "..."
nexus run --sandbox docker:network "..."
```

The value is `[engine]:profile`. `engine` is `auto`, `bwrap` or `docker` and defaults to `auto`; the profile is `:workspace`, `:read-only` or `:network`. The match is exact and case-sensitive. An unknown value, `:full-access`, `none:workspace` and similar are refused with the list of valid values; nothing falls back to an unconfined run. `docker:read-only` is refused: read-only confinement needs Bubblewrap. The engine words alone (`auto`, `bwrap`, `docker`, `none`) work as before and name no profile.

| Profile | Same as | Network | What it means |
|---|---|---|---|
| `:workspace` | `--sandbox` | off | Writes only inside the workspace; `$HOME` masked. |
| `:read-only` | `--read-only` (and `--sandbox <engine>` when an engine is named) | off | No writes anywhere; commands see only the workspace and the runtime. It puts the session in read-only mode exactly as `--read-only` does, so it also wins over `--yes`, `--approve` and `--full-access` on the same command line. |
| `:network` | `--sandbox --sandbox-network` | on | As `:workspace`, with the network on. |

Network rules:

- `--sandbox-network` together with `:workspace` or `:read-only` is an error (these profiles have no network); use `:network`.
- `NEXUS_SANDBOX_NETWORK=1` in the operator environment is ignored under `:workspace` and `:read-only`, with a notice. A named profile fixes the network posture of the run.
- Without a profile, `--sandbox-network` and `NEXUS_SANDBOX_NETWORK` behave as they always did.

## Seeing the effective profile

- `nexus doctor` / `/doctor`: the `sandbox.confinement` finding names the profile, its source, the engine, the network and the residual holes; the JSON report carries `posture.profile` and `posture.profileSource` (report `schemaVersion` stays 2).
- REPL `/status` and the TUI status line: `sandbox:` shows `:workspace (bwrap, network off, --sandbox :workspace)` when a profile was named, and the text it always showed (`off`, `on`, `bwrap`, ...) otherwise. The TUI adds `profile: ...` when the label says something the sandbox text does not (for example `:read-only` while the sandbox text is `off`).
- Sidecar `session.state`: `posture.profile` (optional string: `:workspace`, `:read-only`, `:network` or `unconfined`) next to `posture.sandbox`. It is additive; the protocol version stays 1.
- Sandbox denial events (receipts and flight records, VR-3) carry the session's named profile in `profile`, and `default` when none was named or the denial came from `nexus verify`.

With no named profile the label is still derived: `--sandbox` is `:workspace`, `--sandbox` with the network on is `:network`, and read-only mode is `:read-only`. A stricter setting from elsewhere replaces a named profile and says what decided it (for example `read-only mode (in place of --sandbox :workspace)`).

`nexus doctor` and bare read-only: read-only mode confines `run_command` in Bubblewrap whether or not a `--sandbox` engine was selected, but with none selected the native worker runs on the host. Doctor says so (the worker "runs outside any sandbox", and the `--sandbox` HOME mounts are not listed) and warns when `bwrap` is not installed, because read-only mode then refuses commands. Add an engine (`--sandbox bwrap:read-only`) to confine the worker too.

## What a profile cannot do

A profile is a confinement bundle. It cannot:

- disable verification-path protection (edits to tests, CI and verifier files still need an operator decision);
- grant allow-always or change any approval decision; the approval mode, `--yes` and full access are resolved before and apart from the profile;
- bypass managed policy (below) or the verification ladder; a sandbox is not a verdict.

## Composition with managed policy

The order in `buildConfig` is: the approval request and its managed-policy clamp first; then the profile is expanded into the flags above; then the sandbox clamp and the network clamp run on the result; the effective network choice is recorded only after every clamp has passed (a refused build leaves no network permission behind). The stricter of profile and policy applies, and a profile is never looser than either:

| Policy key | Effect on a profile |
|---|---|
| `sandbox.required` | `--sandbox none` is refused; a profile always has a sandbox on. With no `--sandbox` the sandbox is switched on (`auto`) and shown as `:workspace`. |
| `sandbox.forbid_network` | `--sandbox :network` is refused, naming the policy source; `:workspace` and `:read-only` are unaffected. |

See [MANAGED_POLICY.md](MANAGED_POLICY.md) for the keys and the refusal text.

## `nexus verify --sandbox` does not take profiles

`nexus verify --sandbox` confines verification processes and accepts only `auto`, `bwrap`, `docker` or `none`. A profile there is a usage error (`--sandbox takes auto, bwrap, docker or none`). Verification keeps its own defaults and its own `--sandbox-network` rule (decision D-SB1-5).

## Residual holes

What each profile does not protect against, as `nexus doctor` prints it. A sandbox here is a mount and network namespace, not a second account.

**All profiles**

- no seccomp filter under Bubblewrap: every system call the kernel offers an unprivileged process stays reachable
- commands run as the operator's own user: the sandbox is a mount and network namespace, not a second account
- MCP servers and plugins are not sandboxed

**`:workspace` and `:network`**

- broad host reads: `/` is bound read-only, so `/etc`, `/usr` and every other world-readable file outside `$HOME` can be read
- the writable workspace includes `.git` (hooks, config) and ignored trees such as `node_modules`, which tools run later on the host may execute
- toolchain directories under `$HOME` (`PATH` entries and the fixed list) are readable
- under engine `auto` with no engine available the native worker runs unconfined, while commands are still refused

**`:network` only**

- unrestricted egress: no domain filter in the sandbox, so anything a command can read it can also send

**`:read-only` only**

- everything in the workspace is readable, including secrets kept in it

**Unconfined (no sandbox, no read-only)**

- commands run on the host as the operator's user, with the scrubbed command environment as the only limit

## Example

[`examples/sandbox-profiles/`](../examples/sandbox-profiles/) prints the effective profile of each of the three profiles with `nexus doctor --json`; it needs no model.
