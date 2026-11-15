import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dirname, "..", "..", "scripts", "check_doc_versions.mjs");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-docver-home-"));

function tree(over: { readme?: string; changelog?: string; latest?: string; pkg?: string; quickstart?: string; guide?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-docver-"));
  fs.mkdirSync(path.join(dir, "docs", "releases"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/releases/LATEST"), over.latest ?? "v1.1.4\n");
  fs.writeFileSync(path.join(dir, "docs/releases/v1.1.4.md"), "# v1.1.4\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: over.pkg ?? "1.2.0-rc.1" }));
  fs.writeFileSync(path.join(dir, "README.md"), over.readme ??
    "> **Status:** the latest stable release is [v1.1.4](x). v1.2.0 is in development.\n```\nNEXUS_VERSION=v1.1.4 sh\nNEXUS_VERSION=v1.2.0-rc.1 sh\n```\n");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), over.changelog ??
    "## [v1.2.0] - Unreleased\n\n## [v1.1.4] - 2026-11-14\n\n## [v1.1.3] - 2026-11-05\n");
  if (over.quickstart !== undefined) fs.writeFileSync(path.join(dir, "quickstart.md"), over.quickstart);
  if (over.guide !== undefined) fs.writeFileSync(path.join(dir, "docs/GUIDE.md"), over.guide);
  return dir;
}
const run = (dir: string) => spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8", env: { ...process.env, HOME: home } });

test("consistent tree passes; an unreleased newer version may say Unreleased", () => {
  const r = run(tree());
  assert.equal(r.status, 0, r.stderr);
});

test("a stale latest-stable line in README fails", () => {
  const r = run(tree({ readme: "latest stable release is [v1.1.3](x). v1.1.4 is in development.\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names v1\.1\.3 as the latest stable/);
  assert.match(r.stderr, /v1\.1\.4 is in development but v1\.1\.4 is released/);
});

test("a stale install pin fails but an rc pin is allowed", () => {
  const r = run(tree({ readme: "latest stable release is [v1.1.4](x)\nNEXUS_VERSION=v1.1.3 sh\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /install pin NEXUS_VERSION=v1\.1\.3/);
});

test("a released version whose CHANGELOG heading says Unreleased fails", () => {
  const r = run(tree({ changelog: "## [v1.1.4] - Unreleased\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /heading \[v1\.1\.4\] says Unreleased/);
});

test("LATEST must be a stable tag with a release file and not newer than the package", () => {
  assert.equal(run(tree({ latest: "v1.1.4-rc.1\n" })).status, 1);
  const r = run(tree({ pkg: "1.1.3" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /newer than package\.json/);
});

test("README without a latest stable status line fails", () => {
  const r = run(tree({ readme: "NEXUS_VERSION=v1.1.4 sh\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no 'latest stable release is' status line/);
});

test("'still in active development' wording for a released version is caught", () => {
  const r = run(tree({ readme: "latest stable release is [v1.1.4](x). v1.1.4 is still in active development.\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /v1\.1\.4 is in development/);
});

test("stale stable pins in quickstart.md and docs/*.md fail; rc pins and docs/releases stay allowed", () => {
  const ok = run(tree({ quickstart: "NEXUS_VERSION=v1.1.4 sh\nNEXUS_VERSION=v1.0.0-rc.1 sh\n", guide: "NEXUS_VERSION=v1.2.0-rc.1 sh\n" }));
  assert.equal(ok.status, 0, ok.stderr);
  const bad = run(tree({ quickstart: "NEXUS_VERSION=v1.0.0 sh\n", guide: "NEXUS_VERSION=v1.1.3 sh\n" }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /quickstart\.md install pin NEXUS_VERSION=v1\.0\.0/);
  assert.match(bad.stderr, /docs\/GUIDE\.md install pin NEXUS_VERSION=v1\.1\.3/);
});
