// Run trusted GNU find inventories across canonical system roots. Large roots are
// split at their immediate children so a broad directory cannot monopolize a worker.
import { opendir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const FIND = "/usr/bin/find";
const MAX_OUTPUT = 64 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const MAX_ENTRIES = 500_000;
const MAX_JOBS = 100_000;
const DIRECT_ENTRY_BATCH_SIZE = 256;
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

async function* enumerateJobs() {
  let entryCount = 0;
  let jobCount = 0;
  for (const root of roots) {
    const directory = await opendir(root);
    let directEntries = [];
    for await (const entry of directory) {
      if (++entryCount > MAX_ENTRIES) throw new Error("compiler inventory entry limit exceeded");
      const item = path.join(root, entry.name);
      // Never follow symlinked directories. GNU find receives symlinks as starting
      // points under -P and checks their names and link targets without traversal.
      let job;
      if (entry.isDirectory()) {
        job = [item];
      } else {
        directEntries.push(item);
        if (directEntries.length === DIRECT_ENTRY_BATCH_SIZE) {
          job = directEntries;
          directEntries = [];
        }
      }
      if (job) {
        if (++jobCount > MAX_JOBS) throw new Error("compiler inventory job limit exceeded");
        yield job;
      }
    }
    if (directEntries.length) {
      if (++jobCount > MAX_JOBS) throw new Error("compiler inventory job limit exceeded");
      yield directEntries;
    }
  }
}

const jobs = enumerateJobs();

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
  void jobs.return().catch(() => {});
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

async function worker() {
  while (!failed) {
    try {
      const next = await jobs.next();
      if (failed || next.done) return;
      await scanRoots(next.value);
    } catch {
      failed = true;
      stopAll();
      return;
    }
  }
}

await Promise.all(Array.from({ length: 4 }, () => worker()));
clearTimeout(deadline);
clearTimeout(killTimer);
if (failed) {
  process.stderr.write("trusted compiler inventory could not complete\n");
  process.exitCode = 1;
} else {
  process.stdout.write(Buffer.concat(outputs.flat(), outputBytes));
}
