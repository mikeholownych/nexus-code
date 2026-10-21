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

Without `NEXUS_VERSION`, the installer follows the latest stable release. No stable release is currently published, so pin a published prerelease to install Nexus Code:

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

Nexus reports `VERIFIED` only when its selected verifier passes and the operator has declared the product files for that task before it starts. For example: `nexus run --deliverable-file src/math.ts "Fix the addition defect"`; repeat `--deliverable-file` for each expected product file. The scope must use literal workspace-relative paths and cannot name tests. A passing suite without a declared scope is regression evidence (`REGRESSION_FREE`), not proof that the requested product change was verified. `UNVERIFIED`, `BLOCKED`, and `LIMIT_REACHED` remain distinct outcomes; a completed model response alone does not mean the work is correct.

Resuming a saved session or durable task keeps verification pending because local session and task files do not authenticate their own history. No generic verifier is currently trusted to clear that obligation after recovery: even an external test runner can execute workspace-controlled tests. A resumed task may continue, but it remains `UNVERIFIED`. Before starting a new task to establish a new baseline, the operator must review the workspace state, including ignored and untracked files and verifier/test definitions, and restore or remove any state that is not trusted. A clean Git status alone does not establish that ignored files or external acceptance inputs are trustworthy. A future verifier could replace this manual boundary only after its implementation and acceptance inputs are independently bound outside candidate control. A current-invocation `--authoritative-verifier` alone does not clear recovered obligations.

## Upgrade and remove

Check whether a newer release is published:

```sh
nexus upgrade --check
```

To upgrade in-place to the latest stable release:

```sh
nexus upgrade
```

To target or reinstall an exact pinned version:

```sh
nexus upgrade --version v1.0.0
```

Inside the interactive live TUI, run `/upgrade` or `/upgrade --check`. An upgrade requires deliberate modal confirmation before modifying the installation. In scripts or CI, non-interactive upgrades require `--yes`.

Alternatively, run the installer pipeline to reinstall or upgrade:

```sh
curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | NEXUS_VERSION=v1.0.0 sh
```

Removal is manual and limited to Nexus-owned paths:

```sh
rm "$HOME/.local/bin/nexus"
rm -rf "$HOME/.local/lib/nexus"
```

User configuration, credentials, sessions, and project `.nexus` data are retained.

## Build from source

See [Development and release](docs/DEVELOPMENT.md). Source builds require Rust, Cargo, Node.js 20+, npm, a C toolchain, and platform libraries. The release installer is the recommended path for supported Linux x86-64 systems.
