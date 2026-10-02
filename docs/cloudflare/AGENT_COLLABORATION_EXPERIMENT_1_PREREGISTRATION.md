# Agent Collaboration Experiment 1 — Preregistration

**Status:** Hypothesis and measurement declared before autonomous actors start.
**Date:** 2026-10-02

## Question

Does a machine-readable signal about an actor's evolving interface work let a second autonomous actor produce a candidate that integrates with less corrective work?

## Hypothesis

If an actor sees a relevant, source-attributed work-state signal before and during implementation, it can choose an implementation that remains compatible with an evolving interface and avoid at least one integration correction compared with an actor that sees only the baseline.

## Controlled fixture

- A small TypeScript customer-store module begins with synchronous `readCustomer(id): Customer`.
- Actor B intends to migrate that interface to `Promise<Customer>`.
- Actor A in both conditions implements a customer-summary operation.
- Baseline, B's candidate, control A, and treatment A use distinct real Cloudflare Artifact repositories forked from one baseline commit. Actor changes are real local Git commits pushed to their assigned Artifact repos by a secret-isolated runner.
- The change models a realistic producer/consumer interface dependency. It does not manufacture a textual merge conflict.

## Conditions

- **Control:** Actor A receives the fixture baseline and task only. No information about Actor B's work is provided.
- **Treatment:** Actor A receives the identical fixture and task plus a small machine-readable signal authored from Actor B's declared intent. After B's real commit is pushed and read back, treatment receives an updated signal anchored to the exact candidate SHA and actual diff, then reassesses once before integration.
- The two A actors run in separate working directories and do not exchange messages. The condition signal is advisory evidence, not an assignment, lock, or authority grant.

## Primary metric — fixed before execution

**First-pass integration validation:** whether the actor A candidate, applied unchanged on top of Actor B's candidate, passes the fixture's strict TypeScript build and runtime summary assertion before either actor receives integration-error feedback.

This metric is binary per condition. One sample per condition cannot establish statistical superiority.

## Secondary measures

- Number of correction cycles after the first integration result.
- Whether the actor notices and records the relevant interface change before integration.
- Final build/runtime validation outcome.
- Candidate commit count and changed-file/line counts as descriptive measures only.

## Procedure and limits

1. Capture one baseline Artifact commit in a real repository, then fork three independent repos (B, control A, and treatment A).
2. Ask Actor B to declare intent before editing; preserve the active-state JSON.
3. Run control and treatment Actor A tasks against equivalent baseline code. Only treatment receives the signal.
4. Have B implement, commit, push, and independently read back its interface change. Update the treatment signal with repository/ref/SHA, observed path/symbol diff, and validation status; ask treatment to reassess.
5. Integrate each A candidate onto B's exact candidate in a disposable Git clone and run the preregistered validation before sending any failure output to either actor.
6. Record results and limitations, independently review live resources/evidence, then revoke credentials and clean up.

The actor model/profile may be unavailable; record UNKNOWN if so. This is a single bounded fixture experiment, not a production collaboration service, model benchmark, or claim about broad agent populations. No UI, scheduler, issue, PR, or merge-queue abstraction is tested.
