# Nexus Code quickstart

Nexus Code is a local coding client. It is separate from the Cloudflare Workers and Artifacts collaboration service in the contest entry.

## Install

On Linux x86-64 with glibc 2.35 or newer and Node.js 20 or newer:

```sh
curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | NEXUS_VERSION=v0.1.0-alpha.2 sh
```

The installer downloads the matching versioned client archive and `SHA256SUMS` from this repository's GitHub Release, verifies the archive, and installs under `~/.local/lib/nexus`. It adds a `nexus` symlink in `~/.local/bin`; it does not edit shell startup files or use root. If `~/.local/bin` is not in `PATH`, add it yourself:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The command above pins the current published prerelease. To follow the latest stable release after one is published, omit `NEXUS_VERSION`. To install another specific version, including a prerelease, set the desired tag:

```sh
curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | NEXUS_VERSION=v0.1.0-alpha.2 sh
```

For inspect-before-running, download [install.sh](https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh), read it, then run `sh install.sh`.

The release package includes the TypeScript client, production Node dependencies, `harness-core`, and the Ratatui `nexus-tui` binary. Node is an external runtime prerequisite. Current release support is limited to Linux x86-64/glibc; macOS, Windows, ARM, musl, and other architectures are not claimed.

## Configure an inference endpoint

Nexus works with an OpenAI-compatible local endpoint such as LM Studio or vLLM. Start that server and load a model first. For example:

```sh
mkdir -p "$HOME/.config/nexus"
chmod 700 "$HOME/.config/nexus"
cat > "$HOME/.config/nexus/config.env" <<'EOF'
LOCAL_LLM_ENDPOINT=http://localhost:1234/v1
LOCAL_LLM_MODEL=your-loaded-model
LOCAL_LLM_API_KEY=local
EOF
chmod 600 "$HOME/.config/nexus/config.env"
```

Use your endpoint's actual model ID. Nexus automatically discovers the loaded context window from LM Studio (`/api/v0/models`), llama.cpp (`/props`), vLLM (`/v1/models`), and Ollama (`/api/show`), or you can override it with `--context-limit` (`NEXUS_CONTEXT_LIMIT`). For HTTPS servers using a private certificate authority, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in `~/.config/nexus/config.env`. Do not put real credentials in a project `.env`, shell history, or this example. See [Local servers](docs/LOCAL_SERVERS.md) for per-server setup and [Cloud providers](docs/CLOUD_PROVIDERS.md) for cloud provider and credential handling.

## First run

From a project directory:

```sh
nexus doctor
nexus
```

Enter a small task, review requested actions, and inspect the reported turn outcome. On a terminal, running `nexus` with no arguments opens the live TUI; in non-interactive environments or with `nexus repl`, it opens the interactive REPL. For non-interactive tasks, run `nexus run "<task>"`. Use `nexus --help` and `/help` for implemented commands.

### Trust your own repository

By default, an untrusted workspace opens in `review` posture, asking for your explicit confirmation before executing shell commands, file modifications, network egress, or test suites.

If this is your own repository and you want autonomous execution, trust it:

```sh
nexus trust .
```

Once trusted, Nexus runs in `auto` posture. To force review mode regardless of trust, pass `--approve`. To run autonomously in CI or scripts without trusting the workspace permanently, pass `--yes` (or `--mode auto`, or set `NEXUS_APPROVAL_MODE=auto`).

Nexus reports `VERIFIED` only when its selected verifier passes. `UNVERIFIED`, `BLOCKED`, and `LIMIT_REACHED` are distinct outcomes; a completed model response alone does not mean the work is correct.

## Upgrade and remove

Run the same installer to reinstall or upgrade. Pin an upgrade with the `NEXUS_VERSION` pipeline form above. Removal is manual and limited to Nexus-owned paths:

```sh
rm "$HOME/.local/bin/nexus"
rm -rf "$HOME/.local/lib/nexus"
```

User configuration, credentials, sessions, and project `.nexus` data are retained.

## Build from source

See [Development and release](docs/DEVELOPMENT.md). Source builds require Rust, Cargo, Node.js 20+, npm, a C toolchain, and platform libraries. The release installer is the recommended path for supported Linux x86-64 systems.
