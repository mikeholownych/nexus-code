// Run one trusted GNU find inventory per canonical system root. These roots are
// independent, and parallel traversal avoids serially timing out on large images.
import { spawn } from "node:child_process";

const FIND = "/usr/bin/find";
const MAX_OUTPUT = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const COMPILER_NAMES = [
  "go", "go[0-9]*", "go-[0-9]*",
  "rustc", "rustc[0-9]*", "rustc-[0-9]*",
  "cargo", "cargo[0-9]*", "cargo-[0-9]*",
  "rustup",
];

function findArgs(root) {
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
    "-P", root,
    "(", "(", "-type", "l", "(", ...nameExpression, "-o", ...linkTargetExpression, ")", ")",
    "-o",
    "(", "(", ...nameExpression, ")", "-a", "-type", "f", "-a", "-perm", "/111", ")",
    ")", "-print0",
  ];
}

const roots = process.argv.slice(2);
if (roots.length === 0 || roots.length > 16 || roots.some((root) => !root.startsWith("/"))) {
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

function scanRoot(root) {
  return new Promise((resolve) => {
  const child = spawn(FIND, findArgs(root), {
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

let nextRoot = 0;
async function worker() {
  while (!failed && nextRoot < roots.length) {
    const root = roots[nextRoot++];
    await scanRoot(root);
  }
}

await Promise.all(Array.from({ length: Math.min(4, roots.length) }, () => worker()));
clearTimeout(deadline);
clearTimeout(killTimer);
if (failed) {
  process.stderr.write("trusted compiler inventory could not complete\n");
  process.exitCode = 1;
} else {
  process.stdout.write(Buffer.concat(outputs.flat(), outputBytes));
}
