/** Batch specifications deliberately use the existing `nexus operation` JSON format. */
import { validateOperationSpec } from "./operation_cli.js";
import { newOperation, type OperationPolicy, type WorkUnitSpec } from "./core/operation.js";
import type { ResourceDescriptor } from "./core/resources.js";
import type { BoundaryRules } from "./core/boundary_rules.js";

export interface BatchSpecification {
  id?: string;
  objective: string;
  units: WorkUnitSpec[];
  resources?: Array<Partial<ResourceDescriptor> & { id: string; model: string; endpoint?: string }>;
  discoverCatalog?: boolean;
  policy?: Partial<OperationPolicy>;
  git?: { isolate?: boolean; baseRef?: string };
  boundaries?: BoundaryRules;
}

/**
 * Validates an untrusted batch document using the operation parser and constructor. The constructor owns work-unit
 * invariants such as dependency existence, required/advisory edges, scope normalization and cycle detection; keeping
 * this path on those functions prevents `/batch` from growing a second workflow schema or DAG implementation.
 */
export function validateBatchSpec(spec: unknown): BatchSpecification {
  validateOperationSpec(spec);
  const batch = spec as BatchSpecification;
  // A resource list is provider configuration and is validated by validateOperationSpec; an empty list here keeps
  // validation independent of the current provider and does not perform discovery or inference.
  newOperation(batch.id ?? "batch-validation", batch.objective, batch.units, [], 0, batch.policy);
  return batch;
}
