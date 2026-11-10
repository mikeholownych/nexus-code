# Nexus Code Documentation Hub

Welcome to the **Nexus Code** documentation directory. This hub organizes all guides, architectural specifications, operating procedures, and design records for users, operators, and open-source contributors.

---

## 🚀 Getting Started & Configuration

Quickly set up your environment, connect models, and start your first session:

| Guide | Description |
|---|---|
| [User Manual](USER_MANUAL.md) | Comprehensive reference for interactive TUI, REPL, execution postures, and approvals |
| [Quickstart Guide](../quickstart.md) | One-line installer, prerequisite validation, and running tasks in 60 seconds |
| [Local Servers Setup](LOCAL_SERVERS.md) | Step-by-step setup for Ollama, vLLM, LM Studio, and llama.cpp |
| [Cloud Providers Guide](CLOUD_PROVIDERS.md) | Connecting Anthropic Claude, OpenAI, and custom OpenAI-compatible endpoints |
| [MCP Guide](MCP_GUIDE.md) | Configuring Model Context Protocol servers and exposing tools to the agent |
| [Skills & Plugins](SKILLS_AND_PLUGINS.md) | Extending the agent's capabilities with domain-specific skills |
| [Doctor & Troubleshooting](DOCTOR_TROUBLESHOOTING.md) | Diagnosing common sandbox, network, permission, and environment issues |

---

## 🏗️ Architecture & System Design

Deep-dive documentation on how Nexus Code operates under the hood:

| Document | Focus Area |
|---|---|
| [Architecture Reference](ARCHITECTURE.md) | High-level system topology, decoupled TypeScript/Rust model, and IPC protocol |
| [Client Guide](CLIENT_GUIDE.md) | Internals of the TypeScript agent brain, REPL, and sidecar event loop |
| [Execution Convergence](EXECUTION_CONVERGENCE.md) | Turn state machines, deterministic action loops, and invariant verification |
| [Compaction & Continuity](COMPACTION_AND_CONTINUITY.md) | Context budgeting, live prompt compaction, and long-running task persistence |
| [State Compatibility](STATE_COMPATIBILITY.md) | Schema versioning for checkpoints, turn journals, and backward-compatible state restoration |

---

## 🌲 Git Operations & Worktrees

How Nexus Code safely isolates speculative work in clean git worktree checkouts:

| Document | Focus Area |
|---|---|
| [Worktrees Reference](WORKTREES.md) | Isolated named worktrees, branch switching, worktree lifecycle, and receipt verification |

---

## 🛠️ Development, Testing & Release

Guidelines for building, verifying, and packaging Nexus Code from source:

| Document | Focus Area |
|---|---|
| [Development Guide](DEVELOPMENT.md) | Build requirements, running local test gates (`make test`, `make test-ci`), and packaging |
| [Repository Quality Standards](REPOSITORY_QUALITY.md) | Code style, static analysis, type checking, and clippy guidelines |
| [Upgrade Security](UPGRADE_SECURITY.md) | Safe dependency upgrades, vulnerability auditing, and SBOM maintenance |
| [Releases Directory](releases/) | Version release notes, qualification records, and changelog archives |

---

## 🔐 Security & Governance

Core policies governing the project's operation and community interactions:

- [Security Policy](../SECURITY.md) — Responsible vulnerability disclosure guidelines.
- [Contributing Guidelines](../CONTRIBUTING.md) — Process for submitting issues and pull requests.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — Contributor Covenant community expectations.
- [Project Governance](../GOVERNANCE.md) — Maintainer model, RFC processes, and project stewardship.
- [Support Channels](../SUPPORT.md) — Where to get help and ask questions.

---

## 📜 Historical Records

- [Cloudflare Contest Entry](CLOUDFLARE_CONTEST.md) — Documentation of the Cloudflare Workers collaboration service entry.
- [Historical System Evolution](HISTORICAL.md) — Early project milestones and architectural evolution.
