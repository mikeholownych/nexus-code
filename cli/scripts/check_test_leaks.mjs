// Lists test files that construct a RustCoreBridge or AutonomousAgent but neither import the leak guard
// (test/helpers/leak_guard) nor release anything (shutdown(), close(), dispose, kill()). Run directly (exit 1 when any) or import findUnguarded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const constructs = /new RustCoreBridge\(|new AutonomousAgent\(/;
const releases = /helpers\/leak_guard|shutdown\(|\.close\(|dispose|\.kill\(/;

export function findUnguarded(testDir) {
  return fs.readdirSync(testDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => {
      const text = fs.readFileSync(path.join(testDir, f), "utf8");
      return constructs.test(text) && !releases.test(text);
    })
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test");
  const bad = findUnguarded(dir);
  for (const f of bad) console.error(`test/${f}: constructs a bridge or agent with no shutdown, close, dispose or kill and no leak_guard import`);
  process.exit(bad.length ? 1 : 0);
}
