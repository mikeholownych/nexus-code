/** Private, per-user keying for operation-local credential account identifiers. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const LEGACY_FINGERPRINT = /^[0-9a-f]{12}$/;
const STALE_TEMP_AGE_MS = 60_000;
const TEMP_HOST_ID = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);

export class AccountIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountIdentityError";
  }
}

function uid(): number {
  if (typeof process.getuid !== "function") throw new AccountIdentityError("Secure account identities are unavailable on this platform.");
  return process.getuid();
}

function checkedDirectory(parent: string, name: string): string {
  const dir = path.join(parent, name);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new AccountIdentityError("Cannot inspect the private account identity directory.");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid() || (stat.mode & 0o022) !== 0) {
    throw new AccountIdentityError("The account identity directory must be a user-owned, non-writable real directory.");
  }
  return dir;
}

function keyPath(home: string): string {
  let realHome: string;
  try {
    realHome = fs.realpathSync(path.resolve(home));
  } catch {
    throw new AccountIdentityError("Cannot resolve the credential home for secure account identities.");
  }
  const homeStat = fs.statSync(realHome);
  if (!homeStat.isDirectory() || homeStat.uid !== uid() || (homeStat.mode & 0o022) !== 0) {
    throw new AccountIdentityError("The credential home must be a user-owned directory that is not group- or world-writable.");
  }
  const config = checkedDirectory(realHome, ".config");
  const nexus = checkedDirectory(config, "nexus");
  const privateDir = checkedDirectory(nexus, "account-identities");
  return path.join(privateDir, "hmac-key");
}

function cleanupStaleTemporaryKeys(file: string): void {
  const dir = path.dirname(file);
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const match = /^hmac-key\.tmp\.([0-9a-f]{16})\.(\d+)\.([0-9a-f]{24})$/.exec(name);
    if (!match) continue;
    // Only reap names created on this host. A shared home may contain an active
    // writer whose PID cannot be checked in this process namespace.
    if (match[1] !== TEMP_HOST_ID) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || now - stat.mtimeMs < STALE_TEMP_AGE_MS) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error: any) {
        if (error?.code !== "ESRCH") continue;
      }
      // Re-check the inode immediately before unlinking in case another writer
      // changed the candidate after the first lstat.
      const current = fs.lstatSync(candidate);
      if (current.dev === stat.dev && current.ino === stat.ino && current.nlink === 1) fs.unlinkSync(candidate);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function readOrCreateKey(home: string): Buffer {
  const file = keyPath(home);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new AccountIdentityError("Secure account identity key access is unavailable on this platform.");
  cleanupStaleTemporaryKeys(file);

  // Generate bytes before opening a path so entropy-provider failures cannot
  // strand an open descriptor or an empty temporary file.
  const key = randomBytes(KEY_BYTES);
  const temporary = `${file}.tmp.${TEMP_HOST_ID}.${process.pid}.${randomBytes(12).toString("hex")}`;
  let fd: number;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
  } catch (error: any) {
    throw new AccountIdentityError(error?.code === "EEXIST"
      ? "A private account identity key creation path unexpectedly already exists."
      : "Cannot create a private account identity key safely.");
  }

  let published = false;
  let operationError: unknown;
  try {
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
    const openedFd = fd;
    fd = -1;
    fs.closeSync(openedFd);
    // link() publishes the fully written inode atomically and refuses to replace a
    // key another process may already have created.
    try {
      fs.linkSync(temporary, file);
      published = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (fd >= 0) {
      const openedFd = fd;
      fd = -1;
      try {
        fs.closeSync(openedFd);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error: any) {
      // A concurrent reader may have removed this exact interrupted-link name
      // while repairing a creator that paused after publication.
      if (error?.code !== "ENOENT" && cleanupError === undefined) cleanupError = error;
    }
    if (operationError === undefined && cleanupError !== undefined) throw cleanupError;
  }
  if (published) syncDirectory(path.dirname(file), noFollow);
  return readKey(file, noFollow);
}

function syncDirectory(dir: string, noFollow: number): void {
  const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function removeInterruptedKeyLink(file: string, keyStat: fs.Stats): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp.`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && stat.dev === keyStat.dev && stat.ino === keyStat.ino) fs.unlinkSync(candidate);
    } catch (error: any) {
      // Another reader may remove the same interrupted link after our readdir.
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function readKey(file: string, noFollow: number): Buffer {
  let fd: number;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof nonBlock !== "number") throw new AccountIdentityError("Non-blocking account identity key access is unavailable on this platform.");
  try {
    // O_NOFOLLOW prevents symlink traversal; O_NONBLOCK prevents an attacker who
    // replaces the key with a FIFO from hanging the caller before fstat can reject it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    throw new AccountIdentityError("The private account identity key cannot be opened safely.");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new AccountIdentityError("The private account identity key must be a regular file.");
    const named = fs.lstatSync(file);
    let checkedStat = stat;
    if (checkedStat.nlink > 1) {
      // A process can stop after the atomic link() and before removing its
      // temporary name. Remove only names that point at this exact key inode.
      removeInterruptedKeyLink(file, checkedStat);
      checkedStat = fs.fstatSync(fd);
    }
    if (
      checkedStat.uid !== uid() || checkedStat.nlink !== 1 || (checkedStat.mode & 0o777) !== 0o600 ||
      named.isSymbolicLink() || named.dev !== checkedStat.dev || named.ino !== checkedStat.ino
    ) {
      throw new AccountIdentityError("The private account identity key has unsafe ownership, permissions, or file type.");
    }
    const key = fs.readFileSync(fd);
    if (key.length !== KEY_BYTES) throw new AccountIdentityError("The private account identity key is invalid; account-scoped state was not changed.");
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

/** One context per newly created operation; matching credentials within it get the same opaque ID. */
export interface OperationAccountIdentity {
  fingerprint(secret: string | undefined): string | undefined;
  migrateLegacy(value: string, operationId: string): string;
}

export function createOperationAccountIdentity(home = os.homedir()): OperationAccountIdentity {
  const salt = randomBytes(32);
  let key: Buffer | undefined;
  const getKey = (): Buffer => {
    key ??= readOrCreateKey(home);
    return key;
  };
  const digest = (domain: string, value: string): string => {
    return `acct:${domain}:v1:${createHmac("sha256", getKey()).update(domain).update("\0").update(salt).update("\0").update(value).digest("hex")}`;
  };
  return {
    fingerprint(secret) {
      if (!secret || secret === "not-needed" || secret === "local") return undefined;
      return digest("credential", secret);
    },
    migrateLegacy(value, operationId) {
      // The operation ID makes an interrupted legacy migration stable across invocations while keeping
      // the same old account fingerprint unlinkable across distinct operations.
      return `acct:legacy:v1:${createHmac("sha256", getKey()).update("legacy\0").update(operationId).update("\0").update(value).digest("hex")}`;
    },
  };
}

export function isLegacyCredentialFingerprint(value: string): boolean {
  return LEGACY_FINGERPRINT.test(value);
}
