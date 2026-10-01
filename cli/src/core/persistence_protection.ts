import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { InformationFlowBoundary } from "./egress.js";

export class SensitivePersistenceError extends Error {
  constructor(destination: string) {
    super(`Sensitive content prevents durable persistence to ${destination}.`);
    this.name = "SensitivePersistenceError";
  }
}

/**
 * Apply Nexus's canonical classifier with irreversible redaction for durable
 * application data. No reversible mapping is created or persisted.
 */
export function redactForPersistence<T>(value: T): T {
  return InformationFlowBoundary.getGlobalInstance().redactForDurablePersistence(value);
}

/**
 * Refuse a durable copy when redaction would alter its source-of-truth content.
 * Checkpoint snapshots use this instead of creating a sanitized, unrestorable
 * workspace copy.
 */
export function assertNoSensitivePersistenceContent(value: unknown, destination: string): void {
  try {
    const protectedValue = redactForPersistence(value);
    if (JSON.stringify(protectedValue) !== JSON.stringify(value)) {
      throw new SensitivePersistenceError(destination);
    }
  } catch (error) {
    if (error instanceof SensitivePersistenceError) throw error;
    throw new SensitivePersistenceError(destination);
  }
}

export function appendProtectedHistoryLine(filePath: string, line: string): void {
  const safeLine = redactForPersistence(line);
  fs.appendFileSync(filePath, `${safeLine}\n`, "utf8");
}

export function writeProtectedTextFile(filePath: string, content: string): void {
  const safeContent = redactForPersistence(content);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, safeContent, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw new Error("Protected persistence write failed");
  }
}
