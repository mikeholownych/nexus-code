# Agent Collaboration Experiment 3 — Irrelevant State Update

**Status:** Preregistered before the producer and consumer actors start.
**Date:** 2026-10-02

## Question

When an actor observes a real, updated work-state record for unrelated work, does it avoid unnecessary candidate changes while preserving successful integration?

## Hypothesis

A treatment actor given a versioned, path-specific producer state can recognize that a README-only documentation change is unrelated to its source-level customer-summary task. It should not make a corrective candidate commit solely because state changed.

## Fixture and conditions

- Baseline: `nexus-exp1-oct02/nexus-agent-collab-e1-base` at `684db6fa5c960fdd0fe26ba213ea30a45eecd4de`.
- Producer objective: document the package's setup and validation commands; intended change is `README.md` only.
- Consumer objective for both actors: implement `getCustomerSummary(customerId)` in `src/customer-summary.ts`, returning the fixture customer's name and ID while preserving baseline missing-customer behavior.
- Control: receives the consumer task and baseline only, with no Work State capability or signal.
- Treatment: reads the producer's initial Work State through the protected Worker, commits its first candidate, then reads the updated state after the README commit and may reassess before integration.
- Each consumer works in a separate real Artifact repository ref based on the same baseline. Producer code/state and candidates are pushed with short-lived repository-scoped credentials. No actor receives another actor's code or integration result before first validation.

## Primary metric — fixed before actors start

Count of additional consumer commits after treatment's updated-state observation and before first integration. Zero means no treatment candidate rework in response to the unrelated update. Control's post-task candidate commit count is recorded as a reference, not as a second selected primary metric.

Integration pass/fail for each final consumer candidate against the exact producer commit is a secondary correctness measure, using strict TypeScript 5.9.3, the store runtime test, and known/missing summary assertions.

## Procedure

1. Publish an initial Artifact-backed work-state record for the README-only producer task.
2. Start separate control and treatment consumer actors from the exact baseline. Treatment reads only the initial state; control receives no state.
3. Capture one local consumer candidate commit from each actor before producer integration state is shown.
4. Producer creates, validates, and pushes a deterministic README-only commit to a separate Artifact ref.
5. Update and push the Work State record with the exact candidate SHA, tree, changed path, file hash, and validation note.
6. Treatment reads the updated state through the Worker and may reassess. Control receives no signal. Capture any treatment corrective commits before integration.
7. Integrate each final candidate with the exact README commit using ordinary Git and run the fixed validation before disclosing outcomes.
8. Retain live state for independent review, revoke credentials, then decide cleanup.

## Interpretation limits

- One pair is descriptive; it does not estimate false-positive rates or general agent ability.
- The test uses an explicit unrelated path/objective pair. It does not prove semantic relevance classification in general.
- No events, scheduler, shared authority service, UI, or issue/PR workflow is used.
- If the treatment cannot retrieve state through the Worker, or the producer change touches consumer source/contracts, classify the trial as blocked/invalid rather than adapting the hypothesis after execution.
- Actor profile, model, and exact elapsed time may remain UNKNOWN.
