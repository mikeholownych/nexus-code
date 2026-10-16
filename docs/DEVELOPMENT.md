# Development and release

## Build and checks

Requirements: Rust stable/Cargo, Node.js 20+, npm, a C compiler/linker, and glibc development headers. From a clean checkout:

```sh
npm ci --prefix cli
cargo test --locked --manifest-path core/Cargo.toml
npm --prefix cli run build
npm --prefix cli test
bash scripts/security_gates.sh
```

`make build` compiles the Rust binaries and builds `cli/dist` (`npm --prefix cli run build`). `make test` runs the Rust and TypeScript suites and the repository security gates. The Cloudflare service has separate setup and tests; see [the contest entry](CLOUDFLARE_CONTEST.md).

## Release package

The current binary release target is **Linux x86-64 on glibc 2.35 or newer**, built on Ubuntu 22.04. Node.js 20+ is required at runtime. The archive contains the TypeScript client, production npm dependencies, `harness-core`, and `nexus-tui`; Rust/Cargo are not runtime requirements. No other OS, libc, or architecture is supported by the binary release yet.

Create and inspect a candidate locally:

```sh
bash scripts/package-linux.sh v0.1.0-alpha.2 ./release
bash scripts/smoke-package.sh ./release/nexus-linux-x86_64-v0.1.0-alpha.2.tar.gz
```

The root `package.json` version is the single source of truth. After changing it, run `node scripts/sync-version.mjs` to update `cli/package.json`, its lockfile, `core/Cargo.toml` and `core/Cargo.lock`. CI and the release workflow run `node scripts/sync-version.mjs --check`, which fails on any drift or on a tag that does not match.

CI validates pull requests and `main`. A SemVer tag matching `package.json` triggers the controlled GitHub Release workflow; prerelease tags are marked prereleases. Releases contain the versioned archive and `SHA256SUMS`. The current published candidate is [`v0.1.0-alpha.2`](https://github.com/mikeholownych/nexus-code/releases/tag/v0.1.0-alpha.2).

The installer uses these stable URLs:

- `https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh`
- `https://github.com/mikeholownych/nexus-code/releases`

The no-version installer path follows the latest stable release. While only prereleases are published, use `NEXUS_VERSION` to pin a prerelease as shown in the [quickstart](../quickstart.md).
