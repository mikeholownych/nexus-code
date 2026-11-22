/** PA-4 evaluation arms. All arms retain the task's exact objective and final evaluator. */
export const WORKFLOW_ARMS = Object.freeze([
  "serial",
  "independent_agents",
  "specialist_assisted",
  "durable_goal",
  "bounded_batch",
]);

const TEAM_STEPS = Object.freeze([
  { id: "research", role: "researcher", title: "Independent codebase research", prompt: (objective) => `Inspect the repository evidence relevant to this objective. Do not modify files. Objective: ${objective}` },
  { id: "design", role: "architect", title: "Implementation design", dependsOn: ["research"], prompt: (objective) => `Plan a bounded implementation using the research evidence. Do not modify files. Objective: ${objective}` },
  { id: "implement", role: "implementer", title: "Implementation", dependsOn: ["design"], prompt: (objective) => objective },
  { id: "verify", role: "tester", title: "Verification", dependsOn: ["implement"], taskClass: "review", prompt: (objective) => `Run available deterministic project checks for this work and report concrete evidence. Objective: ${objective}` },
  { id: "review", role: "reviewer", title: "Reviewer assessment", dependsOn: ["verify"], taskClass: "review", prompt: (objective) => `Review the implemented change and verifier evidence against the original objective. State any acceptance concerns with supporting evidence. Objective: ${objective}` },
]);

export function validateWorkflowArm(value) {
  if (!WORKFLOW_ARMS.includes(value)) throw new Error(`workflowArm must be one of: ${WORKFLOW_ARMS.join(", ")}`);
  return value;
}

/** Quote one argument for the shared slash parser while preserving Unicode and literal newlines. */
function slashQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function workflowSlashRequest(arm, task, batchSpecPath) {
  validateWorkflowArm(arm);
  if (arm === "specialist_assisted") {
    return { command: "team", args: `full --independent-review ${task.objective}` };
  }
  if (arm === "durable_goal") return { command: "goal", args: task.objective };
  if (arm === "bounded_batch") {
    if (typeof batchSpecPath !== "string" || !batchSpecPath) throw new Error("bounded_batch requires a generated batch specification path");
    return { command: "batch", args: slashQuote(batchSpecPath) };
  }
  throw new Error(`${arm} does not run through a slash lifecycle`);
}

/** The transient arm asks one parent to obtain three separate, read-only analyses before implementation. */
export function independentAgentsObjective(objective) {
  return [
    "Evaluation strategy: before editing, call spawn_subagent exactly three times with distinct read-only questions:",
    "(1) inspect the relevant tests and acceptance evidence; (2) map implementation and call sites; (3) inspect likely failure and security boundaries.",
    "Give each child only its question and necessary source context. Integrate their evidence, then complete the original task yourself.",
    "The engineering objective and acceptance criteria are unchanged:",
    objective,
  ].join("\n\n");
}

/** Generate a durable, sequential work-unit graph using the existing operation specification format. */
export function makeBatchWorkflowSpec(task, id) {
  if (!task || typeof task.objective !== "string" || !task.objective.trim()) throw new Error("workflow task needs an objective");
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error("batch evaluation id is invalid");
  return {
    id,
    objective: task.objective,
    policy: { maxConcurrentUnits: 1 },
    units: TEAM_STEPS.map((step) => ({
      id: step.id,
      title: step.title,
      role: step.role,
      prompt: step.prompt(task.objective),
      ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      ...(step.taskClass ? { taskClass: step.taskClass } : {}),
    })),
  };
}
