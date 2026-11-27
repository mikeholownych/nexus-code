# Nexus Code v1.3.1 Implementation Plan: Harness Improvement Runs (HIR)

**Status:** Implementation in progress on `v1/hir-phase1-mvp` (v1.3.1 scope approved by owner)  
**Date:** 2026-11-26  
**Target branch:** `release/v1.3.1`  
**Implementation branch:** `v1/hir-phase1-mvp`

## 1. Objective

Deliver a Nexus-native, evidence-gated workflow for improving agent harnesses without mutating live harness state. A Harness Improvement Run (HIR) is an operator-invoked, durable, isolated, auditable run that snapshots a base harness, evaluates candidate harness edits through probes, compares evidence, drafts reflection/library entries, and emits a human-reviewable promotion report.

HIR is adjacent to `/goal`, `/loop`, and operations. It does not replace them, does not auto-promote harness changes, and does not weaken existing completion/safety semantics.

## 2. Evidence Baseline

| Source | Confirmed | Use | Confidence |
|---|---|---|---|
| [arXiv:2610.14224](https://arxiv.org/abs/2610.14224), *Harness^2: Recursive Agent Harnessing for an Open World* | Task-level Propose-Probe-Compose with behavioral contrast; harnessing-level reflection/library. | Inspiration for candidate/probe/compose/reflect separation. | High for abstract claims; not independently reproduced. |
| [shrinedogg/harness2-hermes README](https://raw.githubusercontent.com/shrinedogg/harness2-hermes/main/README.md) | Harness as prompt/config/skills; isolated probes; structural gate; promotion report; no live profile writes. | Safety boundary pattern. | Medium-high for README-described behavior; not code-audited. |
| Nexus `release/v1.3.1@abfa58c` baseline | Durable goal/loop/operation control plane; evidence/receipts; schema validation; slash routing; persistence protection. | Reuse Nexus patterns. | High (inspected local source). |

Unverified/excluded: "10x better" marketing claim.

## 3. v1.3.1 Scope (MVP)

### In scope
- HIR domain model, durable state, schema validation, storage.
- CLI: `nexus harness init/run/status/show/report/cancel --json`.
- Base harness snapshot from fixture/explicit path.
- Candidate tree/manifest, diffing, structural gate.
- Deterministic mock probe adapter and isolated real probe adapter (no live model; verifier commands use a no-network OS sandbox by default; real probing has a separately gated unsandboxed override).
- Scorecard/comparison, evidence-cited composition, promotion report JSON+MD.
- Redaction, path containment, no-live-mutation invariant.
- Deterministic tests (Node 22/24 compatible).

### Deferred (v1.3.2+ unless pulled forward)
- Parallel/sequential recursion k>1.
- Reflection drafts + active library accept/reject.
- `/harness` REPL/TUI slash command.
- Auto-apply (never default; separate explicit decision).

## 4. Safety Invariants

1. **No live mutation**: HIR never writes active profile, global config, installed skills, or repo-managed harness files.
2. **Pinned policy**: probes cannot weaken approval/sandbox/redaction.
3. **No secret persistence**: artifacts pass redaction/sensitive-persistence guards; failures block persistence.
4. **Path containment**: snapshot/candidate/probe/artifact paths normalized and confined to HIR state or declared temp workspace.
5. **Untrusted content**: task suite/probe artifacts/repo content are data, never instructions.
6. **Unknown effect blocks**: ambiguous external effects require explicit operator action.
7. **Advisory != authority**: model/rubric judgments cannot produce `apply` recommendation in v1; deterministic evidence only.
8. **Budget caps enforced**: probe/round/time/token/concurrency caps hard-fail or block.
9. **Verifier boundary**: task-suite verifier commands are untrusted shell input. Mock and real probes require an OS sandbox with networking disabled; only the separately gated real-probe override may run unsandboxed.
10. **Cancellation and incomplete evidence**: operator cancellation reaches active verifier processes and is durable across CLI processes. A cancelled, blocked, or timed-out required probe cannot produce a completed run or promotion report.

## 5. Architecture

Dedicated HIR domain with operation-compatible persistence patterns. No new scheduler; no changes to goal/loop completion semantics.

Proposed layout under Nexus state root:
```
<state>/harness/
  runs/<hir-id>/run.json
  runs/<hir-id>/events.jsonl
  runs/<hir-id>/evidence.jsonl
  runs/<hir-id>/report.json
  runs/<hir-id>/report.md
  bases/<harness-id>/manifest.json
  bases/<harness-id>/tree/...
  candidates/<candidate-id>/manifest.json
  candidates/<candidate-id>/tree/...
  candidates/<candidate-id>/diff.patch
  probes/<probe-id>/result.json
  probes/<probe-id>/artifacts/...
  locks/<hir-id>.lock
```

## 6. Module Plan

| Path | Purpose |
|---|---|
| `cli/src/core/harness/types.ts` | Domain types |
| `cli/src/core/harness/schema.ts` | Schema guards/validation |
| `cli/src/core/harness/store.ts` | Durable persistence |
| `cli/src/core/harness/snapshot.ts` | Base snapshot/import and hashing |
| `cli/src/core/harness/task_suite.ts` | Task suite parsing/validation |
| `cli/src/core/harness/gate.ts` | Structural gate |
| `cli/src/core/harness/probe_adapter.ts` | Probe adapter interface + mock adapter |
| `cli/src/core/harness/orchestrator.ts` | HIR lifecycle/state transitions/budgets |
| `cli/src/core/harness/compare.ts` | Scorecards/behavioral contrast |
| `cli/src/core/harness/compose.ts` | Evidence-cited composition |
| `cli/src/core/harness/report.ts` | JSON/MD promotion report |
| `cli/src/core/harness/events.ts` | Event/evidence helpers |
| `cli/src/harness_cli.ts` | CLI command registration |
| `cli/src/index.ts` | Register `nexus harness` |

## 7. Acceptance Criteria (MVP)

- [ ] `nexus harness init/status/show/report/cancel --json` work on fixture inputs.
- [ ] Base snapshot immutable and content-hashed; candidate trees immutable.
- [ ] Structural gate blocks path escape, policy weakening, secret persistence, oversize components.
- [x] Mock and real verifier commands use a no-network OS sandbox by default; missing sandbox blocks execution unless the separately gated real-probe override is explicitly enabled.
- [x] Cancellation stops active probe process trees, persists across processes, and cannot be overwritten by a stale run snapshot.
- [x] Blocked, cancelled, or timed-out required probes prevent a completed run and promotion report; CLI exit/result status reflects non-completion.
- [ ] Promotion report generated with evidence refs and explicit no-apply warning.
- [ ] No live profile/config/skill files mutated.
- [ ] HIR artifacts redacted/safe to persist; sensitive persistence errors fail closed.
- [ ] Existing goal/loop/operation tests pass unchanged.
- [x] `npm --prefix cli run build` passes; HIR assurance, adapter, CLI, command, and sandbox-policy tests pass.

## 8. Owner Decisions (2026-11-26)

| ID | Decision |
|---|---|
| HIR-D1 | Land HIR in v1.3.1. |
| HIR-D2 | Command name: `nexus harness`. |
| HIR-D3 | Include live profile snapshot (explicit path/profile source; no live mutation). |
| HIR-D4 | Use existing operation/state root conventions + `harness/` namespace. |
| HIR-D5 | Real probes included (isolated temp workspace, deterministic verifier/artifact cases; no live harness mutation). |
| HIR-D6 | Active library accept/reject included in v1.3.1 (records decisions only; no live mutation). |
| HIR-D7 | `/harness` slash command included in v1.3.1. |

## 9. Defaults

| ID | Decision | Default |
|---|---|---|
| HIR-D1 | Land in v1.3.1 | Phase 0-1 MVP only, feature-gated by explicit command use. |
| HIR-D2 | Command name | `nexus harness` |
| HIR-D3 | Base source | Fixtures/explicit paths only |
| HIR-D4 | State location | Existing Nexus state-path conventions + `harness/` namespace |
| HIR-D5 | Real probes | Mock only in v1.3.1 |
| HIR-D6 | Library | Draft report only |
| HIR-D7 | Slash command | CLI first, no `/harness` in v1.3.1 |
