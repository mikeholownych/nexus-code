/**
 * Deterministic Micro-Routing Engine (Nexus Code v1.1.2)
 *
 * Eliminates unnecessary LLM inference turns for non-semantic, deterministic commands
 * and routes tasks to specialized profiles based on unambiguous rule matching.
 *
 * Principles:
 * 1. Ordinary discovery, test runs, diff inspection, and AST queries remain deterministic.
 * 2. Model-assisted routing is permitted only when rules are ambiguous, and must record
 *    its inputs, confidence, and fallback to deterministic defaults.
 * 3. Model classification can never override hard security or policy constraints.
 */

import type { SpecialistRole } from "./specialist_profiles.js";

export type RoutingKind =
  | "DETERMINISTIC_FASTPATH"
  | "SPECIALIST_DELEGATION"
  | "GENERAL_ENGINEERING";

export interface MicroRoutingDecision {
  kind: RoutingKind;
  ruleId: string;
  targetRole?: SpecialistRole;
  targetTool?: string;
  targetToolArgs?: Record<string, unknown>;
  reason: string;
  confidence: number;
  requiresInference: boolean;
}

interface DeterministicPattern {
  ruleId: string;
  kind: RoutingKind;
  matcher: (input: string) => boolean;
  targetRole?: SpecialistRole;
  targetTool?: string;
  getArgs?: (input: string) => Record<string, unknown>;
  reason: string;
}

/**
 * Checks whether an input prompt conveys code authoring, patching, or mutation intent.
 * Prompts with mutation intent cannot be routed to read-only specialist profiles.
 */
export function isMutationIntent(q: string): boolean {
  return /\b(?:fix|patch|edit|modify|write|create|delete|remove|bump|update|merge|refactor|implement|replace|change|remedy)\b/i.test(q);
}

const DETERMINISTIC_PATTERNS: DeterministicPattern[] = [
  // 1. Direct test suite execution
  {
    ruleId: "FASTPATH_TEST_RUN",
    kind: "DETERMINISTIC_FASTPATH",
    matcher: (q) => /^(?:run\s+(?:the\s+)?tests?|npm\s+test|cargo\s+test|make\s+test)\s*$/i.test(q.trim()),
    targetTool: "run_tests",
    reason: "Exact request to run project test suite without semantic modification",
  },

  // 2. Exact git diff / status inspection
  {
    ruleId: "FASTPATH_GIT_DIFF",
    kind: "DETERMINISTIC_FASTPATH",
    matcher: (q) => /^(?:git\s+diff|show\s+(?:the\s+)?diff|git\s+status)\s*$/i.test(q.trim()),
    targetTool: "run_command",
    getArgs: (q) => ({ command: q.trim().toLowerCase().startsWith("git") ? q.trim() : "git diff" }),
    reason: "Pure repository diff or status query without code authoring",
  },

  // 3. Security and vulnerability review requests (read-only)
  {
    ruleId: "SPECIALIST_SECURITY_AUDIT",
    kind: "SPECIALIST_DELEGATION",
    matcher: (q) =>
      !isMutationIntent(q) &&
      /\b(?:security\s+review|vulnerability\s+audit|codeql|dependabot|injection\s+check)\b/i.test(q),
    targetRole: "security_reviewer",
    reason: "Query specifically requests security auditing or vulnerability analysis",
  },

  // 4. Failure investigation & debugging (diagnostic; failure_debugger may run commands and tests)
  {
    ruleId: "SPECIALIST_FAILURE_DEBUG",
    kind: "SPECIALIST_DELEGATION",
    matcher: (q) =>
      !isMutationIntent(q) &&
      /\b(?:investigate\s+(?:the\s+)?failure|diagnose\s+crash|debug\s+test\s+failure|stack\s*trace)\b/i.test(q),
    targetRole: "failure_debugger",
    reason: "Query targets failure triage, diagnostic stack trace analysis, or crash isolation",
  },

  // 5. Dependency & call-site tracing (read-only)
  {
    ruleId: "SPECIALIST_CALL_SITE",
    kind: "SPECIALIST_DELEGATION",
    matcher: (q) =>
      !isMutationIntent(q) &&
      /\b(?:call\s*sites?|who\s+calls|trace\s+dependencies?|downstream\s+callers?)\b/i.test(q),
    targetRole: "call_site_analyzer",
    reason: "Query targets call graph tracing, dependency flow, or caller discovery",
  },

  // 6. Semantic exploration & search (read-only)
  {
    ruleId: "SPECIALIST_EXPLORATION",
    kind: "SPECIALIST_DELEGATION",
    matcher: (q) =>
      !isMutationIntent(q) &&
      /\b(?:explore\s+(?:the\s+)?codebase|architecture\s+overview|map\s+the\s+modules?)\b/i.test(q),
    targetRole: "semantic_explorer",
    reason: "Query requests broad architectural reconnaissance or cross-file pattern discovery",
  },

  // 7. Acceptance & review (read-only)
  {
    ruleId: "SPECIALIST_ACCEPTANCE",
    kind: "SPECIALIST_DELEGATION",
    matcher: (q) =>
      !isMutationIntent(q) &&
      /\b(?:independent\s+review|verify\s+(?:the\s+)?release|acceptance\s+check)\b/i.test(q),
    targetRole: "acceptance_reviewer",
    reason: "Query requests independent validation, acceptance review, or verification gate check",
  },
];

/**
 * Evaluates an input prompt and determines the routing path.
 * Deterministic rules execute with 100% confidence. Unmatched queries fall back to general engineering.
 */
export function routeTaskMicroDecision(input: string): MicroRoutingDecision {
  const normalized = input.trim();

  for (const pattern of DETERMINISTIC_PATTERNS) {
    if (pattern.matcher(normalized)) {
      return {
        kind: pattern.kind,
        ruleId: pattern.ruleId,
        targetRole: pattern.targetRole,
        targetTool: pattern.targetTool,
        targetToolArgs: pattern.getArgs ? pattern.getArgs(normalized) : undefined,
        reason: pattern.reason,
        confidence: 1.0,
        requiresInference: pattern.kind !== "DETERMINISTIC_FASTPATH",
      };
    }
  }

  // Fallback to general engineering execution
  return {
    kind: "GENERAL_ENGINEERING",
    ruleId: "FALLBACK_GENERAL_MODEL",
    reason: "Task requires general code authoring, multi-turn editing, or complex synthesis",
    confidence: 0.85,
    requiresInference: true,
  };
}
