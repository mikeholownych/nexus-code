/**
 * Local-first skill lifecycle index (WP-GS-05): digest tracking and revocation.
 * Air-gapped; no remote registry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SkillLifecycleEntry {
  name: string;
  contentDigest: string;
  sourcePath: string;
  revoked?: boolean;
  revokedAt?: string;
  /** ISO time of last successful local qualification (WP-GS-06) */
  qualifiedAt?: string;
  /** Digest that was qualified; cleared when content drifts */
  qualificationDigest?: string;
  updatedAt: string;
}

interface SkillLifecycleIndex {
  version: 1;
  entries: Record<string, SkillLifecycleEntry>;
}

function stateDir(): string {
  return process.env.NEXUS_STATE_DIR || path.join(os.homedir(), ".nexus");
}

function indexPath(): string {
  return path.join(stateDir(), "skills", "index.json");
}

export function loadSkillLifecycleIndex(): SkillLifecycleIndex {
  const p = indexPath();
  try {
    if (!fs.existsSync(p)) return { version: 1, entries: {} };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw?.version !== 1 || typeof raw.entries !== "object") return { version: 1, entries: {} };
    return raw as SkillLifecycleIndex;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveSkillLifecycleIndex(index: SkillLifecycleIndex): void {
  const p = indexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export function recordSkillActivationLifecycle(entry: Omit<SkillLifecycleEntry, "updatedAt" | "revoked" | "revokedAt">): void {
  const index = loadSkillLifecycleIndex();
  const prev = index.entries[entry.name];
  // WP-GS-06: digest drift clears qualification while preserving revoke flags.
  const digestChanged = Boolean(prev?.qualificationDigest && prev.qualificationDigest !== entry.contentDigest);
  index.entries[entry.name] = {
    ...prev,
    ...entry,
    revoked: false,
    revokedAt: undefined,
    ...(digestChanged ? { qualifiedAt: undefined, qualificationDigest: undefined } : {}),
    updatedAt: new Date().toISOString(),
  };
  saveSkillLifecycleIndex(index);
}

export function revokeSkill(name: string): boolean {
  const index = loadSkillLifecycleIndex();
  const prev = index.entries[name];
  if (!prev) {
    index.entries[name] = {
      name,
      contentDigest: "",
      sourcePath: "",
      revoked: true,
      revokedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } else {
    prev.revoked = true;
    prev.revokedAt = new Date().toISOString();
    prev.updatedAt = new Date().toISOString();
  }
  saveSkillLifecycleIndex(index);
  return true;
}

export function isSkillRevoked(name: string): boolean {
  return Boolean(loadSkillLifecycleIndex().entries[name]?.revoked);
}
