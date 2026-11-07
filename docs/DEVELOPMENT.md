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

`make build` compiles the Rust binaries and builds `cli/dist` (`npm --prefix cli run build`). `make test` runs the Rust suite, the CLI suite, the terminal-scope check and the repository security gates. It runs all four even when one fails, prints which step failed, and exits non-zero at the end.

### Local gate with the CI evaluator fixtures

CI runs the evaluator tests against a capped tmpfs and a public runtime directory, passed as `NEXUS_EVAL_TEST_WORKSPACE_ROOT` and `NEXUS_EVAL_TEST_RUNTIME_ROOT`. Without them `make test` prints a notice: `cli/test/eval_version_probe_storage.test.ts` fails, and `cli/test/eval_integrity.test.ts` runs its `/dev/shm` fallback branches. To run the same gate as CI locally (Linux, needs `sudo` for the mount):

```sh
make test-ci
```

`make test-ci` runs `scripts/with-ci-fixtures.sh`, which mounts a 128 MiB tmpfs at `/mnt/nexus-eval-ci` (mode 0711), creates `/opt/nexus-eval-ci-runtime` (mode 0711), exports both variables, runs `make test`, and unmounts and removes only what it created, including on failure or interrupt. It refuses to start if either path already exists or the tmpfs is already mounted, so it never touches fixtures it did not create. If you already provisioned those paths, export the two variables yourself and run `make test`. The host also needs the one-time CI setup: `scripts/install-evaluator-toolchains.sh`, `scripts/ensure-ci-bubblewrap.sh` and `scripts/ensure-ci-user-cgroups.sh`. Run the suite alone with `bash scripts/with-ci-fixtures.sh -- npm --prefix cli test`.

The Cloudflare service has separate setup and tests; see [the contest entry](CLOUDFLARE_CONTEST.md).

## Release package

The current binary release target is **Linux x86-64 on glibc 2.35 or newer**, built on Ubuntu 22.04. Node.js 22 or newer is required at runtime. The archive contains the TypeScript client, production npm dependencies, `harness-core`, and `nexus-tui`; Rust/Cargo are not runtime requirements. No other OS, libc, or architecture is supported by the binary release yet.

Create and inspect a candidate locally. Set `NEXUS_VERSION` to the release tag being built; for an RC, use its RC tag, and for a stable release, use its stable tag:

```sh
: "${NEXUS_VERSION:?Set NEXUS_VERSION to the release tag, for example v1.0.0-rc.1 or v1.0.0}"
NEXUS_BUILD_CONTAINER_IMAGE="$(sed -n 's/^APPROVED_RUST_BUILD_IMAGE := //p' Makefile)" \
  bash scripts/package-linux.sh "$NEXUS_VERSION" ./release
bash scripts/smoke-package.sh "./release/nexus-linux-x86_64-$NEXUS_VERSION.tar.gz"
```

Packaging builds the Rust binaries inside the approved, digest-pinned builder image (`APPROVED_RUST_BUILD_IMAGE` in the `Makefile`) by default. Unless `NEXUS_ALLOW_HOST_RUST_BUILD=1` is set, `scripts/package-linux.sh` exits with status 2 if `NEXUS_BUILD_CONTAINER_IMAGE` is unset; it always exits with status 2 if the variable names any other image. The release-tools install and license-notice generation also use an immutable, digest-pinned Node 24 image by default and require Docker, even when host Rust builds are enabled. For local packaging without Docker, set `NEXUS_RELEASE_TOOLS_NODE24_BIN` to a trusted Node 24.22.2 `bin` directory containing `node` and `npm` 11.19.1; the script checks both versions and uses that directory only for the release-tools install and notice command. The CLI install/build stays on the existing `PATH` (Node 22.22.1/npm 10.9.4 in release workflows). To package without Docker locally, also set `NEXUS_ALLOW_HOST_RUST_BUILD=1` and leave `NEXUS_BUILD_CONTAINER_IMAGE` unset. `make verify-reproducibility` uses the pinned Docker builder and compares the archive, `SHA256SUMS`, notices, SBOM and `install.sh` byte for byte. Host-built packages are not release candidates.

The root `package.json` version is the single source of truth. After changing it, run `node scripts/sync-version.mjs` to update `cli/package.json`, its lockfile, `core/Cargo.toml` and `core/Cargo.lock`. CI and the release workflow run `node scripts/sync-version.mjs --check`, which fails on any drift or on a tag that does not match.

CI validates pull requests and `main`. A SemVer tag matching `package.json` triggers the controlled GitHub Release workflow; prerelease tags are marked prereleases. Releases contain the versioned archive and `SHA256SUMS`. Find the published stable release and any prereleases on the [GitHub Releases page](https://github.com/mikeholownych/nexus-code/releases).

The installer uses these stable URLs:

- `https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh`
- `https://github.com/mikeholownych/nexus-code/releases`

The no-version installer path follows the latest stable release. While only prereleases are published, use `NEXUS_VERSION` to pin a prerelease as shown in the [quickstart](../quickstart.md).
