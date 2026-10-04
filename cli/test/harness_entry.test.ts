import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness.sh");

interface Checkout {
  root: string;
  node: string;
  calls(): string[];
}

/** A copy of harness.sh in a fake checkout whose node and nexus-tui only record how they were called. */
function fakeCheckout(withTui: boolean): Checkout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-entry-")));
  fs.copyFileSync(harness, path.join(root, "harness.sh"));
  fs.mkdirSync(path.join(root, "cli", "dist"), { recursive: true });
  const log = path.join(root, "calls.log");
  const recorder = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n`;
  const node = path.join(root, "fake-node");
  fs.writeFileSync(node, recorder, { mode: 0o755 });
  if (withTui) {
    fs.mkdirSync(path.join(root, "core", "target", "release"), { recursive: true });
    fs.writeFileSync(path.join(root, "core", "target", "release", "nexus-tui"), recorder, { mode: 0o755 });
  }
  return { root, node, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n") : []) };
}

function env(checkout: Checkout): NodeJS.ProcessEnv {
  return { ...process.env, HOME: checkout.root, NODE_EXEC: checkout.node };
}

/** Runs harness.sh with a pseudo-terminal on stdin and stdout (util-linux `script`), like an operator's shell. */
function inTerminal(checkout: Checkout, args: string[]) {
  const command = ["bash", path.join(checkout.root, "harness.sh"), ...args].map((a) => `'${a}'`).join(" ");
  return spawnSync("script", ["-qec", command, "/dev/null"], { env: env(checkout), encoding: "utf-8", input: "" });
}

/** Runs harness.sh with pipes, like a script or CI job. */
function piped(checkout: Checkout, args: string[]) {
  return spawnSync("bash", [path.join(checkout.root, "harness.sh"), ...args], { env: env(checkout), encoding: "utf-8", input: "" });
}

describe("harness.sh entry", () => {
  test("no arguments in a terminal open the live TUI", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(inTerminal(c, []).status, 0);
      assert.deepEqual(c.calls(), [`nexus-tui --live --sidecar ${c.root}/cli/dist/sidecar.js --node ${c.node} --`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("no arguments without a terminal run the REPL", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(piped(c, []).status, 0);
      assert.deepEqual(c.calls(), [`fake-node ${c.root}/cli/dist/index.js repl`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("an unbuilt TUI falls back to the REPL and says why", () => {
    const c = fakeCheckout(false);
    try {
      const run = inTerminal(c, []);
      assert.equal(run.status, 0);
      assert.match(run.stdout, /the live TUI is not built/);
      assert.deepEqual(c.calls(), [`fake-node ${c.root}/cli/dist/index.js repl`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("--repl keeps the readline REPL with its options", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(inTerminal(c, ["--repl", "-m", "x"]).status, 0);
      assert.deepEqual(c.calls(), [`fake-node ${c.root}/cli/dist/index.js repl -m x`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });

  test("--live passes sidecar options after one separator", () => {
    const c = fakeCheckout(true);
    try {
      assert.equal(inTerminal(c, ["--live", "--approve"]).status, 0);
      assert.deepEqual(c.calls(), [`nexus-tui --live --sidecar ${c.root}/cli/dist/sidecar.js --node ${c.node} -- --approve`]);
    } finally {
      fs.rmSync(c.root, { recursive: true, force: true });
    }
  });
});
