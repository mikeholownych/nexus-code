import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const MAX_ENTRIES = 10_000;

/**
 * Content hash of an evaluation fixture (a file, or a directory tree), or undefined when it cannot be identified
 * (missing, unreadable, or more than 10 000 entries). Entries are sorted; regular files are hashed by content, symlinks
 * by their link text and never followed, other entry kinds are ignored. Local identity only: it detects a changed
 * fixture, it does not authenticate one.
 */
export function hashFixture(fixturePath: string): string | undefined {
  try {
    const root = fs.lstatSync(fixturePath);
    const hasher = createHash("sha256");
    let count = 0;
    const visit = (full: string, rel: string, stat: fs.Stats): boolean => {
      if (++count > MAX_ENTRIES) return false;
      if (stat.isSymbolicLink()) {
        hasher.update(`L\0${rel}\0${fs.readlinkSync(full)}\n`);
      } else if (stat.isFile()) {
        hasher.update(`F\0${rel}\0${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}\n`);
      } else if (stat.isDirectory()) {
        hasher.update(`D\0${rel}\n`);
        for (const name of fs.readdirSync(full).sort()) {
          const child = path.join(full, name);
          if (!visit(child, rel ? `${rel}/${name}` : name, fs.lstatSync(child))) return false;
        }
      }
      return true;
    };
    return visit(fixturePath, "", root) ? hasher.digest("hex") : undefined;
  } catch {
    return undefined;
  }
}
