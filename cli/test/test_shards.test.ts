import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allShardsPassed, durationKey, loadTestDurations, partitionTestFiles, runShards } from "../scripts/test_shards.mjs";

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
  assert.throws(() => partitionTestFiles(files, 3), /count must be 1 or 2/);
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
    assert.equal(await runShards(files), 0);
    const observed = fs.readdirSync(markers);
    assert.deepEqual(observed.slice().sort(), ["four.test.ts", "one.test.ts", "three.test.ts", "two.test.ts"]);
    const homes = new Set(observed.map((file) => fs.readFileSync(path.join(markers, file), "utf8")));
    assert.equal(homes.size, 2, "each shard receives its own HOME");
    assert.ok([...homes].every((home) => home.startsWith(os.tmpdir())));

    fs.rmSync(markers, { recursive: true, force: true });
    fs.mkdirSync(markers);
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
