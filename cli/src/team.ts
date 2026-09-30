import * as path from "node:path";
import * as fs from "node:fs";
import { AutonomousAgent } from "./agent.js";
import { HarnessConfig, ToolDefinition, ExecutionResult } from "./types.js";
import pc from "picocolors";

export type AgentRole = "researcher" | "architect" | "implementer" | "tester";

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
    recommendedTools: ["read_file", "write_file", "edit_file", "patch_file", "run_command", "run_tests", "task_completed"],
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
    recommendedTools: ["run_tests", "run_command", "read_file", "write_file", "edit_file", "search_code", "task_completed"],
  },
};

export interface RoleTaskResult {
  role: AgentRole;
  summary: string;
  steps: number;
  durationMs: number;
  success: boolean;
}

export interface TeamWorkflowResult {
  objective: string;
  phases: RoleTaskResult[];
  finalReport: string;
  success: boolean;
}

/**
 * Hierarchical Multi-Agent Team Orchestrator (Candidate #13)
 * Coordinates specialized agent sub-roles with structured handoffs.
 */
export class TeamOrchestrator {
  private config: HarnessConfig;

  constructor(config: HarnessConfig) {
    this.config = config;
  }

  /**
   * Execute a focused task delegated to a specific team role
   */
  public async executeRoleTask(
    role: AgentRole,
    task: string,
    contextHandoff?: string
  ): Promise<RoleTaskResult> {
    const profile = ROLE_PROFILES[role] || ROLE_PROFILES.implementer;
    const t0 = Date.now();

    const roleConfig: HarnessConfig = {
      ...this.config,
      maxSteps: Math.min(this.config.maxSteps, 15),
    };

    const agent = new AutonomousAgent(roleConfig, 1);

    try {
      const enrichedPrompt = `[Role: ${profile.title}]\nObjective: ${task}\n${
        contextHandoff ? `\n[Handoff Context from Previous Phase]:\n${contextHandoff}\n` : ""
      }\nExecute tools necessary to fulfill this objective, then report your findings/results via task_completed.`;

      const summary = await agent.runSubagent(enrichedPrompt);

      return {
        role,
        summary: summary || `Role ${role} completed objective.`,
        steps: agent.getHistory().length,
        durationMs: Date.now() - t0,
        success: true,
      };
    } catch (err: any) {
      return {
        role,
        summary: `Role ${role} encountered an error: ${err.message}`,
        steps: 0,
        durationMs: Date.now() - t0,
        success: false,
      };
    } finally {
      agent.shutdown();
    }
  }

  /**
   * Run full collaborative team workflow:
   * 1. Researcher -> 2. Architect -> 3. Implementer -> 4. Tester
   */
  public async runFullWorkflow(objective: string): Promise<TeamWorkflowResult> {
    const phases: RoleTaskResult[] = [];
    let cumulativeContext = `Primary Task: ${objective}`;

    // Phase 1: Research
    const researchRes = await this.executeRoleTask(
      "researcher",
      `Survey relevant files, APIs, and patterns for: "${objective}"`,
      cumulativeContext
    );
    phases.push(researchRes);
    cumulativeContext += `\n\n[Research Findings]:\n${researchRes.summary}`;

    // Phase 2: Architecture & Design
    const archRes = await this.executeRoleTask(
      "architect",
      `Design the implementation plan, file modifications, and interface signatures for: "${objective}"`,
      cumulativeContext
    );
    phases.push(archRes);
    cumulativeContext += `\n\n[Architectural Design]:\n${archRes.summary}`;

    // Phase 3: Implementation
    const implRes = await this.executeRoleTask(
      "implementer",
      `Implement the required code changes according to architectural specification for: "${objective}"`,
      cumulativeContext
    );
    phases.push(implRes);
    cumulativeContext += `\n\n[Implementation Summary]:\n${implRes.summary}`;

    // Phase 4: Test & Verification
    const testRes = await this.executeRoleTask(
      "tester",
      `Verify changes by running the test suite, authoring new tests if needed, and reporting status for: "${objective}"`,
      cumulativeContext
    );
    phases.push(testRes);

    const overallSuccess = phases.every((p) => p.success);
    const finalReport = `=== Multi-Agent Team Execution Report ===\n` +
      `Objective: ${objective}\n` +
      phases.map((p) => `\n[${p.role.toUpperCase()}] (${(p.durationMs / 1000).toFixed(1)}s):\n${p.summary}`).join("\n") +
      `\n\nResult: ${overallSuccess ? "SUCCESS" : "FAILURES DETECTED"}`;

    return {
      objective,
      phases,
      finalReport,
      success: overallSuccess,
    };
  }
}
