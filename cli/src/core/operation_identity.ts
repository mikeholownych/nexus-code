/** Stable identity for deciding whether a tool call may repeat an interrupted side effect. */
import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** Hash tool name and canonical arguments; never persist the arguments themselves because they can contain secrets. */
export function argsFingerprint(toolName: string, args: unknown): string {
  return createHash("sha256").update(JSON.stringify([toolName, canonical(args ?? {})])).digest("hex");
}
