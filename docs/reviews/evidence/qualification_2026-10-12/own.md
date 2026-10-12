# Coordinator findings: completion correctness, delivery, performance, evaluation

All commands run read-only against /home/mike/nexus-code or in an isolated extract of 696178a
(`scratchpad/assess/x696178a`, built with `npm run build` and `cargo build --release`).

### A1 A wrong deliverable ends VERIFIED and its requirement `verified`
- Priority: P0 · Label: REPRODUCED DEFECT · Affects: main, feat/tui-surface (installed runtime); fix/context-convergence (same verifier model, see its gating changes 8674520/cb3e20f/547525b — gating by configured verifier does not bind to the deliverable either)
- Trigger: objective "1. add math.js exporting add(a, b) that returns a + b"; the model writes `exports.add = (a, b) => a - b;`, runs the discovered verifier, marks R1 verified, calls task_completed. The repository suite (`npm test`) passes but never exercises math.js.
- Expected: not VERIFIED (no evidence covers the deliverable); R1 at most `implemented`.
- Observed: `{"execution":"COMPLETED","outcome":"VERIFIED","verifier":"npm test","R1":"verified","file":"exports.add = (a, b) => a - b;"}` (repro `scratchpad/assess/repro_false_verified.test.ts`, run in the 696178a extract).
- Cause (source): the verifier is the first generic command found in the repository — `cli/src/tester.ts:77-104` (`make test`, `cargo test`, `npm test`, `pytest`, `go test`); `verified` on a requirement needs only some passing verifier attempt recorded on the current workspace — `cli/src/core/objective.ts:335-340` (main 3727938, unchanged on 696178a). Nothing relates the run to the changed files or to the requirement text. Turn VERIFIED derives from verifier evidence status alone — `cli/src/agent.ts` outcome derivation (`evidence?.status === "PASSED"` → VERIFIED; see the block around lines 3436-3470 on main).
- Impact: VERIFIED — the strongest claim Nexus makes — can be printed for incorrect work whenever the repository's suite is green and does not cover the change. This is the common case for new features.
- Remediation: separate "suite passed" from "deliverable verified". (1) Record per-requirement acceptance checks: operator-supplied commands/tests, or model-proposed checks the operator accepts (`/requirements` UI); (2) require fail-before/pass-after evidence for new checks (run against the pre-change checkpoint); (3) require that a passing run touched the changed files (coverage or test-file selection) before VERIFIED; otherwise report `COMPLETED · tests passed, deliverable unverified`. Keep the generic suite as a regression gate (REGRESSION_FREE), not as verification.
- Acceptance test: the repro above must end not VERIFIED and R1 not `verified`; a variant where the operator-accepted check `node -e "assert(require('./math').add(2,3)===5)"` exists must fail on the wrong implementation and pass on the correct one; mutation suite (10 seeded wrong deliverables with green unrelated suites) → 0 VERIFIED.
- Dependencies: objective ledger (main), checkpoint snapshots (main). Not addressed by unmerged work.

### D1 Build identity is not observable; the installed runtime silently follows the checkout
- Priority: P1 · Label: REPRODUCED DEFECT · Affects: installed runtime (all branches)
- Trigger: the checkout is on unmerged feat/tui-surface @ 696178a; run `nexus --version` and `nexus doctor --json`.
- Expected: version output and doctor name the commit, branch/tag and dirty state of the running build, and warn when it is not a release or not main.
- Observed: `nexus --version` → `1.2.1`; doctor `install.build` evidence `['version 1.2.1', 'install root /home/mike/nexus-code']`, `nexusVersion 1.2.1` — identical to main. `cli/src/doctor.ts` has no git/commit lookup (grep for rev-parse/gitHead/commit: no matches). `/usr/local/bin/nexus -> /home/mike/nexus-code/harness.sh` runs `core/target/release/nexus-tui` and `cli/dist` from the working tree (`harness.sh:14-43`).
- Impact: dogfooding results, bug reports and evidence cannot be attributed to a build; a branch switch in the dev checkout changes what users run with no signal (exactly the current state).
- Remediation: generate build info at build time (commit, describe, dirty flag, build time) into `cli/dist/build-info.json` and Rust `env!` via build.rs for harness-core and nexus-tui; print it in `--version`, the doctor (`install.identity` finding: warn when dirty or not on a release tag/main, fail when the three components disagree), the TUI status line or receipt, session exports and inference receipts.
- Acceptance test: build from a dirty tree on a branch → `--version` shows `1.2.1+<sha>.dirty (branch)`; doctor warns; mixing a CLI dist and engine from different commits → doctor fails `install.identity`.
- Dependencies: none.

### D2 No CI; tests and gates run only by hand on one host
- Priority: P1 · Label: SOURCE-SUPPORTED RISK · Affects: all
- Observed: no `.github/`, `.gitlab-ci.yml` or other pipeline definition in the repository root (checked `ls -a`); `git remote -v` is empty. `make test` (Makefile:47-50) is the only gate and is run manually.
- Impact: merges to main are not gated; regressions depend on the implementer remembering to run the suite; results are not reproducible by others.
- Remediation: a pipeline (the operator runs a self-hosted GitLab) running `make build`, `make test` (incl. PTY scenarios, which need only a pty, no display) and the security gates on every branch, required for merges to main; artefacts: test logs, build-info, SBOM.
- Acceptance test: a deliberately failing test on a branch blocks its merge request; pipeline logs show commit identity.

### D3 Installation is the development checkout; no versioned install, upgrade or rollback
- Priority: P1 · Label: SOURCE-SUPPORTED RISK · Affects: installed runtime
- Observed: README documents building in place; `harness.sh` resolves its own directory and executes the working tree's artefacts; the version is a constant 1.2.1 in `cli/package.json` and `package.json`; no `make install`, packaging, tags or release notes (no CHANGELOG).
- Impact: upgrade = git pull + rebuild in the tree that is also being developed; rollback = git checkout + rebuild; a half-finished build or a test run that rebuilds artefacts changes the live runtime.
- Remediation: `make install PREFIX=~/.local` copying a built, identified release into `<prefix>/lib/nexus/<version-sha>/` and switching a `current` symlink (rollback = switch back); release tags with notes; the launcher refuses to mix components from different builds.
- Acceptance test: install release A, then B, then roll back to A with one command; `nexus --version` reflects each; rebuilding the dev checkout does not change the installed runtime.

### D4 Supply-chain and policy files missing or partial
- Priority: P2 · Label: SOURCE-SUPPORTED RISK
- Observed: `package.json` declares `"license": "MIT"` but there is no LICENSE file; no SECURITY.md or vulnerability-reporting process; no CHANGELOG. `make verify-reproducibility` (Makefile:36-45) only rebuilds the TypeScript CLI twice (Rust artefacts not checked; fixed /tmp paths). Security gates run npm audit and cargo audit and a pattern secret scan (`scripts/security_gates.sh:26-127`); `scripts/generate_sbom.sh` writes a CycloneDX-style SBOM to `dist/` but nothing signs artefacts or records provenance.
- Remediation: add LICENSE, SECURITY.md (contact, supported versions, response targets), CHANGELOG; extend reproducibility to the Rust binaries (`--locked`, `SOURCE_DATE_EPOCH`, path remapping) and compare hashes across two clean builds; attach SBOM + checksums to tagged releases; optional signing.
- Acceptance test: two clean builds of a tag on different directories produce identical hashes for all three components; SBOM lists Rust and Node dependencies with versions.

### D5 Repository hygiene: a session transcript and personal paths are tracked
- Priority: P3 · Label: REPRODUCED (source)
- Observed: `nexus-session-session_20261011_162349_6lvu.json` (124 KB conversation export, 13 `/home/<user>/` paths, no credential-shaped strings) is tracked in the repository root, added by a9437ba (an earlier "land outstanding changes" commit made by the assessing agent's own session); README hard-codes `/home/mike/nexus-code/cli/.env` (README.md:182).
- Remediation: move session exports out of the tree (export into `.nexus/exports/`, gitignored), remove the tracked file, make README paths relative.

### D6 Platform scope
- Priority: P2 (product scope) · Label: PRODUCT IMPROVEMENT
- Observed: README.md:3 states Linux; doctor repairs use `/proc/self/fd` (`cli/src/safe_fs.ts`); the TUI relies on unix process groups. Peers document macOS and (for most) Windows/WSL support.
- Remediation: declare Linux-only support explicitly in docs and doctor; if macOS is targeted, replace /proc-based checks with fcntl(F_GETPATH)/fstat comparisons and run CI on macOS.

### P1 Fixed per-request overhead is large and unmeasured against task outcomes
- Priority: P2 · Label: EVIDENCE GAP (measurement) · Affects: all
- Observed (estimate): the first request of the installed build carries 38 tool schemas (incl. 5 browser tools, LSP, CST, trigram/hybrid search) = 17,784 chars plus a 2,342-char system prompt; whole body 20,383 chars ≈ 5.1k tokens at 4 chars/token (estimate, not provider-reported; repro `repro_overhead.test.ts`). Measured (provider-reported, earlier this session with `scripts/token_accounting.py`): the 2026-10-11 dogfood session used 2,506,632 prompt tokens over 87 requests (≈28.8k per request), exactly the sum of provider usage reports.
- Impact: on local inference, fixed overhead and repeated full-context resends dominate latency and context headroom; no data shows which tools are used or what the overhead costs in task success.
- Remediation: measure first (per-request breakdown: system, tools, pinned objective, history, tool results); then admit tool groups by need (browser/LSP/CST only when enabled or requested), and report per-request token composition in receipts.
- Acceptance test: receipts carry a composition breakdown; on the evaluation set, the reduced tool set keeps task success within noise while lowering median prompt tokens per request (pre-registered threshold).

### E1 No matched task-level evaluation exists
- Priority: P1 · Label: EVIDENCE GAP · Affects: all
- Observed: 55 CLI test files (deterministic mock gateway, harness behaviour) and Rust unit tests; dogfood campaign reports (docs/reviews/*DOGFOOD*); one controlled experiment (`experiments/context-validation-2026-10-04/RESULTS.md:52-53`: "n = 4 per cell; … one model; one task family"). No maintained suite that runs fixed coding tasks against fixed repositories and scores artefact correctness; no SWE-bench/Terminal-Bench-style runner (grep found mentions only in planning docs).
- Impact: completion rate, correctness and recovery are unproven; mechanism changes (compaction, continuation) are judged by individual dogfood runs.
- Remediation: see the evaluation plan in the main report (fixed repos/commits, hidden acceptance tests, fault injection, matched settings, separate scores).

## Positive evidence (checked)
- Token accounting is provider-reported where available and reconciles exactly (2026-10-11: sum of reported usage over 87 requests = session tokenStats).
- Doctor: 18 pass / 0 fail on the installed runtime (`nexus doctor --json`, inference check skipped); repairs are symlink-safe (reviewed earlier, safe_fs.ts).
- Security gates exist and distinguish scanner failure from findings (scripts/security_gates.sh:26-99).

## Checks actually run
- `git status/branch/log/worktree list/remote -v`, `ls -l /usr/local/bin/nexus`, sha256 of runtime artefacts — identity recorded in the main report.
- `ps` for running nexus processes — none.
- `git -C /home/mike/nexus-code archive 696178a | tar -x` → npm run build (0), cargo build --release (0).
- `npx tsx --test test/zz_false_verified.test.ts` (extract) → VERIFIED for a wrong deliverable (pass of the repro).
- `npx tsx --test test/zz_overhead.test.ts` (extract) → 38 tools, 20,383-char first request.
- `nexus --version`, `nexus doctor --json` (installed, read-only) → 1.2.1, 18 pass, no commit identity.

## Limitations
- No live inference was run; the false-VERIFIED repro uses a scripted model and shows the harness accepts the outcome, not how often a real model produces it.
- Token figures for overhead are character estimates.
