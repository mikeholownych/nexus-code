import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { redactSecrets } from "../ui.js";
import type { RunManifest, RunStatus } from "./contracts.js";

export interface IntegrityRecord {
  runId: string;
  calculatedAt: string;
  fileHashes: Record<string, string>;
  compositeSha256: string;
}

export function sanitizeIdentifier(id: string, name: string): string {
  if (!id || typeof id !== "string") {
    throw new Error(`Invalid ${name}: must be a non-empty string`);
  }
  const trimmed = id.trim();
  if (
    trimmed === "." ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    !/^[a-zA-Z0-9_.-]+$/.test(trimmed)
  ) {
    throw new Error(
      `Invalid ${name} "${id}": contains invalid characters or path traversal elements`
    );
  }
  return trimmed;
}

export class CeriEvidenceStore {
  private readonly baseDir: string;
  private currentRunDir?: string;
  private currentManifest?: RunManifest;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Initializes a run directory and atomically writes the initial RunManifest.
   */
  initRun(manifest: RunManifest): string {
    const sEvalId = sanitizeIdentifier(manifest.evaluationId, "evaluationId");
    const sRunId = sanitizeIdentifier(manifest.runId, "runId");
    const runDir = path.resolve(this.baseDir, sEvalId, sRunId);
    if (!runDir.startsWith(this.baseDir + path.sep)) {
      throw new Error(`Path traversal detected: ${runDir} is outside baseDir ${this.baseDir}`);
    }

    fs.mkdirSync(runDir, { recursive: true });
    this.currentRunDir = runDir;
    this.currentManifest = { ...manifest, status: "RUNNING" };

    const manifestPath = path.join(runDir, "manifest.json");
    this.atomicWriteJson(manifestPath, this.currentManifest);
    return runDir;
  }

  /**
   * Appends an event to events.jsonl with secret redaction.
   */
  appendEvent(event: Record<string, unknown>): void {
    if (!this.currentRunDir) {
      throw new Error("Cannot append event: no active run initialized");
    }
    const eventsPath = path.join(this.currentRunDir, "events.jsonl");
    const serialized = JSON.stringify(event, (_k, v) => (typeof v === "string" ? redactSecrets(v) : v));
    fs.appendFileSync(eventsPath, serialized + "\n", { encoding: "utf-8" });
  }

  /**
   * Records deterministic assertion outputs atomically.
   */
  recordAssertions(assertions: Record<string, unknown>[]): void {
    if (!this.currentRunDir) {
      throw new Error("Cannot record assertions: no active run initialized");
    }
    const assertionsPath = path.join(this.currentRunDir, "assertions.json");
    this.atomicWriteJson(assertionsPath, assertions);
  }

  /**
   * Records independent validation receipts atomically.
   */
  recordReceipts(receipts: Record<string, unknown>[]): void {
    if (!this.currentRunDir) {
      throw new Error("Cannot record receipts: no active run initialized");
    }
    const receiptsPath = path.join(this.currentRunDir, "receipts.json");
    this.atomicWriteJson(receiptsPath, receipts);
  }

  /**
   * Finalizes the run, updates status and completedAt in manifest, and generates
   * a tamper-evident integrity record linking all artifacts.
   */
  finalizeRun(status: RunStatus, terminationReason?: string): { integrityHash: string; runDir: string } {
    if (!this.currentRunDir || !this.currentManifest) {
      throw new Error("Cannot finalize run: no active run initialized");
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(this.currentManifest.startedAt).getTime();

    this.currentManifest.status = status;
    this.currentManifest.completedAt = completedAt;
    this.currentManifest.durationMs = durationMs;
    if (terminationReason) {
      this.currentManifest.terminationReason = terminationReason;
    }

    const manifestPath = path.join(this.currentRunDir, "manifest.json");
    this.atomicWriteJson(manifestPath, this.currentManifest);

    // Compute file hashes for tamper evidence
    const files = fs.readdirSync(this.currentRunDir).filter((f) => f !== "integrity.json" && !f.startsWith(".tmp"));
    const fileHashes: Record<string, string> = {};
    const compositeHasher = createHash("sha256");

    files.sort().forEach((file) => {
      const fullPath = path.join(this.currentRunDir!, file);
      const content = fs.readFileSync(fullPath);
      const hash = createHash("sha256").update(content).digest("hex");
      fileHashes[file] = hash;
      compositeHasher.update(`${file}:${hash};`);
    });

    const compositeSha256 = compositeHasher.digest("hex");
    const integrityRecord: IntegrityRecord = {
      runId: this.currentManifest.runId,
      calculatedAt: completedAt,
      fileHashes,
      compositeSha256,
    };

    const integrityPath = path.join(this.currentRunDir, "integrity.json");
    this.atomicWriteJson(integrityPath, integrityRecord);

    const result = { integrityHash: compositeSha256, runDir: this.currentRunDir };
    this.currentRunDir = undefined;
    this.currentManifest = undefined;
    return result;
  }

  /**
   * Loads assertions recorded for a past evaluation run.
   */
  loadAssertions(evaluationId: string, runId: string): Record<string, boolean> | undefined {
    const sEvalId = sanitizeIdentifier(evaluationId, "evaluationId");
    const sRunId = sanitizeIdentifier(runId, "runId");
    const assertionsPath = path.resolve(this.baseDir, sEvalId, sRunId, "assertions.json");
    if (!assertionsPath.startsWith(this.baseDir + path.sep)) {
      throw new Error(`Path traversal detected: ${assertionsPath} is outside baseDir ${this.baseDir}`);
    }
    if (!fs.existsSync(assertionsPath)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(assertionsPath, "utf-8"));
      if (Array.isArray(data)) {
        const map: Record<string, boolean> = {};
        for (const item of data) {
          if (item && typeof item === "object" && typeof item.id === "string") {
            map[item.id] = Boolean(item.passed);
          }
        }
        return map;
      } else if (data && typeof data === "object") {
        return data as Record<string, boolean>;
      }
    } catch {}
    return undefined;
  }

  /**
   * Loads manifest for a past evaluation run.
   */
  loadManifest(evaluationId: string, runId: string): RunManifest | undefined {
    const sEvalId = sanitizeIdentifier(evaluationId, "evaluationId");
    const sRunId = sanitizeIdentifier(runId, "runId");
    const manifestPath = path.resolve(this.baseDir, sEvalId, sRunId, "manifest.json");
    if (!manifestPath.startsWith(this.baseDir + path.sep)) {
      throw new Error(`Path traversal detected: ${manifestPath} is outside baseDir ${this.baseDir}`);
    }
    if (!fs.existsSync(manifestPath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as RunManifest;
    } catch {
      return undefined;
    }
  }

  /**
   * Scans baseDir for runs left in RUNNING status without completion (interrupted runs).
   */
  detectInterruptedRuns(): string[] {
    const interrupted: string[] = [];
    if (!fs.existsSync(this.baseDir)) return interrupted;

    const evalDirs = fs.readdirSync(this.baseDir);
    for (const evalId of evalDirs) {
      const evalPath = path.join(this.baseDir, evalId);
      if (!fs.statSync(evalPath).isDirectory()) continue;

      const runDirs = fs.readdirSync(evalPath);
      for (const runId of runDirs) {
        const runPath = path.join(evalPath, runId);
        if (!fs.statSync(runPath).isDirectory()) continue;

        const manifestPath = path.join(runPath, "manifest.json");
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as RunManifest;
            if (manifest.status === "RUNNING" && !manifest.completedAt) {
              interrupted.push(manifest.runId);
            }
          } catch {}
        }
      }
    }
    return interrupted;
  }

  /**
   * Atomically writes JSON content via temporary file rename.
   */
  private atomicWriteJson(targetPath: string, data: unknown): void {
    const dir = path.dirname(targetPath);
    const tmpPath = path.join(dir, `.tmp.${path.basename(targetPath)}.${process.pid}.${Date.now()}`);
    const serialized = JSON.stringify(data, (_k, v) => (typeof v === "string" ? redactSecrets(v) : v), 2);

    fs.writeFileSync(tmpPath, serialized, { encoding: "utf-8" });
    fs.renameSync(tmpPath, targetPath);
  }
}
