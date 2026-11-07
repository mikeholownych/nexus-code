/**
 * Shared rules for text that becomes a specialist's input: which workspace paths may never be read into it, how a
 * diff is stripped of them, and the credential redaction applied before it is persisted or prompted.
 */
import * as path from "node:path";
import { SecurityManager } from "../security.js";
import { MAX_SPECIALIST_INPUT_CHARS } from "./specialist_profiles.js";
import { redactForPersistence } from "./persistence_protection.js";

/**
 * Whether a workspace-relative path is off limits as input text: protected by the workspace security policy (the one
 * read_file applies), or inside Nexus's own state directory (`.nexus`, compared case-insensitively because the
 * filesystem may be).
 */
export function inputPathProtection(security: SecurityManager, relative: string): string | undefined {
  const segments = relative.split(/[\\/]/).map((segment) => segment.toLowerCase());
  if (segments.includes(".nexus")) return "inside .nexus";
  const check = security.isPathProtected(relative);
  return check.protected ? (check.reason ?? "protected by the security policy") : undefined;
}

/** Drops the sections of a unified diff that touch protected paths; says how many were left out. */
export function stripProtectedDiffSections(diff: string, workspace: string): { diff: string; omitted: number } {
  const security = new SecurityManager(path.resolve(workspace));
  const sections = diff.split(/^(?=diff --git )/m);
  let omitted = 0;
  const kept = sections.filter((section) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section.split("\n", 1)[0] ?? "");
    if (!header) return true;
    const protectedPath = [header[1], header[2]].some((p) => inputPathProtection(security, p) !== undefined);
    if (protectedPath) omitted++;
    return !protectedPath;
  });
  return { diff: kept.join(""), omitted };
}

/** Credential-redacted and bounded to the input limit, with a marker when cut. */
export function boundedRedactedInput(text: string): string {
  const redacted = redactForPersistence(text);
  return redacted.length > MAX_SPECIALIST_INPUT_CHARS ? `${redacted.slice(0, MAX_SPECIALIST_INPUT_CHARS - 16)}\n[truncated]` : redacted;
}
