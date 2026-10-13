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

`make test` runs the Rust and TypeScript suites and the repository security gates. The Cloudflare service has separate setup and tests; see [the contest entry](CLOUDFLARE_CONTEST.md).

## Release package

The current binary release target is **Linux x86-64 on glibc 2.35 or newer**, built on Ubuntu 22.04. Node.js 20+ is required at runtime. The archive contains the TypeScript client, production npm dependencies, `harness-core`, and `nexus-tui`; Rust/Cargo are not runtime requirements. No other OS, libc, or architecture is supported by the binary release yet.

Create and inspect a candidate locally:

```sh
bash scripts/package-linux.sh v1.2.1 ./release
bash scripts/smoke-package.sh ./release/nexus-linux-x86_64-v1.2.1.tar.gz
```

CI builds and uploads the same package on `main` and pull requests. A `vX.Y.Z` tag matching `package.json` triggers the controlled GitHub Release workflow. Do not create the tag until the candidate package and notes are accepted. Releases contain the versioned archive and `SHA256SUMS`.

The installer uses these stable URLs:

- `https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh`
- `https://github.com/mikeholownych/nexus-code/releases`

Before a release is published, the installer intentionally reports that no stable release exists.
