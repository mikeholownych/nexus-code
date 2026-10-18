# PLAN-04 AGT-111 v1 subset closure evidence

**Agent:** RubyForest (cursor-agent)  
**Branch:** `v1/plan-04-agt111-v1-closure`  
**Base:** `origin/v1/integration@cab12f050fb5e9c430dd4e8d5de8d7c3128177d5`  
**Date:** 2026-10-18  

## Scope

REQ-AGT-111 / AGT-05 v1 subset only (SPEC-04 §3 item 10):

1. Call `measureAdmission` in the subagent loop.
2. Offer the same tool set the loop accepts (`getEffectiveTools()` for both chat and parse).
3. Document remaining main/subagent divergences (post-v1 shared step function).

This does **not** claim the post-v1 single shared step implementation.

## Source verification at `cab12f0`

| Check | Result |
|---|---|
| `measureAdmission` in `runSubagent` | Present (`cli/src/agent.ts` ~6150) |
| Subagent inference tools | `getEffectiveTools()` (not raw `HARNESS_TOOLS`) |
| Matched offered/accepted | Covered by `cli/test/agt111_subagent_parity.test.ts` |
| Remaining divergences documented | `docs/EXECUTION_CONVERGENCE.md` §10 |

## Focused test

- File: `cli/test/agt111_subagent_parity.test.ts`
- Command: `HOME=<tmp> npm --prefix cli test -- test/agt111_subagent_parity.test.ts`
- Result: **1/1 pass** (see `focused-tests.tap`)
- Method: spy `getEffectiveTools` while `runningAsSubagent`, assert each subagent chat `tools` list equals a live snapshot; spy `measureAdmission` and require a call per subagent chat request.

## Needs from other slices

- `FILE_docs_v1.0.0_REQUIREMENTS.md` was held by `codex-lead` (CTX-001 row; pid gone) at authoring time. This PR does **not** edit the ledger. Owner or a later agent should set `REQ-AGT-111` to `partial` (or the accepted v1 wording) with test reference `cli/test/agt111_subagent_parity.test.ts`, preserving post-v1 single-loop scope in the Priority/notes columns — matching the DEC-04 style used for `REQ-AGT-010`.
- Independent review required before merge; this author does not self-accept.

## Non-claims

- No held-out corpus access.
- No installed-RC qualification.
- No independent acceptance (REQ-AGT-110).
