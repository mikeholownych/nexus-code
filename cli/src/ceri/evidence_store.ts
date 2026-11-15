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
  migrated?: boolean;
  migratedAt?: string;
  migrationReason?: string;
  normalizedAssertions?: string[];
}

export type IntegrityFailureReason =
  | "INTEGRITY_MISSING"
  | "INTEGRITY_UNREADABLE"
  | "RUN_ID_MISMATCH"
  | "FILE_SET_MISMATCH"
  | "HASH_MISMATCH"
  | "COMPOSITE_MISMATCH"
  | "NON_BOOLEAN_PASSED";

export class CeriEvidenceIntegrityError extends Error {
  constructor(readonly reason: IntegrityFailureReason, detail: string) {
    super(`CERI evidence rejected (${reason}): ${detail}`);
    this.name = "CeriEvidenceIntegrityError";
  }
}

function compositeOf(fileHashes: Record<string, string>): string {
  const hasher = createHash("sha256");
  for (const file of Object.keys(fileHashes).sort()) hasher.update(`${file}:${fileHashes[file]};`);
  return hasher.digest("hex");
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

/** Words that make a key a credential on their own. */
const SECRET_WORDS = new Set([
  "password", "passwords", "passwd", "passphrase", "pwd", "secret", "secrets", "credential", "credentials", "authorization", "auth", "cookie", "cookies", "bearer", "jwt", "apikey",
  // The same names written as one lowercase word.
  "accesstoken", "refreshtoken", "idtoken", "authtoken", "sessiontoken", "bearertoken", "apitoken", "clientsecret",
  "secretvalue",
]);
/** Words that, before "pass", make it a password (`DB_PASS`, `user_pass`); bare `pass` and `bypass` are not credentials. */
const PASS_CONTEXT = new Set(["db", "database", "user", "admin", "root", "login", "smtp", "mysql", "postgres", "redis", "ssh", "ftp", "sql", "mongo", "ldap", "wifi", "master"]);
/** Words after "token" that make it a count or a limit (`tokenCount`, `token_limit`). */
const COUNT_AFTER = new Set(["count", "counts", "limit", "limits", "budget", "usage", "total", "used"]);
/** Words that, before "token", make it a count or a limit rather than a credential. */
const COUNT_WORDS = new Set(["max", "min", "total", "input", "output", "prompt", "completion", "num", "count", "context", "reasoning", "cached", "budget"]);

/** Words before a bare `pat` that make it a personal access token (`github_pat`, `user_pat`). */
const PAT_OWNERS = new Set(["github", "gitlab", "gh", "user", "personal", "access", "my", "bitbucket", "azure"]);
/** Words that, before `key`, make it a credential (`api_key`, `ssh_keys`). */
const KEY_CONTEXT = new Set(["api", "access", "private", "secret", "auth", "signing", "ssh", "master", "encryption"]);
/** Words after `key` that make it a reference to a key, not the key (`encryptionKeyId`, `api_key_name`). */
const KEY_REFERENCE = new Set(["id", "ids", "name", "names", "path", "file", "fingerprint", "type", "version", "ref", "label"]);

/** Splits `apiKey`, `api_key`, `api-key` and `X-Api-Key` into lowercase words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** `dbpass`, `sshkey` and `encryptionkeys` written as one lowercase word: a context word from the lists above plus `pass` or `key(s)`. */
function isJoinedCredentialWord(w: string): boolean {
  for (const p of PASS_CONTEXT) if (w === `${p}pass`) return true;
  for (const p of KEY_CONTEXT) if (w === `${p}key` || w === `${p}keys`) return true;
  return false;
}

/** Whether a key names a credential, by whole words: `api_key` and `access_token` do, `max_token`, `pass` and `bypass` do not. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  return words.some((w, i) => {
    if (SECRET_WORDS.has(w) || isJoinedCredentialWord(w)) return true;
    if (w === "token") return !COUNT_WORDS.has(words[i - 1] ?? "") && !COUNT_AFTER.has(words[i + 1] ?? "");
    if (w === "pass") return PASS_CONTEXT.has(words[i - 1] ?? "") || ["word", "wd", "phrase"].includes(words[i + 1] ?? "");
    // `pat` is a personal access token only alone or after a provider or owner word, so `path_pat` (a pattern) is kept.
    if (w === "pat") return words.length === 1 || PAT_OWNERS.has(words[i - 1] ?? "");
    // `key` and `keys` after a credential word; `encryptionKeyId` and `keyName` only name a key, so they are kept.
    if (w === "key" || w === "keys") return KEY_CONTEXT.has(words[i - 1] ?? "") && !KEY_REFERENCE.has(words[i + 1] ?? "");
    return false;
  });
}

/**
 * Serializes evidence with secrets removed. A replacer that only sees string values cannot know that
 * `{"apiKey": "abcdef1234567890"}` is a credential, so the key name is checked as well as the value text, and the
 * whole value under a credential key (string, number, array or object) is replaced.
 */
function redactedJson(data: unknown, space?: number): string {
  return JSON.stringify(
    data,
    (key, v) => {
      if (key && v !== null && v !== undefined && isSensitiveKey(key)) return "[REDACTED]";
      return typeof v === "string" ? redactSecrets(v) : v;
    },
    space,
  );
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

    fs.mkdirSync(path.dirname(runDir), { recursive: true });
    try {
      fs.mkdirSync(runDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Run "${sRunId}" already exists for evaluation "${sEvalId}"; run ids are never reused or overwritten. ` +
            `If that run crashed before finalizeRun, quarantine it with abandonRun("${sEvalId}", "${sRunId}") and start again.`,
        );
      }
      throw err;
    }
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
    const serialized = redactedJson(event);
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

    const compositeSha256 = this.writeIntegrity(this.currentRunDir, this.currentManifest.runId, completedAt);

    const result = { integrityHash: compositeSha256, runDir: this.currentRunDir };
    this.currentRunDir = undefined;
    this.currentManifest = undefined;
    return result;
  }

  private runDirOf(evaluationId: string, runId: string): { sEvalId: string; sRunId: string; runDir: string } {
    const sEvalId = sanitizeIdentifier(evaluationId, "evaluationId");
    const sRunId = sanitizeIdentifier(runId, "runId");
    const runDir = path.resolve(this.baseDir, sEvalId, sRunId);
    if (!runDir.startsWith(this.baseDir + path.sep)) {
      throw new Error(`Path traversal detected: ${runDir} is outside baseDir ${this.baseDir}`);
    }
    return { sEvalId, sRunId, runDir };
  }

  /** Reads every evidence file of a run once (regular files only); the same buffers are hashed and parsed. */
  private readRunFiles(runDir: string): Map<string, Buffer> | string {
    const files = new Map<string, Buffer>();
    for (const name of fs.readdirSync(runDir).sort()) {
      if (name === "integrity.json" || name.startsWith(".tmp")) continue;
      const full = path.join(runDir, name);
      if (!fs.lstatSync(full).isFile()) return `'${name}' is not a regular file`;
      files.set(name, fs.readFileSync(full));
    }
    return files;
  }

  private writeIntegrity(runDir: string, runId: string, calculatedAt: string, extra: Partial<IntegrityRecord> = {}): string {
    const files = this.readRunFiles(runDir);
    if (typeof files === "string") throw new Error(`Cannot write integrity record: ${files}`);
    const fileHashes: Record<string, string> = {};
    for (const [name, buf] of files) fileHashes[name] = createHash("sha256").update(buf).digest("hex");
    const compositeSha256 = compositeOf(fileHashes);
    const record: IntegrityRecord = { runId, calculatedAt, fileHashes, compositeSha256, ...extra };
    this.atomicWriteJson(path.join(runDir, "integrity.json"), record, false);
    return compositeSha256;
  }

  private verifyAndRead(
    sEvalId: string,
    sRunId: string,
    runDir: string,
  ): { ok: true; files: Map<string, Buffer>; migrated: boolean } | { ok: false; reason: IntegrityFailureReason; detail: string } {
    const fail = (reason: IntegrityFailureReason, detail: string) => ({ ok: false as const, reason, detail });
    const integrityPath = path.join(runDir, "integrity.json");
    if (!fs.existsSync(integrityPath)) {
      return fail(
        "INTEGRITY_MISSING",
        `no integrity record for run '${sRunId}'. If the run crashed before finalizeRun, quarantine it with abandonRun; ` +
          `for evidence written before integrity records existed, an operator can run migrateLegacyRun`,
      );
    }
    const legacy = ` (legacy evidence can be re-recorded by an operator with migrateLegacyRun("${sEvalId}", "${sRunId}", reason))`;
    let record: IntegrityRecord;
    try {
      record = JSON.parse(fs.readFileSync(integrityPath, "utf-8")) as IntegrityRecord;
      if (!record || typeof record.fileHashes !== "object" || record.fileHashes === null || typeof record.compositeSha256 !== "string") throw new Error("bad shape");
    } catch {
      return fail("INTEGRITY_UNREADABLE", `integrity.json is not a valid integrity record${legacy}`);
    }
    if (record.runId !== sRunId) return fail("RUN_ID_MISMATCH", `record names run '${record.runId}', directory is '${sRunId}'${legacy}`);
    const files = this.readRunFiles(runDir);
    if (typeof files === "string") return fail("FILE_SET_MISMATCH", files);
    const recorded = Object.keys(record.fileHashes).sort();
    const present = [...files.keys()];
    if (present.join("\0") !== recorded.join("\0")) return fail("FILE_SET_MISMATCH", `files on disk [${present}] differ from recorded [${recorded}]${legacy}`);
    for (const [name, buf] of files) {
      if (createHash("sha256").update(buf).digest("hex") !== record.fileHashes[name]) return fail("HASH_MISMATCH", `${name} does not match its recorded hash${legacy}`);
    }
    if (compositeOf(record.fileHashes) !== record.compositeSha256) return fail("COMPOSITE_MISMATCH", `composite hash does not match the recorded file hashes${legacy}`);
    return { ok: true, files, migrated: record.migrated === true };
  }

  /**
   * Checks a run's integrity record against the files on disk: record present and readable, naming this run, covering
   * exactly the regular files present, with every file hash and the composite matching.
   */
  verifyRun(evaluationId: string, runId: string): { ok: true; migrated?: true } | { ok: false; reason: IntegrityFailureReason; detail: string } {
    const { sEvalId, sRunId, runDir } = this.runDirOf(evaluationId, runId);
    const v = this.verifyAndRead(sEvalId, sRunId, runDir);
    if (!v.ok) return v;
    return v.migrated ? { ok: true, migrated: true } : { ok: true };
  }

  /** Verified evidence files of a run, or undefined when the run does not exist. Throws on any integrity failure. */
  private loadVerifiedFile(evaluationId: string, runId: string, file: string): Buffer | undefined {
    const { sEvalId, sRunId, runDir } = this.runDirOf(evaluationId, runId);
    if (!fs.existsSync(runDir)) return undefined;
    const v = this.verifyAndRead(sEvalId, sRunId, runDir);
    if (!v.ok) throw new CeriEvidenceIntegrityError(v.reason, v.detail);
    return v.files.get(file);
  }

  /**
   * Quarantines a run that never reached finalizeRun (a crash): the directory is renamed to `<id>.abandoned-<ms>`,
   * never deleted, and the run id becomes available again. A finalized run cannot be abandoned.
   */
  abandonRun(evaluationId: string, runId: string): string {
    const { sRunId, runDir } = this.runDirOf(evaluationId, runId);
    if (!fs.existsSync(runDir)) throw new Error(`Cannot abandon: no run '${sRunId}' for evaluation '${evaluationId}'`);
    if (fs.existsSync(path.join(runDir, "integrity.json"))) throw new Error(`Cannot abandon run '${sRunId}': it is finalized`);
    const target = `${runDir}.abandoned-${Date.now()}`;
    fs.renameSync(runDir, target);
    if (this.currentRunDir === runDir) {
      this.currentRunDir = undefined;
      this.currentManifest = undefined;
    }
    return target;
  }

  /**
   * One-way, operator-invoked re-recording of evidence written before integrity records were reliable (missing,
   * redacted or mismatched record, string `passed`). The old integrity record and any rewritten assertions file are kept
   * as `*.pre-migration-<ms>.*`; the new record is marked `migrated` with the reason. Only the exact strings "true" and
   * "false" are normalized; anything else is refused. A run that already verifies is not migrated. This trusts the files
   * as they are now: it records, it does not prove, that they are the original evidence.
   */
  migrateLegacyRun(evaluationId: string, runId: string, reason: string): { integrityHash: string; runDir: string } {
    if (typeof reason !== "string" || !reason.trim()) throw new Error("migrateLegacyRun requires a non-empty reason");
    const { sEvalId, sRunId, runDir } = this.runDirOf(evaluationId, runId);
    if (!fs.existsSync(runDir)) throw new Error(`Cannot migrate: no run '${sRunId}' for evaluation '${sEvalId}'`);
    const stamp = Date.now();
    const files = this.readRunFiles(runDir);
    if (typeof files === "string") throw new Error(`Cannot migrate run '${sRunId}': ${files}`);
    if (this.verifyAndRead(sEvalId, sRunId, runDir).ok) throw new Error(`Run '${sRunId}' already verifies; nothing to migrate`);

    const normalized: string[] = [];
    let rewritten: string | undefined;
    const raw = files.get("assertions.json");
    if (raw) {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString("utf-8"));
      } catch {
        data = undefined;
      }
      const fix = (id: string, passed: unknown): boolean => {
        if (typeof passed === "boolean") return passed;
        if (passed === "true" || passed === "false") {
          normalized.push(id);
          return passed === "true";
        }
        throw new CeriEvidenceIntegrityError("NON_BOOLEAN_PASSED", `assertion '${id}' has passed=${JSON.stringify(passed)}, cannot be migrated`);
      };
      if (Array.isArray(data)) {
        rewritten = JSON.stringify(data.map((i) => (i && typeof i === "object" && typeof i.id === "string" ? { ...i, passed: fix(i.id, i.passed) } : i)), null, 2);
      } else if (data && typeof data === "object") {
        rewritten = JSON.stringify(Object.fromEntries(Object.entries(data).map(([id, p]) => [id, fix(id, p)])), null, 2);
      }
    }
    if (rewritten !== undefined && normalized.length > 0) {
      fs.renameSync(path.join(runDir, "assertions.json"), path.join(runDir, `assertions.pre-migration-${stamp}.json`));
      fs.writeFileSync(path.join(runDir, "assertions.json"), rewritten, "utf-8");
    }
    const integrityPath = path.join(runDir, "integrity.json");
    if (fs.existsSync(integrityPath)) fs.renameSync(integrityPath, path.join(runDir, `integrity.pre-migration-${stamp}.json`));
    const integrityHash = this.writeIntegrity(runDir, sRunId, new Date(stamp).toISOString(), {
      migrated: true,
      migratedAt: new Date(stamp).toISOString(),
      migrationReason: reason.trim(),
      normalizedAssertions: normalized,
    });
    return { integrityHash, runDir };
  }

  /**
   * Loads assertions recorded for a past evaluation run.
   */
  loadAssertions(evaluationId: string, runId: string): Record<string, boolean> | undefined {
    const raw = this.loadVerifiedFile(evaluationId, runId, "assertions.json");
    if (!raw) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(raw.toString("utf-8"));
    } catch {
      return undefined;
    }
    const strict = (id: string, passed: unknown): boolean => {
      if (typeof passed !== "boolean") {
        throw new CeriEvidenceIntegrityError("NON_BOOLEAN_PASSED", `assertion '${id}' has passed=${JSON.stringify(passed)}, expected a boolean`);
      }
      return passed;
    };
    const map: Record<string, boolean> = {};
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === "object" && typeof item.id === "string") map[item.id] = strict(item.id, item.passed);
      }
      return map;
    }
    if (data && typeof data === "object") {
      for (const [id, passed] of Object.entries(data)) map[id] = strict(id, passed);
      return map;
    }
    return undefined;
  }

  /**
   * Loads manifest for a past evaluation run.
   */
  loadManifest(evaluationId: string, runId: string): RunManifest | undefined {
    const raw = this.loadVerifiedFile(evaluationId, runId, "manifest.json");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw.toString("utf-8")) as RunManifest;
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
        if (runId.includes(".abandoned-")) continue;
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
  private atomicWriteJson(targetPath: string, data: unknown, redact = true): void {
    const dir = path.dirname(targetPath);
    const tmpPath = path.join(dir, `.tmp.${path.basename(targetPath)}.${process.pid}.${Date.now()}`);
    const serialized = redact ? redactedJson(data, 2) : JSON.stringify(data, null, 2);

    fs.writeFileSync(tmpPath, serialized, { encoding: "utf-8" });
    fs.renameSync(tmpPath, targetPath);
  }
}
