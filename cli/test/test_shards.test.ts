import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { MAX_SHARDS, allShardsPassed, durationKey, listCliTestFiles, loadTestDurations, mergeDurationMaps, parseShardSpec, partitionTestFiles, runShards, selectShardFiles } from "../scripts/test_shards.mjs";

test("CLI test sharding assigns every file once and keeps shared evaluator mount tests together", () => {
  const files = [
    "test/a.test.ts",
    "test/b.test.ts",
    "test/eval_integrity.test.ts",
    "test/eval_version_probe_storage.test.ts",
    "test/evaluator_cgroup_limits.test.ts",
    "test/c.test.ts",
  ];
  const sizes = new Map(files.map((file, i) => [file, (i + 1) * 100]));
  const shards = partitionTestFiles(files, 2, (file) => sizes.get(file)!);
  assert.equal(shards.length, 2);
  assert.deepEqual(shards.flat().slice().sort(), files.slice().sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  for (const file of files.filter((name) => name.includes("eval_") || name.includes("evaluator_cgroup"))) {
    assert.ok(shards[0].includes(file), `${file} shares the evaluator fixture shard`);
  }
  for (const count of [0, 1.5, MAX_SHARDS + 1, Number.NaN]) {
    assert.throws(() => partitionTestFiles(files, count, (file) => sizes.get(file)!), /count must be an integer from 1 to 16/);
  }
});

test("shard K of N covers every file exactly once for N = 1, 2, 4 and 8, whatever the input order", () => {
  const files = Array.from({ length: 41 }, (_, i) => `test/f${String(i).padStart(2, "0")}.test.ts`)
    .concat(["test/eval_integrity.test.ts", "test/eval_version_probe_storage.test.ts", "test/evaluator_cgroup_limits.test.ts"]);
  const sizeOf = (file: string) => 100 + (file.length * 7919 + file.charCodeAt(6) * 104729) % 9000;
  const durations = { "test/f03.test.ts": 40, "test/f17.test.ts": 0.5 };
  for (const total of [1, 2, 4, 8]) {
    const shards = Array.from({ length: total }, (_, i) => selectShardFiles(files, { index: i + 1, total }, sizeOf, durations));
    assert.deepEqual(shards.flat().slice().sort(), files.slice().sort(), `union of ${total} shards is the whole list`);
    assert.equal(new Set(shards.flat()).size, shards.flat().length, `${total} shards are pairwise disjoint`);
    assert.ok(shards.every((shard) => shard.length > 0), `none of ${total} shards is empty`);
    for (const pinned of files.slice(-3)) assert.ok(shards[0].includes(pinned), `${pinned} stays on shard 1 of ${total}`);
    const reordered = Array.from({ length: total }, (_, i) => selectShardFiles([...files].reverse().concat(files[0]), { index: i + 1, total }, sizeOf, durations));
    assert.deepEqual(reordered, shards, "selection depends on the set of files, not on their order or on duplicates");
  }
  // Fewer files than shards: the surplus indexes are empty slots, never a renumbering of the others.
  const few = ["test/a.test.ts", "test/b.test.ts"];
  const slots = Array.from({ length: 4 }, (_, i) => selectShardFiles(few, { index: i + 1, total: 4 }, () => 10, {}));
  assert.deepEqual(slots.flat().slice().sort(), few);
  assert.equal(slots.filter((slot) => slot.length === 0).length, 2);
});

test("the real suite file list is covered exactly once by 4 and by 8 shards", () => {
  const files = listCliTestFiles();
  assert.ok(files.length > 100, "the real list is the whole suite");
  for (const total of [4, 8]) {
    const shards = Array.from({ length: total }, (_, i) => selectShardFiles(files, { index: i + 1, total }));
    assert.equal(shards.flat().length, files.length, `${total} shards hold as many entries as there are files`);
    assert.deepEqual(new Set(shards.flat()), new Set(files), `${total} shards hold every file`);
    assert.ok(shards.every((shard) => shard.length > 0));
  }
});

test("a shard spec is K/N with 1 <= K <= N <= 16 and anything else is an error", () => {
  assert.deepEqual(parseShardSpec("3/4"), { index: 3, total: 4 });
  assert.deepEqual(parseShardSpec("8/8"), { index: 8, total: 8 });
  assert.throws(() => parseShardSpec("5/4"), /index 5 is out of range 1\.\.4/);
  assert.throws(() => parseShardSpec("1/17"), /at most 16 shards/);
  for (const bad of ["0/4", "4", "1/0", "-1/4", "1/4/2", "a/b", "1.5/4", " 1/4", "", "01/4x"]) {
    assert.throws(() => parseShardSpec(bad), /malformed shard spec/, `${JSON.stringify(bad)} is rejected`);
  }
  assert.throws(() => selectShardFiles(["test/a.test.ts"], { index: 0, total: 2 }, () => 1, {}), /out of range/);
  assert.throws(() => selectShardFiles(["test/a.test.ts"], { index: 3, total: 2 }, () => 1, {}), /out of range/);
  const script = path.resolve(import.meta.dirname, "../scripts/test_shards.mjs");
  for (const [args, message] of [[["--shard=9/8"], /out of range/], [["--shard=x"], /malformed shard spec/], [["--shards=1/2"], /unsupported or repeated argument/], [["--shard=1/2", "--shard=2/2"], /unsupported or repeated argument/]] as const) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")} exits 2 before running any test`);
    assert.match(result.stderr, message);
  }
});

test("mergeDurationMaps keeps the largest positive measurement per file in sorted order", () => {
  assert.deepEqual(mergeDurationMaps([{ "test/b.test.ts": 2, "test/a.test.ts": 1 }, { "test/b.test.ts": 1.5, "test/a.test.ts": 3, "test/c.test.ts": 0 }]), { "test/a.test.ts": 3, "test/b.test.ts": 2 });
  assert.deepEqual(Object.keys(mergeDurationMaps([{ "test/b.test.ts": 2 }, { "test/a.test.ts": 1 }])), ["test/a.test.ts", "test/b.test.ts"]);
});

test("both CLI shards execute every file once with separate throwaway homes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-shards-"));
  const fixtureDir = path.join(root, "fixtures");
  const markers = path.join(root, "markers");
  fs.mkdirSync(fixtureDir);
  fs.mkdirSync(markers);
  fs.writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({ type: "module" }));
  for (const name of ["one", "two", "three", "four"].map((n) => `${n}.test.ts`)) {
    fs.writeFileSync(path.join(fixtureDir, name), `
      import { test } from "node:test";
      import * as fs from "node:fs";
      import * as path from "node:path";
      test("record shard execution", () => {
        fs.writeFileSync(path.join(process.env.NEXUS_SHARD_MARKERS!, path.basename(new URL(import.meta.url).pathname)), process.env.HOME!);
        if (process.env.NEXUS_SHARD_TEST_FAIL) throw new Error("intentional shard failure");
      });
    `);
  }

  const previous = process.env.NEXUS_SHARD_MARKERS;
  const previousFailure = process.env.NEXUS_SHARD_TEST_FAIL;
  process.env.NEXUS_SHARD_MARKERS = markers;
  try {
    const files = fs.readdirSync(fixtureDir).filter((file) => file.endsWith(".test.ts")).map((file) => path.join(fixtureDir, file));
    const durationsOut = path.join(root, "out", "test-durations.json");
    const previousDurationsOut = process.env.NEXUS_TEST_DURATIONS_OUT;
    process.env.NEXUS_TEST_DURATIONS_OUT = durationsOut;
    try {
      assert.equal(await runShards(files), 0);
    } finally {
      if (previousDurationsOut === undefined) delete process.env.NEXUS_TEST_DURATIONS_OUT;
      else process.env.NEXUS_TEST_DURATIONS_OUT = previousDurationsOut;
    }
    const measured = JSON.parse(fs.readFileSync(durationsOut, "utf8"));
    assert.equal(Object.keys(measured).length, 4, "both concurrent processes' durations land in the one output file");
    assert.ok(Object.values(measured).every((seconds) => typeof seconds === "number" && seconds >= 0));
    assert.deepEqual(fs.readdirSync(path.dirname(durationsOut)), ["test-durations.json"], "the per-process parts are removed");
    const observed = fs.readdirSync(markers);
    assert.deepEqual(observed.slice().sort(), ["four.test.ts", "one.test.ts", "three.test.ts", "two.test.ts"]);
    const homes = new Set(observed.map((file) => fs.readFileSync(path.join(markers, file), "utf8")));
    assert.equal(homes.size, 2, "each shard receives its own HOME");
    assert.ok([...homes].every((home) => home.startsWith(os.tmpdir())));

    // Shard selection: each of the two shards runs only its own files, together they run every file once,
    // and an index past the last shard is refused instead of passing with nothing run.
    const ran: string[][] = [];
    for (const index of [1, 2]) {
      fs.rmSync(markers, { recursive: true, force: true });
      fs.mkdirSync(markers);
      assert.equal(await runShards(files, { shard: { index, total: 2 } }), 0);
      ran.push(fs.readdirSync(markers).sort());
      assert.deepEqual(ran[index - 1], selectShardFiles(files, { index, total: 2 }).map((file: string) => path.basename(file)).sort());
    }
    assert.deepEqual(ran.flat().sort(), ["four.test.ts", "one.test.ts", "three.test.ts", "two.test.ts"]);
    fs.rmSync(markers, { recursive: true, force: true });
    fs.mkdirSync(markers);
    assert.equal(await runShards(files.slice(0, 1), { shard: { index: 2, total: 2 } }), 1, "a shard that selects no file fails");
    assert.deepEqual(fs.readdirSync(markers), []);
    await assert.rejects(runShards(files, { count: 3 }), /processes per machine must be 1 or 2/);
    await assert.rejects(runShards(files, { shard: { index: 3, total: 2 } }), /out of range/);

    process.env.NEXUS_SHARD_TEST_FAIL = "1";
    assert.equal(await runShards(files), 1, "failure in both shards is aggregated as a failed suite");
    assert.deepEqual(fs.readdirSync(markers).slice().sort(), ["four.test.ts", "one.test.ts", "three.test.ts", "two.test.ts"], "the other shard is allowed to finish and report its failures");
  } finally {
    if (previous === undefined) delete process.env.NEXUS_SHARD_MARKERS;
    else process.env.NEXUS_SHARD_MARKERS = previous;
    if (previousFailure === undefined) delete process.env.NEXUS_SHARD_TEST_FAIL;
    else process.env.NEXUS_SHARD_TEST_FAIL = previousFailure;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a single failed shard fails the aggregate result", () => {
  assert.equal(allShardsPassed([{ code: 0 }, { code: 0 }]), true);
  assert.equal(allShardsPassed([{ code: 0 }, { code: 1 }]), false);
  assert.equal(allShardsPassed([{ code: 0 }, { code: null }]), false);
});

test("measured durations take precedence over file size when balancing shards", () => {
  const files = ["test/small_but_slow.test.ts", "test/large_but_fast.test.ts", "test/unmeasured.test.ts"];
  // Size alone puts the large file first; a 240 s measurement must move the slow file onto the other shard.
  const sizes = new Map(files.map((file) => [file, file.includes("large") ? 90_000 : 100]));
  const bySize = partitionTestFiles(files, 2, (file) => sizes.get(file)!, {});
  assert.ok(bySize[0].includes("test/large_but_fast.test.ts"));
  const durations = { "test/small_but_slow.test.ts": 240, "test/large_but_fast.test.ts": 2 };
  const byDuration = partitionTestFiles(files, 2, (file) => sizes.get(file)!, durations);
  assert.deepEqual(byDuration.flat().slice().sort(), files.slice().sort(), "every file is still assigned exactly once");
  assert.ok(byDuration[0].includes("test/small_but_slow.test.ts"), "the slowest measured file anchors the first shard");
  assert.ok(byDuration[1].includes("test/large_but_fast.test.ts"), "a fast measured file must not anchor a shard");
});

test("durationKey and loadTestDurations accept POSIX paths and ignore malformed manifests", () => {
  assert.equal(durationKey("test/a.test.ts"), "test/a.test.ts");
  assert.equal(durationKey("/work/cli/test/a.test.ts", "/work/cli"), "test/a.test.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-durations-"));
  const manifest = path.join(root, "durations.json");
  try {
    fs.writeFileSync(manifest, JSON.stringify({ "test/a.test.ts": 12.5, "test/b.test.ts": -1, "test/c.test.ts": "slow" }));
    const previous = process.env.NEXUS_TEST_DURATIONS;
    process.env.NEXUS_TEST_DURATIONS = manifest;
    try {
      assert.deepEqual(loadTestDurations(), { "test/a.test.ts": 12.5 });
    } finally {
      if (previous === undefined) delete process.env.NEXUS_TEST_DURATIONS;
      else process.env.NEXUS_TEST_DURATIONS = previous;
    }
    fs.writeFileSync(manifest, "{not json");
    process.env.NEXUS_TEST_DURATIONS = manifest;
    try {
      assert.deepEqual(loadTestDurations(), {});
    } finally {
      if (previous === undefined) delete process.env.NEXUS_TEST_DURATIONS;
      else process.env.NEXUS_TEST_DURATIONS = previous;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
