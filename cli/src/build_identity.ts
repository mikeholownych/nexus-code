import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.dirname(fileURLToPath(import.meta.url));

export interface BuildIdentity {
  version: string;
  commit: string;
  /** The commit's time (deterministic; not when the build ran). */
  commitTime: string | null;
  branch: string | null;
  /** The source differed from the commit when it was built. */
  dirty: boolean;
  string: string;
}

let cached: BuildIdentity | null = null;

/**
 * The identity of the running build, as `npm run build` recorded it in cli/dist/build-info.json (no git call at run
 * time). A build without that file (an older build, or running from source) reports commit "unknown".
 */
export function getBuildIdentity(): BuildIdentity {
  if (cached) return cached;
  const read = (file: string): any => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  const version = read(path.resolve(DIST, "../package.json")).version ?? read(path.resolve(DIST, "../../package.json")).version ?? "unknown";
  const info = read(path.join(DIST, "build-info.json"));
  const commit = typeof info.commit === "string" ? info.commit : "unknown";
  const dirty = info.dirty === true;
  const branch = typeof info.branch === "string" ? info.branch : null;
  cached = {
    version,
    commit,
    commitTime: typeof info.commitTime === "string" ? info.commitTime : null,
    branch,
    dirty,
    string: commit === "unknown" ? `${version} (build identity unknown)` : `${version} (${commit}${dirty ? "-dirty" : ""}${branch ? `, ${branch}` : ""})`,
  };
  return cached;
}
