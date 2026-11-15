// Shrink-only ratchet for the test leak guard. A test file that constructs a RustCoreBridge, an AutonomousAgent or a
// scripted gateway (startGateway) must import test/helpers/leak_guard, unless it is listed in
// test/leak_guard_baseline.json. A file not on the baseline that skips the guard fails, and so does a baseline entry whose
// file has adopted the guard or no longer constructs any of them (remove it). Run directly (exit 1) or import checkLeaks.
// `--write-baseline` rewrites the list (only ever to shrink it in review).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const constructs = /new\s+(?:RustCoreBridge|AutonomousAgent)\s*\(|(?<!function\s)\bstartGateway\s*\(/;
const guarded = /\bleak_guard(?:\.js|\.ts)?["']/;
const ignored = new Set(["leak_guard.test.ts", "leak_guard.ts", "leak_registry.ts"]);

function sources(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full, base);
    return /\.(?:ts|mjs)$/.test(entry.name) && !ignored.has(entry.name) ? [path.relative(base, full)] : [];
  });
}

export function checkLeaks(testDir, baselineFile) {
  const baseline = new Set(JSON.parse(fs.readFileSync(baselineFile, "utf8")));
  const files = sources(testDir);
  const text = (f) => fs.readFileSync(path.join(testDir, f), "utf8");
  const building = files.filter((f) => constructs.test(text(f)));
  const unguarded = building.filter((f) => !guarded.test(text(f))).sort();
  return {
    unguarded,
    missing: unguarded.filter((f) => !baseline.has(f)),
    stale: [...baseline].filter((f) => !unguarded.includes(f)).sort(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test");
  const baselineFile = path.join(dir, "leak_guard_baseline.json");
  if (process.argv.includes("--write-baseline")) {
    if (!fs.existsSync(baselineFile)) fs.writeFileSync(baselineFile, "[]\n");
    fs.writeFileSync(baselineFile, `${JSON.stringify(checkLeaks(dir, baselineFile).unguarded, null, 2)}\n`);
    process.exit(0);
  }
  const { missing, stale } = checkLeaks(dir, baselineFile);
  for (const f of missing) console.error(`test/${f}: constructs a bridge, agent or scripted gateway without importing helpers/leak_guard (add the import, or release everything and import it)`);
  for (const f of stale) console.error(`test/${f}: listed in leak_guard_baseline.json but already guarded or no longer constructs one; remove it from the list`);
  process.exit(missing.length || stale.length ? 1 : 0);
}
