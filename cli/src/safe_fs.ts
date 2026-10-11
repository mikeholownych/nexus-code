/**
 * Filesystem changes that cannot be redirected by symbolic links: the primitives `doctor --fix` uses.
 *
 * A path check followed by a path-based change is racy, and checking only the last component misses a linked parent
 * (`~/.nexus -> /elsewhere` makes `~/.nexus/sessions` point outside the home). Here every change is made through a
 * file descriptor that has been proven to be the expected object:
 *
 * 1. Ancestry: every component of the target below a trusted root (the operator's home, which may itself be a link)
 *    must be a real directory entry — not a symbolic link — owned by the current user.
 * 2. Binding: the target is opened with O_NOFOLLOW; the opened object's real location (`/proc/self/fd/N`) must equal
 *    the expected path under the root's real path, and its device/inode must match what was diagnosed. A parent or
 *    final component swapped at any point before the open is therefore detected after the open.
 * 3. Mutation: `fchmod` on that descriptor, so a swap after the check cannot redirect the change. New directories and
 *    files are created exclusively (O_EXCL, O_NOFOLLOW) and verified the same way; anything created in an unexpected
 *    place is removed again through its verified real path and reported.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export class SafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafePathError";
  }
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

export interface Identity {
  dev: number;
  ino: number;
  mode: number;
}

function relativeParts(root: string, target: string): string[] {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new SafePathError(`${target} is not inside ${root}`);
  return rel.split(path.sep).filter(Boolean);
}

/**
 * Why `target` (under `root`) is unsafe to change, or undefined when every existing component below `root` is a
 * real, user-owned entry and every non-final one is a directory. Components that do not exist yet are fine.
 */
export function ancestryProblem(root: string, target: string): string | undefined {
  let parts: string[];
  try {
    parts = relativeParts(root, target);
  } catch (err) {
    return (err as Error).message;
  }
  let current = path.resolve(root);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      return `${current}: ${err?.code ?? err}`;
    }
    if (stat.isSymbolicLink()) return `${current} is a symbolic link`;
    if (i < parts.length - 1 && !stat.isDirectory()) return `${current} is not a directory`;
    const me = uid();
    if (me !== undefined && stat.uid !== me) return `${current} is owned by uid ${stat.uid}, not ${me}`;
  }
  return undefined;
}

/** The identity (device, inode, permission bits) of the entry itself, never a link's target. */
export function identityOf(file: string): Identity | undefined {
  try {
    const stat = fs.lstatSync(file);
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
  } catch {
    return undefined;
  }
}

function expectedRealPath(root: string, target: string): string {
  return path.join(fs.realpathSync(path.resolve(root)), ...relativeParts(root, target));
}

/** Where an open descriptor really is (Linux /proc), or undefined where that is not available. */
function descriptorPath(fd: number): string | undefined {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** Throws unless descriptor `fd` is the object expected at `target` under `root` (and matches `expect`, if given). */
function verifyDescriptor(fd: number, root: string, target: string, expect?: Pick<Identity, "dev" | "ino">): fs.Stats {
  const stat = fs.fstatSync(fd);
  const expected = expectedRealPath(root, target);
  const actual = descriptorPath(fd);
  if (actual !== undefined && actual !== expected) throw new SafePathError(`${target} resolves to ${actual}, not ${expected}`);
  if (actual === undefined) {
    // Without /proc: the path must still name the same object, through no link.
    const now = identityOf(target);
    if (!now || now.dev !== stat.dev || now.ino !== stat.ino || fs.realpathSync(target) !== expected) {
      throw new SafePathError(`${target} changed while it was being opened`);
    }
  }
  if (expect && (stat.dev !== expect.dev || stat.ino !== expect.ino)) throw new SafePathError(`${target} is no longer the object that was diagnosed`);
  const me = uid();
  if (me !== undefined && stat.uid !== me) throw new SafePathError(`${target} is owned by uid ${stat.uid}, not ${me}`);
  return stat;
}

/** Opens `target` without following a final link and proves it is the expected object. Caller closes the descriptor. */
export function openVerified(root: string, target: string, kind: "dir" | "file", expect?: Pick<Identity, "dev" | "ino">): number {
  const problem = ancestryProblem(root, target);
  if (problem) throw new SafePathError(problem);
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (kind === "dir" ? fs.constants.O_DIRECTORY : 0);
  const fd = fs.openSync(target, flags);
  try {
    verifyDescriptor(fd, root, target, expect);
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

/**
 * Sets `mode` on the object at `target`, only if it is still the diagnosed object with the diagnosed mode. The
 * change is made through the verified descriptor.
 */
export function chmodVerified(root: string, target: string, mode: number, expect: Identity, kind: "dir" | "file"): void {
  const fd = openVerified(root, target, kind, expect);
  try {
    const current = fs.fstatSync(fd).mode & 0o777;
    if (current !== expect.mode) throw new SafePathError(`${target} changed mode since the diagnosis (${expect.mode.toString(8)} -> ${current.toString(8)})`);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Creates `target` and any missing parents below `root` with mode 0700, one component at a time, verifying each.
 * Returns the components it created.
 */
export function mkdirVerified(root: string, target: string): string[] {
  const problem = ancestryProblem(root, target);
  if (problem) throw new SafePathError(problem);
  const created: string[] = [];
  let current = path.resolve(root);
  for (const part of relativeParts(root, target)) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
      created.push(current);
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
    const fd = (() => {
      try {
        return openVerified(root, current, "dir");
      } catch (err) {
        // A directory we just made somewhere unexpected (a parent was swapped): remove it again where it really is.
        for (const made of created.reverse()) {
          try {
            fs.rmdirSync(fs.realpathSync(made));
          } catch {}
        }
        throw err;
      }
    })();
    fs.closeSync(fd);
  }
  return created;
}

/**
 * Creates `file` exclusively (never through a link, never over an existing entry) with mode 0600, writes `content`,
 * and verifies where it was created. Returns its identity, for a verified removal later.
 */
export function writeExclusiveVerified(root: string, file: string, content: string): Identity {
  const problem = ancestryProblem(root, file);
  if (problem) throw new SafePathError(problem);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let stat: fs.Stats;
  try {
    try {
      stat = verifyDescriptor(fd, root, file);
    } catch (err) {
      const actual = descriptorPath(fd);
      if (actual) {
        try {
          fs.unlinkSync(actual);
        } catch {}
      }
      throw err;
    }
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
}

/** Reads `file` only if it is a real, user-owned file at the expected place. */
export function readVerified(root: string, file: string): string {
  const fd = openVerified(root, file, "file");
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Removes `file` only while it is still the object `expect` names (a lock or manifest this process created). */
export function unlinkVerified(root: string, file: string, expect: Pick<Identity, "dev" | "ino">): void {
  const fd = openVerified(root, file, "file", expect);
  fs.closeSync(fd);
  fs.unlinkSync(file);
}
