import { redactForPersistence } from "./core/persistence_protection.js";
import { redactSecrets } from "./ui.js";
import { visibleControls } from "./file_diff.js";

/**
 * Sanitize text bound for a sink that is not a protocol event: the diff kept on disk, the evidence ledger, stderr
 * diagnostics. Events themselves are sanitized exactly once, by formatSafeSidecarEvent, so emit() call sites pass raw
 * text and never wrap it.
 */
export function formatSafeSidecarText(value: string): string {
  try {
    const safe = redactForPersistence(value);
    if (typeof safe !== "string") throw new Error("unexpected sanitized value type");
    return visibleControls(redactSecrets(safe));
  } catch {
    return "[diagnostic suppressed: credential sanitization failed]";
  }
}
