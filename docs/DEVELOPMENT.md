# Development and release

## Build and checks

Requirements: Rust stable/Cargo, Node.js 22+, npm, a C compiler/linker, and glibc development headers. Node.js 22 is the minimum supported runtime; end-of-life Node.js releases are not supported. From a clean checkout:

```sh
npm ci --prefix cli
cargo test --locked --manifest-path core/Cargo.toml
npm --prefix cli run build
npm --prefix cli test
bash scripts/security_gates.sh
```

`make build` compiles the Rust binaries and builds `cli/dist` (`npm --prefix cli run build`). `make test` runs the Rust and TypeScript suites and the repository security gates. The Cloudflare service has separate setup and tests; see [the contest entry](CLOUDFLARE_CONTEST.md).

## Release package

The current binary release target is **Linux x86-64 on glibc 2.35 or newer**, built on Ubuntu 22.04. Node.js 22 or newer is required at runtime. The archive contains the TypeScript client, production npm dependencies, `harness-core`, and `nexus-tui`; Rust/Cargo are not runtime requirements. No other OS, libc, or architecture is supported by the binary release yet.

Create and inspect a candidate locally. Set `NEXUS_VERSION` to the release tag being built; for an RC, use its RC tag, and for a stable release, use its stable tag:

```sh
: "${NEXUS_VERSION:?Set NEXUS_VERSION to the release tag, for example v1.0.0-rc.1 or v1.0.0}"
NEXUS_BUILD_CONTAINER_IMAGE="$(make -s -f Makefile -p 2>/dev/null | sed -n 's/^APPROVED_RUST_BUILD_IMAGE := //p')" \
  bash scripts/package-linux.sh "$NEXUS_VERSION" ./release
bash scripts/smoke-package.sh "./release/nexus-linux-x86_64-$NEXUS_VERSION.tar.gz"
```

Packaging builds the Rust binaries inside the approved, digest-pinned builder image (`APPROVED_RUST_BUILD_IMAGE` in the `Makefile`) and requires Docker. `scripts/package-linux.sh` exits with status 2 if `NEXUS_BUILD_CONTAINER_IMAGE` is unset or names any other image. `make verify-reproducibility` builds the package twice with that image and compares the archive, `SHA256SUMS`, notices and SBOM byte for byte. For a local, non-release build only, `NEXUS_ALLOW_HOST_RUST_BUILD=1` builds with the host Rust toolchain instead; such a package is not a release candidate.

The root `package.json` version is the single source of truth. After changing it, run `node scripts/sync-version.mjs` to update `cli/package.json`, its lockfile, `core/Cargo.toml` and `core/Cargo.lock`. CI and the release workflow run `node scripts/sync-version.mjs --check`, which fails on any drift or on a tag that does not match.

CI validates pull requests and `main`. A SemVer tag matching `package.json` triggers the controlled GitHub Release workflow; prerelease tags are marked prereleases. Releases contain the versioned archive and `SHA256SUMS`. Find the published stable release and any prereleases on the [GitHub Releases page](https://github.com/mikeholownych/nexus-code/releases).

The installer uses these stable URLs:

- `https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh`
- `https://github.com/mikeholownych/nexus-code/releases`

The no-version installer path follows the latest stable release. While only prereleases are published, use `NEXUS_VERSION` to pin a prerelease as shown in the [quickstart](../quickstart.md).
