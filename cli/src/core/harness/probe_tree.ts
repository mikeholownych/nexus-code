import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir } from "../durable_file.js";

function escapesRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** Copy a candidate tree without following links outside it or recursing through directory-link cycles. */
export function copyProbeTree(src: string, dst: string): void {
  const root = fs.realpathSync(src);
  const active = new Set<string>();

  const copy = (source: string, destination: string): void => {
    const realSource = fs.realpathSync(source);
    if (escapesRoot(root, realSource)) throw new Error(`symlink escapes probe source: ${source}`);
    const stat = fs.statSync(realSource);
    if (!stat.isDirectory()) {
      ensurePrivateDir(path.dirname(destination));
      fs.copyFileSync(realSource, destination);
      return;
    }
    if (active.has(realSource)) throw new Error(`directory symlink cycle in probe source: ${source}`);

    active.add(realSource);
    ensurePrivateDir(destination);
    try {
      for (const entry of fs.readdirSync(realSource, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const childSource = path.join(realSource, entry.name);
        const childDestination = path.join(destination, entry.name);
        const childStat = fs.lstatSync(childSource);
        if (childStat.isSymbolicLink()) {
          const target = fs.realpathSync(childSource);
          if (escapesRoot(root, target)) throw new Error(`symlink escapes probe source: ${childSource}`);
          if (fs.statSync(target).isDirectory()) copy(target, childDestination);
          else {
            ensurePrivateDir(path.dirname(childDestination));
            fs.copyFileSync(target, childDestination);
          }
        } else if (childStat.isDirectory()) copy(childSource, childDestination);
        else if (childStat.isFile()) {
          ensurePrivateDir(path.dirname(childDestination));
          fs.copyFileSync(childSource, childDestination);
        }
      }
    } finally {
      active.delete(realSource);
    }
  };

  copy(root, dst);
}
