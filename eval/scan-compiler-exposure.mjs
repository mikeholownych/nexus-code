// Run one trusted GNU find inventory per canonical system root. These roots are
// independent. Large roots are split at their immediate children so a single
// broad directory cannot monopolize one worker and exceed the inventory deadline.
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const FIND = "/usr/bin/find";
const MAX_OUTPUT = 64 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const COMPILER_NAMES = [
  "go", "go[0-9]*", "go-[0-9]*",
  "rustc", "rustc[0-9]*", "rustc-[0-9]*",
  "cargo", "cargo[0-9]*", "cargo-[0-9]*",
  "rustup",
];

function findArgs(roots) {
  const nameExpression = COMPILER_NAMES.flatMap((name, index) => index === 0
    ? ["-name", name]
    : ["-o", "-name", name]);
  const linkTargetExpression = COMPILER_NAMES.flatMap((name, index) => {
    const patterns = [name, `*/${name}`];
    return patterns.flatMap((pattern, patternIndex) => index === 0 && patternIndex === 0
      ? ["-lname", pattern]
      : ["-o", "-lname", pattern]);
  });
  return [
    "-P", ...roots,
    "(", "(", "-type", "l", "(", ...nameExpression, "-o", ...linkTargetExpression, ")", ")",
    "-o",
    "(", "(", ...nameExpression, ")", "-a", "-type", "f", "-a", "-perm", "/111", ")",
    ")", "-print0",
  ];
}

const roots = process.argv.slice(2);
if (roots.length === 0 || roots.length > 128 || roots.some((root) => !root.startsWith("/"))) {
  process.stderr.write("compiler inventory roots must be absolute\n");
  process.exit(2);
}

const children = new Set();
const outputs = [];
let outputBytes = 0;
let failed = false;
let killTimer;
let stopping = false;

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  killTimer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 1_000);
  killTimer.unref();
}

process.on("SIGTERM", () => {
  failed = true;
  stopAll();
});
process.on("SIGINT", () => {
  failed = true;
  stopAll();
});

const deadline = setTimeout(() => {
  failed = true;
  stopAll();
}, TIMEOUT_MS);

function scanRoots(roots) {
  return new Promise((resolve) => {
    const child = spawn(FIND, findArgs(roots), {
      env: { HOME: "/nonexistent", LANG: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const stdout = [];
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) {
        failed = true;
        stopAll();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      failed = true;
      stopAll();
    });
    child.on("error", () => {
      failed = true;
      stopAll();
    });
    child.on("close", (code) => {
      children.delete(child);
      if (code !== 0 || stderrBytes !== 0) {
        failed = true;
        stopAll();
      }
      outputs.push(stdout);
      resolve();
    });
  });
}

const jobs = [];
let entryCount = 0;
for (const root of roots) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    failed = true;
    stopAll();
    break;
  }
  const directEntries = [];
  for (const entry of entries) {
    if (++entryCount > 500_000) {
      failed = true;
      stopAll();
      break;
    }
    const item = path.join(root, entry.name);
    // Never follow symlinked directories. GNU find receives symlinks as starting
    // points under -P and checks their names and link targets without traversal.
    if (entry.isDirectory()) jobs.push([item]);
    else directEntries.push(item);
  }
  for (let offset = 0; offset < directEntries.length; offset += 256) {
    jobs.push(directEntries.slice(offset, offset + 256));
  }
  if (failed || jobs.length > 100_000) {
    failed = true;
    stopAll();
    break;
  }
}

let nextJob = 0;
async function worker() {
  while (!failed && nextJob < jobs.length) {
    const job = jobs[nextJob++];
    await scanRoots(job);
  }
}

await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, () => worker()));
clearTimeout(deadline);
clearTimeout(killTimer);
if (failed) {
  process.stderr.write("trusted compiler inventory could not complete\n");
  process.exitCode = 1;
} else {
  process.stdout.write(Buffer.concat(outputs.flat(), outputBytes));
}
