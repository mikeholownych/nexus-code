import { createHash } from "node:crypto";

export const MAX_INTEGRATION_CHECKS = 16;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PATHS = 32;
const CHECK_KEYS = new Set(["id", "unitId", "purpose", "command", "requirement", "cwd", "timeoutMs", "when"]);
const ACCESSIBLE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export interface OperationVerificationCheck {
  id: string;
  unitId?: string;
  purpose: string;
  command: string;
  requirement: "required" | "advisory" | "conditional";
  cwd: string;
  timeoutMs: number;
  when?: { changedPaths: string[] };
}

function relativePath(value: unknown): value is string {
  if (value === ".") return true;
  return typeof value === "string" && value.length <= 512 && !/[\\:\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOperationVerificationChecks(raw: unknown): OperationVerificationCheck[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_INTEGRATION_CHECKS) {
    throw new Error(`verificationChecks must contain 1-${MAX_INTEGRATION_CHECKS} checks`);
  }
  const ids = new Set<string>();
  return raw.map((row: unknown, index) => {
    const fail = (reason: string): never => { throw new Error(`verificationChecks[${index}]: ${reason}`); };
    if (!record(row)) return fail("expected a check object");
    if (Object.keys(row).some((key) => !CHECK_KEYS.has(key))) return fail("unknown check field");
    const { id, unitId, purpose, command, requirement, cwd = ".", timeoutMs = DEFAULT_TIMEOUT_MS, when } = row;
    if (typeof id !== "string" || !ACCESSIBLE_ID.test(id) || ids.has(id)) return fail("id must be a unique, non-empty check identifier");
    if (unitId !== undefined && (typeof unitId !== "string" || !ACCESSIBLE_ID.test(unitId))) return fail("unitId must be a work-unit identifier");
    if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 500 || /[\u0000-\u001f\u007f]/.test(purpose)) return fail("purpose must be a bounded single line");
    if (typeof command !== "string" || !command.trim() || command.length > 4096 || /[\u0000-\u001f\u007f]/.test(command)) return fail("command must be a bounded single line");
    if (!relativePath(cwd)) return fail("cwd must be a workspace-relative directory");
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return fail(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
    }
    if (requirement !== "required" && requirement !== "advisory" && requirement !== "conditional") return fail("invalid requirement");
    let changedPaths: string[] | undefined;
    if (requirement === "conditional") {
      if (!record(when) || Object.keys(when).length !== 1 || !Array.isArray(when.changedPaths)
        || !when.changedPaths.length || when.changedPaths.length > MAX_PATHS
        || !when.changedPaths.every(relativePath) || new Set(when.changedPaths).size !== when.changedPaths.length) {
        return fail("conditional checks need unique workspace-relative when.changedPaths");
      }
      changedPaths = [...when.changedPaths].sort();
    } else if (when !== undefined) return fail("when is supported only for conditional checks");
    ids.add(id);
    return {
      id, ...(unitId === undefined ? {} : { unitId }), purpose: purpose.trim(), command: command.trim(), requirement, cwd, timeoutMs,
      ...(changedPaths ? { when: { changedPaths } } : {}),
    };
  });
}

export function operationVerificationDefinitionDigest(check: OperationVerificationCheck): string {
  return createHash("sha256").update(JSON.stringify([
    1, check.id, check.unitId ?? null, check.purpose, check.command, check.requirement, check.cwd, check.timeoutMs, check.when?.changedPaths ?? null,
  ])).digest("hex");
}

export function operationVerificationApplies(check: OperationVerificationCheck, changed: readonly string[]): boolean {
  return check.requirement !== "conditional" || Boolean(check.when?.changedPaths.some(
    (scope) => changed.some((file) => scope === "." || file === scope || file.startsWith(scope + "/")),
  ));
}
