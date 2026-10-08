export const ROLE_PROFILES = {
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
    reviewer: {
        role: "reviewer",
        title: "Independent Reviewer",
        description: "Reviews the implementation on a model independent of the one that wrote it.",
        systemPromptAddendum: `\n### Specialized Role: INDEPENDENT REVIEWER
You are reviewing work produced by a different model. Do not assume it is correct.
- Read the changed code and the stated design; check correctness, edge cases and regressions.
- Do not modify files; report concrete findings with file paths and line references.
- Conclude with an explicit verdict: acceptable, or the specific defects that must be fixed.`,
        recommendedTools: ["read_file", "batch_read", "search_code", "run_tests", "task_completed"],
    },
};
export const ROLE_REQUIREMENTS = {
    researcher: { qualification: "research", capabilities: ["tools"], taskClass: "subagent" },
    architect: { qualification: "architecture", capabilities: ["tools"], taskClass: "architecture" },
    implementer: { qualification: "implementation", capabilities: ["tools"] },
    tester: { qualification: "verification", capabilities: ["tools"], taskClass: "review" },
    reviewer: { qualification: "review", capabilities: ["tools"], taskClass: "review" },
};
export function roleRequirements(role, extra = {}) {
    const r = ROLE_REQUIREMENTS[role];
    return { capabilities: [...r.capabilities], qualification: r.qualification, ...extra };
}
