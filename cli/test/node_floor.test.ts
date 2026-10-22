import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node.js 20 is past upstream end of life; the supported floor is 22. Every
// place that states or enforces the floor must agree, and the installer must
// refuse an end-of-life runtime before it touches the network.
const FLOOR = 22;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

function runInstallerWithNodeMajor(major: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-node-floor-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // A fake node that reports only the requested major; curl is deliberately absent so
    // a runtime that passes the Node gate stops at the next prerequisite, never at the network.
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' ${major}\n`, { mode: 0o755 });
    const uname = ["/usr/bin/uname", "/bin/uname"].find((candidate) => fs.existsSync(candidate));
    assert.ok(uname, "uname must be available");
    fs.symlinkSync(uname, path.join(bin, "uname"));
    return spawnSync("/bin/sh", [path.join(root, "install.sh")], {
      encoding: "utf8",
      env: { PATH: bin, HOME: path.join(dir, "home") },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("installer rejects end-of-life Node.js 20 before any download", () => {
  const result = runInstallerWithNodeMajor(20);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 22 or newer is required/);
});

test("installer accepts Node.js 22 at the runtime gate", () => {
  const result = runInstallerWithNodeMajor(FLOOR);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /Node\.js \d+ or newer is required/);
  assert.match(result.stderr, /curl is required/);
});

test("release requirements and plan agree on the supported Node.js floor", () => {
  const spec = read("docs/v1.0.0/specs/SPEC-07-supply-chain-and-release-engineering.md");
  const plan = read("docs/v1.0.0/plans/PLAN-07-supply-chain-and-release-engineering.md");
  const requirement = spec.split("\n").find((line) => line.includes("REQ-REL-111."));
  const acceptance = spec.split("\n").find((line) => line.startsWith("| ACC-SUP-05 |"));
  const engineTask = plan.split("\n").find((line) => line.startsWith("| 1 |"));
  const matrixTask = plan.split("\n").find((line) => line.startsWith("| 6 |"));
  assert.ok(requirement, "SPEC-07 REQ-REL-111 exists");
  assert.ok(acceptance, "SPEC-07 ACC-SUP-05 exists");
  assert.ok(engineTask, "PLAN-07 engine task exists");
  assert.ok(matrixTask, "PLAN-07 matrix task exists");
  assert.match(requirement, /"node": ">=22"/);
  assert.doesNotMatch(requirement, /">=20"/);
  assert.match(acceptance, /Node 22 and 24/);
  assert.match(acceptance, /packaging use Node 22/);
  assert.doesNotMatch(acceptance, /Node 20/);
  assert.match(engineTask, /"node": ">=22"/);
  assert.match(matrixTask, /Node 22\/24/);
  assert.match(matrixTask, /builds use Node 22/);
  assert.doesNotMatch(matrixTask, /Node 20/);
});

test("package engines, doctor, upgrade preflight and installer state the same Node.js floor", () => {
  for (const manifest of ["package.json", "cli/package.json"]) {
    assert.equal(JSON.parse(read(manifest)).engines?.node, `>=${FLOOR}`, `${manifest} engines`);
  }
  // npm records root engines in the lockfile only when it regenerates it; if present it must agree.
  const lockRoot = JSON.parse(read("cli/package-lock.json")).packages?.[""]?.engines?.node;
  if (lockRoot !== undefined) assert.equal(lockRoot, `>=${FLOOR}`);
  assert.match(read("install.sh"), new RegExp(`"\\$NODE_MAJOR" -ge ${FLOOR} \\]`));
  assert.match(read("cli/src/doctor.ts"), new RegExp(`major >= ${FLOOR} \\? "pass"`));
  assert.match(read("cli/src/upgrade.ts"), new RegExp(`nodeMajor < ${FLOOR}\\)`));
});

test("CI, release and reproducibility workflows never run below the Node.js floor", () => {
  for (const workflow of ["ci.yml", "release.yml", "repro.yml"]) {
    const text = read(path.join(".github/workflows", workflow));
    const versions = [
      ...[...text.matchAll(/node-version:\s*(\d+)/g)].map((match) => Number(match[1])),
      ...[...text.matchAll(/node:\s*\[([^\]]*)\]/g)].flatMap((match) => match[1].split(",").map((value) => Number(value.trim()))),
    ];
    for (const version of versions) assert.ok(version >= FLOOR, `${workflow} uses Node.js ${version}`);
  }
});

test("v1.0.0 release notes never present an end-of-life Node.js floor as promotable", () => {
  // rc.1 is published history; later notes that still describe a Node 20 build must say it cannot become v1.0.0.
  const releases = path.join(root, "docs/releases");
  for (const name of fs.readdirSync(releases).filter((file) => /^v1\.0\.0.*\.md$/.test(file) && file !== "v1.0.0-rc.1.md")) {
    const text = fs.readFileSync(path.join(releases, name), "utf8");
    if (/Node\.js 20 or newer/.test(text)) assert.match(text, /not promotable/, `${name} presents Node.js 20 as supported`);
  }
});
