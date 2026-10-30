/**
 * Durable publication of an extracted package.
 *
 * `safeExtractTar` writes the release tree with `tar` and the CLI then renames
 * that directory into place and switches the launcher. A rename persists the
 * directory entry, not the file contents: without an fsync of every extracted
 * file, a power loss shortly after the switch can leave a package whose files
 * are zero-length while the launcher already points at it. The installation is
 * then unusable, and the CLI that would run `upgrade --recover` cannot start.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface DurabilityIo {
  openSync(file: string, flags: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

export const nodeDurabilityIo: DurabilityIo = {
  openSync: (file, flags) => fs.openSync(file, flags),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
};

/**
 * Flush every regular file and directory under `root`, children before their
 * parent, so the whole tree is durable before it is renamed into place.
 * Symlinks carry no payload of their own and are skipped.
 */
export function fsyncTree(root: string, io: DurabilityIo = nodeDurabilityIo): void {
  const absolute = path.resolve(root);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`fsyncTree requires a real directory: ${absolute}`);

  const flush = (file: string) => {
    const fd = io.openSync(file, "r");
    try {
      try { io.fsyncSync(fd); }
      catch (error: any) { throw new Error(`durability flush failed for ${file}: ${error.message}`); }
    } finally { io.closeSync(fd); }
  };
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) flush(full);
    }
    flush(directory);
  };
  visit(absolute);
}
