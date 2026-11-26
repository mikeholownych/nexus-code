import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotHarnessFromPath } from "./snapshot.js";
import { HarnessStore } from "./store.js";
import type { HarnessManifest } from "./types.js";

/**
 * Snapshot a live profile/harness source. v1 supports explicit path or known Nexus config locations.
 * It copies only regular files, redaction/gate happen later; secrets in source files are still a risk,
 * so callers should prefer fixture/path sources and operators should review reports.
 */
export async function snapshotHarnessFromProfile(opts: { profilePath?: string; store: HarnessStore; id: string }): Promise<HarnessManifest> {
  const sourcePath = opts.profilePath ? path.resolve(opts.profilePath) : path.join(os.homedir(), ".config", "nexus");
  if (!fs.existsSync(sourcePath)) throw new Error(`Profile path not found: ${sourcePath}`);
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return snapshotHarnessFromPath({ sourcePath, store: opts.store, id: opts.id, sourceKind: "profile", sourceRef: sourcePath });
  }
  // single file profile source
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hir-profile-"));
  const base = path.join(tmp, "base");
  fs.mkdirSync(base, { recursive: true });
  fs.copyFileSync(sourcePath, path.join(base, path.basename(sourcePath)));
  return snapshotHarnessFromPath({ sourcePath: base, store: opts.store, id: opts.id, sourceKind: "profile", sourceRef: sourcePath });
}
