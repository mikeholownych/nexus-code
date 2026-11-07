/**
 * Bounded Specialist Agent Contracts & Profiles (Nexus Code v1.1.2)
 *
 * Defines explicit contracts for specialized subagent workflows:
 * - Permitted tool whitelist
 * - Read-only enforcement
 * - Input requirements and evidence prerequisites
 * - Structured output schema validation
 * - Token budget ceilings and escalation thresholds
 *
 * Deterministic operations (ordinary file discovery, grep, AST queries, git diff)
 * remain deterministic tools. Specialists provide bounded semantic analysis.
 */

export type SpecialistRole =
  | "semantic_explorer"
  | "call_site_analyzer"
  | "failure_debugger"
  | "security_reviewer"
  | "acceptance_reviewer";

export interface SpecialistContract {
  role: SpecialistRole;
  title: string;
  description: string;
  permittedTools: readonly string[];
  readOnly: boolean;
  maxContextTokens: number;
  inputRequirements: readonly string[];
  outputSchemaName: string;
  escalationCriteria: string[];
}

export const SPECIALIST_CONTRACTS: Record<SpecialistRole, SpecialistContract> = {
  semantic_explorer: {
    role: "semantic_explorer",
    title: "Codebase Semantic Explorer",
    description: "Performs targeted conceptual discovery, cross-file pattern analysis, and architectural mapping.",
    permittedTools: [
      "read_file",
      "batch_read",
      "search_code",
      "search_symbols",
      "find_files",
      "file_info",
      "file_tree",
      "task_completed",
    ],
    readOnly: true,
    maxContextTokens: 16000,
    inputRequirements: ["target_query", "focus_directories"],
    outputSchemaName: "SemanticExplorationOutput",
    escalationCriteria: [
      "Query matches 0 relevant code symbols after exhaustive search",
      "Conflicting architectural patterns detected across modules",
    ],
  },

  call_site_analyzer: {
    role: "call_site_analyzer",
    title: "Dependency & Call-Site Analyzer",
    description: "Traces call graphs, parameter flows, type contracts, and cross-package dependency impacts.",
    permittedTools: [
      "read_file",
      "batch_read",
      "search_code",
      "search_symbols",
      "file_info",
      "task_completed",
    ],
    readOnly: true,
    maxContextTokens: 24000,
    inputRequirements: ["symbol_name", "defining_path"],
    outputSchemaName: "CallSiteAnalysisOutput",
    escalationCriteria: [
      "Dynamic reflection or untyped call-sites prevent static dependency resolution",
      "Public API boundary change affects external consumers",
    ],
  },

  failure_debugger: {
    role: "failure_debugger",
    title: "Failure Investigation & Root-Cause Debugger",
    description: "Analyzes stack traces, compiler errors, test logs, and isolates root-cause failure points.",
    permittedTools: [
      "read_file",
      "batch_read",
      "search_code",
      "run_command",
      "run_tests",
      "file_info",
      "task_completed",
    ],
    // run_command / run_tests can write to the workspace, so this role is not read-only.
    readOnly: false,
    maxContextTokens: 32000,
    inputRequirements: ["failure_log", "reproduction_command"],
    outputSchemaName: "FailureDebugOutput",
    escalationCriteria: [
      "Failure cannot be reproduced deterministically in isolated environment",
      "Failure is caused by unmodeled host platform dependency or environmental drift",
    ],
  },

  security_reviewer: {
    role: "security_reviewer",
    title: "Security & Vulnerability Reviewer",
    description: "Audits diffs for injection vectors, path traversal, credential exposure, and unsafe execution.",
    permittedTools: [
      "read_file",
      "batch_read",
      "search_code",
      "file_info",
      "task_completed",
    ],
    readOnly: true,
    maxContextTokens: 24000,
    inputRequirements: ["unified_diff", "authorized_scope"],
    outputSchemaName: "SecurityReviewOutput",
    escalationCriteria: [
      "Diff touches sensitive credential stores, crypto roots, or shell sanitization routines",
      "Ambiguous input validation boundary requires architect review",
    ],
  },

  acceptance_reviewer: {
    role: "acceptance_reviewer",
    title: "Independent Acceptance Reviewer",
    description: "Conducts independent, un-biased verification against raw requirements and objective test evidence.",
    permittedTools: [
      "read_file",
      "batch_read",
      "search_code",
      "file_info",
      "task_completed",
    ],
    readOnly: true,
    maxContextTokens: 32000,
    inputRequirements: ["raw_requirements", "authorized_scope", "unified_diff", "verifier_evidence"],
    outputSchemaName: "IndependentReviewVerdict",
    escalationCriteria: [
      "Acceptance criteria lack unambiguous deterministic test proofs",
      "Candidate diff touches files outside authorized change boundary",
    ],
  },
};

export class ToolAccessDeniedError extends Error {
  constructor(
    readonly role: SpecialistRole,
    readonly toolName: string,
    readonly permittedTools: readonly string[],
  ) {
    super(
      `Specialist role '${role}' is not permitted to execute tool '${toolName}'. Permitted tools: [${permittedTools.join(", ")}].`,
    );
    this.name = "ToolAccessDeniedError";
  }
}

/**
 * Validates whether a specialist profile is authorized to call a specific tool.
 * Throws ToolAccessDeniedError if the tool is not whitelisted.
 */
export function validateSpecialistToolAccess(role: SpecialistRole, toolName: string): void {
  if (!isSpecialistRole(role)) {
    throw new Error(`Unknown specialist role: '${role}'`);
  }
  const contract = SPECIALIST_CONTRACTS[role];
  if (!contract.permittedTools.includes(toolName)) {
    throw new ToolAccessDeniedError(role, toolName, contract.permittedTools);
  }
}

export function isSpecialistRole(role: string | undefined): role is SpecialistRole {
  return role !== undefined && typeof role === "string" && Object.hasOwn(SPECIALIST_CONTRACTS, role);
}

/** Largest accepted value for one named input, and the most inputs one unit may carry. */
export const MAX_SPECIALIST_INPUT_CHARS = 200_000;
export const MAX_SPECIALIST_INPUTS = 16;

/** Why `inputs` is not a valid named-input map, or undefined when it is. Shared by specs, new operations and loads. */
export function specialistInputsProblem(inputs: unknown): string | undefined {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return "'inputs' must be an object of named strings";
  const entries = Object.entries(inputs as Record<string, unknown>);
  if (entries.length > MAX_SPECIALIST_INPUTS) return `'inputs' has more than ${MAX_SPECIALIST_INPUTS} entries`;
  for (const [name, value] of entries) {
    if (typeof value !== "string") return `input '${name}' must be a string`;
    if (value.length > MAX_SPECIALIST_INPUT_CHARS) return `input '${name}' is longer than ${MAX_SPECIALIST_INPUT_CHARS} characters`;
  }
  return undefined;
}

/** The contract's required inputs that are absent or blank in `inputs`. */
export function missingSpecialistInputs(role: SpecialistRole, inputs: Record<string, string> | undefined): string[] {
  return SPECIALIST_CONTRACTS[role].inputRequirements.filter((name) => !inputs || typeof inputs[name] !== "string" || inputs[name].trim() === "");
}

/**
 * Splits leading `name=value` words (names from the role's contract; a value is one word or a quoted string; an
 * `@path` value is a workspace file the caller resolves) off a one-line task, for callers such as `/team` that have
 * no structured input channel. The rest is the task.
 */
export function parseLeadingSpecialistInputs(role: SpecialistRole, text: string): { inputs: Record<string, string>; task: string } {
  const names = new Set<string>(SPECIALIST_CONTRACTS[role].inputRequirements);
  const inputs: Record<string, string> = {};
  let rest = text.trimStart();
  for (;;) {
    const m = /^([a-z_]+)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(rest);
    if (!m || !names.has(m[1]) || Object.hasOwn(inputs, m[1])) break;
    inputs[m[1]] = m[2] ?? m[3] ?? m[4];
    rest = rest.slice(m[0].length);
  }
  return { inputs, task: rest.trim() };
}

export interface SpecialistEvidenceItem {
  path: string;
  lineRange?: [number, number];
  note: string;
}

export interface SpecialistStructuredOutput<T = unknown> {
  specialistRole: SpecialistRole;
  status: "SUCCESS" | "FAILED" | "INCONCLUSIVE";
  summary: string;
  findings: T;
  evidence: SpecialistEvidenceItem[];
  escalationRecommended: boolean;
  escalationReason?: string;
}

export function validateSpecialistOutput<T>(
  role: SpecialistRole,
  raw: unknown,
): SpecialistStructuredOutput<T> {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Specialist output must be an object, received: ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.specialistRole !== role) {
    throw new Error(`Specialist output role mismatch: expected '${role}', got '${obj.specialistRole}'`);
  }
  if (!["SUCCESS", "FAILED", "INCONCLUSIVE"].includes(obj.status as string)) {
    throw new Error(`Invalid specialist status: '${obj.status}'`);
  }
  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    throw new Error("Specialist output must include a non-empty summary string");
  }
  if (!Array.isArray(obj.evidence)) {
    throw new Error("Specialist output must include an evidence array");
  }
  for (const item of obj.evidence) {
    if (!item || typeof item !== "object" || typeof item.path !== "string") {
      throw new Error("Each evidence item must contain a 'path' string");
    }
  }
  return obj as unknown as SpecialistStructuredOutput<T>;
}
