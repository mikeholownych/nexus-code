import { redactForPersistence } from "./core/persistence_protection.js";
import { redactSecrets } from "./ui.js";
import { visibleControls } from "./file_diff.js";

/**
 * Sanitize text bound for a sink that is not a protocol event: the diff kept on disk, the evidence ledger, stderr
 * diagnostics. Events themselves are sanitized exactly once, by formatSafeSidecarEvent, so emit() call sites pass raw
 * text and never wrap it.
 */
/** What the sanitiser returns when it fails: callers that must not use that text compare with this constant, never a prefix. */
export const SANITIZATION_FAILED = "[diagnostic suppressed: credential sanitization failed]";

export function formatSafeSidecarText(value: string): string {
  try {
    const safe = redactForPersistence(value);
    if (typeof safe !== "string") throw new Error("unexpected sanitized value type");
    return visibleControls(redactSecrets(safe));
  } catch {
    return SANITIZATION_FAILED;
  }
}
