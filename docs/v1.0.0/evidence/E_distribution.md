# Scope E: distribution, release, CI, diagnostics, maintainability

Auditor: scope E agent, 2026-10-14. Repo HEAD db1ca55. Published releases are v0.1.0-alpha.1 (61057cf) and v0.1.0-alpha.2 (a2e94f3). Both are prereleases, and no stable release exists.

## 1. Coverage ledger

| File | Method |
|---|---|
| install.sh | full read + RUNTIME (6 install runs, scratch HOMEs, + docker ubuntu:22.04) |
| harness.sh | full read |
| Makefile, package.json, cli/package.json | full read |
| cli/package-lock.json | `npm audit` (prod + all) in snapshot; not line-read |
| core/Cargo.toml / Cargo.lock | full read / `cargo tree -d` |
| scripts/package-linux.sh, smoke-package.sh, installer-smoke.sh, package-smoke-*.{py,mjs}, security_gates.sh, audit_rust_deps.py, generate_sbom.sh, token_accounting.py | full read |
| cli/scripts/write_build_info.mjs | full read |
| .github/workflows/ci.yml, release.yml | full read + `gh run list/view --log` (CI run 38540767677) |
| .gitlab-ci.yml | full read |
| LICENSE, README.md, quickstart.md, docs/DEVELOPMENT.md, docs/releases/*.md | full read |
| cli/src/doctor.ts | targeted read (lines 90-110, 180-200, 300-530, 540-650 grep, 745-760) + RUNTIME |
| cli/src/index.ts | read 1-340, 730-757; command list via grep |
| cli/src/build_identity.ts, tui.ts (launchInteractive) | targeted read |
| cli/src/diagnostics.ts | skim. This is the compiler-output parser used by agent.ts/tester.ts, not the doctor. |
| cli/src/operation_cli.ts, provider_cli.ts | command names only (grep). The doctor redaction path was exercised at RUNTIME. |
| docs/DOCTOR_TROUBLESHOOTING.md | targeted read + check-ID cross-reference against doctor.ts |
| docs/DOCTOR_TROUBLESHOOTING_DESIGN_PLAN.md | excluded (design history, not product behaviour) |
| docs/USER_MANUAL.md | targeted (launch section lines 8-32), because launcher behaviour is in scope |
| cli/dist (tracked, 86 files) | diffed `git archive HEAD cli/dist` against the snapshot's fresh `npm run build` |
| Published release assets | `gh release view` + installed and executed |

## 2. Architecture / data flow

- **Release pipeline.** A tag `v*.*.*` triggers `release.yml`. The workflow checks that the tag commit is an ancestor of origin/main and that the tag matches `package.json` version. It then runs `npm ci`, the cli build, `cargo test --locked`, the release build, `npm test`, and security_gates. Next it runs `package-linux.sh` twice and `cmp`s the outputs (a reproducibility check), then `smoke-package.sh` and `installer-smoke.sh`. Finally `softprops/action-gh-release` uploads `nexus-linux-x86_64-<tag>.tar.gz` + `SHA256SUMS`, setting prerelease when the tag contains `-`. Release notes come from `generate_release_notes`; `docs/releases/*.md` is not used.
- **Package layout.**
  - `nexus/bin/nexus` is a sh launcher that sets `NEXUS_HOME` and execs `node lib/cli/dist/index.js "$@"`.
  - `lib/cli/{dist,node_modules(prod),package*.json}`
  - `lib/core/{harness-core,nexus-tui}`
  - `LICENSE`, `VERSION`
  - Node is not bundled. The binaries need GLIBC ≤ 2.34.
- **Installer.**
  - Trust boundaries: the raw GitHub `main` script, then the GitHub API (`/releases/latest`), then release download.
  - The SHA256SUMS file comes from the same origin as the archive. This gives integrity only; there is no signature or provenance.
  - It installs to `$PREFIX/lib/nexus/<tag>` and atomically swaps the `$PREFIX/bin/nexus` symlink.
  - It refuses to touch a non-symlink `nexus` or a symlink pointing outside `$PREFIX/lib/nexus`.
  - Old versions are kept, so rollback means re-running with the older tag.
- **Two launchers with different grammars:**
  - **Checkout `harness.sh`** (the developer's `/usr/local/bin/nexus`):
    - With no args, it starts the live Ratatui TUI (`nexus-tui --live --sidecar`).
    - Unknown first word → `run <words>`, i.e. an agent task.
  - **Packaged `bin/nexus`:**
    - With no args, it starts the readline REPL (index.ts:747-749).
    - Unknown words are a commander error.
    - There is no live-TUI route.
- **Doctor** (cli/src/doctor.ts). Checks run in parallel, each with its own deadline. `NEXUS_HOME` switches it between packaged and checkout semantics. Output is text, or JSON with schemaVersion 2. Exit codes: 0 healthy, 1 warnings, 2 at least one fail, 3 the doctor itself crashed. `--fix` covers only three repair kinds (mkdir 0700, chmod dir 0700, chmod credentials 0600). It writes a backup manifest under `~/.nexus/doctor-backups` and asks for confirmation unless `--yes` is given. All output goes through `redactDiagnostic`.

## 3. Findings

| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| REL-01 | S2 | install → first run | scripts/package-linux.sh:24-30; cli/src/index.ts:747-749; harness.sh:21-38 | RUNTIME. Installed `nexus` (no args) opens the readline REPL. `nexus --live` → `error: unknown option '--live'`. The packaged launcher has no route to the live TUI (`nexus-tui --live --sidecar`), although nexus-tui and sidecar.js are shipped and doctor reports `PASS tui.build: The live TUI ... built`. | Release users never get the primary UI that the developer uses and that the PTY tests cover. The shipped product is a different product from the tested daily driver. The doctor's PASS is misleading. | Make the packaged launcher equal to harness.sh: same routing, and live TUI when there are no args and a TTY. Add a smoke test that the package launches `--live` in a PTY. |
| REL-02 | S2 | docs → CLI | docs/USER_MANUAL.md:12-26 vs index.ts commands | RUNTIME. On the installed alpha.2, `nexus --approve` → `unknown option '--approve'` and `nexus -r` → `unknown option '-r'`. Through harness.sh they reach `run --approve`/`run -r`, which also fail (run requires a prompt and has no --approve). Quickstart uses the correct `nexus repl --approve`. | The documented resume and approval entry points fail on first use. | Accept the REPL flags at the top level, or fix the manual. Add a docs-command test that runs every fenced `nexus ...` line with `--help`. |
| REL-03 | S2 | dev launcher safety | harness.sh:39-42 | SOURCE. The routed-subcommand whitelist omits `trust, flights, replay, worktrees, stage, eval, knowledge, browse, operation, status, decide, resume, verify`. Any other first word falls to `run "$@"`, which starts an autonomous agent task with write tools. For example, `nexus trust .` or `nexus worktrees` become prompts to the model. The packaged launcher errors on the same input instead. | A mistyped or unlisted admin command starts an edit-capable agent in the cwd on the checkout launcher. Per orchestrator facts, the user's `/usr/local/bin/nexus` is the checkout launcher. Two launchers mean two grammars. | Replace the hand list with a query of commander's registered commands (or `index.js --list-commands`). Require explicit `run` for free text, or confirm before free text becomes a task. |
| REL-04 | S2 | versioning | core/Cargo.toml:3 (`1.2.1`) vs package.json:3 / cli/package.json:3 (`0.1.0-alpha.2`); doctor.ts:491-492; local tags v1.1.0/v1.2.0/v1.2.1 | RUNTIME. A fresh clean install gives `WARN engine.binary: The engine reports version 1.2.1, the CLI 0.1.0-alpha.2 → Rebuild with make build`. Every release user sees a warning, and its remedy is impossible in a packaged install (there is no Makefile). Local v1.x tags (not on origin, not ancestors of main, no release.yml at those commits, so not publishable by accident) conflict with the future v1.0.0 ordering. | A permanent false warning on a healthy install trains users to ignore doctor. Version identity is inconsistent across components. | Single-source the version: release workflow asserts Cargo.toml == package.json == cli/package.json == tag. Delete stale local v1.x tags. Make doctor remedies context-aware (packaged → "reinstall"). |
| REL-05 | S2 | compliance | scripts/package-linux.sh:22; release assets | RUNTIME + SOURCE. The archive contains only the project LICENSE. About 150 Rust crates are statically linked (Cargo.lock: 152 packages, MIT/Apache-2.0 etc.), and there is no third-party notice for them. Node deps ship their own LICENSE files (20 found). No SBOM is published. | MIT/Apache attribution obligations are not met for redistributed binaries. Enterprise intake (SBOM) is blocked. | Generate THIRD_PARTY_NOTICES (cargo-about / cargo-deny licenses + npm license list) and a real lockfile-based SBOM, and attach both to releases. |
| REL-06 | S3 | supply chain | scripts/generate_sbom.sh:32-94 | SOURCE. The "CycloneDX SBOM" lists only direct deps, with versions taken from package.json/Cargo.toml *ranges* (`^12.1.0` → `12.1.0`), not lockfile resolutions. Transitive deps are omitted. It includes a wall-clock timestamp and a random serial. It is not run in CI or release. | Anyone relying on `make sbom` gets wrong component versions. | Replace it with `cyclonedx-npm` + `cargo cyclonedx` driven from lockfiles, and run it in release. |
| REL-07 | S3 | security gate | scripts/audit_rust_deps.py:13-87; security_gates.sh:84-97 | SOURCE + RUNTIME (CI log). The fallback "RustSec advisory database" is 9 hard-coded 2020-2023 advisories, yet it prints "Scanned N packages against RustSec advisory database … clean". In GitHub CI, cargo-audit is preinstalled on the runner image and the real scan ran (CI log: "Loaded 1310 security advisories … 152 crate dependencies"). Locally, or if the runner image changes, the toy fallback silently passes. | False assurance outside CI. CI depends on an undeclared runner-image tool. | Delete the fallback and fail when cargo-audit is absent. Install cargo-audit (or cargo-deny) explicitly with `--locked` in workflows. |
| REL-08 | S3 | installer, latest path | install.sh:21-24 | RUNTIME. Without NEXUS_VERSION: `curl: (22) ... 404` / `nexus installer: could not find latest stable release.` (only prereleases exist). The same message appears for API rate-limit (60/h unauthenticated) or network failure. There is no hint to set NEXUS_VERSION and no list of available prereleases. | The first-time "omit version" path fails opaquely until v1.0.0 exists, and later under rate limiting. | Tell the 404 apart from other errors. On 404 say "no stable release yet; use NEXUS_VERSION=vX (latest prerelease: …)". Fall back to the `releases/latest/download` redirect, which avoids the API. |
| REL-09 | S3 | integrity | install.sh:33-35; release.yml:44-48 | SOURCE. SHA256SUMS is fetched from the same release as the archive. There is no signature, cosign/sigstore, or GitHub build-provenance attestation, and the installer script itself is served from mutable `main`. | A compromise of the release or repo is not detectable. The checksum only protects against transport corruption. | v1: add `actions/attest-build-provenance` (verifiable with `gh attestation verify`), or minisign/cosign signatures. Offer an installer pinned to a tag URL. |
| REL-10 | S3 | installer, reinstall/repair | install.sh:48-49 | SOURCE + RUNTIME. When the version dir already exists, the verified archive is discarded and the existing tree is reused after checking only 3 executables + VERSION. A corrupted or partially edited install (e.g. deleted dist files) cannot be repaired by re-running the installer. Versions accumulate forever with no prune (two versions measured at 14M+15M). | Reinstall is not a repair path. Disk use grows. | Compare a manifest hash, or reinstall into a temp dir and swap. Add `NEXUS_FORCE=1`. Document or implement uninstall/prune (`nexus self uninstall`). |
| REL-11 | S4 | installer input validation | install.sh:26 | RUNTIME. `case v[0-9]*.[0-9]*.[0-9]*` accepts `v1.2.3/../../x`. That string flows into the URL and into `VERSION_DIR="$PREFIX/lib/nexus/$VERSION"`, though the run failed at download. The input is user-controlled only. | Low. Path traversal is possible if combined with a malicious base URL. | Use a strict SemVer regex via `grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'`. |
| REL-12 | S4 | installer UX | install.sh:32-33 | RUNTIME. `curl -fL` without `-s` prints two progress meters inside a `curl \| sh` pipeline. The PATH hint prints the expanded absolute path. The failure message on Ubuntu 22.04 (distro node v12.22.9) is correct but gives no install pointer. | Cosmetic. | Use `-fsSL --show-error`. Link Node 20 install docs. |
| REL-13 | S3 | CI coverage | .github/workflows/ci.yml:41-66; release.yml | SOURCE + RUNTIME (CI log). There is one OS/arch (ubuntu-22.04 x86_64) and Node 20 only on GitHub; Node 22/24 is not tested, while the developer runs 24.21.0. Rust uses `dtolnay/rust-toolchain@stable`, with no `rust-toolchain.toml` and no `rust-version` in Cargo.toml, so the toolchain floats. There is no `engines` field in package.json. Nothing asserts that tracked `cli/dist` equals a build of `cli/src`. There is no musl/arm/macOS, which matches the docs. Positive: the PTY e2e suites run in CI (905 tests, 0 skipped). | Breakage on newer Node or a future stable Rust is caught late. Reproducibility depends on whatever "stable" is on release day. | Add a Node matrix (20, 22, 24). Pin the toolchain file and MSRV. Add an `engines` field. Add a `git diff --exit-code cli/dist` step after the build. |
| MNT-01 | S3 | maintainability | cli/dist (86 tracked files) | MEASUREMENT. HEAD's tracked dist is byte-identical to a fresh build of HEAD src (`diff -rq`: only the untracked build-info.json differs). It is currently in sync, but nothing enforces this (see REL-13), and every src change produces a large generated diff. | Staleness risk. Review noise. | Enforce it in CI, or stop tracking dist. The package already builds dist itself. |
| MNT-02 | S4 | maintainability | .gitlab-ci.yml | SOURCE. A GitLab pipeline remains (Node 24, rust 1.89), but the origin is GitHub-only, and it diverges from the GitHub workflow (no packaging, installer, or repro checks). | A dead config misleads contributors. | Delete it or mark it as a mirror. |
| MNT-03 | S4 | maintainability | Makefile:36-45 | SOURCE. `verify-reproducibility` writes fixed `/tmp/nexus-repro-{1,2}` and covers only cli/dist, not the release tarball. The real check lives in the workflows (`cmp` of two package builds, same machine and same toolchain). | Weak local repro check. Cross-machine reproducibility is not proven. | Point the target at `package-linux.sh` twice + `cmp`, using mktemp. |
| MNT-04 | S4 | naming | cli/package.json:2,8 (`local-code-harness`, bin `harness`); package.json:2 (`nexus-code-harness`); index.ts:63 `.name("harness")` | RUNTIME. `nexus --help` prints `Usage: harness [options] [command]`. | Confusing identity in help and errors. | Set the program name to `nexus` and unify package names. |
| MNT-05 | S4 | changelog | docs/releases/*.md; release.yml:47 | SOURCE + RUNTIME. The GitHub release bodies are only "Full Changelog: compare…". The curated notes in docs/releases are not attached, and there is no CHANGELOG.md. | Users on GitHub do not see known limits or breaking changes (e.g. `spawn_subagent max_steps` removed). | Use `body_path: docs/releases/${tag}.md`, and fail the release if the file is missing. |
| MNT-06 | S4 | deps | core/Cargo.lock | MEASUREMENT. `cargo tree -d`: duplicate hashbrown 0.16/0.17, syn 2/3, thiserror 1/2. `npm audit` (prod and all): 0 vulnerabilities. | Minor binary bloat. | No action for v1. |
| DX-01 | S3 | doctor | doctor.ts:751,757 (runCheck adds 2 listeners per check to parent signal) | RUNTIME. Every `nexus doctor` run, including `--json`, prints `MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal]` on stderr. | The health tool's first output line looks like a bug. It pollutes stderr for scripted use. | Remove the listeners in finally, or `events.setMaxListeners(n, signal)`. Add a test asserting empty stderr. |
| DX-02 | S3 | doctor (packaged) | doctor.ts:332, 492, 316, 520 | RUNTIME + SOURCE. In a packaged install the remedies point at checkout artifacts: "Optionally link …/v0.1.0-alpha.2/harness.sh into a PATH directory" (that file does not exist in the package; seen with `~/.local/bin` off PATH), "Rebuild with `make build`", and "Run `make build`". | Wrong instructions on the supported install path. | Branch every remedy on `PACKAGED_HOME`. Packaged remedies: add `~/.local/bin` to PATH, re-run the installer. |
| DX-03 | S3 | doctor redaction | doctor.ts:103-110 → redactSecrets | RUNTIME. `workspace.access` and the effective-config `workspace` are shown as `[REDACTED:HIGH_ENTROPY_STRING]` for a path containing a UUID-like segment. Secrets were correctly redacted: env key, `-k`, URL userinfo, and `?api_key=` all had 0 occurrences. | Over-redaction hides the one value a user needs (which workspace). It is common with UUID or hash paths. | Exempt paths from entropy redaction, or redact only path segments that match a credential shape. |
| DX-04 | S3 | doctor coverage | doctor.ts (no check on ~/.config/nexus/config.env mode) | RUNTIME. A `config.env` containing `LOCAL_LLM_API_KEY` at mode 644 produced no warning. Only credentials.json is checked (line 644). Quickstart tells users to chmod 600. | A world-readable API key goes unflagged. | Add a `config.env` permission check with the same narrow chmod-600 repair. |
| DX-05 | S4 | doctor | doctor.ts:517-529 | RUNTIME. `PASS tui.build` in a packaged install, even though that install cannot launch the live TUI (REL-01). | Misleading. | Fix together with REL-01. |

## 4. Reproductions (trimmed)

```
# clean HOME, documented command (Node 20.20.2 at /usr/bin/node)
env -i HOME=$S/h1 PATH=/usr/bin:/bin TMPDIR=$S bash -c 'curl -fsSL https://raw.githubusercontent.com/mikeholownych/nexus-code/main/install.sh | NEXUS_VERSION=v0.1.0-alpha.2 sh'
→ [two curl progress meters] Installed Nexus Code v0.1.0-alpha.2 in $S/h1/.local/lib/nexus/v0.1.0-alpha.2
  Add this to your shell profile if needed: export PATH="$S/h1/.local/bin:$PATH"
  0.1.0-alpha.2 (a2e94f306640)                       exit 0
# omit NEXUS_VERSION
→ curl: (22) The requested URL returned error: 404 / nexus installer: could not find latest stable release.   exit 1, HOME untouched
# NEXUS_VERSION=v9.9.9 → nexus installer: download failed for nexus-linux-x86_64-v9.9.9.tar.gz.  HOME untouched
# NEXUS_VERSION=0.1.0-alpha.2 → version must be a release tag like v1.2.3.
# NEXUS_VERSION='v1.2.3/../../x' → passes validation, fails at download (REL-11)
# docker ubuntu:22.04, no node → "Node.js 20 or newer is required; install Node.js and retry." exit 1
#   + apt nodejs (v12.22.9) → "Node.js 20 or newer is required (found v12.22.9)." exit 1
# upgrade/rollback in $S/h4: alpha.1 → alpha.2 → alpha.1 : symlink swaps correctly each time; both version dirs retained
nexus doctor   (fresh HOME, no config, no server; exit 2)
  (node) MaxListenersExceededWarning: ... 11 abort listeners added to [AbortSignal]     ← DX-01
  9 pass · 3 warn · 1 fail · 6 skipped
  FAIL endpoint.reachable ... ECONNREFUSED ... → Start the local model server ...
  WARN engine.binary: The engine reports version 1.2.1, the CLI 0.1.0-alpha.2. → Rebuild with `make build`.   ← REL-04/DX-02
  PASS workspace.access ... · [REDACTED:HIGH_ENTROPY_STRING]                                                ← DX-03
  SKIP runtime.launcher ... → Optionally link .../v0.1.0-alpha.2/harness.sh into a PATH directory            ← DX-02
nexus doctor --fix </dev/null → "2 repair(s) proposed; none applied without confirmation. Re-run with --yes"
nexus doctor --fix --yes (x2) → APPLIED state.create x2 ; second run "Repairs: none needed."   (idempotent)
chmod 777 sessions; credentials.json 644 → --fix --yes → 700 / 600, backup manifest written with previousMode
Secret probe: LOCAL_LLM_API_KEY, -k sk-..., http://bob:<pw>@host/v1?api_key=<t> → 0 leaks in text+JSON
config.env with key at 0644 → no finding (DX-04)
nexus --live → error: unknown option '--live'      (REL-01)
nexus --approve → error: unknown option '--approve'; nexus -r → error: unknown option '-r'   (REL-02)
nexus --help → "Usage: harness [options] [command]"   (MNT-04)
diff -rq <git archive HEAD cli/dist> snap/cli/dist → Only in snap: build-info.json   (MNT-01)
gh run view 38540767677 --log: "# tests 905 # pass 905 # skipped 0"; cargo audit "Loaded 1310 security advisories ... 152 crate dependencies"
```

## 5. Strengths (with evidence)

- **Installer is safe by default.** It installs as non-root under `$HOME/.local`, never edits shell rc files, and never overwrites a foreign `nexus` (install.sh:41-47; covered by installer-smoke.sh:48-51). Checksum failure leaves the existing install unchanged (installer-smoke.sh:43-46). The symlink swap is atomic (`ln` + `mv -f`). Failures leave HOME untouched (RUNTIME, h2/h3).
- **Clear prerequisite failures.** Unsupported platform, Node missing or too old, and curl/tar/sha256sum missing each produce a clear message (RUNTIME, docker).
- **Upgrade and rollback work** by re-running the installer with the tag (RUNTIME). Versioned dirs make rollback instant.
- **Strong release gating.**
  - The tag must be on main and match package.json (release.yml:27-31).
  - The full test suite, including PTY TUI e2e, runs before publish (CI log: 905/905).
  - Two package builds are `cmp`-compared for byte reproducibility.
  - Package smoke runs inference against a fixture server.
  - Installer smoke covers install, reinstall, upgrade, bad checksum and conflict.
  - Published assets match the docs (2 assets each; alpha.1 and alpha.2 marked prerelease; `gh release view`).
- **Dependency hygiene.** `--locked` cargo, `npm ci`, and an `--omit=dev` package. `npm audit` is clean, and real `cargo audit` runs in CI.
- **Doctor is well built.** It runs with no config, no model and no session. It has a versioned JSON schema and distinct exit codes. Redaction held for env, flag, URL userinfo and query secrets. Repairs are narrow (3 kinds), confirmation-gated (non-TTY refuses without `--yes`), idempotent and backed up. They use verified chmod/mkdir helpers (safe_fs `chmodVerified` with identity expectation).
- **Build identity.** `nexus --version` shows version + commit, and the build-info is deterministic (no wall-clock time).

## 6. Qualification gaps

- **Cross-machine reproducibility is unproven.** The CI repro check runs on the same runner with the same toolchain. To qualify: build the tag on two different machines or runner images with a pinned toolchain, then `cmp` the tarballs and the published SHA256SUMS.
- **Install on other glibc distros (Debian 12, Fedora, RHEL 9) and with Node 22/24 is not run.** To qualify: run a docker matrix of the documented command, then `nexus doctor --json` and the package smoke.
- **Doctor `--deep` was not exercised** (it needs a model). To qualify: run against the fixture `scripts/package-smoke-server.mjs` with `LOCAL_LLM_ENDPOINT` and check that `inference.verified` passes and that redaction holds in the deep evidence.
- **Behaviour when the installer is interrupted mid-mv, and concurrent installs, are untested.** To qualify: kill the installer between `mv "$PACKAGE"` and the link swap, re-run, and verify recovery.
- **Licence obligations are not inventoried.** To qualify: `cargo about generate` / `cargo deny check licenses` + `npx license-checker --production`.
- **The `doctor --fix` symlink-swap race (TOCTOU) was not attacked.** Source shows an identity expectation (`expect: identityOf`), but it was not tested here. To qualify: replace the dir with a symlink between diagnose and confirm, and expect a refusal.

## 7. Proposed v1.0.0 requirements

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| E-R1 | The packaged `nexus` has the same command grammar and default UI as the checkout launcher: live TUI with no args on a TTY, REPL otherwise. | workflow | BLOCKER | A PTY test against the installed package: `nexus` renders the TUI frame; `nexus --repl` gives the REPL. |
| E-R2 | Every `nexus …` command in README, quickstart and USER_MANUAL runs (or `--help`s) without "unknown option/command" on the packaged install. | workflow/docs | BLOCKER | A CI script extracts the fenced commands and runs each with `--help` against the package. |
| E-R3 | One version everywhere: tag == package.json == cli/package.json == Cargo.toml. A fresh install's doctor shows no version warning. | compat | BLOCKER | A release.yml assertion, plus smoke-package asserting no `warn` on `engine.binary`. |
| E-R4 | The checkout launcher never turns an unrecognized subcommand into an agent task without an explicit `run` or a prompt-like argument. | safety | RELEASE-REQUIRED | `harness.sh trust .` → routes to trust; `harness.sh notacmd` → error. |
| E-R5 | Releases ship THIRD_PARTY_NOTICES and a lockfile-derived SBOM. | compliance | RELEASE-REQUIRED | Release assets include both. Notices cover 100% of Cargo.lock and prod npm packages. |
| E-R6 | Release provenance: signed or attested assets, and the installer can verify them. | supply chain | RELEASE-REQUIRED | `gh attestation verify nexus-linux-x86_64-v1.0.0.tar.gz -R mikeholownych/nexus-code` passes. |
| E-R7 | The no-version installer resolves v1.0.0 as latest stable. Errors distinguish "no stable release", "rate-limited" and "network". | workflow | RELEASE-REQUIRED | After v1.0.0 is published, the documented command without NEXUS_VERSION installs it. A simulated 404 or 403 shows distinct messages. |
| E-R8 | Doctor stderr is clean, and its remedies are valid for the install type. | DX | RELEASE-REQUIRED | Packaged doctor test: stderr empty; no remedy mentions `make` or `harness.sh` when NEXUS_HOME is set. |
| E-R9 | Doctor flags a group- or world-readable config.env that holds credentials, and offers a confirmed chmod 600. | safety | RELEASE-REQUIRED | A unit test with config.env at 0644 → warn + repair; idempotent on re-run. |
| E-R10 | Documented uninstall, plus an optional `nexus self uninstall`/prune that removes only `$PREFIX/lib/nexus` and the symlink. | workflow | POST-V1 (docs part RELEASE-REQUIRED; already in quickstart:59-68) | Uninstall test that preserves `~/.config/nexus` and `~/.nexus`. |
| E-R11 | CI matrix: Node 20/22/24, a pinned Rust toolchain plus MSRV, and a `cli/dist` freshness check. | compat | RELEASE-REQUIRED | Workflow jobs green; `git diff --exit-code cli/dist` step. |
| E-R12 | The Rust vulnerability gate fails closed when cargo-audit/cargo-deny is not installed. The toy fallback is removed. | safety | RELEASE-REQUIRED | `PATH` without cargo-audit → security_gates exits non-zero. |
| E-R13 | GitHub release body comes from docs/releases/<tag>.md. | docs | POST-V1 | Release view shows the curated notes. |
| E-R14 | Strict SemVer validation of NEXUS_VERSION. | safety | POST-V1 | `NEXUS_VERSION='v1.2.3/../x'` rejected before any network call. |

## 8. Commands run

- `cat -n` of all scope files.
- `gh release list/view -R mikeholownych/nexus-code` (read-only).
- `gh run list`.
- `gh run view 38540767677 --log` (grep).
- `git ls-remote --tags origin`.
- `git show <tag>:package.json`.
- `git archive HEAD cli/dist | tar -x` (to scratch), then `diff -rq` vs `snap/cli/dist`.
- `npm audit --omit=dev` and `npm audit` (snap/cli).
- `cargo tree -d --locked --offline -e normal` (snap/core).
- Installer runs with `env -i HOME=<scratch>/h{1,2,3,3b,4} PATH=/usr/bin:/bin TMPDIR=<scratch> bash -c 'curl -fsSL …/install.sh | [NEXUS_VERSION=…] sh'`, covering alpha.2, none, v9.9.9, no-v, traversal, and alpha.1→alpha.2→alpha.1.
- `docker run --rm ubuntu:22.04` (no node, then distro node 12) with the documented command as a non-root user.
- Installed binary (scratch HOME via `e_run.sh` = `env -i HOME PATH=$HOME/.local/bin:/usr/bin:/bin`):
  - `nexus --version`
  - `nexus doctor`
  - `nexus doctor --json`
  - `nexus doctor --fix </dev/null`
  - `nexus doctor --fix --yes` ×3, with chmod perturbations
  - the secret-redaction probe with fake keys
  - `nexus --help / --live / --approve / -r / bogus-cmd / status`
- `objdump -T nexus-tui` (max GLIBC 2.34).
- An import-graph grep over cli/src: only the index.ts and sidecar.ts entrypoints are unimported; no orphan modules.
