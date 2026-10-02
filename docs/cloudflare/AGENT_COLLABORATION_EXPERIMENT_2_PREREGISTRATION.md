# Agent Collaboration Experiment 2 — Reassessment from Artifact State

**Status:** Hypothesis and measure declared before the new actor executions.
**Date:** 2026-10-02

## Question

Can an agent use an authenticated Worker read of versioned work state stored in a real Artifact Git repository to reassess after a producer's actual interface change, before candidate integration?

## Hypothesis

An advisory state update anchored to an exact producer commit lets a consumer adapt its candidate before integration feedback when the producer's actual API differs from the earlier uncertain state.

## Scenario

The customer store begins at the Experiment 1 fixture baseline. Producer B investigates a change from `readCustomer(id): Customer` (missing customer throws) to an asynchronous lookup whose missing-customer result is `null`. Its initial machine-readable state records uncertainty without specifying the final signature. B later commits and validates the actual interface change on a separate Artifact ref, then updates the state record with the exact ref, SHA, changed files, digest, and validation evidence.

Consumer A in both conditions implements `getCustomerSummary(customerId)` with the same task and baseline. Control receives no producer work state. Treatment reads the initial state from the protected Worker endpoint, creates a local candidate, then reads the updated exact state through the same endpoint before integration and may reassess. No candidate is assigned, locked, or cancelled.

## Primary metric — fixed before actors start

Binary first integration result for the final consumer candidate, applied to the exact producer commit and validated with strict TypeScript 5.9.3 plus both runtime checks, before either consumer receives compiler or runtime integration feedback. Report control and treatment separately. A single pair is descriptive evidence only.

Secondary measures are whether treatment makes a candidate change after the updated state, number of correction commits before first integration, and whether the final missing-customer behavior is preserved.

## Procedure

1. Fork actor repositories from the unchanged baseline `684db6fa5c960fdd0fe26ba213ea30a45eecd4de`; use experimental refs inside each actor's repository.
2. Publish B's initial uncertainty record as a real Git commit on its Artifact `work-state` ref.
3. Deploy a minimal Worker whose only sensitive operation is authenticated, cache-disabled read of a fixed work-state file from B's Artifact ref. No route may mutate repositories.
4. Test unauthenticated rejection. Supply the read capability only to treatment via a mode-0600 temporary file; control receives no capability or signal.
5. Start separate A control/treatment executions. Treatment reads the initial signal from the Worker. Both commit their first local candidate; no integration feedback is sent.
6. B commits and pushes the actual API change to its producer ref, validates it, and updates/pushes the work-state record to B's Artifact ref.
7. Treatment reads the new Worker state and may make a local correction commit. Control receives no update.
8. Integrate each final A candidate unchanged onto the exact B API commit and run the fixed validation before disclosing integration outcomes.
9. Capture source/evidence hashes, independently review live Artifact/Git/Worker state, revoke credentials, and clean up disposable resources.

## Boundaries and limitations

- This measures one producer/consumer dependency and a real Cloudflare/Artifacts state transport, not general coordination quality or a platform architecture.
- No event subscription is used. Treatment explicitly re-reads the state; event delivery is not assumed.
- The Worker capability is read-only for one fixed repository/ref/path. It does not mint Artifact tokens or expose other actor repositories.
- Worker access has shown an unresolved HTTP 403 discrepancy across independent review environments. If the treatment execution cannot reach the endpoint, classify the experiment as blocked at the external actor/Worker boundary; do not inject the signal manually and count that as the intended path.
- Exact actor model/profile may be unavailable. Preserve tool-message order and state payload hashes; do not invent timestamps or identities.
