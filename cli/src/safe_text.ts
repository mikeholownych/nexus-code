import { SANITIZATION_FAILED, redactForPersistence } from "./core/persistence_protection.js";
import { safeTerminal } from "./ui.js";

/**
 * Sanitize text bound for a sink that is not a protocol event: the diff kept on disk, the evidence ledger, stderr
 * diagnostics. Events themselves are sanitized exactly once, by formatSafeSidecarEvent, so emit() call sites pass raw
 * text and never wrap it.
 */
export { SANITIZATION_FAILED };

export function formatSafeSidecarText(value: string): string {
  try {
    const safe = redactForPersistence(value);
    if (typeof safe !== "string") throw new Error("unexpected sanitized value type");
    return safeTerminal(safe);
  } catch {
    return SANITIZATION_FAILED;
  }
}
