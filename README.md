# Nexus Code

Nexus Code is a local coding client and harness. It combines a TypeScript agent and sidecar with Rust workspace tools and a Ratatui terminal interface.

## Choose a path

- **[Install and use Nexus Code](quickstart.md)** — supported platform, one-line installer, configuration, and first task.
- **[Explore and reproduce the Cloudflare contest entry](docs/CLOUDFLARE_CONTEST.md)** — the collaboration service built with Cloudflare Workers and Artifacts, its source map, and judge guide.

The contest submission is the agent-collaboration service. Nexus Code is the separate client and harness used to demonstrate it.

## Install Nexus Code

```sh
curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | NEXUS_VERSION=v0.1.0-alpha.2 sh
```

This downloads and installs the published `v0.1.0-alpha.2` Linux x86-64 package under your home directory, verifies its SHA-256 checksum, and requires Node.js 20+. This is an early prerelease; see [release status and platform requirements](docs/DEVELOPMENT.md).

## Build and contribute

See [development and release procedures](docs/DEVELOPMENT.md), [client guide](docs/CLIENT_GUIDE.md), [provider setup](docs/CLOUD_PROVIDERS.md), and the [contest entry](docs/CLOUDFLARE_CONTEST.md).

The client sources are in `cli/` and `core/`. The Cloudflare service and fixture are in `experiments/cloudflare-artifacts-vertical-slice/`; demo orchestration is in `demo/`.

## Community and project policies

Read the [contribution guide](CONTRIBUTING.md), [support channels](SUPPORT.md), [security policy](SECURITY.md), [governance](GOVERNANCE.md), and [code of conduct](CODE_OF_CONDUCT.md). Track changes in [releases](https://github.com/mikeholownych/nexus-code/releases); development plans do not establish release readiness.
