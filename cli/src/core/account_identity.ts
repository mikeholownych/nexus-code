/** Private, per-user keying for operation-local credential account identifiers. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHmac, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const LEGACY_FINGERPRINT = /^[0-9a-f]{12}$/;

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
  if (!homeStat.isDirectory() || homeStat.uid !== uid()) throw new AccountIdentityError("The credential home is not a user-owned directory.");
  const config = checkedDirectory(realHome, ".config");
  const nexus = checkedDirectory(config, "nexus");
  const privateDir = checkedDirectory(nexus, "account-identities");
  return path.join(privateDir, "hmac-key");
}

function readOrCreateKey(home: string): Buffer {
  const file = keyPath(home);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new AccountIdentityError("Secure account identity key access is unavailable on this platform.");

  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    return readKey(file, noFollow);
  }

  const key = randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
  return readKey(file, noFollow);
}

function readKey(file: string, noFollow: number): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new AccountIdentityError("The private account identity key cannot be opened safely.");
  }
  try {
    const stat = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (
      !stat.isFile() || stat.uid !== uid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
      named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino
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
