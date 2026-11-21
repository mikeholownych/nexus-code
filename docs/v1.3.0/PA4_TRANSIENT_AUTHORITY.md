# PA-4 transient delegation authority milestone

This milestone narrows the existing in-turn `spawn_subagent` path. It does not introduce another scheduler or durable store.

## Contract

- The compatible prompt-only call selects `semantic_explorer`, a predefined read-only profile.
- Optional `profile` selects only an existing role; optional `inputs` accepts string values and conveys task data, never authority.
- Unknown fields, unknown profiles, non-string inputs, and oversized requests are rejected before child construction.
- Child tools are the intersection of the parent's currently offered tools, explicit matching parent grants (when configured), and the selected profile's allowlist. The dispatcher repeats this exact-name check before any tool effect.
- A child has `fullAccess: false`; a writable profile requires an already established isolated worktree. Delegation depth is limited to one child level and each parent admits at most four child attempts.
- Active children, delegated inference steps, and execution duration are bounded. Defaults are four active children, eight delegated inference requests per parent agent, and two minutes per child.
- Operators may set `NEXUS_DELEGATION_MAX_CHILDREN` (1–16), `NEXUS_DELEGATION_MAX_ACTIVE` (1–16), `NEXUS_DELEGATION_MAX_STEPS` (1–64), and `NEXUS_DELEGATION_MAX_DURATION_MS` (1,000–600,000). Invalid values fail closed. Delegation depth is fixed at one level.
- Completion returns a validated structured receipt. An incomplete child with workspace mutations is `UNKNOWN_EFFECT`; a reported failure is not treated as completion.
- The child uses its own conversation and returns only a bounded summary receipt to the parent. Parent cancellation continues to signal the child.

These restrictions preserve prompt-only compatibility while intentionally refusing legacy prompt-only requests that relied on unrestricted writes. The process-wide active-child ceiling is shared by transient delegations; aggregate budgets across separate parent agents and independent evidence review remain open PA-4 work.

## Reference coding

XERJ was consulted per `docs/XERJ_REFERENCE_CODING.md`. The useful reference was the peer pattern of host-owned predefined role profiles with allowlisted tools. No peer implementation was copied. XERJ field report was submitted after preview; GitHub PR creation was unavailable and the report endpoint accepted the fallback.

## Qualification status

The shared `SUITE` claim was active during implementation, so no local tests were run for this milestone. TypeScript compilation and hosted CI are required before merge. This document records implementation intent, not test evidence.
