import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { appendLinesDurably, ensurePrivateDir, writeFileDurably } from "../durable_file.js";
import { redactForPersistence } from "../persistence_protection.js";
import { assertValid, validateHarnessCandidate, validateHarnessManifest, validateHirRun, validateHirTaskSuite, validateLibraryEntry, validateProbeResult, validatePromotionReport } from "./schema.js";
import type { HarnessCandidate, HarnessImprovementRun, HarnessManifest, HirEvidenceRecord, HirEvent, HirTaskSuite, ProbeResult, PromotionReport } from "./types.js";

function nowIso(): string { return new Date().toISOString(); }
function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(id)) throw new Error(`invalid id: ${id}`);
  return id;
}

export interface HarnessStoreOptions {
  rootDir?: string;
}

export class HarnessStore {
  readonly rootDir: string;
  constructor(opts: HarnessStoreOptions = {}) {
    const base = opts.rootDir ?? path.join(process.env.NEXUS_STATE_DIR || path.join(os.homedir(), ".nexus"), "harness");
    this.rootDir = path.resolve(base);
    ensurePrivateDir(this.rootDir);
    for (const d of ["runs", "bases", "candidates", "probes", "library/entries", "locks"]) ensurePrivateDir(path.join(this.rootDir, d));
  }

  runDir(runId: string): string { return path.join(this.rootDir, "runs", safeId(runId)); }
  runPath(runId: string): string { return path.join(this.runDir(runId), "run.json"); }
  eventsPath(runId: string): string { return path.join(this.runDir(runId), "events.jsonl"); }
  evidencePath(runId: string): string { return path.join(this.runDir(runId), "evidence.jsonl"); }
  reportJsonPath(runId: string): string { return path.join(this.runDir(runId), "report.json"); }
  reportMdPath(runId: string): string { return path.join(this.runDir(runId), "report.md"); }
  baseDir(id: string): string { return path.join(this.rootDir, "bases", safeId(id)); }
  candidateDir(id: string): string { return path.join(this.rootDir, "candidates", safeId(id)); }
  probeDir(id: string): string { return path.join(this.rootDir, "probes", safeId(id)); }

  saveRun(run: HarnessImprovementRun): void {
    assertValid("run", run, validateHirRun);
    const dir = this.runDir(run.id);
    ensurePrivateDir(dir);
    const redacted = redactForPersistence(run);
    writeFileDurably(this.runPath(run.id), JSON.stringify(redacted, null, 2) + "\n", 0o600);
  }

  loadRun(runId: string): HarnessImprovementRun {
    const raw = JSON.parse(fs.readFileSync(this.runPath(runId), "utf8"));
    return assertValid("run", raw, validateHirRun);
  }

  listRuns(): HarnessImprovementRun[] {
    const dir = path.join(this.rootDir, "runs");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.startsWith("hir_")).flatMap((n) => {
      try { return [this.loadRun(n)]; } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  saveBaseManifest(manifest: HarnessManifest): void {
    assertValid("manifest", manifest, validateHarnessManifest);
    const dir = this.baseDir(manifest.id);
    ensurePrivateDir(dir);
    writeFileDurably(path.join(dir, "manifest.json"), JSON.stringify(redactForPersistence(manifest), null, 2) + "\n", 0o600);
  }

  loadBaseManifest(id: string): HarnessManifest {
    const raw = JSON.parse(fs.readFileSync(path.join(this.baseDir(id), "manifest.json"), "utf8"));
    return assertValid("manifest", raw, validateHarnessManifest);
  }

  saveTaskSuite(suite: HirTaskSuite): string {
    assertValid("taskSuite", suite, validateHirTaskSuite);
    const dir = path.join(this.rootDir, "task-suites");
    ensurePrivateDir(dir);
    const ref = `suite_${suite.id}`;
    writeFileDurably(path.join(dir, `${safeId(ref)}.json`), JSON.stringify(redactForPersistence(suite), null, 2) + "\n", 0o600);
    return ref;
  }

  loadTaskSuite(ref: string): HirTaskSuite {
    const raw = JSON.parse(fs.readFileSync(path.join(this.rootDir, "task-suites", `${safeId(ref)}.json`), "utf8"));
    return assertValid("taskSuite", raw, validateHirTaskSuite);
  }

  saveCandidate(candidate: HarnessCandidate): void {
    assertValid("candidate", candidate, validateHarnessCandidate);
    const dir = this.candidateDir(candidate.id);
    ensurePrivateDir(dir);
    writeFileDurably(path.join(dir, "manifest.json"), JSON.stringify(redactForPersistence(candidate), null, 2) + "\n", 0o600);
  }

  loadCandidate(id: string): HarnessCandidate {
    const raw = JSON.parse(fs.readFileSync(path.join(this.candidateDir(id), "manifest.json"), "utf8"));
    return assertValid("candidate", raw, validateHarnessCandidate);
  }

  saveProbe(result: ProbeResult): void {
    assertValid("probeResult", result, validateProbeResult);
    const dir = this.probeDir(result.id);
    ensurePrivateDir(dir);
    writeFileDurably(path.join(dir, "result.json"), JSON.stringify(redactForPersistence(result), null, 2) + "\n", 0o600);
  }

  loadProbe(id: string): ProbeResult {
    const raw = JSON.parse(fs.readFileSync(path.join(this.probeDir(id), "result.json"), "utf8"));
    return assertValid("probeResult", raw, validateProbeResult);
  }

  saveReport(runId: string, report: PromotionReport, md: string): void {
    assertValid("promotionReport", report, validatePromotionReport);
    const dir = this.runDir(runId);
    ensurePrivateDir(dir);
    writeFileDurably(this.reportJsonPath(runId), JSON.stringify(redactForPersistence(report), null, 2) + "\n", 0o600);
    writeFileDurably(this.reportMdPath(runId), String(redactForPersistence(md)), 0o600);
  }

  loadReport(runId: string): PromotionReport | undefined {
    const p = this.reportJsonPath(runId);
    if (!fs.existsSync(p)) return undefined;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return assertValid("promotionReport", raw, validatePromotionReport);
  }

  appendEvent(runId: string, event: Omit<HirEvent, "schemaVersion" | "id" | "runId" | "at"> & { at?: string }): HirEvent {
    const full: HirEvent = {
      schemaVersion: 1,
      id: `hev_${randomUUID()}`,
      runId,
      at: event.at ?? nowIso(),
      type: event.type,
      message: event.message,
      ...(event.data ? { data: redactForPersistence(event.data) as Record<string, unknown> } : {}),
    };
    appendLinesDurably(this.eventsPath(runId), [JSON.stringify(redactForPersistence(full))], 0o600);
    return full;
  }

  appendEvidence(runId: string, rec: Omit<HirEvidenceRecord, "schemaVersion" | "id" | "runId" | "createdAt"> & { createdAt?: string }): HirEvidenceRecord {
    const full: HirEvidenceRecord = {
      schemaVersion: 1,
      id: `hevid_${randomUUID()}`,
      runId,
      createdAt: rec.createdAt ?? nowIso(),
      kind: rec.kind,
      subjectId: rec.subjectId,
      summary: rec.summary,
      refs: rec.refs,
      confidence: rec.confidence,
      deterministic: rec.deterministic,
    };
    appendLinesDurably(this.evidencePath(runId), [JSON.stringify(redactForPersistence(full))], 0o600);
    return full;
  }

  readEvents(runId: string): HirEvent[] {
    const p = this.eventsPath(runId);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as HirEvent]; } catch { return []; }
    });
  }

  libraryDir(): string { return path.join(this.rootDir, "library", "entries"); }
  libraryPath(id: string): string { return path.join(this.libraryDir(), `${safeId(id)}.json`); }

  saveLibraryEntry(entry: import("./types.js").HarnessLibraryEntry): void {
    assertValid("libraryEntry", entry, validateLibraryEntry);
    ensurePrivateDir(this.libraryDir());
    writeFileDurably(this.libraryPath(entry.id), JSON.stringify(redactForPersistence(entry), null, 2) + "\n", 0o600);
  }

  loadLibraryEntry(id: string): import("./types.js").HarnessLibraryEntry {
    const raw = JSON.parse(fs.readFileSync(this.libraryPath(id), "utf8"));
    return assertValid("libraryEntry", raw, validateLibraryEntry);
  }

  listLibraryEntries(): import("./types.js").HarnessLibraryEntry[] {
    const dir = this.libraryDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).flatMap((n) => {
      try { return [assertValid("libraryEntry", JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")), validateLibraryEntry)]; } catch { return []; }
    }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
