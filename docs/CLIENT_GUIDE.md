# Nexus Code client guide

For binary installation and first run, start with the [quickstart](../quickstart.md). It documents the currently supported package target: Linux x86-64, glibc 2.35+, and Node.js 22+.

## Interfaces and commands

Use `nexus --help` for the installed CLI and `/help` inside an interactive session. Common commands include:

```sh
nexus                         # interactive session in current workspace (TUI on TTY; REPL on non-TTY)
nexus repl --approve          # ask before edits and shell commands
nexus run "Explain this project" --read-only
nexus doctor --deep           # diagnostics; deep mode sends one small inference request
nexus sessions                # list saved sessions
nexus providers               # provider and credential status, values withheld
```

On a terminal, running `nexus` with no arguments opens the live TUI; in non-interactive pipes or via `nexus repl`, it opens the interactive REPL. Non-interactive tasks require the explicit `run` subcommand (`nexus run "<task>"`). Unknown subcommands exit non-zero with an error (REQ-REL-104). The interactive slash commands include `/help`, `/status`, `/doctor`, `/mode`, `/compact`, `/clear`, `/resume`, `/sessions`, `/save`, `/export [md|json]`, `/checkpoints`, `/undo`, `/git`, and `/exit`. Availability and usage are listed by `/help` in the running client. `nexus run` supports JSON results with `--json`; its execution, verification outcome, and acceptance are separate. `VERIFIED` means the selected verifier ran and passed; a model saying it is done is not verification.

## Providers and local inference

The quickstart configures an OpenAI-compatible local endpoint. Nexus also supports explicit providers and provider-specific authentication; see [Cloud providers](CLOUD_PROVIDERS.md) for model selection, API keys, sign-in flows, endpoint disclosure, credential storage, and failure recovery. Keep credentials in the operator environment or `~/.config/nexus/config.env` with mode 0600. Never commit keys, put them in task prompts, or use real keys in examples. Project `.env` files cannot choose a cloud destination.

## Permissions and execution boundary

The client executes workspace tools and shell commands with the current user's permissions. `--approve` / review mode prompts for edits and shell execution. Automatic approval is convenient but gives the configured model authority to request those actions; review consequential changes and command output yourself. `--read-only` refuses mutating tools and commands. In read-only mode, shell commands are limited to an allowlist of inspection commands and run only inside Bubblewrap, with no network, a cleared environment, and a read-only view of the workspace pinned when the session starts. On a host without a usable Bubblewrap (including a host that offers only Docker), read-only shell commands are refused rather than run unconfined; file reading and search tools still work. `--sandbox` can use a supported bubblewrap or Docker runtime; availability and guarantees vary by host, so do not treat the option name as proof of isolation. A running shell command cannot always be force-stopped after it has started.

Provider disclosure is explicit for cloud destinations. Local inference keeps task material on the configured endpoint and its own infrastructure. Credentials are scoped to provider origins and are not stored in session transcripts. Review [Cloud providers](CLOUD_PROVIDERS.md) before sending workspace content to a third party.

## Sessions, context, and recovery

Saved sessions and task state live under `~/.nexus/`. Use `/sessions`, `/resume [id]`, and `/export [md|json]` to inspect, resume, or export a session. Exports are written into the current workspace; inspect and protect them as source data. `/compact` summarizes older context to make room, while durable findings and the active plan are retained where supported. `/doctor` checks the current runtime; `nexus doctor --deep` performs a minimal inference probe and can incur model cost.

An interrupted or limited run is not a successful result. Read the final execution/outcome fields, run the project's verifier, and resume explicitly when needed. Recovery is bounded by saved session state and the provider's availability; it cannot reconstruct output the provider never returned.

## Troubleshooting and limits

Run `nexus doctor` first; use `nexus doctor --json` for a versioned report and `nexus doctor --deep` for live inference and read-only engine probes. See [doctor troubleshooting](DOCTOR_TROUBLESHOOTING.md).

The release package currently targets one platform only. The client depends on Node.js and an inference endpoint. Cloud providers can change authentication and endpoint behavior; unofficial sign-in options have provider-term limitations documented in the provider guide. Generated code and model output are untrusted; the client cannot guarantee correctness or safe behavior for arbitrary shell commands. Verification is only as strong as the verifier selected for a task.

## Development

Use [Development and release](DEVELOPMENT.md) for clean source builds, test commands, package creation, and tag-based publication. The root [LICENSE](../LICENSE) is MIT; package dependencies retain their own licenses and notices.
