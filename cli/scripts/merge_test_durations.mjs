// Rebuilds scripts/test_durations.json, the manifest that balances CLI test shards, from measured runs.
// Every CI `test-shard` leg uploads an artifact `test-shard-node<node>-<k>of<n>` holding `test-durations.json`
// (seconds per test file). Download the artifacts of a green run on the release branch into a directory, then:
//   node cli/scripts/merge_test_durations.mjs <directory or durations file>... [--out <manifest>]
// (or `make test-durations-merge DIR=<directory>`). Directories are searched for files named test-durations*.json.
// Per file the largest measurement wins (Node 22 and 24 legs both report). A file that was not measured keeps its
// current manifest value; entries for test files that no longer exist are dropped. A malformed input is an error.
// The script never downloads anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durationKey, listCliTestFiles, mergeDurationMaps } from "./test_shards.mjs";

const defaultManifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "test_durations.json");

export function findDurationFiles(inputs) {
  return inputs.flatMap((input) => {
    if (!fs.statSync(input).isDirectory()) return [input];
    return fs.readdirSync(input, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /^test-durations.*\.json$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
  });
}

export function readDurationFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`${file}: expected an object of seconds per test file`);
  for (const [key, seconds] of Object.entries(parsed)) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError(`${file}: ${key} has a non-numeric or negative duration`);
  }
  return parsed;
}

/** `known` is the list of current test-file keys; the result holds only those, in sorted order. */
export function mergeDurationManifest({ measured, existing, known }) {
  const fresh = mergeDurationMaps(measured);
  const kept = mergeDurationMaps([existing]);
  const manifest = {};
  const stats = { measured: 0, kept: 0, unmeasured: 0, dropped: Object.keys({ ...kept, ...fresh }).filter((key) => !known.includes(key)).length };
  for (const key of [...new Set(known)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (fresh[key] !== undefined) { manifest[key] = fresh[key]; stats.measured += 1; }
    else if (kept[key] !== undefined) { manifest[key] = kept[key]; stats.kept += 1; }
    else stats.unmeasured += 1;
  }
  return { manifest, stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : defaultManifest;
  if (args.length === 0 || !out || args.some((arg) => arg.startsWith("--"))) {
    console.error("usage: merge_test_durations.mjs <directory or durations file>... [--out <manifest>]");
    process.exit(64);
  }
  try {
    const files = findDurationFiles(args);
    if (files.length === 0) throw new Error("no test-durations*.json file found in the given inputs");
    const existing = fs.existsSync(out) ? readDurationFile(out) : {};
    const { manifest, stats } = mergeDurationManifest({ measured: files.map(readDurationFile), existing, known: listCliTestFiles().map((file) => durationKey(file)) });
    fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.error(`[test-durations] ${files.length} inputs -> ${out}: measured=${stats.measured} kept=${stats.kept} unmeasured=${stats.unmeasured} dropped=${stats.dropped}`);
  } catch (error) {
    console.error(`merge_test_durations: ${error.message}`);
    process.exit(1);
  }
}
