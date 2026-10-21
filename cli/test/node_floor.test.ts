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

test("package engines, doctor, upgrade preflight and installer state the same Node.js floor", () => {
  const engines = JSON.parse(read("cli/package.json")).engines?.node;
  assert.equal(engines, `>=${FLOOR}`);
  const lockRoot = JSON.parse(read("cli/package-lock.json")).packages?.[""]?.engines?.node;
  assert.equal(lockRoot, `>=${FLOOR}`);
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
