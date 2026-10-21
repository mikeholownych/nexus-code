# Nexus Code v1.0.0: audit and planning package

This package is the evidence-based path from `v0.1.0-alpha.2` (audited at `db1ca55`, 2026-10-14) to v1.0.0.

**Verdict: v1.0.0 readiness is BLOCKED.** Candidate source revision `6151a231e9179c109cfbe8cff87e0a4148587b6a` passed an isolated `make build` and full `make test` run on 2026-10-16 (Rust 281/281; CLI 1087/1087; zero skipped). This is source-suite evidence, not RC qualification. Held-out task quality, T3/T4 qualification, standalone/provider qualification, the manual terminal matrix, package/install matrix on the RC, and independent RC acceptance remain incomplete. See [the current readiness reconciliation](READINESS.md) for exact open requirements and gates. The contest entry remains frozen and separate.

## How to read it

| If you want to… | Read |
|---|---|
| Understand what Nexus is today, what was examined, and what is wrong | [AUDIT.md](AUDIT.md) |
| See current release readiness and remaining actions | [READINESS.md](READINESS.md) |
| See every requirement (historical and new), its status, blocker class, and how it is accepted | [REQUIREMENTS.md](REQUIREMENTS.md) |
| Know the order of work, the effort, and the critical path | [ROADMAP.md](ROADMAP.md) |
| Implement a workstream | Its spec in [specs/](specs/), then its plan in [plans/](plans/) |
| Qualify a release candidate | [ACCEPTANCE.md](ACCEPTANCE.md) |
| Check what was actually run and what it proves | [EVIDENCE.md](EVIDENCE.md) and [evidence/](evidence/) |
| See the decisions taken (all resolved under delegated owner authority) and the remaining owner actions | [DECISIONS.md](DECISIONS.md) |
| Run several agents on this plan at once without collisions | [CONCURRENCY.md](CONCURRENCY.md) (also referenced from the root `AGENTS.md`) |

## Workstreams

| # | Workstream | Spec | Plan | Milestone | Blockers |
|---|---|---|---|---|---|
| 01 | Safe execution defaults and approval integrity | [SPEC-01](specs/SPEC-01-safe-execution-defaults.md) | [PLAN-01](plans/PLAN-01-safe-execution-defaults.md) | M1 | SEC-101, 102, 103, 119 |
| 02 | Process ownership, cancellation, resource bounds | [SPEC-02](specs/SPEC-02-process-ownership-and-bounds.md) | [PLAN-02](plans/PLAN-02-process-ownership-and-bounds.md) | M1 | AGT-109, SEC-106 |
| 03 | Untrusted workspace inputs and egress boundary | [SPEC-03](specs/SPEC-03-untrusted-inputs-and-egress.md) | [PLAN-03](plans/PLAN-03-untrusted-inputs-and-egress.md) | M1 | SEC-110, 111, 115, 116 |
| 04 | Continuity, resume, durable work units | [SPEC-04](specs/SPEC-04-continuity-and-durable-work.md) | [PLAN-04](plans/PLAN-04-continuity-and-durable-work.md) | M3 | AGT-101, 102 |
| 05 | Standalone local inference and provider robustness | [SPEC-05](specs/SPEC-05-standalone-local-inference.md) | [PLAN-05](plans/PLAN-05-standalone-local-inference.md) | M3/M5 | PRV-101, 102, 106 |
| 06 | Packaged product parity, launcher, versioning, doctor | [SPEC-06](specs/SPEC-06-packaged-product-parity.md) | [PLAN-06](plans/PLAN-06-packaged-product-parity.md) | M0/M2 | REL-101, 102, 103 |
| 07 | Supply chain, compliance, release engineering | [SPEC-07](specs/SPEC-07-supply-chain-and-release-engineering.md) | [PLAN-07](plans/PLAN-07-supply-chain-and-release-engineering.md) | M2 | REL-107 |
| 08 | Persistence hygiene | [SPEC-08](specs/SPEC-08-persistence-hygiene.md) | [PLAN-08](plans/PLAN-08-persistence-hygiene.md) | M0/M4 | (prerequisite: PER-103) |
| 09 | Requirements governance and documentation truth | [SPEC-09](specs/SPEC-09-requirements-governance-and-docs.md) | [PLAN-09](plans/PLAN-09-requirements-governance-and-docs.md) | M0/M6 | OPS-101, 103 |
| 10 | v1 qualification and evaluation | [SPEC-10](specs/SPEC-10-v1-qualification-and-evaluation.md) | [PLAN-10](plans/PLAN-10-v1-qualification-and-evaluation.md) | M3/M5 | QUAL-101 to 107 |
| 11 | Verification and tool-call integrity | [SPEC-11](specs/SPEC-11-verification-and-tool-call-integrity.md) | [PLAN-11](plans/PLAN-11-verification-and-tool-call-integrity.md) | M1/M3 | AGT-112, 113, 114 |
| 12 | In-place CLI and TUI upgrade | [SPEC-12](specs/SPEC-12-cli-and-tui-upgrade.md) | [PLAN-12](plans/PLAN-12-cli-and-tui-upgrade.md) | M2 | REL-115 |
| C1 | Contest (separate product; post-contest maintenance; no freeze applies) | [SPEC-C1](specs/SPEC-C1-contest-submission-track.md) | [PLAN-C1](plans/PLAN-C1-contest-submission-track.md) | post-contest | — (not a client gate) |


## How to execute

0. If more than one agent (or person) will implement in parallel, read [CONCURRENCY.md](CONCURRENCY.md) first. It covers slice claims, worktrees, hot files, the gateway lock and merge order.
1. **Start with M0** (ROADMAP). Merge PLAN-08 PR-8a first, so that test runs stop writing into the real `~/.nexus`. Then land PLAN-06 PR-6a (version sync) and PLAN-09 PR-9a (ledger checker, historical banners, cheap doc fixes).
2. **M1 is the critical path.** Work through PLAN-01, PLAN-02, PLAN-03 and PLAN-11 PR-11a/b in the PR slices listed. Each plan names its safe change boundary, code locations, tests and rollback.
3. **For every PR:**
   - update the matching REQUIREMENTS rows (status, test reference, commit);
   - keep `scripts/check_requirements.mjs` green;
   - run `make test` on a snapshot copy, never while editing (tasks/lessons.md).
4. M2 and M4 run in parallel with M1/M3. Held-out task authoring (agent-authored, as authorised) and the standalone proxy start during M1.
5. Cut `v1.0.0-rc.1` only when G0–G4 pass. Then run ACCEPTANCE §4–§8 against the **installed** RC.

## Conventions

- **Requirement IDs.** `REQ-<AREA>-0xx` marks a commitment carried over from history. `REQ-<AREA>-1xx` marks a new v1 requirement.
- **Finding IDs.** These are owned by the scoped evidence files: AGT, VER, PRV, SEC, PER, TUI, REL, DX, MNT, HIST, EVL, CON, PERF, DOC.
- **Acceptance IDs.** `ACC-<AREA>-NN`. Each is defined in its spec, or in ACCEPTANCE §3.1.
- **Evidence labels.** SRC, TEST, RT, MEAS, DOC, HIST, INF, UNV (REQUIREMENTS §1).
- **Status ladder.** open → partial → implemented → tested → visually-accepted → product-qualified. Independent acceptance is recorded separately.

This package supersedes the Issue #12 matrices and the PHASE and WP documents as the source of current requirements. Those documents remain as historical record.
