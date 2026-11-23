import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(cli, "scripts", "run_tests.mjs");
const sharedEvaluatorFixtures = new Set([
  "test/eval_integrity.test.ts",
  "test/eval_version_probe_storage.test.ts",
  "test/evaluator_cgroup_limits.test.ts",
]);

export function listCliTestFiles(root = cli) {
  return [
    ...fs.readdirSync(path.join(root, "test")).filter((file) => file.endsWith(".test.ts")).sort().map((file) => path.join("test", file)),
    path.resolve(root, "../eval/dataset.test.mjs"),
    path.resolve(root, "../eval/package_runtime.test.mjs"),
  ];
}

/** Test files use POSIX-relative paths so the checked-in manifest works on every runner. */
export function durationKey(file, root = cli) {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return relative.split(path.sep).join("/");
}

/**
 * Measured seconds per test file, from `NEXUS_TEST_DURATIONS` or the checked-in manifest
 * (written by a run with `NEXUS_TEST_DURATIONS_OUT`). A missing or malformed manifest is not a failure:
 * the sharder falls back to source size.
 */
export function loadTestDurations(root = cli) {
  const file = process.env.NEXUS_TEST_DURATIONS || path.join(root, "scripts", "test_durations.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, seconds]) => Number.isFinite(seconds) && seconds > 0));
  } catch {
    return {};
  }
}

/** Upper bound for `--shard=K/N` and for `partitionTestFiles`: a typo must not silently produce near-empty shards. */
export const MAX_SHARDS = 16;

const defaultSizeOf = (file) => fs.statSync(path.resolve(cli, file)).size;

/**
 * Greedy best-fit by measured duration where one exists, source size otherwise. Duration is scaled to
 * "byte-equivalent" weight (1 s = 1000) so the two bases can coexist while a measured file is gradually added.
 * The result depends only on the set of files, their weights and `count` (never on input order). Empty shards are
 * dropped unless `keepEmpty` is set, which shard selection needs so that index K always names the same slot.
 */
export function partitionTestFiles(files, count = 2, sizeOf = defaultSizeOf, durations = loadTestDurations(), { keepEmpty = false } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHARDS) throw new RangeError(`CLI test shard count must be an integer from 1 to ${MAX_SHARDS}`);
  const shards = Array.from({ length: count }, () => []);
  const loads = Array.from({ length: count }, () => 0);
  const pinned = [];
  const weighted = [];
  const weightOf = (file) => {
    const measured = durations[durationKey(file)];
    return measured > 0 ? measured * 1000 : Math.max(1, sizeOf(file));
  };
  for (const file of [...new Set(files)]) {
    const relative = durationKey(file);
    if (sharedEvaluatorFixtures.has(relative)) pinned.push(file);
    else weighted.push({ file, weight: weightOf(file) });
  }
  if (pinned.length) {
    shards[0].push(...pinned.sort());
    loads[0] = pinned.reduce((total, file) => total + weightOf(file), 0);
  }
  weighted.sort((a, b) => b.weight - a.weight || (String(a.file) < String(b.file) ? -1 : String(a.file) > String(b.file) ? 1 : 0));
  for (const item of weighted) {
    let target = 0;
    for (let i = 1; i < count; i++) if (loads[i] < loads[target]) target = i;
    shards[target].push(item.file);
    loads[target] += item.weight;
  }
  return keepEmpty ? shards : shards.filter((shard) => shard.length > 0);
}

/** Parses `K/N` (shard K of N, 1-based). Anything else, or an index outside 1..N, is an error, never a default. */
export function parseShardSpec(spec) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(spec));
  if (!match) throw new RangeError(`malformed shard spec ${JSON.stringify(spec)}: expected K/N, for example 3/4`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total > MAX_SHARDS) throw new RangeError(`shard spec ${spec}: at most ${MAX_SHARDS} shards are supported`);
  if (index > total) throw new RangeError(`shard spec ${spec}: index ${index} is out of range 1..${total}`);
  return { index, total };
}

/** The files of shard `index` of `total`. Over index 1..total the results are disjoint and cover every file once. */
export function selectShardFiles(files, { index, total }, sizeOf = defaultSizeOf, durations = loadTestDurations()) {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) throw new RangeError(`shard index ${index} is out of range 1..${total}`);
  return partitionTestFiles(files, total, sizeOf, durations, { keepEmpty: true })[index - 1];
}

/** Largest measurement per file across several `{ file: seconds }` maps; non-positive or non-numeric values are ignored. */
export function mergeDurationMaps(maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [file, seconds] of Object.entries(map)) {
      if (Number.isFinite(seconds) && seconds > 0) merged.set(file, Math.max(merged.get(file) ?? 0, seconds));
    }
  }
  return Object.fromEntries([...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function allShardsPassed(results) {
  return results.length > 0 && results.every((result) => result.code === 0 && !result.error);
}

function runShard(files, index, children, durationsOut) {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _nodeTestContext, NEXUS_TEST_DURATIONS_OUT: _durationsOut, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [runner, ...files], {
      cwd: cli,
      env: { ...parentEnv, NEXUS_TEST_SHARD: String(index + 1), ...(durationsOut ? { NEXUS_TEST_DURATIONS_OUT: durationsOut } : {}) },
      detached: true,
      stdio: "inherit",
    });
    children.add(child);
    child.once("error", (error) => { children.delete(child); resolve({ code: null, error }); });
    child.once("close", (code, signal) => { children.delete(child); resolve({ code: code ?? 1, signal }); });
  });
}

function killShards(children) {
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

function signalShards(children, signal) {
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  }
}

/**
 * Runs `files` in up to `count` concurrent processes on this machine. With `shard: { index, total }` only that shard
 * of the files runs (CI fans the suite out over runners this way); the selected files are then split over the
 * concurrent processes exactly as a whole run is. `NEXUS_TEST_DURATIONS_OUT` receives one merged file: each process
 * writes its own part, because processes sharing the path used to overwrite each other.
 */
export async function runShards(files, { count = 2, durations = loadTestDurations(), shard } = {}) {
  // More than two processes on one machine is untested: the suite's timing-sensitive tests were tuned at two.
  if (count !== 1 && count !== 2) throw new RangeError("CLI test processes per machine must be 1 or 2");
  if (shard) {
    const all = [...new Set(files)];
    files = selectShardFiles(all, shard, undefined, durations);
    console.error(`[test-shard-select ${shard.index}/${shard.total}] files=${files.length} of ${all.length}`);
    if (files.length === 0) {
      console.error(`[test-shard-select ${shard.index}/${shard.total}] selected no test files; refusing to report an empty shard as passed`);
      return 1;
    }
  }
  const shards = partitionTestFiles(files, count, undefined, durations);
  const durationsOut = process.env.NEXUS_TEST_DURATIONS_OUT ? path.resolve(cli, process.env.NEXUS_TEST_DURATIONS_OUT) : null;
  const durationParts = shards.map((_, index) => (durationsOut ? `${durationsOut}.part${index + 1}` : null));
  const children = new Set();
  let interrupted = false;
  let forceKillTimer;
  const onSignal = () => {
    interrupted = true;
    signalShards(children, "SIGTERM");
    forceKillTimer ??= setTimeout(() => killShards(children), 5_000);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const results = await Promise.all(shards.map((shard, index) => {
      const bytes = shard.reduce((total, file) => total + fs.statSync(path.resolve(cli, file)).size, 0);
      const measured = shard.filter((file) => durations[durationKey(file)] > 0).length;
      const basis = measured === shard.length ? "duration" : measured > 0 ? "mixed" : "size";
      console.error(`[test-shard ${index + 1}/${shards.length}] files=${shard.length} source_bytes=${bytes} measured=${measured}/${shard.length} basis=${basis}`);
      return runShard(shard, index, children, durationParts[index]);
    }));
    if (durationsOut) {
      const parts = durationParts.filter((part) => fs.existsSync(part));
      const measured = mergeDurationMaps(parts.map((part) => JSON.parse(fs.readFileSync(part, "utf8"))));
      fs.mkdirSync(path.dirname(durationsOut), { recursive: true });
      fs.writeFileSync(durationsOut, `${JSON.stringify(measured, null, 2)}\n`);
      for (const part of parts) fs.rmSync(part, { force: true });
      console.error(`[test-durations] merged ${Object.keys(measured).length} measured files from ${parts.length} processes into ${durationsOut}`);
    }
    if (interrupted) return 1;
    return allShardsPassed(results) ? 0 : 1;
  } finally {
    clearTimeout(forceKillTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Usage: test_shards.mjs [--shard=K/N] [test files...]. No arguments runs the whole suite, as `npm test` does.
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const named = args.filter((arg) => !arg.startsWith("--"));
  let shard;
  try {
    for (const flag of flags) {
      if (!flag.startsWith("--shard=") || shard) throw new RangeError(`unsupported or repeated argument ${flag}; usage: test_shards.mjs [--shard=K/N] [test files...]`);
      shard = parseShardSpec(flag.slice("--shard=".length));
    }
  } catch (error) {
    console.error(`test_shards: ${error.message}`);
    process.exit(2);
  }
  const code = await runShards(named.length > 0 ? named : listCliTestFiles(), { shard });
  process.exit(code);
}
