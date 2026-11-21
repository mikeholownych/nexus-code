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

/**
 * Binary best-fit by measured duration where one exists, source size otherwise. Duration is scaled to
 * "byte-equivalent" weight (1 s = 1000) so the two bases can coexist while a measured file is gradually added.
 */
export function partitionTestFiles(files, count = 2, sizeOf = (file) => fs.statSync(path.resolve(cli, file)).size, durations = loadTestDurations()) {
  if (!Number.isInteger(count) || count < 1 || count > 2) throw new RangeError("CLI test shard count must be 1 or 2");
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
  return shards.filter((shard) => shard.length > 0);
}

export function allShardsPassed(results) {
  return results.length > 0 && results.every((result) => result.code === 0 && !result.error);
}

function runShard(files, index, children) {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _nodeTestContext, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [runner, ...files], {
      cwd: cli,
      env: { ...parentEnv, NEXUS_TEST_SHARD: String(index + 1) },
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

export async function runShards(files, { count = 2, durations = loadTestDurations() } = {}) {
  const shards = partitionTestFiles(files, count, undefined, durations);
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
      const bytes = shard.reduce((total, file) => total + fs.statSync(file).size, 0);
      const measured = shard.filter((file) => durations[durationKey(file)] > 0).length;
      const basis = measured === shard.length ? "duration" : measured > 0 ? "mixed" : "size";
      console.error(`[test-shard ${index + 1}/${shards.length}] files=${shard.length} source_bytes=${bytes} measured=${measured}/${shard.length} basis=${basis}`);
      return runShard(shard, index, children);
    }));
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
  const files = process.argv.length > 2 ? process.argv.slice(2) : listCliTestFiles();
  const code = await runShards(files);
  process.exit(code);
}
