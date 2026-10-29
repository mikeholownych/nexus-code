// Run trusted GNU find inventories across canonical system roots. Large roots are
// split at their immediate children so a broad directory cannot monopolize a worker.
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import path from "node:path";

const FIND = "/usr/bin/find";
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_ENUMERATION_OUTPUT = 64 * 1024 * 1024;
// This is a hard fail-closed bound. Keep the full inventory within it by letting GNU
// find optimize the cheap name predicates ahead of filesystem metadata checks.
const TIMEOUT_MS = 25_000;
const MAX_ENTRIES = 500_000;
const MAX_JOBS = 100_000;
// Bundle enough sibling directories to avoid spawning one `find` process for
// every pair on large hosted system roots, while keeping independent jobs for
// bounded parallel scanning.
const DIRECTORY_BATCH_SIZE = 64;
const DIRECT_ENTRY_BATCH_SIZE = 256;
const SCAN_WORKERS = 8;
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
    "-O3", "-P", ...roots,
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
  let enumerationBytes = 0;
  for (const root of roots) {
    const child = spawn(FIND, ["-P", root, "-mindepth", "1", "-maxdepth", "2", "-printf", "%d\\0%y\\0%p\\0"], {
      env: { HOME: "/nonexistent", LANG: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stderrBytes = 0;
    let spawnError = null;
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      failed = true;
      stopAll();
    });
    child.on("error", (error) => {
      spawnError = error;
      failed = true;
      stopAll();
    });
    const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    let scanDirectories = [];
    let directEntries = [];
    let entryDepth = null;
    let entryType = null;
    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout) {
        enumerationBytes += chunk.length;
        if (enumerationBytes > MAX_ENUMERATION_OUTPUT) {
          failed = true;
          stopAll();
          throw new Error("compiler inventory enumeration output limit exceeded");
        }
        const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        while (true) {
          const delimiter = data.indexOf(0, offset);
          if (delimiter < 0) break;
          const field = data.subarray(offset, delimiter);
          offset = delimiter + 1;
          if (entryDepth === null) {
            if (field.length !== 1 || field[0] < 0x31 || field[0] > 0x32) {
              throw new Error("invalid compiler inventory entry depth");
            }
            entryDepth = field[0] - 0x30;
            continue;
          }
          if (entryType === null) {
            if (field.length !== 1) throw new Error("invalid compiler inventory entry type");
            entryType = field.toString("ascii");
            continue;
          }
          if (++entryCount > MAX_ENTRIES) {
            failed = true;
            stopAll();
            throw new Error("compiler inventory entry limit exceeded");
          }
          const item = field.toString("utf8");
          if (!Buffer.from(item, "utf8").equals(field)) {
            throw new Error("compiler inventory path is not valid UTF-8");
          }
          let job;
          // Enumerate two levels before scheduling recursive scans. This splits large
          // immediate subtrees into independent jobs without following symlinked dirs.
          if (entryType === "d" && entryDepth === 2) {
            scanDirectories.push(item);
            if (scanDirectories.length === DIRECTORY_BATCH_SIZE) {
              job = scanDirectories;
              scanDirectories = [];
            }
          } else {
            if (entryType !== "d") {
              directEntries.push(item);
              if (directEntries.length === DIRECT_ENTRY_BATCH_SIZE) {
                job = directEntries;
                directEntries = [];
              }
            }
          }
          entryDepth = null;
          entryType = null;
          if (job) {
            if (++jobCount > MAX_JOBS) {
              failed = true;
              stopAll();
              throw new Error("compiler inventory job limit exceeded");
            }
            yield job;
          }
        }
        pending = data.subarray(offset);
      }
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      const code = await closed;
      children.delete(child);
      if (spawnError || code !== 0 || stderrBytes !== 0 || entryDepth !== null || entryType !== null || pending.length !== 0) {
        failed = true;
        stopAll();
      }
    }
    if (failed) throw new Error("compiler inventory enumeration failed");
    for (const remaining of [scanDirectories, directEntries]) {
      if (remaining.length) {
        if (++jobCount > MAX_JOBS) throw new Error("compiler inventory job limit exceeded");
        yield remaining;
      }
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

await Promise.all(Array.from({ length: SCAN_WORKERS }, () => worker()));
clearTimeout(deadline);
clearTimeout(killTimer);
if (failed) {
  process.stderr.write("trusted compiler inventory could not complete\n");
  process.exitCode = 1;
} else {
  const output = Buffer.concat(outputs.flat(), outputBytes);
  if (!isUtf8(output)) {
    process.stderr.write("trusted compiler inventory paths are not valid UTF-8\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(output);
  }
}
