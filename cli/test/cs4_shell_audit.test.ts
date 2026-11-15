import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTestSuite, runVerifierShell, discoverVerifier, buildVerifierEnvironment } from "../src/tester.js";
import { OperationGit } from "../src/core/operation_git.js";
import { loadEnvironment } from "../src/config.js";

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

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("toolchain variables pass by default; credentials, secrets and NEXUS_* do not", () => {
  withEnv({ CARGO_HOME: "/c", VIRTUAL_ENV: "/v", GOPATH: "/g", UV_CACHE_DIR: "/u", CI: "1", OPENAI_API_KEY: "sk-x", CS4_CANARY_SECRET: "s", UV_TOKEN: "t", NEXUS_EVAL_TEST_RUNTIME_ROOT: "/n", NEXUS_VERIFIER_ENV_PASSTHROUGH: undefined }, () => {
    const root = tmp();
    const r = runVerifierShell('echo "$CARGO_HOME|$VIRTUAL_ENV|$GOPATH|$UV_CACHE_DIR|$CI|$OPENAI_API_KEY|$CS4_CANARY_SECRET|$UV_TOKEN|$NEXUS_EVAL_TEST_RUNTIME_ROOT"', root, 10_000);
    assert.equal(r.output.trim(), "/c|/v|/g|/u|1||||");
  });
});

test("NEXUS_VERIFIER_ENV_PASSTHROUGH opts names and prefixes in", () => {
  withEnv({ NEXUS_EVAL_TEST_WORKSPACE_ROOT: "/w", NEXUS_EVAL_TEST_RUNTIME_ROOT: "/r", ANSIBLE_CONFIG: "/a", NEXUS_VERIFIER_ENV_PASSTHROUGH: "NEXUS_EVAL_TEST_*, ANSIBLE_CONFIG" }, () => {
    const env = buildVerifierEnvironment();
    assert.equal(env.NEXUS_EVAL_TEST_WORKSPACE_ROOT, "/w");
    assert.equal(env.NEXUS_EVAL_TEST_RUNTIME_ROOT, "/r");
    assert.equal(env.ANSIBLE_CONFIG, "/a");
  });
});

test("NEXUS_VERIFIER_ENV_PASSTHROUGH set only in a project .env is ignored", () => {
  const project = tmp();
  fs.writeFileSync(path.join(project, ".env"), "NEXUS_VERIFIER_ENV_PASSTHROUGH=CS4_PROJECT_CANARY\n");
  const cwd = process.cwd();
  withEnv({ NEXUS_VERIFIER_ENV_PASSTHROUGH: undefined, CS4_PROJECT_CANARY: "leak" }, () => {
    process.chdir(project);
    try {
      loadEnvironment();
      assert.equal(buildVerifierEnvironment().CS4_PROJECT_CANARY, undefined);
    } finally {
      process.chdir(cwd);
      delete process.env.NEXUS_VERIFIER_ENV_PASSTHROUGH;
    }
  });
});

test("workspace node_modules/.bin on PATH still resolves", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/.bin/cs4tool"), "#!/bin/sh\necho tool-ran\n", { mode: 0o755 });
  withEnv({ PATH: `${root}/node_modules/.bin:${process.env.PATH}` }, () => {
    const r = runVerifierShell("cs4tool", root, 10_000);
    assert.equal(r.success, true);
    assert.match(r.output, /tool-ran/);
  });
});

test("a failing verifier reports failure; exit status is returned", () => {
  const root = tmp();
  const r = runVerifierShell("exit 3", root, 10_000);
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 3);
});

test("a hung verifier is killed at the deadline together with its background children", () => {
  const root = tmp();
  const marker = path.join(root, "alive");
  const started = Date.now();
  const r = runVerifierShell(`(sleep 1.5; touch ${marker}) & sleep 30; echo done`, root, 500);
  assert.equal(r.success, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
  const until = Date.now() + 2500;
  while (Date.now() < until) { /* give an orphan the chance to run */ }
  assert.equal(fs.existsSync(marker), false);
});

test("exit 127 on runTestSuite names the scrub and the passthrough setting", { skip: fs.existsSync("/usr/bin/cargo") || fs.existsSync("/bin/cargo") }, () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname=\"x\"\n");
  withEnv({ NEXUS_EVAL_TEST_ROOT: "/x", PATH: "/usr/bin:/bin" }, () => {
    const r = runTestSuite(root);
    assert.equal(r.success, false);
    assert.match(r.rawOutput, /NEXUS_VERIFIER_ENV_PASSTHROUGH/);
    assert.match(r.rawOutput, /NEXUS_EVAL_TEST_ROOT/);
    assert.equal(r.rawOutput.includes("/x"), false);
  });
});

test("verifyMerged maps 126/127 to an environment failure and 1 to a candidate failure", () => {
  const root = tmp();
  const ops: any = new OperationGit({ integrationWorktree: root, baseDir: root } as any, {} as any);
  const missing = ops.verifyMerged("cs4-no-such-tool");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /could not run on the merged tree \(exit 127\)/);
  assert.match(missing.reason, /NEXUS_VERIFIER_ENV_PASSTHROUGH/);
  const failed = ops.verifyMerged("exit 1");
  assert.match(failed.reason, /integration verification failed on the merged tree/);
  assert.equal(ops.verifyMerged("true").ok, true);
});

test("output beyond the capture limit keeps the last bytes and says so", () => {
  const root = tmp();
  const r = runVerifierShell("head -c 6000000 /dev/zero | tr '\\0' x; echo; echo SUMMARY-LINE", root, 30_000);
  assert.equal(r.success, true);
  assert.equal(r.truncated, true);
  assert.match(r.output, /output truncated/);
  assert.match(r.output.trimEnd(), /SUMMARY-LINE$/);
});

test("the only shell-string call sites in src are the helper and two constant-command sites", () => {
  const src = path.resolve(import.meta.dirname, "../src");
  const sites = new Map<string, number>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        const code = fs.readFileSync(p, "utf-8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
        const count = (code.match(/(?<![.\w])execSync\(|(?<![.\w])exec\(|shell:\s*true|["'](?:ba)?sh["'],\s*\[\s*["']-c["']/g) ?? []).length;
        if (count) sites.set(path.relative(src, p), count);
      }
    }
  };
  walk(src);
  assert.deepEqual([...sites.entries()].sort(), [["ceri/runner.ts", 2], ["clipboard.ts", 1]]);
  assert.equal((fs.readFileSync(path.join(src, "tester.ts"), "utf-8").match(/"-c", command/g) ?? []).length, 2);
  const runner = fs.readFileSync(path.join(src, "ceri/runner.ts"), "utf-8");
  for (const m of runner.matchAll(/execSync\(([^,)]*)/g)) assert.match(m[1], /^"[^"$`]*"$/, "ceri/runner.ts execSync takes a constant string");
});
