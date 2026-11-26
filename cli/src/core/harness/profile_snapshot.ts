import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePrivateDir, writeFileDurably } from "../durable_file.js";
import { assertValid, validateHarnessManifest } from "./schema.js";
import { HarnessStore, sha256 } from "./store.js";
import type { HarnessComponent, HarnessManifest } from "./types.js";

const SECRET_FILE_RE = /(token|secret|key|credential|auth|\.env|config\.env|id_rsa|pem)$/i;
const SECRET_CONTENT_RE = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /NEXUS_[A-Z0-9_]*(TOKEN|KEY|SECRET)\s*=\s*\S+/i,
];

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function collectFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const lst = await fs.promises.lstat(full);
    if (lst.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await collectFiles(root, full, out); continue; }
    if (!entry.isFile()) continue;
    const real = await fs.promises.realpath(full).catch(() => "");
    if (!real || !isWithin(root, real)) continue;
    out.push(full);
  }
}

/**
 * Snapshot a live profile/harness source. Copies regular files only; skips symlinks/binaries/oversized files.
 * Secret-like files/content are replaced with redaction placeholders in the snapshot tree.
 */
export async function snapshotHarnessFromProfile(opts: { profilePath?: string; store: HarnessStore; id: string }): Promise<HarnessManifest> {
  const sourcePath = opts.profilePath ? path.resolve(opts.profilePath) : path.join(os.homedir(), ".config", "nexus");
  if (!fs.existsSync(sourcePath)) throw new Error(`Profile path not found: ${sourcePath}`);
  const st = await fs.promises.stat(sourcePath);
  const baseDir = opts.store.baseDir(opts.id);
  const treeDir = path.join(baseDir, "tree");
  ensurePrivateDir(treeDir);
  const components: HarnessComponent[] = [];

  const addFile = async (abs: string, rel: string) => {
    const lst = await fs.promises.lstat(abs);
    if (!lst.isFile() || lst.isSymbolicLink()) return;
    if (lst.size > 256 * 1024) return;
    const buf = await fs.promises.readFile(abs);
    const text = buf.toString("utf8");
    if (text.includes("\u0000")) return;
    const secret = SECRET_FILE_RE.test(path.basename(abs)) || SECRET_CONTENT_RE.some((r) => r.test(text));
    const outBuf = secret ? Buffer.from("[REDACTED BY HIR PROFILE SNAPSHOT]\n", "utf8") : buf;
    const dst = path.join(treeDir, rel);
    ensurePrivateDir(path.dirname(dst));
    fs.writeFileSync(dst, outBuf, { mode: 0o600 });
    components.push({
      kind: rel.endsWith("SYSTEM.md") || rel.endsWith(".system.md") ? "system_prompt" : rel.includes("skills/") && rel.endsWith(".md") ? "skill" : "other",
      path: rel,
      contentHash: sha256(outBuf),
      bytes: outBuf.byteLength,
      mutable: true,
    });
  };

  if (st.isDirectory()) {
    const rootReal = await fs.promises.realpath(sourcePath);
    const files: string[] = [];
    await collectFiles(rootReal, rootReal, files);
    files.sort((a, b) => a.localeCompare(b));
    for (const abs of files) {
      const rel = path.relative(rootReal, abs).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      await addFile(abs, rel);
    }
  } else if (st.isFile()) {
    await addFile(sourcePath, path.basename(sourcePath));
  } else {
    throw new Error(`Unsupported profile source: ${sourcePath}`);
  }

  const manifest: HarnessManifest = {
    schemaVersion: 1,
    id: opts.id,
    createdAt: new Date().toISOString(),
    source: { kind: "profile", ref: sourcePath },
    components: components.length > 0 ? components : [{ kind: "other", path: "README.txt", contentHash: sha256("empty"), bytes: 5, mutable: true }],
  };
  if (components.length === 0) {
    fs.writeFileSync(path.join(treeDir, "README.txt"), "empty", { mode: 0o600 });
  }
  assertValid("manifest", manifest, validateHarnessManifest);
  opts.store.saveBaseManifest(manifest);
  return manifest;
}
