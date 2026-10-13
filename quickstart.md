# Nexus Code quickstart

Nexus Code is a local coding client. It is separate from the Cloudflare Workers and Artifacts collaboration service in the contest entry.

## Install

On Linux x86-64 with glibc 2.35 or newer and Node.js 20 or newer:

```sh
curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | sh
```

The installer downloads the matching versioned client archive and `SHA256SUMS` from this repository's GitHub Release, verifies the archive, and installs under `~/.local/lib/nexus`. It adds a `nexus` symlink in `~/.local/bin`; it does not edit shell startup files or use root. If `~/.local/bin` is not in `PATH`, add it yourself:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The command above follows the latest stable release and reports clearly when no stable release has been published. To install a specific published version, including a prerelease, pipe the same installer with `NEXUS_VERSION` set for the shell:

```sh
curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | NEXUS_VERSION=v0.1.0-alpha.1 sh
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

Use your endpoint's actual model ID. Do not put real credentials in a project `.env`, shell history, or this example. For a cloud provider and credential handling, see [Cloud providers](docs/CLOUD_PROVIDERS.md).

## First run

From a project directory:

```sh
nexus doctor
nexus
```

Enter a small task, review requested actions, and inspect the reported turn outcome. Use `nexus --help` and `/help` for implemented commands. To require human approval for edits and shell commands, start with `nexus repl --approve`.

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
