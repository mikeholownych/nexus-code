import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir, writeFileDurably } from "../durable_file.js";
import { assertValid, validateHarnessManifest } from "./schema.js";
import { HarnessStore, sha256 } from "./store.js";
import type { HarnessComponent, HarnessManifest } from "./types.js";

export interface SnapshotOptions {
  sourcePath: string;
  store: HarnessStore;
  id: string;
  sourceKind: "fixture" | "path" | "profile";
  sourceRef: string;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function walkFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const lstat = await fs.promises.lstat(full);
    if (lstat.isSymbolicLink()) {
      const real = await fs.promises.realpath(full);
      if (!isWithin(root, real)) throw new Error(`symlink escapes base: ${full}`);
      // allow symlinks inside base but copy resolved content as regular file
      if (lstat.isDirectory()) await walkFiles(root, full, out);
      else if (lstat.isFile()) out.push(full);
      else continue;
      continue;
    }
    if (entry.isDirectory()) {
      await walkFiles(root, full, out);
    } else if (entry.isFile()) {
      const real = await fs.promises.realpath(full);
      if (!isWithin(root, real)) throw new Error(`path escapes base: ${full}`);
      out.push(full);
    }
  }
}

export async function snapshotHarnessFromPath(opts: SnapshotOptions): Promise<HarnessManifest> {
  const sourcePath = path.resolve(opts.sourcePath);
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isDirectory()) throw new Error(`sourcePath must be directory: ${sourcePath}`);
  const rootReal = await fs.promises.realpath(sourcePath);
  const files: string[] = [];
  await walkFiles(rootReal, rootReal, files);
  files.sort((a, b) => a.localeCompare(b));
  const components: HarnessComponent[] = [];
  const baseDir = opts.store.baseDir(opts.id);
  const treeDir = path.join(baseDir, "tree");
  ensurePrivateDir(treeDir);

  for (const abs of files) {
    const real = await fs.promises.realpath(abs);
    if (!isWithin(rootReal, real)) throw new Error(`path escapes base: ${abs}`);
    const rel = path.relative(rootReal, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) throw new Error(`invalid relative path: ${rel}`);
    const buf = await fs.promises.readFile(real);
    const contentHash = sha256(buf);
    const dst = path.join(treeDir, rel);
    ensurePrivateDir(path.dirname(dst));
    fs.writeFileSync(dst, buf, { mode: 0o600 });
    components.push({
      kind: rel.endsWith("SYSTEM.md") || rel.endsWith(".system.md") ? "system_prompt" : rel.endsWith(".md") && rel.includes("skills/") ? "skill" : "other",
      path: rel,
      contentHash,
      bytes: buf.byteLength,
      mutable: true,
    });
  }

  const manifest: HarnessManifest = {
    schemaVersion: 1,
    id: opts.id,
    createdAt: new Date().toISOString(),
    source: { kind: opts.sourceKind, ref: opts.sourceRef },
    components,
  };
  assertValid("manifest", manifest, validateHarnessManifest);
  opts.store.saveBaseManifest(manifest);
  return manifest;
}
