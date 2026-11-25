import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findDurationFiles, mergeDurationManifest, readDurationFile } from "../scripts/merge_test_durations.mjs";

const script = path.resolve(import.meta.dirname, "../scripts/merge_test_durations.mjs");

test("the manifest takes the largest new measurement, keeps unmeasured entries and drops files that no longer exist", () => {
  const { manifest, stats } = mergeDurationManifest({
    measured: [{ "test/a.test.ts": 4, "test/b.test.ts": 9 }, { "test/a.test.ts": 6, "test/gone.test.ts": 3 }],
    existing: { "test/a.test.ts": 100, "test/c.test.ts": 2, "test/old.test.ts": 1 },
    known: ["test/c.test.ts", "test/a.test.ts", "test/b.test.ts", "test/d.test.ts"],
  });
  assert.deepEqual(manifest, { "test/a.test.ts": 6, "test/b.test.ts": 9, "test/c.test.ts": 2 });
  assert.deepEqual(Object.keys(manifest), ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
  assert.deepEqual(stats, { measured: 2, kept: 1, unmeasured: 1, dropped: 2 });
});

test("downloaded artifact directories are searched for test-durations files, and the command rewrites only the named manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-merge-durations-"));
  try {
    const leg = (name: string, data: unknown) => {
      fs.mkdirSync(path.join(root, "artifacts", name), { recursive: true });
      fs.writeFileSync(path.join(root, "artifacts", name, "test-durations.json"), typeof data === "string" ? data : JSON.stringify(data));
      fs.writeFileSync(path.join(root, "artifacts", name, "suite.log"), "not json");
    };
    leg("test-shard-node22-1of4", { "test/test_shards.test.ts": 3.5, "test/protocol.test.ts": 0.1 });
    leg("test-shard-node24-1of4", { "test/test_shards.test.ts": 2.5, "test/not_a_real_file.test.ts": 7 });
    assert.deepEqual(findDurationFiles([path.join(root, "artifacts")]).map((file) => path.relative(root, file)), [
      path.join("artifacts", "test-shard-node22-1of4", "test-durations.json"),
      path.join("artifacts", "test-shard-node24-1of4", "test-durations.json"),
    ]);
    const out = path.join(root, "manifest.json");
    fs.writeFileSync(out, JSON.stringify({ "test/security.test.ts": 0.3, "test/removed_long_ago.test.ts": 5 }));
    const merged = spawnSync(process.execPath, [script, path.join(root, "artifacts"), "--out", out], { encoding: "utf8" });
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stderr, /2 inputs .* measured=2 kept=1 unmeasured=\d+ dropped=2/);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), { "test/protocol.test.ts": 0.1, "test/security.test.ts": 0.3, "test/test_shards.test.ts": 3.5 });

    const before = fs.readFileSync(out, "utf8");
    leg("test-shard-node24-2of4", "{truncated");
    const malformed = spawnSync(process.execPath, [script, path.join(root, "artifacts"), "--out", out], { encoding: "utf8" });
    assert.equal(malformed.status, 1, "a malformed input fails instead of being skipped");
    assert.equal(fs.readFileSync(out, "utf8"), before, "the manifest is untouched after a failure");
    assert.throws(() => readDurationFile(path.join(root, "artifacts", "test-shard-node24-2of4", "test-durations.json")));
    fs.writeFileSync(path.join(root, "bad.json"), JSON.stringify({ "test/a.test.ts": "slow" }));
    assert.throws(() => readDurationFile(path.join(root, "bad.json")), /non-numeric or negative/);

    fs.mkdirSync(path.join(root, "empty"));
    assert.equal(spawnSync(process.execPath, [script, path.join(root, "empty"), "--out", out], { encoding: "utf8" }).status, 1, "no input file is an error");
    assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 64, "no argument prints the usage");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
