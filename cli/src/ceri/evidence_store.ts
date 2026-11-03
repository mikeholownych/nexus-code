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
    const serialized = redactedJson(data, 2);

    fs.writeFileSync(tmpPath, serialized, { encoding: "utf-8" });
    fs.renameSync(tmpPath, targetPath);
  }
}
