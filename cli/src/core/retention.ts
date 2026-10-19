import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { tryStateStoreGuard } from "./state_store_guard.js";
import { ensurePrivateDir, writePrivateFile } from "./durable_file.js";

export const DEFAULT_RETENTION_MAX_AGE_DAYS = 90; // DEC-11
export const DEFAULT_RETENTION_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (DEC-11)
export const DEFAULT_AUTO_GC_TIME_BUDGET_MS = 2000; // 2 seconds (DEC-11)

export type RetentionItemKind = "task" | "session" | "checkpoint" | "flight";

export interface RetentionItem {
  kind: RetentionItemKind;
  id: string;
  primaryFile: string;
  associatedFiles: string[];
  /** Exact file identities captured by planning; changed records must be replanned. */
  fileIdentities?: Record<string, string | null>;
  primaryIdentity?: string;
  /** Missing envelope tracked when collecting an orphaned companion group. */
  recordFile?: string;
  orphan?: boolean;
  workspace?: string;
  gitRef?: string;
  sizeBytes: number;
  mtimeMs: number;
  pinned?: boolean;
  current?: boolean;
  testPollution?: boolean;
  reason?: "expired_age" | "size_cap_exceeded" | "test_pollution";
}

export interface RetentionPolicyOptions {
  maxAgeDays?: number;
  maxSizeBytes?: number;
  dryRun?: boolean;
  onlyTestPollution?: boolean;
  timeBudgetMs?: number;
  deadline?: number;
  currentSessionId?: string;
  home?: string;
  workspace?: string;
}

export interface RetentionPlan {
  reclaimableItems: RetentionItem[];
  reclaimableBytes: number;
  reclaimableCount: number;
  totalScannedBytes: number;
  totalScannedCount: number;
  byKind: Record<RetentionItemKind, { count: number; bytes: number }>;
  timedOut: boolean;
  durationMs: number;
}

export interface GcExecutionResult {
  dryRun: boolean;
  scannedCount: number;
  scannedBytes: number;
  deletedCount: number;
  deletedBytes: number;
  deletedItems: RetentionItem[];
  byKind: Record<RetentionItemKind, { count: number; bytes: number }>;
  errors: Array<{ path: string; error: string }>;
  timedOut: boolean;
  durationMs: number;
}

export interface GcState {
  version: 1;
  acknowledged: boolean;
  acknowledgedAt?: string;
  lastRunAt?: string;
  lastRunSummary?: {
    scannedCount: number;
    deletedCount: number;
    deletedBytes: number;
    durationMs: number;
  };
}

export function isTestPollutionPath(wsPath?: string): boolean {
  if (!wsPath) return false;
  return /^\/tmp\/nexus-(app-)?test-/.test(wsPath) || /^\/tmp\/perm-/.test(wsPath);
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function computeDirSize(dir: string, deadline?: number): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (deadline && Date.now() >= deadline) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += computeDirSize(full, deadline);
      } else if (entry.isFile()) {
        const s = safeStat(full);
        if (s) size += s.size;
      }
    }
  } catch {}
  return size;
}

/** Index companion files once; scanning all names for every task would be quadratic. */
function recordCompanions(directory: string, names: string[], deadline?: number): {
  records: Map<string, { files: string[]; bytes: number; mtimeMs: number }>;
  timedOut: boolean;
} {
  const records = new Map<string, { files: string[]; bytes: number; mtimeMs: number }>();
  for (const name of names) {
    if (deadline && Date.now() >= deadline) return { records, timedOut: true };
    let identity: string | undefined;
    if (name.endsWith(".messages.jsonl")) identity = name.slice(0, -".messages.jsonl".length);
    else if (name.endsWith(".history.jsonl")) identity = name.slice(0, -".history.jsonl".length);
    else identity = /^(.+)\.json\.pre-migration-v(?:0|[1-9]\d*)$/.exec(name)?.[1];
    if (!identity) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      const record = records.get(identity) ?? { files: [], bytes: 0, mtimeMs: 0 };
      record.files.push(file);
      record.bytes += stat.size;
      record.mtimeMs = Math.max(record.mtimeMs, stat.mtimeMs);
      records.set(identity, record);
    } catch { /* A concurrently removed companion is already absent. */ }
  }
  return { records, timedOut: false };
}

/** Retain/account for failed first publications and interrupted cleanup without inventing an age grace. */
function orphanCompanions(
  directory: string, names: string[], records: Map<string, { files: string[]; bytes: number; mtimeMs: number }>,
  kind: "task" | "session", currentSessionId?: string, deadline?: number,
): { items: RetentionItem[]; timedOut: boolean } {
  const present = new Set(names), items: RetentionItem[] = [];
  for (const [id, record] of records) {
    if (deadline && Date.now() >= deadline) return { items, timedOut: true };
    if (present.has(`${id}.json`) || !/^[A-Za-z0-9._-]{1,160}$/.test(id) || id === "." || id === "..") continue;
    const primaryFile = record.files[0];
    items.push({ kind, id, primaryFile, primaryIdentity: fileIdentity(primaryFile) ?? undefined,
      recordFile: path.join(directory, `${id}.json`), orphan: true,
      associatedFiles: record.files.slice(1), sizeBytes: record.bytes, mtimeMs: record.mtimeMs,
      current: currentSessionId === id });
  }
  return { items, timedOut: false };
}

interface EnvelopeMetadata {
  workspace?: string;
  pinned: boolean;
  sessionId?: string;
  taskId?: string;
  id?: string;
}

const MAX_DIRECT_ENVELOPE_READ_BYTES = 64 * 1024; // 64 KiB
const MAX_SCAN_CHUNK_BYTES = 64 * 1024; // 64 KiB

function readEnvelopeMetadata(
  filePath: string,
  stat: fs.Stats,
  deadline?: number
): { metadata: EnvelopeMetadata; timedOut: boolean } {
  if (deadline && Date.now() >= deadline) {
    return { metadata: { pinned: false }, timedOut: true };
  }

  // Fast path for small, standard envelopes (<= 64 KiB, which covers all schema-2 envelopes).
  if (stat.size <= MAX_DIRECT_ENVELOPE_READ_BYTES) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        metadata: {
          workspace: typeof parsed.workspacePath === "string" ? parsed.workspacePath : (typeof parsed.workspace === "string" ? parsed.workspace : undefined),
          pinned: Boolean(parsed.pinned),
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
          taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
          id: typeof parsed.id === "string" ? parsed.id : undefined,
        },
        timedOut: false,
      };
    } catch {
      return { metadata: { pinned: false }, timedOut: false };
    }
  }

  // Bounded streaming scanner for large legacy/unmigrated files.
  // Avoids buffering multi-megabyte inline messages or allocating memory proportional to file size.
  let fd: number | undefined;
  let timedOut = false;
  const result: EnvelopeMetadata = { pinned: false };
  const buf = Buffer.alloc(MAX_SCAN_CHUNK_BYTES);

  try {
    fd = fs.openSync(filePath, "r");
    let depth = 0;
    let inString = false;
    let escaped = false;
    let key = "";
    let inKey = false;
    let afterColon = false;
    let val = "";
    let inValString = false;

    while (true) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;

      for (let i = 0; i < bytesRead; i++) {
        const byte = buf[i];
        if (inString) {
          if (escaped) {
            escaped = false;
            if (inKey && key.length < 64) key += String.fromCharCode(byte);
            else if (inValString && val.length < 4096) val += String.fromCharCode(byte);
          } else if (byte === 92) { // \
            escaped = true;
          } else if (byte === 34) { // "
            inString = false;
            if (inKey) {
              inKey = false;
              afterColon = false;
            } else if (inValString) {
              inValString = false;
              if (key === "workspace" || key === "workspacePath") result.workspace = val;
              else if (key === "sessionId") result.sessionId = val;
              else if (key === "taskId") result.taskId = val;
              else if (key === "id") result.id = val;
              key = "";
              val = "";
            }
          } else {
            if (inKey && key.length < 64) key += String.fromCharCode(byte);
            else if (inValString && val.length < 4096) val += String.fromCharCode(byte);
          }
          continue;
        }

        if (byte === 34) { // "
          inString = true;
          if (depth === 1 && !afterColon) {
            inKey = true;
            key = "";
          } else if (depth === 1 && afterColon) {
            inValString = true;
            val = "";
          }
          continue;
        }

        if (byte === 123 || byte === 91) { // { or [
          depth++;
          continue;
        }
        if (byte === 125 || byte === 93) { // } or ]
          depth--;
          if (depth === 0) break;
          continue;
        }

        if (depth === 1) {
          if (byte === 58) { // :
            afterColon = true;
          } else if (byte === 44) { // ,
            afterColon = false;
            key = "";
          } else if (afterColon && key === "pinned") {
            if (byte === 116) { // 't' in true
              result.pinned = true;
              afterColon = false;
              key = "";
            } else if (byte === 102) { // 'f' in false
              result.pinned = false;
              afterColon = false;
              key = "";
            }
          }
        }
      }
      if (depth === 0) break;
    }
  } catch {
    // Read errors retain existing defaults
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  return { metadata: result, timedOut };
}

export function scanTasks(tasksDir: string, checkTestPollution: boolean = false, deadline?: number, currentSessionId?: string): { items: RetentionItem[]; timedOut: boolean } {
  const items: RetentionItem[] = [];
  let timedOut = false;
  if (!fs.existsSync(tasksDir)) return { items, timedOut };

  try {
    const entries = fs.readdirSync(tasksDir);
    const companions = recordCompanions(tasksDir, entries, deadline);
    if (companions.timedOut) return { items: [], timedOut: true };
    for (const name of entries) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      if (!name.endsWith(".json") || name.startsWith(".corrupt-")) continue;

      const fullPath = path.join(tasksDir, name);
      const stat = safeStat(fullPath);
      if (!stat || !stat.isFile()) continue;

      const cleanId = name.replace(/\.json$/, "");
      const companion = companions.records.get(cleanId);
      const totalSize = stat.size + (companion?.bytes ?? 0);
      const associatedFiles = companion?.files ?? [];

      let isPollution = false;
      let ws: string | undefined;
      let pinned = false, current = currentSessionId === cleanId;
      const { metadata, timedOut: readTimedOut } = readEnvelopeMetadata(fullPath, stat, deadline);
      if (readTimedOut) {
        timedOut = true;
        break;
      }
      ws = metadata.workspace;
      pinned = metadata.pinned;
      current ||= Boolean(currentSessionId && currentSessionId === (metadata.sessionId || metadata.id));
      isPollution = checkTestPollution && isTestPollutionPath(ws);

      items.push({
        kind: "task",
        id: cleanId,
        primaryFile: fullPath,
        primaryIdentity: statIdentity(stat),
        associatedFiles,
        workspace: ws,
        pinned, current,
        sizeBytes: totalSize,
        mtimeMs: stat.mtimeMs,
        testPollution: isPollution,
      });
    }
    const orphans = orphanCompanions(tasksDir, entries, companions.records, "task", currentSessionId, deadline);
    items.push(...orphans.items); timedOut ||= orphans.timedOut;
  } catch {}

  return { items, timedOut };
}

export function scanSessions(
  sessionsDir: string,
  currentSessionId?: string,
  checkTestPollution: boolean = false,
  deadline?: number
): { items: RetentionItem[]; timedOut: boolean } {
  const items: RetentionItem[] = [];
  let timedOut = false;
  if (!fs.existsSync(sessionsDir)) return { items, timedOut };
  let entries: string[];
  try { entries = fs.readdirSync(sessionsDir); }
  catch { return { items, timedOut }; }
  const companions = recordCompanions(sessionsDir, entries, deadline);
  if (companions.timedOut) return { items: [], timedOut: true };
  const presentNames = new Set(entries);

  // Fast path: try index.json if present
  const indexPath = path.join(sessionsDir, "index.json");
  const knownFromIndex = new Set<string>();

  if (fs.existsSync(indexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (raw && raw.version === 1 && typeof raw.sessions === "object") {
        for (const [cleanId, entry] of Object.entries(raw.sessions as Record<string, any>)) {
          if (deadline && Date.now() >= deadline) {
            timedOut = true;
            break;
          }
          if (!presentNames.has(`${cleanId}.json`)) continue;
          const primaryFile = path.join(sessionsDir, `${cleanId}.json`);
          const stat = safeStat(primaryFile);
          if (!stat) continue;

          // Cached pin/workspace/identity fields are advisory: expiry must use
          // the current envelope even if an index timestamp appears newer.
          const { metadata, timedOut: readTimedOut } = readEnvelopeMetadata(primaryFile, stat, deadline);
          if (readTimedOut) {
            timedOut = true;
            break;
          }
          const actualId = metadata.sessionId || metadata.taskId || metadata.id || cleanId;
          const workspace = metadata.workspace;
          knownFromIndex.add(cleanId);
          const companion = companions.records.get(cleanId);
          const associatedFiles = companion?.files ?? [];

          const isCurrent = Boolean(currentSessionId && (currentSessionId === cleanId || currentSessionId === actualId));
          const isPollution = checkTestPollution ? isTestPollutionPath(workspace) : false;

          items.push({
            kind: "session",
            id: actualId,
            primaryFile,
            primaryIdentity: statIdentity(stat),
            associatedFiles,
            workspace,
            sizeBytes: stat.size + (companion?.bytes ?? 0),
            mtimeMs: stat.mtimeMs,
            pinned: metadata.pinned,
            current: isCurrent,
            testPollution: isPollution,
          });
        }
      }
    } catch {}
  }

  // Scan any session files not found in the index
  try {
    for (const name of entries) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      if (!name.endsWith(".json") || name === "index.json" || name.startsWith(".corrupt-")) continue;
      const cleanId = name.replace(/\.json$/, "");
      if (knownFromIndex.has(cleanId)) continue;

      const fullPath = path.join(sessionsDir, name);
      const stat = safeStat(fullPath);
      if (!stat || !stat.isFile()) continue;

      const companion = companions.records.get(cleanId);
      const associatedFiles = companion?.files ?? [];

      const { metadata, timedOut: readTimedOut } = readEnvelopeMetadata(fullPath, stat, deadline);
      if (readTimedOut) {
        timedOut = true;
        break;
      }
      const realId = metadata.sessionId || metadata.taskId || metadata.id || cleanId;
      const ws = metadata.workspace;
      const pinned = metadata.pinned;

      const isCurrent = Boolean(currentSessionId && (currentSessionId === cleanId || currentSessionId === realId));
      const isPollution = checkTestPollution ? isTestPollutionPath(ws) : false;

      items.push({
        kind: "session",
        id: realId,
        primaryFile: fullPath,
        primaryIdentity: statIdentity(stat),
        associatedFiles,
        workspace: ws,
        sizeBytes: stat.size + (companion?.bytes ?? 0),
        mtimeMs: stat.mtimeMs,
        pinned,
        current: isCurrent,
        testPollution: isPollution,
      });
    }
  } catch {}

  const orphans = orphanCompanions(sessionsDir, entries, companions.records, "session", currentSessionId, deadline);
  items.push(...orphans.items); timedOut ||= orphans.timedOut;
  return { items, timedOut };
}

export function scanCheckpoints(checkpointsBaseDir: string, deadline?: number): { items: RetentionItem[]; timedOut: boolean } {
  const items: RetentionItem[] = [];
  let timedOut = false;
  if (!fs.existsSync(checkpointsBaseDir)) return { items, timedOut };

  try {
    const hashDirs = fs.readdirSync(checkpointsBaseDir);
    for (const hashDir of hashDirs) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const dirPath = path.join(checkpointsBaseDir, hashDir);
      const dirStat = safeStat(dirPath);
      if (!dirStat || !dirStat.isDirectory()) continue;

      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (deadline && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (!file.endsWith(".json")) continue;
        const jsonPath = path.join(dirPath, file);
        const stat = safeStat(jsonPath);
        if (!stat || !stat.isFile()) continue;

        const cpId = file.replace(/\.json$/, "");
        let gitRef: string | undefined;
        let ws: string | undefined;
        let snapshotDir: string | undefined;
        let snapSize = 0;
        const associatedFiles: string[] = [];

        try {
          const content = fs.readFileSync(jsonPath, "utf8");
          const data = JSON.parse(content);
          gitRef = data.gitRef;
          ws = data.workspace;
          if (data.snapshotDir && typeof data.snapshotDir === "string" && fs.existsSync(data.snapshotDir)) {
            const snapDir: string = data.snapshotDir;
            snapshotDir = snapDir;
            snapSize = computeDirSize(snapDir, deadline);
            associatedFiles.push(snapDir);
          }
        } catch {}

        items.push({
          kind: "checkpoint",
          id: cpId,
          primaryFile: jsonPath,
          associatedFiles,
          workspace: ws,
          gitRef,
          sizeBytes: stat.size + snapSize,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  } catch {}

  return { items, timedOut };
}

export function scanFlights(flightsDir: string, deadline?: number): { items: RetentionItem[]; timedOut: boolean } {
  const items: RetentionItem[] = [];
  let timedOut = false;
  if (!fs.existsSync(flightsDir)) return { items, timedOut };

  try {
    const files = fs.readdirSync(flightsDir);
    for (const file of files) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      if (!file.endsWith(".flightlog")) continue;
      const fullPath = path.join(flightsDir, file);
      const stat = safeStat(fullPath);
      if (!stat || !stat.isFile()) continue;

      const flightId = file.replace(/\.flightlog$/, "");
      items.push({
        kind: "flight",
        id: flightId,
        primaryFile: fullPath,
        associatedFiles: [],
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  } catch {}

  return { items, timedOut };
}

function statIdentity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function fileIdentity(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    return statIdentity(stat);
  } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

function captureRecordIdentities(item: RetentionItem): void {
  if (item.kind !== "task" && item.kind !== "session") return;
  const recordFile = item.recordFile ?? item.primaryFile;
  const stem = recordFile.replace(/\.json$/, "");
  const files = new Set([recordFile, item.primaryFile, ...item.associatedFiles,
    `${stem}.messages.jsonl`, `${stem}.history.jsonl`,
    `${recordFile}.pre-migration-v0`, `${recordFile}.pre-migration-v1`]);
  item.fileIdentities = Object.fromEntries([...files].map(file => [file, fileIdentity(file)]));
  // A record replaced between scan and identity capture must never inherit the
  // old record's expiry decision. Force execution to skip and replan it.
  if (item.primaryIdentity !== item.fileIdentities[item.primaryFile]) item.fileIdentities[item.primaryFile] = "changed-during-scan";
}

/**
 * Plan garbage collection according to age, size cap, and test pollution rules (REQ-PER-102, DEC-11).
 */
export function planRetention(options: RetentionPolicyOptions = {}): RetentionPlan {
  const startTime = Date.now();
  const home = options.home || os.homedir();
  const maxAgeDays = options.maxAgeDays !== undefined ? options.maxAgeDays : DEFAULT_RETENTION_MAX_AGE_DAYS;
  const maxSizeBytes = options.maxSizeBytes !== undefined ? options.maxSizeBytes : DEFAULT_RETENTION_MAX_SIZE_BYTES;
  const deadline = options.deadline !== undefined
    ? options.deadline
    : (options.timeBudgetMs !== undefined ? startTime + options.timeBudgetMs : undefined);

  const nexusDir = path.join(home, ".nexus");
  const tasksDir = path.join(nexusDir, "tasks");
  const sessionsDir = path.join(nexusDir, "sessions");
  const checkpointsDir = path.join(nexusDir, "checkpoints");
  const flightsDir = options.workspace ? path.join(options.workspace, ".nexus", "flights") : path.join(nexusDir, "flights");

  let timedOut = false;

  const { items: tasks, timedOut: tOut1 } = scanTasks(tasksDir, Boolean(options.onlyTestPollution), deadline, options.currentSessionId);
  if (tOut1) timedOut = true;

  const { items: sessions, timedOut: tOut2 } = scanSessions(sessionsDir, options.currentSessionId, Boolean(options.onlyTestPollution), deadline);
  if (tOut2) timedOut = true;

  const { items: checkpoints, timedOut: tOut3 } = scanCheckpoints(checkpointsDir, deadline);
  if (tOut3) timedOut = true;

  const { items: flights, timedOut: tOut4 } = scanFlights(flightsDir, deadline);
  if (tOut4) timedOut = true;

  const allItems: RetentionItem[] = [...tasks, ...sessions, ...checkpoints, ...flights];

  let totalScannedBytes = 0;
  for (const item of allItems) {
    if (deadline && Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    captureRecordIdentities(item);
    totalScannedBytes += item.sizeBytes;
  }

  const reclaimable: RetentionItem[] = [];
  const reclaimableSet = new Set<string>();

  // Case 1: --only-test-pollution
  if (options.onlyTestPollution) {
    for (const item of allItems) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      if (item.testPollution && !item.pinned && !item.current) {
        item.reason = "test_pollution";
        reclaimable.push(item);
        reclaimableSet.add(item.primaryFile);
      }
    }
  } else {
    // Case 2: General retention policy (age + size cap)
    const cutoffAgeMs = startTime - maxAgeDays * 24 * 60 * 60 * 1000;

    // Phase A: Expired by age
    for (const item of allItems) {
      if (deadline && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      if (item.pinned || item.current) continue;
      if (item.mtimeMs < cutoffAgeMs) {
        item.reason = "expired_age";
        reclaimable.push(item);
        reclaimableSet.add(item.primaryFile);
      }
    }

    // Phase B: Size cap enforcement
    let survivingBytes = 0;
    const survivingCandidates: RetentionItem[] = [];

    if (!timedOut) {
      for (const item of allItems) {
        if (deadline && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (reclaimableSet.has(item.primaryFile)) continue;
        survivingBytes += item.sizeBytes;
        if (!item.pinned && !item.current) {
          survivingCandidates.push(item);
        }
      }
    }

    if (!timedOut && survivingBytes > maxSizeBytes) {
      // Sort oldest first
      survivingCandidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of survivingCandidates) {
        if (deadline && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (survivingBytes <= maxSizeBytes) break;
        item.reason = "size_cap_exceeded";
        reclaimable.push(item);
        reclaimableSet.add(item.primaryFile);
        survivingBytes -= item.sizeBytes;
      }
    }
  }

  const byKind: Record<RetentionItemKind, { count: number; bytes: number }> = {
    task: { count: 0, bytes: 0 },
    session: { count: 0, bytes: 0 },
    checkpoint: { count: 0, bytes: 0 },
    flight: { count: 0, bytes: 0 },
  };

  let reclaimableBytes = 0;
  for (const item of reclaimable) {
    if (deadline && Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    reclaimableBytes += item.sizeBytes;
    byKind[item.kind].count++;
    byKind[item.kind].bytes += item.sizeBytes;
  }

  return {
    reclaimableItems: reclaimable,
    reclaimableBytes,
    reclaimableCount: reclaimable.length,
    totalScannedBytes,
    totalScannedCount: allItems.length,
    byKind,
    timedOut,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Execute retention plan: removes eligible files and git refs (REQ-PER-102, DEC-11).
 */
export function executeRetention(plan: RetentionPlan, options: { dryRun?: boolean; timeBudgetMs?: number; deadline?: number } = {}): GcExecutionResult {
  const directories = [...new Set(plan.reclaimableItems.filter(item => item.kind === "task" || item.kind === "session").map(item => path.dirname(item.primaryFile)))].sort();
  const busy = new Set<string>();
  function locked(index: number): GcExecutionResult {
    if (options.dryRun || index === directories.length) {
      return executeRetentionLocked({ ...plan, reclaimableItems: plan.reclaimableItems.filter(item => !busy.has(path.dirname(item.primaryFile))) }, options);
    }
    const directory = directories[index];
    let result: ReturnType<typeof tryStateStoreGuard<GcExecutionResult>>;
    let entered = false;
    try { result = tryStateStoreGuard(directory, () => { entered = true; return locked(index + 1); }); }
    catch (error: any) {
      if (entered) throw error;
      // Preserve records when a store cannot be safely locked.
      busy.add(directory);
      const next = locked(index + 1);
      next.errors.push({ path: directory, error: error?.message || String(error) });
      return next;
    }
    if (result.acquired) return result.value;
    busy.add(directory);
    const next = locked(index + 1);
    next.errors.push({ path: directory, error: "State store is busy; collection skipped" });
    return next;
  }
  return locked(0);
}

function executeRetentionLocked(plan: RetentionPlan, options: { dryRun?: boolean; timeBudgetMs?: number; deadline?: number }): GcExecutionResult {
  const startTime = Date.now();
  const dryRun = Boolean(options.dryRun);
  const deadline = options.deadline !== undefined
    ? options.deadline
    : (options.timeBudgetMs !== undefined ? startTime + options.timeBudgetMs : undefined);

  let deletedCount = 0;
  let deletedBytes = 0;
  const deletedItems: RetentionItem[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let timedOut = Boolean(plan.timedOut);

  const byKind: Record<RetentionItemKind, { count: number; bytes: number }> = {
    task: { count: 0, bytes: 0 },
    session: { count: 0, bytes: 0 },
    checkpoint: { count: 0, bytes: 0 },
    flight: { count: 0, bytes: 0 },
  };

  const sessionsRemoved: string[] = [];

  for (const item of plan.reclaimableItems) {
    if (deadline && Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    if (dryRun) {
      deletedCount++;
      deletedBytes += item.sizeBytes;
      deletedItems.push(item);
      byKind[item.kind].count++;
      byKind[item.kind].bytes += item.sizeBytes;
      continue;
    }

    if (item.kind === "task" || item.kind === "session") {
      const identities = item.fileIdentities;
      if (!identities || Object.entries(identities).some(([file, identity]) => fileIdentity(file) !== identity)) {
        errors.push({ path: item.primaryFile, error: "Record changed since planning; collection skipped" });
        continue;
      }
    }
    let success = true;

    // Delete primary file
    try {
      if (fs.existsSync(item.primaryFile)) {
        fs.unlinkSync(item.primaryFile);
      }
    } catch (err: any) {
      success = false;
      errors.push({ path: item.primaryFile, error: err?.message || String(err) });
    }

    // A failed primary removal must never leave a live envelope without its log.
    if (!success) continue;

    // Delete associated files (history, snapshots)
    for (const assoc of item.associatedFiles) {
      try {
        if (fs.existsSync(assoc)) {
          const s = safeStat(assoc);
          if (s && s.isDirectory()) {
            fs.rmSync(assoc, { recursive: true, force: true });
          } else {
            fs.unlinkSync(assoc);
          }
        }
      } catch (err: any) {
        success = false;
        errors.push({ path: assoc, error: err?.message || String(err) });
      }
    }

    if (success) {
      // If checkpoint has gitRef, prune git ref
      if (item.kind === "checkpoint" && item.gitRef && item.workspace) {
        try {
          execSync(`git update-ref -d refs/nexus/checkpoints/${item.id}`, {
            cwd: item.workspace,
            stdio: "ignore",
          });
        } catch {}
      }

      if (item.kind === "session") {
        sessionsRemoved.push(item.id);
      }

      deletedCount++;
      deletedBytes += item.sizeBytes;
      deletedItems.push(item);
      byKind[item.kind].count++;
      byKind[item.kind].bytes += item.sizeBytes;
    }
  }

  // If sessions were removed and not a dry run, reconcile session index
  if (!dryRun && sessionsRemoved.length > 0) {
    try {
      const sampleItem = plan.reclaimableItems.find((i) => i.kind === "session");
      if (sampleItem) {
        const sessionsDir = path.dirname(sampleItem.primaryFile);
        const indexPath = path.join(sessionsDir, "index.json");
        if (fs.existsSync(indexPath)) {
          const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
          if (raw && raw.version === 1 && raw.sessions) {
            for (const id of sessionsRemoved) {
              const cleanId = id.replace(/\.json$/, "");
              delete raw.sessions[cleanId];
              delete raw.sessions[id];
            }
            raw.updatedAt = new Date().toISOString();
            writePrivateFile(indexPath, JSON.stringify(raw, null, 2));
          }
        }
      }
    } catch {}
  }

  return {
    dryRun,
    scannedCount: plan.totalScannedCount,
    scannedBytes: plan.totalScannedBytes,
    deletedCount,
    deletedBytes,
    deletedItems,
    byKind,
    errors,
    timedOut,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Execute retention GC directly from policy options (REQ-PER-102, DEC-11).
 */
export function runRetentionGc(options: RetentionPolicyOptions = {}): GcExecutionResult {
  const startTime = Date.now();
  const deadline = options.deadline !== undefined
    ? options.deadline
    : (options.timeBudgetMs !== undefined ? startTime + options.timeBudgetMs : undefined);
  const plan = planRetention({ ...options, deadline });
  const remainingBudgetMs = deadline !== undefined ? Math.max(0, deadline - Date.now()) : options.timeBudgetMs;
  const result = executeRetention(plan, { dryRun: options.dryRun, deadline, timeBudgetMs: remainingBudgetMs });
  result.durationMs = Date.now() - startTime;
  return result;
}

export function getGcState(home: string = os.homedir()): GcState {
  const stateFile = path.join(home, ".nexus", "gc_state.json");
  if (fs.existsSync(stateFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (raw && raw.version === 1) return raw as GcState;
    } catch {}
  }
  return { version: 1, acknowledged: false };
}

export function setGcState(state: GcState, home: string = os.homedir()): void {
  const stateFile = path.join(home, ".nexus", "gc_state.json");
  ensurePrivateDir(path.dirname(stateFile));
  writePrivateFile(stateFile, JSON.stringify(state, null, 2));
}

export function acknowledgeDailyGc(home: string = os.homedir()): GcState {
  const state = getGcState(home);
  state.acknowledged = true;
  state.acknowledgedAt = new Date().toISOString();
  setGcState(state, home);
  return state;
}

/**
 * Background daily GC runner with first-run acknowledgement check (REQ-PER-102, DEC-11).
 */
export async function maybeRunDailyGc(options: { home?: string; force?: boolean; timeBudgetMs?: number; deadline?: number } = {}): Promise<{
  status: "ran" | "already_ran_today" | "disabled" | "needs_acknowledgement";
  summary?: GcExecutionResult;
  notice?: string;
}> {
  if (process.env.NEXUS_GC === "off" || process.env.NEXUS_GC === "0") {
    return { status: "disabled" };
  }

  const home = options.home || os.homedir();
  const gcState = getGcState(home);

  if (process.env.NEXUS_GC === "auto" && !gcState.acknowledged) {
    gcState.acknowledged = true;
    gcState.acknowledgedAt = new Date().toISOString();
    setGcState(gcState, home);
  }

  if (!gcState.acknowledged) {
    const dryRunPlan = planRetention({ home, dryRun: true });
    const mbReclaimable = (dryRunPlan.reclaimableBytes / (1024 * 1024)).toFixed(1);
    const notice = `Nexus retention: automatic daily GC keeps state for 90 days or up to 2 GB (${dryRunPlan.reclaimableCount} items / ${mbReclaimable} MB reclaimable). Run 'nexus gc --ack' or set NEXUS_GC=auto to enable automatic background cleanup.`;
    return { status: "needs_acknowledgement", notice };
  }

  if (!options.force && gcState.lastRunAt) {
    const elapsedMs = Date.now() - new Date(gcState.lastRunAt).getTime();
    if (elapsedMs < 24 * 60 * 60 * 1000) {
      return { status: "already_ran_today" };
    }
  }

  const budgetMs = options.timeBudgetMs ?? DEFAULT_AUTO_GC_TIME_BUDGET_MS;
  const deadline = options.deadline !== undefined ? options.deadline : (Date.now() + budgetMs);

  // Run bounded GC (2 s default budget).
  // The stated 2s time budget bounds the expensive filesystem discovery, planning,
  // and deletion workload in runRetentionGc. Daily GC summary persistence (setGcState)
  // intentionally executes immediately after the bounded run to commit the run timestamp
  // and execution metrics. This prevents repeated GC passes on the same day when a pass
  // reaches its deadline.
  const result = runRetentionGc({
    home,
    dryRun: false,
    deadline,
    timeBudgetMs: budgetMs,
  });

  gcState.lastRunAt = new Date().toISOString();
  gcState.lastRunSummary = {
    scannedCount: result.scannedCount,
    deletedCount: result.deletedCount,
    deletedBytes: result.deletedBytes,
    durationMs: result.durationMs,
  };
  setGcState(gcState, home);

  return { status: "ran", summary: result };
}
