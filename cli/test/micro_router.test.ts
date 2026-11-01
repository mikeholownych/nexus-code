import test from "node:test";
import assert from "node:assert/strict";
import { routeTaskMicroDecision } from "../src/core/micro_router.js";

test("routeTaskMicroDecision fast-paths deterministic commands without inference", () => {
  // Test execution queries
  const test1 = routeTaskMicroDecision("run tests");
  assert.equal(test1.kind, "DETERMINISTIC_FASTPATH");
  assert.equal(test1.ruleId, "FASTPATH_TEST_RUN");
  assert.equal(test1.targetTool, "run_tests");
  assert.equal(test1.requiresInference, false);
  assert.equal(test1.confidence, 1.0);

  const test2 = routeTaskMicroDecision("npm test");
  assert.equal(test2.kind, "DETERMINISTIC_FASTPATH");
  assert.equal(test2.ruleId, "FASTPATH_TEST_RUN");
  assert.equal(test2.requiresInference, false);

  // Git diff queries
  const diff1 = routeTaskMicroDecision("git diff");
  assert.equal(diff1.kind, "DETERMINISTIC_FASTPATH");
  assert.equal(diff1.ruleId, "FASTPATH_GIT_DIFF");
  assert.equal(diff1.targetTool, "run_command");
  assert.equal(diff1.requiresInference, false);
});

test("routeTaskMicroDecision routes specialist requests to appropriate profiles", () => {
  // Security audit
  const sec = routeTaskMicroDecision("Perform a security review of PR #395");
  assert.equal(sec.kind, "SPECIALIST_DELEGATION");
  assert.equal(sec.ruleId, "SPECIALIST_SECURITY_AUDIT");
  assert.equal(sec.targetRole, "security_reviewer");
  assert.equal(sec.requiresInference, true);

  // Failure investigation
  const debug = routeTaskMicroDecision("Investigate the failure in operation_release_review");
  assert.equal(debug.kind, "SPECIALIST_DELEGATION");
  assert.equal(debug.ruleId, "SPECIALIST_FAILURE_DEBUG");
  assert.equal(debug.targetRole, "failure_debugger");

  // Call site analysis
  const calls = routeTaskMicroDecision("Trace downstream callers of isSubmittedUnitPrompt");
  assert.equal(calls.kind, "SPECIALIST_DELEGATION");
  assert.equal(calls.ruleId, "SPECIALIST_CALL_SITE");
  assert.equal(calls.targetRole, "call_site_analyzer");

  // Semantic exploration
  const explore = routeTaskMicroDecision("Explore the codebase architecture for context management");
  assert.equal(explore.kind, "SPECIALIST_DELEGATION");
  assert.equal(explore.ruleId, "SPECIALIST_EXPLORATION");
  assert.equal(explore.targetRole, "semantic_explorer");

  // Independent acceptance review
  const review = routeTaskMicroDecision("Conduct independent review for release v1.1.2");
  assert.equal(review.kind, "SPECIALIST_DELEGATION");
  assert.equal(review.ruleId, "SPECIALIST_ACCEPTANCE");
  assert.equal(review.targetRole, "acceptance_reviewer");
});

test("routeTaskMicroDecision falls back to general engineering execution for complex prompts", () => {
  const general = routeTaskMicroDecision("Refactor the parser to support multiline string template tags");
  assert.equal(general.kind, "GENERAL_ENGINEERING");
  assert.equal(general.ruleId, "FALLBACK_GENERAL_MODEL");
  assert.equal(general.requiresInference, true);
});
