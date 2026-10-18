# Post-integration targeted verification at d2c4bfc

**Source revision:** `d2c4bfcf8d28749c40c5d919d87b2b74e29852d6`

**Purpose:** Record focused behavioral evidence after PR #12 advanced `v1/integration`. The independent source review disposition remains the separate review at `2c70d39` in `independent-review.md`.

## Execution

- Worktree: `/home/mike/nexus-wt/inspect-d2c4`, detached at the source revision above.
- Dependencies: `npm ci --prefix cli`; completed with 0 reported vulnerabilities. npm warned that the esbuild install script was not approved, but the targeted tests executed successfully.
- Command: `env HOME=/tmp/nexus-home-req-exact-d2c4 XDG_CONFIG_HOME=/tmp/nexus-home-req-exact-d2c4/.config node cli/scripts/run_tests.mjs test/workspace_trust.test.ts test/tokens.test.ts`
- Result: 8 tests passed, 0 failed, 0 skipped.
- REQ-AGT-118 coverage: 3 tests passed, including calibration, conservative script/symbol rules, and llama.cpp/vLLM `/tokenize` response shapes.
- REQ-AGT-010 coverage: the focused suite exercised ACC-TRUST-04 and adjacent workspace trust behavior. This does not establish provenance for every injected-context source.
- The relevant token estimator, token test, and workspace-trust test source files are byte-identical between `2c70d39` and `d2c4bfc`; no source change in PR #12 invalidated the earlier independent review.

## Disposition and limits

This is targeted source-level verification at `d2c4bfc`, not installed-RC, provider, held-out, or product-qualification evidence. REQ-AGT-010 remains scoped to the behavior exercised by ACC-TRUST-04. The REQ-AGT-118 independent acceptance disposition remains at `2c70d39`; this post-integration test run does not claim a new independent review.
