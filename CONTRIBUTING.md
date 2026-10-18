# Contributing to Nexus Code

Welcome. Nexus Code combines a TypeScript agent and sidecar (`cli/`) with Rust workspace tools and a terminal UI (`core/`). Start with the [README](README.md), [development guide](docs/DEVELOPMENT.md), and [architecture](docs/ARCHITECTURE.md).

## Choose the right channel

- Reproducible defects and concrete feature proposals: [issues](https://github.com/mikeholownych/nexus-code/issues/new/choose).
- Setup questions and design exploration: [discussions](https://github.com/mikeholownych/nexus-code/discussions).
- Vulnerabilities: follow [SECURITY.md](SECURITY.md); do not post exploit details publicly.
- Community conduct: follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Search existing reports before opening a new one. Include the installed version, platform, reproduction steps, expected result, and redacted output. Never upload credentials, private repository contents, session archives, or private evaluation tasks.

## Agree on scope

For substantial changes, open a proposal before implementation. Keep pull requests focused and explain the user-visible problem and acceptance criteria. During v1 convergence, coordinate against [the roadmap](docs/v1.0.0/ROADMAP.md) and [concurrency protocol](docs/v1.0.0/CONCURRENCY.md). The integration branch is `v1/integration`; use it as the base for v1 work until maintainers announce otherwise. Other changes normally target `main`.

Read applicable `AGENTS.md` files. Agents and humans must preserve unrelated changes and existing comments. Use your own branch/worktree. Machine-local claims cannot coordinate separate clones: remote contributors should state their scope in the PR and check existing PRs for overlap.

## Build and validate

Use the supported environment and prerequisites in the development guide. Install locked CLI dependencies with `npm ci --prefix cli`, then run `make build` before `make test`; some tests consume the built binaries. Run focused tests while developing and relevant package/security checks before requesting review.

The complete suite needs Linux isolation facilities and security tools configured by the CI workflow. Do not disable isolation to obtain a pass. Report environmental blockers and exact commands/results. Tests and probes must use disposable user state; never point them at your normal `~/.nexus`. On a shared development host, acquire the documented `SUITE` claim before running any tests and use a committed snapshot for full suites.

Keep secrets out of logs. Do not use production credentials or inference services for tests without authorization. Local fixtures and deterministic regressions are preferred for failure cases.

## Submit a pull request

Include the problem, final behavior, linked requirements/issues, validation and limitations, compatibility/migration impact, and documentation changes. Add a regression test for meaningful behavior changes. Documentation-only changes need relevant link/configuration checks rather than unrelated product tests.

AI-assisted contributions are welcome. The contributor remains responsible for correctness, licensing, security, and understandable diffs. Record material agent assistance and independent review where relevant. Do not submit unreviewed generated changes or expose held-out evaluation material.

Maintainers review contributions as capacity permits; no response deadline is promised. Required checks must pass on the revision being integrated. Never bypass branch protections, rewrite published release tags, or treat code review as release qualification. Changes are contributed under the repository's [MIT license](LICENSE); no additional CLA or DCO is currently required.
