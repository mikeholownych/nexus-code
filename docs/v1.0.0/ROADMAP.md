# Roadmap: Nexus Code to v1.0.0

The starting point is `db1ca55` (`v0.1.0-alpha.2` + docs), which has 31 blocker requirements open (REQUIREMENTS §3). The roadmap is ordered by dependency, and every milestone ends at a gate defined in [ACCEPTANCE.md](ACCEPTANCE.md). There are no delivery dates; effort is given as ranges, with the assumptions stated.

## Assumptions behind the estimates

- **People.** One implementer working with agent assistance, as in this repository's history. An engineer-day (ed) means one focused day of implementation, review and test for that person.
- **Inference.** Inference comes only from the homelab gateway (DEC-16): one model host, with runs serialised.
- **Uncertainty.** The largest unknown is how many fix loops M5 qualification triggers. The pilot's history suggests at least one.
- **Supporting labour.** Held-out tasks are written by an agent author (authorised, DEC-05). Independent acceptance is done by a reviewer the owner provides (X5).

## Milestones

```
M0 Foundation ──► M1 Safety floor ──────────────► M3 Continuity & inference ──► RC1 ──► M5 Qualification ──► M6 Release
        │               │                                ▲                                  ▲
        │               └──► M2 Product parity & supply chain (parallel) ──────────────────┤
        │                                                                                   │
        └──► M4 Persistence hygiene (parallel with M2/M3) ──────────────────────────────────┤
  (from M1) held-out task authoring, standalone proxy, fixtures (parallel) ─────────────────┘
```

| Milestone | Scope (plans) | Deliverables | Exit gate | Effort |
|---|---|---|---|---|
| **M0 Foundation** | PLAN-08 task 1 (test HOME isolation); PLAN-06 task 3 (version sync). Owner action X1 (stale local tags deleted) is already done.; PLAN-09 tasks 1, 2, 5 (ledger checker in report mode, historical banners, cheap doc truth fixes) | Tests never touch the real HOME. One version identity. The ledger is enforced in CI. | **G0**: ACC-PER-03, ACC-PKG-03, ACC-GOV-01/03 | 2–4 ed |
| **M1 Safety floor** (critical path) | PLAN-01 (effect classes, DEC-01 posture, verifier gating, REPL approvals, read-only masking, argv sandbox, tripwire); PLAN-02 (process registry, cancel and shutdown sweep, bounds); PLAN-03 (project `.env` allowlist, CIDR locality, SSRF-safe fetch, skills/knowledge trust, plugin directories, EXT-004); PLAN-11 PR-11a/11b (parser, binding) | Untrusted input cannot cause unapproved exec, egress or configuration changes. Stop means stopped. No false VERIFIED from a filename coincidence. | **G1**: all ACC-SAFE, ACC-PROC, ACC-TRUST, ACC-VER-01..04 | 15–25 ed |
| **M2 Product parity and supply chain** (parallel with M1 after PLAN-01 PR-1b) | PLAN-06 (unified launcher with the TUI as the packaged default, doc commands, doctor, installer); PLAN-07 (notices, SBOM, provenance, CI matrix, `cli/dist` untracked, SECURITY.md, CHANGELOG); PLAN-12 (CLI and TUI upgrade engine) | The installed product equals the tested product. Compliant release assets. In-place upgrade safely verifies and swaps releases. | **G2**: ACC-PKG-01..09, ACC-SUP-01..07, ACC-UPG-01..06 | 8–14 ed |
| **M3 Continuity and inference** | PLAN-04 (resume, durable work units, accounting, error path, stagnation, team semantics); PLAN-05 code tasks (server-kind discovery, compact-and-retry, error bounds, timeouts, parser robustness, receipts, startup probe, decoupling, CA); PLAN-11 PR-11c..e; PLAN-10 harness tasks 1–7, 9, 10, 13 | Resume and compaction never lose state. Standalone sizing works. Eval harness ready. | **G3**: ACC-CONT-01..09, ACC-INF-01..09, ACC-VER-05..09, eval self-tests | 15–25 ed |
| **M4 Persistence hygiene** (parallel with M2/M3) | PLAN-08 tasks 2–10 | Private state permissions, retention/GC, corruption reporting, schema policy | **G4**: ACC-PER-01..07 | 5–8 ed |
| **RC1** | After PLAN-09 task 7's pre-RC source-ledger reconciliation and enforce gate, tag `v1.0.0-rc.1` (owner approves publishing a prerelease; X7) | RC build installed through the documented command | G0–G4 green on the exact RC source; pre-RC requirements enforcement passed | <1 ed |
| **M5 Qualification** | PLAN-10 task 11 (T2 held-out 5×, T3, T4, standalone stripped-proxy profiles, provider verify); task 12 (terminal matrix); ACC-SUP-08 cross-runner reproducibility; independent acceptance (X5) of continuity and of the RC | Qualification evidence archive, scorer verdict table, independent reports | **G5**: ACCEPTANCE §4–§8 all PASS | 10–20 calendar days. About 84 h of serial inference for T2, plus T3/T4/standalone. Excludes fix loops. |
| **Fix loop(s)** | Defects found in M5, landed as `rc.N` | Re-run the failed gate subsets, plus regression subsets | G5 | 0–15 ed per loop (unknown) |
| **M6 Release** | PLAN-09 task 7 (verify the pre-RC source-ledger reconciliation and enforcement evidence; record exact-RC dispositions in the acceptance record without mutating the accepted RC source); docs sign-off; release notes; tag `v1.0.0` (X7) | Published v1.0.0 with notices, SBOM and attestation | **G6**: ACCEPTANCE §10 checklist | 2–4 ed |

**Total implementation:** about 46–78 ed (the sum of M0–M4 and M6). **Qualification:** 2–4 calendar weeks. **Fix loops:** unknown. A plausible range is 0–2 loops.

## Critical path

The longest dependency chain is:

**M0 → M1 → M3 → RC1 → M5 (T2 held-out runs) → M6**

- M1 comes first because the posture change (DEC-01) alters behaviour that every later test, eval and acceptance run depends on. Qualifying before it would have to be redone.
- M3 is on the path because resume (AGT-01), work-unit durability (AGT-02a) and standalone sizing (PRV-06) are blockers, and the T4 class 9 test (SIGTERM, then resume) needs them.
- M5 is bounded by serial inference on the single gateway host.

When several agents work at once, the parallel lanes, hot-file serialisation and the single-`GATEWAY` lock in [CONCURRENCY.md](CONCURRENCY.md) govern the order in which work merges.

Off the critical path, but must finish before RC1:

- M2, M4;
- the 40 held-out T2 tasks and 8 T3 tasks (agent-authored), with their manifest sealed **before** RC1;
- the stripping proxy and the conformance fixtures.

## Release gates

| Gate | When | Pass condition |
|---|---|---|
| G0 | End of M0 | Foundation acceptance IDs pass. `make test` passes on a clean clone and leaves the real HOME untouched. |
| G1 | End of M1 | All safety acceptance IDs pass in CI. Existing PTY suites stay green. No new skipped tests. |
| G2 | End of M2 | A package smoke run in a PTY shows the TUI. The doc-command test passes. Release dry-run assets are complete. |
| G3 | End of M3 | Continuity, inference and verification acceptance IDs pass. The eval harness self-tests pass, including the T4 smoke. |
| G4 | End of M4 | Persistence acceptance IDs pass. |
| G5 | After the RC | ACCEPTANCE §4–§8 pass. The DEC-05 thresholds are met. Independent reports are filed. |
| G6 | Release | The ledger checker passes in enforce mode, so every B/RR row is ≥ tested and B rows are product-qualified where ACCEPTANCE requires it. Docs are signed off. Owner approval X7 is given. |

## Classification of the work

| Category | Contents |
|---|---|
| **Release blockers** (31 B rows) | M0–M3 for implementation, M5 for qualification evidence |
| **Release-required improvements** (58 RR rows) | Spread across M1–M4; listed in each plan |
| **Post-v1** | REQUIREMENTS §5: single step loop, full context provenance, knowledge freshness, `/tdd` and `nexus eval` fixes, cgroups, macOS/arm64, self-uninstall, and others |
| **Contest track** | PLAN-C1, after judging. Independent of all gates (DEC-13). |

## Risks to the roadmap

| Risk | Effect | Mitigation |
|---|---|---|
| The DEC-01 default change breaks many test fixtures | M1 takes longer | PR-1a lands the classes behind a constant; PR-1b flips the default with mechanical fixture updates |
| The gateway host is unavailable or thermally limited during M5 | M5 is delayed | Serial runs with resumable runner; schedule against the thermal-soak findings; T2 runs are resumable per task |
| Held-out results miss the thresholds | Fix loops | Thresholds are pre-registered, so they are not moved after the fact. The fix is a code change, and the affected run classes are re-run. |
| Parser restriction (PLAN-11) lowers the tool-call rate on text-only models | Task quality falls | Recorded fixtures; one-RC escape hatch; the qualification measures it |
| Independent reviewer is unavailable (X5) | G5 cannot be met honestly | The owner must supply a reviewer. The audit does not substitute self-assessment for it. |

## What must be re-run after implementation

Everything marked RT or MEAS in AUDIT §5 must be re-run on the RC:

- the PTY scripts in `evidence/D_pty`;
- the probes in `evidence/prv`, `evidence/a2probe`, `evidence/probes` and `evidence/repro`;
- the installer and doctor runs;
- the memory measurements.

The baseline suite (905 CLI + 266 Rust tests) must be re-run at every gate. The two live provider verifications and the live end-to-end run (EVIDENCE §3) must be repeated on the RC with pinned models.
