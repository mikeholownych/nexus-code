# Agent Collaboration Experiment 3R — Consequential Stale-State Contract Refactor

**Status:** PREREGISTERED
**Date:** 2026-10-02
**Target:** Cloudflare Contest Critical Path Priority 2

## Question

When a producer actor commits a consequential breaking interface change, does providing machine-readable changed-state evidence to a consumer actor (TREATMENT) eliminate blind integration failures and reduce corrective candidate commits required before first passing integration compared to an uninformed consumer (CONTROL)?

## Background & Defect Correction

Experiment 3 was marked `EXPERIMENT_3_CORRECTION_REQUIRED` because the producer introduced an irrelevant README documentation change. Because the README change did not touch any TypeScript types or function signatures, both control and treatment passed integration on their first attempt without rework (`CORRECTIVE_COMMITS = 0`), demonstrating no collaboration advantage.

Experiment 3R corrects this design defect by introducing a **consequential, breaking contract change** in the shared module (`src/customer-store.ts`).

## Fixture & Interface Contract

- **Module:** `src/customer-store.ts`
- **Baseline Contract:**
  ```typescript
  export interface Customer {
    id: string;
    name: string;
    status: "active" | "suspended";
  }
  export function readCustomer(id: string): Customer;
  ```
- **Consumer Task:**
  Implement `getCustomerSummary(id: string): CustomerSummary` in `src/customer-summary.ts`:
  ```typescript
  export interface CustomerSummary {
    id: string;
    name: string;
    isActive: boolean;
  }
  ```
  Under baseline: `isActive` is derived from `customer.status === "active"`.

- **Producer Breaking Change:**
  Producer refactors `Customer.status` into structured `accountState`:
  ```typescript
  export interface Customer {
    id: string;
    name: string;
    accountState: {
      code: "ACT" | "SUS";
      verified: boolean;
    };
  }
  ```
  `customer.status` is completely removed.

## Preregistered Metrics

### Primary Metric (Fixed Prior to Execution)
`CORRECTIVE CANDIDATE COMMITS REQUIRED BEFORE FIRST PASSING INTEGRATION`
- Measured as: The number of corrective candidate commits committed by the consumer actor to achieve first passing integration against the producer's updated interface.

### Secondary Metric
`FAILED INTEGRATION ATTEMPTS BEFORE FIRST PASS`
- Measured as: Number of blind integration attempts that fail compilation or test validation before achieving a passing build.

## Execution Sequence

1. **Establish Common Baseline:**
   Initialize Git repository with baseline `src/customer-store.ts`, `package.json`, and `tsconfig.json`. Commit as `BASELINE`.
2. **Consumer Initial Commits:**
   - **Control:** Checks out `BASELINE`, implements `src/customer-summary.ts` using baseline `Customer.status`, validates, and commits candidate `C_init`.
   - **Treatment:** Checks out `BASELINE`, implements `src/customer-summary.ts` using baseline `Customer.status`, validates, and commits candidate `T_init`.
   - Both `C_init` and `T_init` are verified against `BASELINE`.
3. **Producer Breaking Change:**
   - Producer branches from `BASELINE`, updates `src/customer-store.ts` to replace `status` with `accountState: { code: "ACT" | "SUS"; verified: boolean }`.
   - Producer updates store tests and commits `P_break`.
4. **Machine-Readable Work State Publication:**
   - Producer writes `.agent/work-state.json`:
     ```json
     {
       "schema": "nexus.agent-work-state.v1",
       "event": "INTERFACE_BREAKING_CHANGE",
       "producerCommit": "<sha>",
       "breakingChanges": [
         {
           "file": "src/customer-store.ts",
           "type": "FIELD_REMOVAL_AND_REPLACEMENT",
           "detail": "Customer.status removed; replaced by Customer.accountState.code ('ACT' | 'SUS')"
         }
       ]
     }
     ```
5. **Differential Delivery:**
   - **Treatment** receives machine-readable work-state evidence.
   - **Control** does NOT receive work-state evidence (simulating isolated, stale-state development).
6. **Actor Continuation:**
   - Treatment observes the breaking contract change, refactors `src/customer-summary.ts` to derive `isActive` from `customer.accountState.code === "ACT"`, validates, and commits proactive candidate `T_corr1`.
   - Control, lacking any signal of producer changes, retains `C_init`.
7. **Integration & Validation:**
   - Attempt Integration 1 for Control (`C_init` + `P_break`): Expected FAIL (`Property 'status' does not exist on type 'Customer'`). Control receives compiler diagnostic, implements fix, and commits `C_corr1`.
   - Attempt Integration 2 for Control (`C_corr1` + `P_break`): Expected PASS.
   - Attempt Integration 1 for Treatment (`T_corr1` + `P_break`): Expected PASS on first attempt.
8. **Outcome Evaluation:**
   - Evaluate primary and secondary metrics.
   - Record exact numbers and evidence in `AGENT_COLLABORATION_EXPERIMENT_3R_EVIDENCE.md`.
