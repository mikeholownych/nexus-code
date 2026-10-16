/**
 * Team role profiles and what each role requires of the resource that runs it.
 *
 * Requirements are scheduling inputs, not model names: a role names the qualification it needs, and resources say
 * which qualifications they hold and which they are preferred for. The scheduler picks the best eligible qualified
 * resource, reroutes or parks when it becomes unavailable, and never runs a role on an unqualified one.
 */
import type { WorkRequirements } from "./resources.js";

export type AgentRole = "researcher" | "architect" | "implementer" | "tester" | "reviewer";

export interface RoleProfile {
  role: AgentRole;
  title: string;
  description: string;
  systemPromptAddendum: string;
  recommendedTools: string[];
}

export const ROLE_PROFILES: Record<AgentRole, RoleProfile> = {
  researcher: {
    role: "researcher",
    title: "Codebase & Technology Researcher",
    description: "Investigates code structure, dependencies, technical documentation, and external solutions.",
    systemPromptAddendum: `\n### Specialized Role: RESEARCHER
You are a senior codebase and technology researcher. Your objective is thorough investigation without making destructive mutations.
- Deeply inspect existing patterns, function definitions, configurations, and imports.
- Utilize batch_read, file_info, search_code, and search_web.
- Conclude with a clear, factual architectural briefing with file paths and line references.`,
    recommendedTools: ["read_file", "batch_read", "search_code", "search_symbols", "find_files", "file_info", "search_web", "task_completed"],
  },
  architect: {
    role: "architect",
    title: "System & Software Architect",
    description: "Formulates modular designs, data flows, interface specifications, and milestone execution plans.",
    systemPromptAddendum: `\n### Specialized Role: ARCHITECT
You are a principal software architect. Your objective is to design clean, modular solutions adhering to existing codebase idioms.
- Define explicit interface boundaries, type signatures, and data contracts.
- Plan the implementation sequence using update_plan with distinct milestone phases.
- Produce structured technical specifications and handoff guidelines for the Implementer.`,
    recommendedTools: ["read_file", "search_code", "file_tree", "update_plan", "file_info", "task_completed"],
  },
  implementer: {
    role: "implementer",
    title: "Core Software Implementer",
    description: "Writes production-grade, modular, idiomatic code and applies surgical file edits.",
    systemPromptAddendum: `\n### Specialized Role: IMPLEMENTER
You are a senior software engineer. Your objective is precise, idiomatic implementation of architectural designs.
- Maintain existing coding conventions, documentation comments, and typing rules.
- Make minimal, surgical edits using edit_file and patch_file.
- Verify syntactical correctness and avoid unintended breaking changes.`,
    recommendedTools: ["read_file", "write_file", "edit_file", "patch_file", "run_command", "run_tests", "read_objective", "update_requirements", "task_completed"],
  },
  tester: {
    role: "tester",
    title: "Quality Assurance & Test Engineer",
    description: "Validates functionality, writes unit/integration tests, runs test suites, and diagnoses regressions.",
    systemPromptAddendum: `\n### Specialized Role: TESTER
You are a QA automation and test engineer. Your objective is rigorous verification and defect discovery.
- Run automated test suites via run_tests or run_command.
- Analyze test failures, parse compiler/test diagnostics, and pinpoint regressions.
- Author unit and integration tests covering positive paths, error handling, and boundary conditions.`,
    recommendedTools: ["run_tests", "run_command", "read_file", "write_file", "edit_file", "search_code", "read_objective", "update_requirements", "task_completed"],
  },
  reviewer: {
    role: "reviewer",
    title: "Independent Reviewer",
    description: "Reviews the implementation on a model independent of the one that wrote it.",
    systemPromptAddendum: `\n### Specialized Role: INDEPENDENT REVIEWER
You are reviewing work produced by a different model. Do not assume it is correct.
- Read the changed code and the stated design; check correctness, edge cases and regressions.
- Do not modify files; report concrete findings with file paths and line references.
- Conclude with an explicit verdict: acceptable, or the specific defects that must be fixed.`,
    recommendedTools: ["read_file", "batch_read", "search_code", "task_completed"],
  },
};

/**
 * Roles that run with a read-only tool set (DEC-07, REQ-AGT-119). The operation runner starts their units in read-only
 * mode, so a write or exec call is refused by the agent rather than relying on the prompt.
 */
export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["researcher", "reviewer"]);

export function isReadOnlyRole(role: AgentRole | string | undefined): boolean {
  return role !== undefined && READ_ONLY_ROLES.has(role as AgentRole);
}

export interface RoleRequirement {
  /** Qualification a resource must hold (resources without a qualification list hold all). */
  qualification: string;
  capabilities: string[];
  /** X-Task-Class routing hint for gateways that route by task class. */
  taskClass?: string;
}

export const ROLE_REQUIREMENTS: Record<AgentRole, RoleRequirement> = {
  researcher: { qualification: "research", capabilities: ["tools"], taskClass: "subagent" },
  architect: { qualification: "architecture", capabilities: ["tools"], taskClass: "architecture" },
  implementer: { qualification: "implementation", capabilities: ["tools"] },
  tester: { qualification: "verification", capabilities: ["tools"], taskClass: "review" },
  reviewer: { qualification: "review", capabilities: ["tools"], taskClass: "review" },
};

export function roleRequirements(role: AgentRole, extra: Partial<WorkRequirements> = {}): WorkRequirements {
  const r = ROLE_REQUIREMENTS[role];
  return { capabilities: [...r.capabilities], qualification: r.qualification, ...extra };
}
