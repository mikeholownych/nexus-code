# Nexus Code Documentation Hub

Welcome to the **Nexus Code** documentation directory. This hub organizes all guides, architectural specifications, operating procedures, and design records for users, operators, and open-source contributors.

---

## Getting Started & Configuration

Quickly set up your environment, connect models, and start your first session:

| Guide | Description |
|---|---|
| [User Manual](USER_MANUAL.md) | Comprehensive reference for interactive TUI, REPL, execution postures, and approvals |
| [Quickstart Guide](../quickstart.md) | One-line installer, prerequisites, and running a first task |
| [Local Servers Setup](LOCAL_SERVERS.md) | Step-by-step setup for Ollama, vLLM, LM Studio, and llama.cpp |
| [Cloud Providers Guide](CLOUD_PROVIDERS.md) | Connecting Anthropic Claude, OpenAI, and custom OpenAI-compatible endpoints |
| [MCP Guide](MCP_GUIDE.md) | Configuring Model Context Protocol servers and exposing tools to the agent |
| [Skills & Plugins](SKILLS_AND_PLUGINS.md) | Extending the agent's capabilities with domain-specific skills |
| [Doctor & Troubleshooting](DOCTOR_TROUBLESHOOTING.md) | Diagnosing common sandbox, network, permission, and environment issues |

---

## Architecture & System Design

Deep-dive documentation on how Nexus Code operates under the hood:

| Document | Focus Area |
|---|---|
| [Architecture Reference](ARCHITECTURE.md) | High-level system topology, decoupled TypeScript/Rust model, and IPC protocol |
| [Client Guide](CLIENT_GUIDE.md) | Everyday CLI commands, providers, permissions, sessions and recovery, and troubleshooting |
| [Execution Convergence](EXECUTION_CONVERGENCE.md) | One lifecycle for autonomous work: execution paths, `/team` on the convergence foundation, completion propagation, restart |
| [Compaction & Continuity](COMPACTION_AND_CONTINUITY.md) | Long tasks with no step ceiling, progress tracking, compaction, context sizing, and restart |
| [State Compatibility](STATE_COMPATIBILITY.md) | Schema versioning and migration for tasks, sessions and checkpoints; persisted store locations and permissions |

---

## Git Operations & Worktrees

How Nexus Code safely isolates speculative work in clean git worktree checkouts:

| Document | Focus Area |
|---|---|
| [Worktrees Reference](WORKTREES.md) | Isolated named worktrees, branch switching, worktree lifecycle, and receipt verification |

---

## Development, Testing & Release

Guidelines for building, verifying, and packaging Nexus Code from source:

| Document | Focus Area |
|---|---|
| [Development Guide](DEVELOPMENT.md) | Build requirements, running local test gates (`make test`, `make test-ci`), and packaging |
| [Repository Quality Standards](REPOSITORY_QUALITY.md) | Repository administration and quality: branch-protection verification, dependency and automation boundaries |
| [Upgrade Security](UPGRADE_SECURITY.md) | Installer and upgrade security: origin and redirect validation, bounded downloads, provenance, rollback, publisher authenticity |
| [Releases Directory](releases/) | Release notes per version |

---

## Security & Governance

Core policies governing the project's operation and community interactions:

- [Security Policy](../SECURITY.md) — Responsible vulnerability disclosure guidelines.
- [Contributing Guidelines](../CONTRIBUTING.md) — Process for submitting issues and pull requests.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — Community conduct expectations.
- [Project Governance](../GOVERNANCE.md) — Maintainer model and project stewardship.
- [Support Channels](../SUPPORT.md) — Where to get help and ask questions.

---

## Historical Records

- [Cloudflare Contest Entry](CLOUDFLARE_CONTEST.md) — Documentation of the Cloudflare Workers collaboration service entry.
- [Historical System Evolution](HISTORICAL.md) — Historical requirement and qualification records (Issue #12).
