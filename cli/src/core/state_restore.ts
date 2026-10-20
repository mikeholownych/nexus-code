/** Crash-replayable state/config restore for cooperating Nexus clients. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireClientLease, releaseClientLease } from "./client_lease.js";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";
import { STATE_RESTORE_PENDING_FILE, STATE_STORE_GUARD_FILE } from "./state_store_guard.js";

type RestoreStore = "state" | "config";
type RestoreMode = "tree" | "file";
export interface RestoreSource { store: RestoreStore; source: string; mode: RestoreMode }
interface ManifestEntry { store: RestoreStore; path: string; kind: "file" | "directory"; size?: number; sha256?: string }
interface RestoreManifest { formatVersion: 1; homeSha256: string; stores: Record<RestoreStore, RestoreMode | null>; entries: ManifestEntry[] }
interface ActiveRestore { formatVersion: 1; id: string; homeSha256: string; manifestSha256: string; phase: "prepared" | "committed"; stores: Record<RestoreStore, RestoreMode | null> }

const CONTROL_DIR = "restore-control";
const ACTIVE_FILE = "active.json";
const TRANSACTIONS_DIR = "transactions";
const CHUNK_SIZE = 64 * 1024;

export class StateRestorePendingError extends Error {
  constructor() { super("Nexus state restore is pending; restart Nexus to resume recovery"); this.name = "StateRestorePendingError"; }
}

function homePath(homeDir: string): string {
  const canonical = fs.realpathSync(path.resolve(homeDir || process.env.HOME || os.homedir()));
  if (!fs.statSync(canonical).isDirectory()) throw new Error("Nexus home is not a directory");
  return canonical;
}

function nexusRoot(home: string): string { return path.join(home, ".nexus"); }
function controlRoot(home: string): string { return path.join(nexusRoot(home), CONTROL_DIR); }
function activePath(home: string): string { return path.join(controlRoot(home), ACTIVE_FILE); }
function transactionPath(home: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid restore transaction identity");
  return path.join(controlRoot(home), TRANSACTIONS_DIR, id);
}

function cleanupOrphanTransactions(home: string): void {
  const transactions = path.join(controlRoot(home), TRANSACTIONS_DIR);
  if (!fs.existsSync(transactions)) return;
  ensurePrivateDirectory(transactions);
  if (readActive(home)) throw new Error("Cannot clean restore staging while a restore is active");
  for (const id of fs.readdirSync(transactions)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Restore staging contains an unknown transaction entry");
    const tx = transactionPath(home, id);
    const stat = fs.lstatSync(tx);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(tx) !== path.resolve(tx) ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
      throw new Error("Orphaned restore transaction is redirected or not private");
    }
    fs.rmSync(tx, { recursive: true, force: false });
    fsyncDirectory(transactions);
  }
}
function homeDigest(home: string): string { return createHash("sha256").update(home).digest("hex"); }
function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }

function hashFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Restore payload changed type while hashing");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try { return fs.lstatSync(target); }
  catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function ensurePrivateDirectory(dir: string, allowPublicAncestors = false): void {
  if (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent !== dir) ensurePrivateDirectory(parent, true);
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    fs.chmodSync(dir, 0o700);
    fsyncDirectory(path.dirname(dir));
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (!allowPublicAncestors && (stat.mode & 0o077) !== 0)) {
    throw new Error("Restore control directory is redirected or not private");
  }
}

function assertRegularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== path.resolve(file) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error("Restore control file is redirected or not private");
  }
}

function writeDurable(file: string, contents: string): void {
  const dir = path.dirname(file);
  ensurePrivateDirectory(dir);
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(fd, contents, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function removeDurably(file: string): void {
  try { fs.unlinkSync(file); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  fsyncDirectory(path.dirname(file));
}

function canonicalControl(home: string, create: boolean): string {
  const root = nexusRoot(home);
  if (create) ensurePrivateDirectory(root);
  else if (!lstatIfPresent(root)) return path.join(root, CONTROL_DIR);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) throw new Error("Nexus state root is redirected");
  const control = controlRoot(home);
  if (create) ensurePrivateDirectory(control);
  else {
    const controlStat = lstatIfPresent(control);
    if (controlStat && (controlStat.isSymbolicLink() || !controlStat.isDirectory() || fs.realpathSync(control) !== path.resolve(control))) {
      throw new Error("Restore control path is redirected");
    }
  }
  return control;
}

function readActive(home: string): ActiveRestore | undefined {
  canonicalControl(home, false);
  const file = activePath(home);
  if (!lstatIfPresent(file)) return undefined;
  assertRegularFile(file);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as ActiveRestore;
  if (!value || value.formatVersion !== 1 || !/^[0-9a-f-]{36}$/.test(value.id) || value.homeSha256 !== homeDigest(home) ||
      !/^[a-f0-9]{64}$/.test(value.manifestSha256) || !["prepared", "committed"].includes(value.phase) ||
      !value.stores || ![null, "tree"].includes(value.stores.state) || ![null, "tree", "file"].includes(value.stores.config) ||
      (!value.stores.state && !value.stores.config)) throw new Error("Pending restore journal is invalid");
  return value;
}

/** Used by task/session operations before and after acquiring their store lock. */
export function assertNoPendingStateRestore(storeDirectory: string): void {
  const canonical = fs.realpathSync(storeDirectory);
  const localMarker = path.join(canonical, STATE_RESTORE_PENDING_FILE);
  if (lstatIfPresent(localMarker)) {
    assertRegularFile(localMarker);
    throw new StateRestorePendingError();
  }
  const root = path.dirname(canonical);
  const active = path.join(root, CONTROL_DIR, ACTIVE_FILE);
  if (lstatIfPresent(active)) {
    assertRegularFile(active);
    throw new StateRestorePendingError();
  }
  // A malformed or redirected control directory is also a fail-closed barrier.
  const control = path.join(root, CONTROL_DIR);
  const controlStat = lstatIfPresent(control);
  if (controlStat) {
    if (controlStat.isSymbolicLink() || !controlStat.isDirectory() || fs.realpathSync(control) !== path.resolve(control)) {
      throw new Error("Restore control path is redirected");
    }
  }
}

export function hasPendingStateRestore(homeDir = process.env.HOME || os.homedir()): boolean {
  const home = homePath(homeDir);
  const active = readActive(home);
  if (active) return true;
  for (const marker of storeMarkerPaths(home, { state:"tree", config:"tree" })) {
    if (lstatIfPresent(marker)) {
      assertRegularFile(marker);
      throw new Error("A store restore marker exists without its global journal; recovery fails closed");
    }
  }
  return false;
}

function validateTree(source: string): void {
  const resolved = path.resolve(source);
  if (fs.realpathSync(resolved) !== resolved) throw new Error("Restore source is redirected");
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Restore source contains unsupported entries");
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(resolved)) {
      if (name === STATE_RESTORE_PENDING_FILE || name === STATE_STORE_GUARD_FILE || name === CONTROL_DIR) throw new Error("Restore source uses a reserved Nexus control name");
      validateTree(path.join(resolved, name));
    }
  }
}

function copyFileDurably(source: string, target: string): void {
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let targetFd: number | undefined;
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    if (!fs.fstatSync(sourceFd).isFile()) throw new Error("Restore source file changed type");
    targetFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    while (true) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (!count) break;
      let written = 0;
      while (written < count) written += fs.writeSync(targetFd, buffer, written, count - written);
      position += count;
    }
    fs.fsyncSync(targetFd);
    fs.closeSync(targetFd); targetFd = undefined;
    fs.renameSync(temp, target);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (targetFd !== undefined) try { fs.closeSync(targetFd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  } finally { fs.closeSync(sourceFd); }
}

function copyTreeDurably(source: string, target: string, skipRoot = new Set<string>()): void {
  validateTree(source);
  ensurePrivateDirectory(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skipRoot.has(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTreeDurably(from, to);
    else copyFileDurably(from, to);
  }
}

function collectEntries(root: string, store: RestoreStore, skip: Set<string> = new Set()): ManifestEntry[] {
  const result: ManifestEntry[] = [];
  const walk = (directory: string, relative: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && skip.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const itemPath = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        result.push({ store, path: itemPath, kind: "directory" });
        walk(full, itemPath);
      } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
        result.push({ store, path: itemPath, kind: "file", size: stat.size, sha256: hashFile(full) });
      } else throw new Error("Restore tree contains a redirected or unsupported entry");
    }
  };
  walk(root, "");
  return result;
}

function manifestFor(home: string, stores: Record<RestoreStore, RestoreMode | null>, payload: string): RestoreManifest {
  const entries: ManifestEntry[] = [];
  for (const store of ["state", "config"] as const) {
    if (!stores[store]) continue;
    const root = path.join(payload, store);
    entries.push(...collectEntries(root, store));
  }
  entries.sort((a, b) => a.store.localeCompare(b.store) || a.path.localeCompare(b.path));
  return { formatVersion: 1, homeSha256: homeDigest(home), stores, entries };
}

function manifestDigest(manifest: RestoreManifest): string { return sha256(JSON.stringify(manifest)); }

function readAndVerifyManifest(home: string, active: ActiveRestore): RestoreManifest {
  const tx = transactionPath(home, active.id);
  if (fs.lstatSync(tx).isSymbolicLink() || fs.realpathSync(tx) !== path.resolve(tx)) throw new Error("Restore transaction path is redirected");
  const file = path.join(tx, "manifest.json");
  assertRegularFile(file);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as RestoreManifest;
  if (manifest.formatVersion !== 1 || manifest.homeSha256 !== active.homeSha256 ||
      manifestDigest(manifest) !== active.manifestSha256 || JSON.stringify(manifest.stores) !== JSON.stringify(active.stores)) {
    throw new Error("Restore manifest identity does not match the active journal");
  }
  const payload = path.join(tx, "payload");
  const observed: ManifestEntry[] = [];
  for (const store of ["state", "config"] as const) if (manifest.stores[store]) observed.push(...collectEntries(path.join(payload, store), store));
  observed.sort((a, b) => a.store.localeCompare(b.store) || a.path.localeCompare(b.path));
  if (JSON.stringify(observed) !== JSON.stringify(manifest.entries)) throw new Error("Staged restore payload failed integrity verification");
  return manifest;
}

function storeMarkerPaths(home: string, stores: Record<RestoreStore, RestoreMode | null>): string[] {
  const result: string[] = [];
  if (stores.state) {
    result.push(path.join(nexusRoot(home), "tasks", STATE_RESTORE_PENDING_FILE));
    result.push(path.join(nexusRoot(home), "sessions", STATE_RESTORE_PENDING_FILE));
  }
  if (stores.config) result.push(path.join(home, ".config", "nexus", STATE_RESTORE_PENDING_FILE));
  return result;
}

function ensureStoreLocks<T>(home: string, stores: Record<RestoreStore, RestoreMode | null>, action: () => T): T {
  const directories: string[] = [];
  if (stores.state) directories.push(path.join(nexusRoot(home), "tasks"), path.join(nexusRoot(home), "sessions"));
  for (const directory of directories) ensurePrivateDirectory(directory);
  const guards: ReturnType<typeof acquireFileGuard>[] = [];
  try {
    for (const directory of directories) {
      const guard = acquireFileGuard(path.join(directory, STATE_STORE_GUARD_FILE), { label: "State store restore guard", waitMs: 2000 });
      if (!guard) throw new Error("State store is busy; retry restore after active work completes");
      guards.push(guard);
    }
    return action();
  } finally { for (const guard of guards.reverse()) releaseFileGuard(guard); }
}

function writeStoreMarkers(home: string, active: ActiveRestore): void {
  for (const marker of storeMarkerPaths(home, active.stores)) {
    if (lstatIfPresent(marker)) {
      assertRegularFile(marker);
      const current = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (current.formatVersion !== 1 || current.id !== active.id || current.manifestSha256 !== active.manifestSha256) {
        throw new Error("Existing restore marker identity does not match the global journal");
      }
      continue;
    }
    writeDurable(marker, JSON.stringify({ formatVersion: 1, id: active.id, manifestSha256: active.manifestSha256 }));
  }
}

function clearStoreMarkers(home: string, active: ActiveRestore): void {
  for (const marker of storeMarkerPaths(home, active.stores)) {
    if (!lstatIfPresent(marker)) continue;
    assertRegularFile(marker);
    const value = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (value.id !== active.id || value.manifestSha256 !== active.manifestSha256) throw new Error("Restore marker identity changed");
    fs.unlinkSync(marker);
    fsyncDirectory(path.dirname(marker));
  }
}

function removeRestoredObsoleteTree(target: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) { fs.unlinkSync(target); fsyncDirectory(path.dirname(target)); return; }
  for (const name of fs.readdirSync(target)) {
    if (name === STATE_STORE_GUARD_FILE || name === STATE_RESTORE_PENDING_FILE) continue;
    removeRestoredObsoleteTree(path.join(target, name));
  }
  if (fs.readdirSync(target).length === 0) { fs.rmdirSync(target); fsyncDirectory(path.dirname(target)); }
}

function applyTree(source: string, destination: string, rootPreserve: Set<string>): void {
  validateTree(source);
  ensurePrivateDirectory(destination);
  const preserved = new Set([...rootPreserve, STATE_STORE_GUARD_FILE, STATE_RESTORE_PENDING_FILE]);
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (preserved.has(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      const existing = fs.lstatSync(to, { throwIfNoEntry: false });
      if (existing && !existing.isDirectory()) { fs.unlinkSync(to); fsyncDirectory(path.dirname(to)); }
      applyTree(from, to, new Set());
    }
    else {
      const targetStat = fs.lstatSync(to, { throwIfNoEntry: false });
      if (targetStat?.isDirectory()) {
        removeRestoredObsoleteTree(to);
        if (fs.existsSync(to)) throw new Error("Restore cannot replace a directory that contains a reserved control file");
      }
      copyFileDurably(from, to);
    }
  }
  for (const name of fs.readdirSync(destination)) {
    if (preserved.has(name)) continue;
    const from = path.join(source, name), to = path.join(destination, name);
    if (!fs.existsSync(from)) removeRestoredObsoleteTree(to);
  }
  fsyncDirectory(destination);
}

function applyRestore(home: string, active: ActiveRestore): void {
  const payload = path.join(transactionPath(home, active.id), "payload");
  if (active.stores.state) applyTree(path.join(payload, "state"), nexusRoot(home), new Set(["backups", CONTROL_DIR]));
  if (active.stores.config === "tree") applyTree(path.join(payload, "config"), path.join(home, ".config", "nexus"), new Set(["backups"]));
  if (active.stores.config === "file") {
    const source = path.join(payload, "config", "config.env");
    ensurePrivateDirectory(path.join(home, ".config", "nexus"));
    copyFileDurably(source, path.join(home, ".config", "nexus", "config.env"));
  }
}

function resumeUnderLease(home: string, active: ActiveRestore): void {
  ensurePrivateDirectory(path.join(controlRoot(home), TRANSACTIONS_DIR));
  ensureStoreLocks(home, active.stores, () => {
    if (active.phase === "prepared") {
      readAndVerifyManifest(home, active);
      writeStoreMarkers(home, active); // Global intent is already durable.
      applyRestore(home, active);
      active = { ...active, phase: "committed" };
      writeDurable(activePath(home), JSON.stringify(active));
    }
    // Keep the global journal and per-store barriers until private staging is
    // fully removed. A crash or cleanup error can then replay this committed
    // transaction and retry cleanup instead of leaving an untracked payload.
    const tx = transactionPath(home, active.id);
    fs.rmSync(tx, { recursive: true, force: true });
    fsyncDirectory(path.join(controlRoot(home), TRANSACTIONS_DIR));
    clearStoreMarkers(home, active);
    removeDurably(activePath(home));
  });
}

function withExclusiveLease<T>(home: string, action: () => T): T {
  const lease: FileGuard = acquireClientLease(home, { exclusive: true, waitMs: 0 });
  try { return action(); }
  finally { releaseClientLease(lease); }
}

/**
 * Older package entry points predate the kernel lease and cannot be serialized
 * against a fresh direct invocation. The durable journal is installed before
 * this census: supported launches through the stable `nexus` launcher run the
 * current entry point, which routes through recovery before loading config.
 * This census rejects already-running legacy entry points. Operators must keep
 * version-pinned legacy binaries and direct old entry points offline until the
 * active journal is cleared; those non-cooperating invocations are outside the
 * launch barrier. Matching is by canonical entry-point path, not process name.
 */
function assertNoLegacyManagedClients(home: string): void {
  if (process.platform !== "linux" || typeof process.getuid !== "function") throw new Error("Managed restore requires Linux /proc process census");
  const proc = "/proc";
  if (!fs.statSync(proc).isDirectory()) throw new Error("Managed restore requires readable /proc");
  const uid = process.getuid();
  for (const entry of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const directory = path.join(proc, entry);
    try {
      if (fs.statSync(directory).uid !== uid) continue;
      const raw = fs.readFileSync(path.join(directory, "cmdline"));
      if (raw.length === 0) continue;
      const argv = raw.toString("utf8").split("\0").filter(Boolean);
      const managed = argv.some((arg) => {
        if (!path.isAbsolute(arg)) return false;
        let resolved = arg;
        try { resolved = fs.realpathSync(arg); } catch {}
        return /(?:^|\/)cli\/(?:dist|src)\/(?:index|sidecar)\.(?:js|ts)$/.test(resolved) ||
          /(?:^|\/)lib\/nexus\/v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\/bin\/nexus$/.test(resolved) ||
          /(?:^|\/)lib\/core\/nexus-tui$/.test(resolved) ||
          /(?:^|\/)core\/target\/(?:release|debug)\/nexus-tui$/.test(resolved);
      });
      if (managed) {
        const environment = fs.readFileSync(path.join(directory, "environ")).toString("utf8").split("\0");
        const homeValue = environment.find((value) => value.startsWith("HOME="))?.slice(5) || os.userInfo().homedir;
        let processHome: string;
        try { processHome = fs.realpathSync(homeValue); }
        catch (error: any) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        if (processHome === home) throw new Error(`A legacy Nexus client (pid ${entry}) is still running; close it and retry restore. Do not launch version-pinned legacy binaries or direct old entry points until restore completes`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      if (error instanceof Error && error.message.startsWith("A legacy Nexus client")) throw error;
      if (error?.code === "EACCES" || error?.code === "EPERM") throw new Error("Cannot verify all same-user processes; restore fails closed");
      throw error;
    }
  }
}

/** Replays a pending restore before Nexus loads configuration or admits clients. */
export function recoverPendingStateRestore(homeDir = process.env.HOME || os.homedir()): boolean {
  try {
    const home = homePath(homeDir);
    const active = readActive(home);
    if (!active) return !hasPendingStateRestore(home);
    return withExclusiveLease(home, () => {
      assertNoLegacyManagedClients(home);
      const current = readActive(home);
      if (!current) return true;
      resumeUnderLease(home, current);
      return !readActive(home);
    });
  } catch { return false; }
}

function stageSources(home: string, sources: RestoreSource[]): ActiveRestore {
  if (!sources.length || sources.some(source => source.store === "state" && source.mode !== "tree" || source.store === "config" && !["tree", "file"].includes(source.mode))) {
    throw new Error("Restore source set is invalid");
  }
  const stores: Record<RestoreStore, RestoreMode | null> = { state: null, config: null };
  for (const source of sources) {
    if (stores[source.store]) throw new Error("Duplicate restore store");
    validateTree(source.source);
    if (source.mode === "file" && !fs.lstatSync(source.source).isFile()) throw new Error("Configuration backup is not a regular file");
    stores[source.store] = source.mode;
  }
  const control = canonicalControl(home, true);
  const transactions = path.join(control, TRANSACTIONS_DIR);
  ensurePrivateDirectory(transactions);
  cleanupOrphanTransactions(home);
  const id = randomUUID();
  const tx = transactionPath(home, id);
  ensurePrivateDirectory(tx);
  const payload = path.join(tx, "payload");
  ensurePrivateDirectory(payload);
  for (const source of sources) {
    const target = path.join(payload, source.store);
    if (source.mode === "tree") copyTreeDurably(source.source, target, new Set(["backups"]));
    else {
      ensurePrivateDirectory(target);
      copyFileDurably(source.source, path.join(target, "config.env"));
    }
  }
  const manifest = manifestFor(home, stores, payload);
  const digest = manifestDigest(manifest);
  writeDurable(path.join(tx, "manifest.json"), JSON.stringify(manifest));
  fsyncDirectory(tx);
  const active: ActiveRestore = { formatVersion: 1, id, homeSha256: homeDigest(home), manifestSha256: digest, phase: "prepared", stores };
  writeDurable(activePath(home), JSON.stringify(active)); // Durable global intent precedes per-store journals and all live writes.
  return active;
}

/** Stages immutable payloads, then commits or leaves a replayable fail-closed journal. */
export function restoreFromSources(homeDir: string, sources: RestoreSource[], onError?: (error: unknown) => void): boolean {
  try {
    const home = homePath(homeDir);
    return withExclusiveLease(home, () => {
      if (hasPendingStateRestore(home)) {
        assertNoLegacyManagedClients(home);
        const pending = readActive(home);
        if (!pending) throw new Error("Pending restore journal disappeared during recovery");
        resumeUnderLease(home, pending);
      }
      // The prepared global journal is the durable managed-launcher route.
      // It must exist before checking clients that predate kernel leases.
      const active = stageSources(home, sources);
      assertNoLegacyManagedClients(home);
      resumeUnderLease(home, active);
      return !readActive(home);
    });
  } catch (error) {
    try { onError?.(error); } catch {}
    return false;
  }
}
