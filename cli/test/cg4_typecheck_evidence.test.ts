import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { classifyTypecheck, discoverTypecheck, parseExecution, parseTypecheckDiagnostics, runTypecheck, typecheckMode, DiscoveredTypecheck } from "../src/tester.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

const TSC_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "typescript", "bin", "tsc");
const NODE_VERIFIER = "env -u NODE_TEST_CONTEXT node --test test/*.test.js";

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, extra: Partial<HarnessConfig> = {}): HarnessConfig => ({
  trustedDeliverableFiles: ["math.js"],
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  ...extra,
});
const write = (name: string, content: string): Reply => ({
  kind: "tools",
  calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }],
});
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2020", module: "commonjs", types: [] }, include: ["*.ts"] });
const PKG = JSON.stringify({ name: "x", version: "1.0.0", private: true, scripts: { test: NODE_VERIFIER } });
const ADD_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';
const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const TYPES_OK = "export const n: number = 1;\n";
const TYPES_BAD = 'export const n: number = "one";\n';
const fix = write("math.js", ADD_FIXED);

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-"));
  for (const [name, content] of Object.entries({ "package.json": PKG, "test/math.test.js": ADD_TEST, "math.js": ADD_BUGGY, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: root, stdio: "ignore" });
  return root;
}

interface Opts {
  steps?: Reply[];
  /** "tsc" puts the real compiler on PATH; "none" leaves a PATH with only the basics, so tsc cannot resolve. */
  path?: "tsc" | "none";
  env?: Record<string, string>;
  config?: Partial<HarnessConfig>;
}

async function withAgent<T>(files: Record<string, string>, opts: Opts, body: (agent: AutonomousAgent, root: string) => Promise<T>): Promise<T> {
  const root = repo(files);
  const steps = opts.steps ?? [fix, done];
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, NEXUS_TYPECHECK: process.env.NEXUS_TYPECHECK };
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-bin-"));
  const link = (name: string, target: string) => fs.symlinkSync(target, path.join(toolDir, name));
  if (opts.path === "tsc") {
    link("tsc", TSC_BIN);
    process.env.PATH = `${toolDir}:${saved.PATH}`;
  } else if (opts.path === "none") {
    link("node", process.execPath);
    for (const tool of ["env", "bash", "sh", "git", "dirname", "ls", "cat"]) {
      const found = execSync(`command -v ${tool}`, { shell: "/bin/sh" }).toString().trim();
      if (found) link(tool, found);
    }
    process.env.PATH = toolDir;
  }
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-home-"));
  delete process.env.NEXUS_TYPECHECK;
  Object.assign(process.env, opts.env ?? {});
  const gw = await startGateway((n) => steps[n - 1] ?? { kind: "text", content: "done" });
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, opts.config)));
  try {
    return await body(agent, root);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(process.env.HOME!, { recursive: true, force: true });
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.NEXUS_TYPECHECK === undefined) delete process.env.NEXUS_TYPECHECK;
    else process.env.NEXUS_TYPECHECK = saved.NEXUS_TYPECHECK;
    fs.rmSync(toolDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const run = (files: Record<string, string>, opts: Opts = {}) =>
  withAgent(files, { path: "tsc", ...opts }, async (agent, root) => {
    const turn = await agent.runTurn("npm test fails; fix math.js.");
    const dirty = execSync("git status --porcelain --untracked-files=all", { cwd: root }).toString().split("\n").filter(Boolean).map((l) => l.slice(3));
    return { turn, dirty, ledger: (agent as any).objective?.verification as Array<{ command: string; status: string; classification?: string; exitCode?: number; failingTests?: string[]; excerpt?: string }> | undefined };
  });

const unitCheck: DiscoveredTypecheck = { tool: "tsc", probe: "tsc --version", command: "tsc --noEmit", configPath: "tsconfig.json", configSha256: "" };
const envelope = (exit: number | null, stdout = "", extra: object = {}) => async () => ({ success: true, output: JSON.stringify({ exit_code: exit, stdout, stderr: "", ...extra }) });
const scripted = (probe: ReturnType<typeof envelope>, check: ReturnType<typeof envelope>) => {
  const calls: Array<{ command: string; timeout: number }> = [];
  return { calls, exec: async (command: string, timeout: number) => (calls.push({ command, timeout }), command.includes("--version") ? probe() : check()) };
};

describe("type-check as verifier evidence: agent level", () => {
  test("an error the candidate introduced in a modified file blocks and names the configuration", { timeout: 120_000 }, async () => {
    const { turn, dirty } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK }, { steps: [fix, write("types.ts", TYPES_BAD), done] });
    assert.notEqual(turn.outcome, "VERIFIED");
    assert.equal(turn.verification?.status, "FAILED");
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "FAILED");
    assert.equal(tc?.enforced, true);
    assert.equal(tc?.configPath, "tsconfig.json");
    assert.equal(tc?.configSha256, createHash("sha256").update(TSCONFIG).digest("hex"));
    assert.match(tc?.toolVersion ?? "", /^Version \d+\.\d+/);
    assert.match(tc?.toolSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(tc?.excerpt ?? "", /^\(untrusted compiler output\)\n[\s\S]*TS2322/);
    assert.equal(tc?.scope, "under tsconfig.json");
    assert.deepEqual(dirty.sort(), ["math.js", "types.ts"], "the check wrote nothing into the workspace");
  });

  test("an error that was already there in an untouched file is PREEXISTING, recorded, and does not block", { timeout: 120_000 }, async () => {
    const { turn, dirty } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK, "legacy.ts": TYPES_BAD });
    assert.equal(turn.outcome, "VERIFIED");
    const tc = turn.verification?.typecheck;
    assert.equal(tc?.status, "PREEXISTING");
    assert.equal(tc?.errorCount, 1);
    assert.match(tc?.firstDiagnostics?.[0] ?? "", /legacy\.ts/);
    assert.deepEqual(dirty, ["math.js"]);
  });

  test("a clean project passes, recorded under its tsconfig", { timeout: 120_000 }, async () => {
    const { turn } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK });
    assert.equal(turn.outcome, "VERIFIED");
    assert.equal(turn.verification?.typecheck?.status, "PASSED");
    assert.equal(turn.verification?.typecheck?.scope, "under tsconfig.json");
    assert.doesNotMatch(JSON.stringify(turn.verification?.typecheck), /everywhere|universal/i);
  });

  test("no tsconfig: not applicable, outcome unchanged", { timeout: 120_000 }, async () => {
    const { turn } = await run({});
    assert.equal(turn.outcome, "VERIFIED");
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
  });

  test("solution-style tsconfig is not applicable and the bad file does not block", { timeout: 120_000 }, async () => {
    const solution = JSON.stringify({ files: [], references: [{ path: "./src" }] });
    const { turn } = await run({ "tsconfig.json": solution, "types.ts": TYPES_OK }, { steps: [fix, write("types.ts", TYPES_BAD), done] });
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.outcome, "REGRESSION_FREE");
  });

  test("NEXUS_TYPECHECK=off disables the check", { timeout: 120_000 }, async () => {
    const { turn } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK }, { steps: [fix, write("types.ts", TYPES_BAD), done], env: { NEXUS_TYPECHECK: "off" } });
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.outcome, "REGRESSION_FREE");
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
    assert.match(turn.verification?.typecheck?.scope ?? "", /disabled/);
  });

  test("the HarnessConfig typecheck setting disables the check", { timeout: 120_000 }, async () => {
    const { turn } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK }, { steps: [fix, write("types.ts", TYPES_BAD), done], config: { typecheck: "off" } });
    assert.equal(turn.verification?.typecheck?.status, "NOT_APPLICABLE");
  });

  test("an operator-configured verifier makes the check record-only unless NEXUS_TYPECHECK=enforce", { timeout: 120_000 }, async () => {
    const bad = { "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK };
    const steps = [fix, write("types.ts", TYPES_BAD), done];
    const config = { authoritativeVerifierCommand: NODE_VERIFIER };
    const record = await run(bad, { steps, config });
    assert.equal(record.turn.verification?.typecheck?.status, "FAILED");
    assert.equal(record.turn.verification?.typecheck?.enforced, false);
    assert.equal(record.turn.verification?.status, "PASSED");
    assert.equal(record.turn.outcome, "REGRESSION_FREE");
    const enforce = await run(bad, { steps, config, env: { NEXUS_TYPECHECK: "enforce" } });
    assert.equal(enforce.turn.verification?.typecheck?.enforced, true);
    assert.equal(enforce.turn.verification?.status, "FAILED");
    assert.notEqual(enforce.turn.outcome, "VERIFIED");
  });

  test("tsc not installed is ENVIRONMENT, recorded, not a candidate failure (PATH without tsc)", { timeout: 120_000 }, async () => {
    const { turn, ledger } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK }, { path: "none", steps: [fix, write("types.ts", TYPES_BAD), done], config: { authoritativeVerifierCommand: NODE_VERIFIER }, env: { NEXUS_TYPECHECK: "enforce" } });
    assert.equal(turn.verification?.typecheck?.status, "ENVIRONMENT");
    assert.equal(turn.verification?.status, "PASSED");
    assert.ok(!ledger?.some((a) => /tsc/.test(a.command)), "an ENVIRONMENT type-check is not recorded as an attempt");
    assert.equal(turn.verification?.status, "PASSED");
    assert.equal(turn.outcome, "REGRESSION_FREE");
  });

  test("an unchanged failing type-check is not rerun: the skip names the typecheck command and keeps its evidence", { timeout: 120_000 }, async () => {
    const steps = [fix, write("types.ts", TYPES_BAD), done, done];
    const { turn, ledger } = await run({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK }, { steps });
    const skipped = ledger?.filter((a) => a.status === "SKIPPED_UNCHANGED_INPUTS") ?? [];
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].command, /tsc --noEmit/);
    assert.equal(ledger?.filter((a) => /tsc --noEmit/.test(a.command) && a.status === "FAILED").length, 1);
    const failed = ledger?.find((a) => /tsc --noEmit/.test(a.command) && a.status === "FAILED");
    assert.equal(failed?.classification, "CANDIDATE_FAILED");
    assert.notEqual(failed?.exitCode, 0);
    assert.match(failed?.failingTests?.[0] ?? "", /types\.ts.*TS2322/);
    assert.match(failed?.excerpt ?? "", /TS2322/);
    assert.equal(turn.verification?.typecheck?.status, "FAILED");
    assert.notEqual(turn.outcome, "VERIFIED");
  });

  test("approval denied blocks in enforce mode and is not run; record mode just does not run", { timeout: 60_000 }, async () => {
    const files = { "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK };
    await withAgent(files, { path: "tsc" }, async (agent) => {
      let executed = 0;
      (agent as any).ensureVerifierApproved = async () => false;
      (agent as any).bridge.executeTool = async () => (executed++, { success: true, output: "{}" });
      const enforced = await (agent as any).runTypecheckOracle({ budgetSecs: 30, configured: false });
      assert.match(enforced.block, /not approved/);
      assert.equal(enforced.evidence.status, "NOT_APPLICABLE");
      const record = await (agent as any).runTypecheckOracle({ budgetSecs: 30, configured: true });
      assert.equal(record.block, undefined);
      assert.equal(executed, 0);
    });
  });

  test("the excerpt is redacted, fenced as untrusted, and carries no raw control characters", { timeout: 60_000 }, async () => {
    const files = { "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK };
    await withAgent(files, { path: "tsc" }, async (agent, root) => {
      (agent as any).modifiedFiles.add(path.join(root, "types.ts"));
      (agent as any).ensureVerifierApproved = async () => true;
      const secret = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8".repeat(4);
      (agent as any).bridge.executeTool = async (_t: string, args: { command: string }) =>
        args.command.includes("--version")
          ? { success: true, output: JSON.stringify({ exit_code: 0, stdout: "Version 5.0.0\n", stderr: "" }) }
          : { success: true, output: JSON.stringify({ exit_code: 2, stdout: `types.ts(1,1): error TS2322: bad ${secret} \u001b[31mred\u001b]0;title\u0007\n`, stderr: "" }) };
      const { evidence, block } = await (agent as any).runTypecheckOracle({ budgetSecs: 30, configured: false });
      assert.equal(evidence.status, "FAILED");
      for (const text of [evidence.excerpt, block]) {
        assert.ok(text.startsWith("Verification Oracle") || text.startsWith("(untrusted compiler output)"));
        assert.doesNotMatch(text, /A1b2C3d4E5f6G7h8/);
        assert.doesNotMatch(text, /[\u001b\u0007]/);
      }
      assert.match(evidence.excerpt, /^\(untrusted compiler output\)\n/);
    });
  });

  test("a requirement-tagged attempt of the same command is not a prior task type-check", { timeout: 60_000 }, async () => {
    await withAgent({ "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK }, { path: "tsc" }, async (agent) => {
      const check = discoverTypecheck((agent as any).config.workspace)!;
      const current = { inputs: "i", epoch: "e", mutationSeq: 1, external: "x" };
      (agent as any).objective = { verification: [{ n: 1, at: "t", command: check.command, ...current, status: "FAILED", requirementId: "R1" }] };
      (agent as any).lastTypecheck = { status: "FAILED", command: check.command, at: "t" };
      (agent as any).ensureVerifierApproved = async () => true;
      let executed = 0;
      (agent as any).bridge.executeTool = async () => (executed++, { success: true, output: JSON.stringify({ exit_code: 0, stdout: "Version 5.0.0\n", stderr: "" }) });
      const { evidence, block } = await (agent as any).runTypecheckOracle({ current, budgetSecs: 30, configured: false });
      assert.equal(block, undefined);
      assert.equal(evidence.status, "PASSED");
      assert.equal(executed, 2);
    });
  });

  test("the approval digest binds the resolved tool", { timeout: 60_000 }, async () => {
    const files = { "tsconfig.json": TSCONFIG, "types.ts": TYPES_OK };
    await withAgent(files, { path: "tsc", config: { approvalMode: "ask", fullAccess: false } }, async (agent) => {
      const digests: string[] = [];
      for (const binding of ["a", "b"]) {
        await (agent as any).ensureVerifierApproved("tsc --noEmit", async (_kind: string, info: { digest: string }) => (digests.push(info.digest), true), undefined, binding);
        (agent as any).approvedVerifiers.clear();
      }
      if (digests.length === 2) assert.notEqual(digests[0], digests[1]);
      else assert.equal(digests.length, 0, "approval policy did not ask in this mode");
    });
  });
});

describe("type-check as verifier evidence: units", () => {
  test("discovery prefers ./node_modules/.bin/tsc and records its hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-disc-"));
    try {
      fs.mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules/.bin/tsc"), "#!/bin/sh\necho stub\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
      const found = discoverTypecheck(dir);
      assert.equal(found?.probe, "./node_modules/.bin/tsc --version");
      assert.equal(found?.command, "./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.json");
      assert.equal(found?.toolSha256, createHash("sha256").update("#!/bin/sh\necho stub\n").digest("hex"));
      assert.equal(found?.skipReason, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovery: composite and references are skipped; cargo is offline, locked and outside the workspace; none", () => {
    const mk = (files: Record<string, string>) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-disc-"));
      for (const [n, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
        fs.writeFileSync(path.join(d, n), c);
      }
      return d;
    };
    const dirs = [mk({}), mk({ "Cargo.toml": "[package]\n" }), mk({ "core/Cargo.toml": "[package]\n" }), mk({ "tsconfig.json": '{ "compilerOptions": { "composite": true } }' }), mk({ "tsconfig.json": '// c\n{ "references": [] }' })];
    try {
      assert.equal(discoverTypecheck(dirs[0]), null);
      const root = discoverTypecheck(dirs[1]);
      assert.equal(root?.tool, "cargo");
      assert.match(root?.command ?? "", /^CARGO_TARGET_DIR='[^']+' cargo check --offline --locked$/);
      assert.ok(!root!.command.includes(dirs[1]), "target dir is not inside the workspace");
      assert.ok(root!.command.includes(os.tmpdir()));
      assert.equal(root?.probe, "cargo --version");
      assert.match(discoverTypecheck(dirs[2])!.command, /cargo check --offline --locked --manifest-path core\/Cargo\.toml$/);
      assert.equal(discoverTypecheck(dirs[2])?.configPath, "core/Cargo.toml");
      assert.ok(discoverTypecheck(dirs[3])?.skipReason);
      assert.ok(discoverTypecheck(dirs[4])?.skipReason);
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("diagnostic parsing: tsc both formats, cargo arrows, unlocated errors", () => {
    const d = parseTypecheckDiagnostics(
      [
        "src/a.ts(3,5): error TS2322: bad",
        "src/b.ts:7:9 - error TS2345: worse",
        "error TS5058: The specified path does not exist",
        "warning: unused variable",
        "  --> src/ignored.rs:1:1",
        "error[E0308]: mismatched types",
        "  --> src/lib.rs:10:5",
      ].join("\n"),
    );
    assert.deepEqual(d.files.sort(), ["src/a.ts", "src/b.ts", "src/lib.rs"]);
    assert.deepEqual(d.unlocatedCodes, ["TS5058"]);
    assert.equal(d.errorCount, 4);
  });

  test("classification: modified file blocks, untouched is PREEXISTING, unlocated is ENVIRONMENT", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cg4-cls-"));
    try {
      const out = "src/a.ts(3,5): error TS2322: bad";
      assert.equal(classifyTypecheck(unitCheck, out, ws, new Set([path.join(ws, "src/a.ts")])).status, "FAILED");
      assert.equal(classifyTypecheck(unitCheck, out, ws, new Set([path.join(ws, "src/other.ts")])).status, "PREEXISTING");
      assert.equal(classifyTypecheck(unitCheck, out, ws, new Set()).status, "PREEXISTING");
      assert.equal(classifyTypecheck(unitCheck, "error TS5083: Cannot read file", ws, new Set()).status, "ENVIRONMENT");
      const cargo = { tool: "cargo" as const, configPath: "core/Cargo.toml" };
      const rustErr = "error[E0308]: mismatched types\n  --> src/lib.rs:10:5";
      assert.equal(classifyTypecheck(cargo, rustErr, ws, new Set([path.join(ws, "core/src/lib.rs")])).status, "FAILED");
      assert.equal(classifyTypecheck(cargo, rustErr, ws, new Set([path.join(ws, "src/lib.rs")])).status, "FAILED");
      for (const msg of [
        "error: failed to select a version for `serde`.",
        "error: no matching package named `foo` found",
        "error: the lock file /x/Cargo.lock needs to be updated but --locked was passed",
        "error: attempting to make an HTTP request, but --offline was specified",
      ]) assert.equal(classifyTypecheck(cargo, msg, ws, new Set()).status, "ENVIRONMENT", msg);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("runTypecheck: timeout, null/missing exit code, missing tool, executor throw, pass, probe and shared budget", async () => {
    const ws = os.tmpdir();
    const none = new Set<string>();
    const ok = envelope(0, "Version 5.9.3\nsecond line 1.2.3\n");
    assert.equal((await runTypecheck(unitCheck, scripted(ok, envelope(null, "", { timed_out: true })).exec, ws, none, 100)).status, "TIMED_OUT");
    assert.equal((await runTypecheck(unitCheck, scripted(ok, envelope(null)).exec, ws, none, 100)).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(unitCheck, scripted(ok, async () => ({ success: true, output: "not an envelope" })).exec, ws, none, 100)).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(unitCheck, scripted(ok, async () => ({ success: false, output: "", error: "bridge down" })).exec, ws, none, 100)).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(unitCheck, scripted(envelope(127), envelope(0)).exec, ws, none, 100)).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(unitCheck, scripted(ok, envelope(127)).exec, ws, none, 100)).status, "ENVIRONMENT");
    assert.equal((await runTypecheck(unitCheck, async () => { throw new Error("boom"); }, ws, none, 100)).status, "ENVIRONMENT");
    const s = scripted(ok, envelope(0));
    const pass = await runTypecheck(unitCheck, s.exec, ws, none, 100);
    assert.equal(pass.status, "PASSED");
    assert.equal(pass.version, "Version 5.9.3");
    assert.deepEqual(s.calls.map((c) => c.command), ["tsc --version", "tsc --noEmit"]);
    assert.equal(s.calls[1].timeout, 100);
    assert.ok(s.calls[0].timeout <= 30);
  });

  test("parseExecution unwraps the envelope and treats anything else as unknown", () => {
    assert.deepEqual(parseExecution({ success: true, output: JSON.stringify({ exit_code: 0, stdout: "a", stderr: "b" }) }), { succeeded: true, timedOut: false, exitCode: 0, rawOutput: "a\nb" });
    assert.equal(parseExecution({ success: true, output: JSON.stringify({ exit_code: null, timed_out: true }) }).timedOut, true);
    assert.equal(parseExecution({ success: true, output: "plain" }).succeeded, false);
    assert.equal(parseExecution({ success: true, output: "plain" }).exitCode, undefined);
  });

  test("typecheckMode: env overrides config; a configured verifier defaults to record", () => {
    const saved = process.env.NEXUS_TYPECHECK;
    try {
      delete process.env.NEXUS_TYPECHECK;
      assert.equal(typecheckMode(undefined, false), "enforce");
      assert.equal(typecheckMode(undefined, true), "record");
      assert.equal(typecheckMode("off", true), "off");
      process.env.NEXUS_TYPECHECK = "off";
      assert.equal(typecheckMode("enforce", false), "off");
      process.env.NEXUS_TYPECHECK = "enforce";
      assert.equal(typecheckMode(undefined, true), "enforce");
    } finally {
      if (saved === undefined) delete process.env.NEXUS_TYPECHECK;
      else process.env.NEXUS_TYPECHECK = saved;
    }
  });
});
