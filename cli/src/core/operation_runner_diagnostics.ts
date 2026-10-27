/** Fixed, bounded debug events for best-effort operation work. Never attach raw provider or filesystem errors. */
export type OperationDiagnosticArea = "executor" | "persistence" | "revalidation";

export interface OperationDiagnostic {
  level: "debug";
  area: OperationDiagnosticArea;
  action: string;
}

export type OperationDiagnosticHandler = (diagnostic: OperationDiagnostic) => void;

export function reportOperationDiagnostic(
  handler: OperationDiagnosticHandler | undefined,
  area: OperationDiagnosticArea,
  action: string,
): void {
  const diagnostic = { level: "debug", area, action } satisfies OperationDiagnostic;
  try {
    if (handler) handler(diagnostic);
    else console.debug(`[operation:${area}] ${action}`);
  } catch {
    // Diagnostics are best effort and must not change operation behavior.
  }
}
