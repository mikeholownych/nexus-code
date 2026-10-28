import type { ResourceConditionRecord, ResourceDescriptor, ResourceRegistry } from "./resources.js";
import type { WorkUnitExecutor } from "./operation_runner.js";
import { reportOperationDiagnostic, type OperationDiagnosticHandler } from "./operation_runner_diagnostics.js";

const ENDPOINT_SCOPES = new Set(["endpoint", "provider"]);

/** Catalog refresh and endpoint probes are best-effort checks before scheduled work is sent. */
export class OperationRevalidator {
  constructor(
    private readonly executor: WorkUnitExecutor,
    private readonly registry: ResourceRegistry,
    private readonly onDiagnostic?: OperationDiagnosticHandler,
  ) {}

  async refresh(signal?: AbortSignal): Promise<void> {
    try {
      await this.executor.refresh?.(this.registry, signal);
    } catch {
      if (!signal?.aborted) reportOperationDiagnostic(this.onDiagnostic, "revalidation", "catalog_refresh_failed");
    }
  }

  async revalidate(signal?: AbortSignal): Promise<void> {
    await this.refresh(signal);
    if (!this.executor.probe) return;
    const probed = new Set<string>();
    for (const condition of this.registry.due()) {
      if (!ENDPOINT_SCOPES.has(condition.scope) || probed.has(condition.key)) continue;
      probed.add(condition.key);
      const resource = this.registry.get(condition.resourceId);
      if (!resource) continue;
      try {
        const result = await this.executor.probe(resource, signal);
        this.registry.observeProbe(resource, result.available, result.failure);
      } catch {
        if (signal?.aborted) return;
        reportOperationDiagnostic(this.onDiagnostic, "revalidation", "endpoint_probe_failed");
      }
    }
  }

  /** Recheck expired conditions just before assignment; return true when scheduling must be reconsidered. */
  async beforeAssign(resource: ResourceDescriptor, signal?: AbortSignal): Promise<boolean> {
    const checkable = (condition: ResourceConditionRecord) =>
      condition.source === "provider-catalog" || ENDPOINT_SCOPES.has(condition.scope);
    const stale = this.registry.dueFor(resource).filter(checkable);
    if (!stale.length) return false;
    const before = JSON.stringify(stale);
    if (stale.some((condition) => condition.source === "provider-catalog")) {
      try {
        await this.executor.refresh?.(this.registry, signal);
      } catch {
        if (!signal?.aborted) reportOperationDiagnostic(this.onDiagnostic, "revalidation", "catalog_refresh_failed");
      }
    }
    if (stale.some((condition) => ENDPOINT_SCOPES.has(condition.scope)) && this.executor.probe) {
      try {
        const result = await this.executor.probe(resource, signal);
        this.registry.observeProbe(resource, result.available, result.failure);
      } catch {
        if (!signal?.aborted) reportOperationDiagnostic(this.onDiagnostic, "revalidation", "endpoint_probe_failed");
      }
    }
    return JSON.stringify(this.registry.dueFor(resource).filter(checkable)) !== before;
  }
}
