import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTestSuite, runVerifierShell, discoverVerifier } from "../src/tester.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cs4-"));
}

const LINES = ["; touch pwned", "$(touch pwned)", "`touch pwned`", "\ntouch pwned", "&& touch pwned", "| touch pwned"];

test("a metacharacter filter on a workspace verifier is rejected before any shell runs", () => {
  for (const line of LINES) {
    const root = tmp();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    assert.throws(() => discoverVerifier(root, `foo ${line}`), /unsafe characters/);
    assert.throws(() => runTestSuite(root, `foo ${line}`), /unsafe characters/);
    assert.equal(fs.existsSync(path.join(root, "pwned")), false, line);
  }
});

test("quoted metacharacters in an approved line stay inert and nothing else runs", () => {
  const root = tmp();
  for (const line of LINES) {
    const r = runVerifierShell(`printf '%s' '${line}' > out`, root, 10_000);
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(path.join(root, "out"), "utf-8"), line);
    assert.equal(fs.existsSync(path.join(root, "pwned")), false, line);
  }
});

test("the verifier shell child does not see the parent's secrets", () => {
  const root = tmp();
  process.env.CS4_CANARY_SECRET = "canary-value";
  process.env.OPENAI_API_KEY = "sk-canary";
  try {
    const r = runVerifierShell(`echo "[$CS4_CANARY_SECRET][$OPENAI_API_KEY]"; env`, root, 10_000);
    assert.equal(r.success, true);
    assert.match(r.output, /\[\]\[\]/);
    assert.equal(r.output.includes("canary-value"), false);
    assert.equal(r.output.includes("sk-canary"), false);
    assert.match(r.output, /^PATH=/m);
  } finally {
    delete process.env.CS4_CANARY_SECRET;
    delete process.env.OPENAI_API_KEY;
  }
});

test("runTestSuite runs the discovered verifier with a scrubbed environment", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "Makefile"), 'test:\n\t@echo "canary=[$$CS4_CANARY_SECRET]"\n');
  process.env.CS4_CANARY_SECRET = "canary-value";
  try {
    const r = runTestSuite(root);
    assert.equal(r.command, "make test");
    assert.equal(r.success, true);
    assert.equal(r.rawOutput.includes("canary-value"), false);
    assert.match(r.rawOutput, /canary=\[\]/);
  } finally {
    delete process.env.CS4_CANARY_SECRET;
  }
});

test("a failing verifier reports failure and a hung one is killed at the deadline", () => {
  const root = tmp();
  assert.equal(runVerifierShell("exit 3", root, 10_000).success, false);
  const started = Date.now();
  const r = runVerifierShell("sleep 30; echo done", root, 500);
  assert.equal(r.success, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test("no src file runs a command string through a shell except the pinned sites", () => {
  const src = path.resolve(import.meta.dirname, "../src");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        fs.readFileSync(p, "utf-8").split("\n").forEach((l, i) => {
          if (/\bexecSync\(|\bexec\(|shell:\s*true|"(?:ba)?sh",\s*\["-c"/.test(l) && !/\.exec\(|^\s*(\/\/|\*)/.test(l)) hits.push(`${path.relative(src, p)}:${l.trim()}`);
        });
      }
    }
  };
  walk(src);
  assert.deepEqual(hits.sort(), [
    'ceri/runner.ts:const commit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();',
    'ceri/runner.ts:const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();',
    "clipboard.ts:const output = execSync(cmd, {",
    'tester.ts:const ran = spawnSync("bash", ["-c", command], {',
  ]);
});
