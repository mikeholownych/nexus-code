import { createHash } from "node:crypto";
import type { BatchPlan, PlanCheck } from "./batch_plan.js";
import type { WorkUnitSpec } from "./core/operation.js";

function integrationCheck(check: PlanCheck, unitId?: string) {
  // Plan check IDs are unique within a scope. Operation check IDs are unique across the operation.
  const id = createHash("sha256").update(JSON.stringify([unitId ?? null, check.id])).digest("hex");
  return {
    id,
    purpose: check.expectation,
    command: check.command,
    requirement: check.when ? "conditional" as const : check.required ? "required" as const : "advisory" as const,
    cwd: check.cwd,
    timeoutMs: check.timeoutSeconds * 1000,
    unitId,
    ...(check.when ? { when: check.when } : {}),
  };
}

/** Translate the reviewed graph without changing the scheduler's normal unit admission rules. */
export function batchPlanExecution(plan: BatchPlan) {
  const units: WorkUnitSpec[] = plan.units.map((unit) => ({
    id: unit.id,
    title: unit.title,
    role: unit.role,
    required: unit.required,
    dependsOn: unit.dependsOn,
    requires: unit.requires,
    ...(unit.mode === "write" ? { authorizedScope: unit.scope } : {}),
    prompt: [
      unit.objective,
      `Operation objective: ${plan.objective}`,
      `Accepted scope: ${unit.scope.join(", ")}`,
      ...unit.acceptanceCriteria.map((criterion) => `Unit acceptance criterion: ${criterion}`),
      ...unit.outputs.map((output) => `Expected output: ${output}`),
      ...unit.handoffs.map((source) => `Handoff from: ${source}`),
      ...plan.acceptanceCriteria.map((criterion) => `Operation acceptance criterion: ${criterion}`),
      ...plan.assumptions.map((assumption) => `Unverified assumption: ${assumption}`),
    ].join("\n"),
  }));
  return {
    units,
    verificationChecks: [
      ...plan.checks.map((check) => integrationCheck(check)),
      ...plan.units.flatMap((unit) => unit.checks.map((check) => integrationCheck(check, unit.id))),
    ],
  };
}
