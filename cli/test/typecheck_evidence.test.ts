/**
 * VR-1: src/core/typecheck_evidence.ts, the type-check evidence of a caller without an agent. The table pins which
 * results stop a passing verifier from counting; the parity test runs the agent's own oracle
 * (core/completion_oracle.ts runTypecheckOracleImpl) on the same projects and the same compiler output and requires the
 * same evidence and the same decision. No compiler runs here: the executor is scripted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runTypecheckOracleImpl } from "../src/core/completion_oracle.js";
import {
  TYPECHECK_STATUS_PRIORITY, captureTypecheckBaseline, collectTypecheckEvidence, combineTypecheckEvidence, typecheckNotApplicable, typecheckProjectEvidence,
  typecheckProjectKey, worstTypecheckBlock, type TypecheckBlockKind,
} from "../src/core/typecheck_evidence.js";
import type { TypecheckEvidence } from "../src/core/turn.js";
import { discoverTypechecks, type DiscoveredTypecheck, type TimedExecutor, type TypecheckRun } from "../src/tester.js";
import { makeRepo } from "./helpers/fixtures.js";

const AT = "2026-01-01T00:00:00.000Z";
const CHECK: DiscoveredTypecheck = { tool: "tsc", probe: "tsc --version", command: "tsc --noEmit --incremental false -p tsconfig.json", configPath: "tsconfig.json", configSha256: "c".repeat(64), toolSha256: "t".repeat(64) };
const ran = (status: TypecheckRun["status"], extra: Partial<TypecheckRun> = {}): TypecheckRun => ({ status, exitCode: status === "PASSED" ? 0 : 2, output: "out", ...extra });

test("which type-check results block an enforced check: the table", () => {
  const rows: Array<{ name: string; check?: Partial<DiscoveredTypecheck>; run?: TypecheckRun; status: TypecheckEvidence["status"]; blocks?: TypecheckBlockKind }> = [
    { name: "passed", run: ran("PASSED"), status: "PASSED" },
    { name: "an error in a changed file, or a new one", run: ran("FAILED", { errorCount: 1, firstDiagnostics: ["a.ts(1,1): error TS1: x"] }), status: "FAILED", blocks: "FAILED" },
    { name: "the check hit its deadline", run: ran("TIMED_OUT", { exitCode: null }), status: "TIMED_OUT", blocks: "TIMED_OUT" },
    { name: "the budget was used up before its turn", status: "TIMED_OUT", blocks: "TIMED_OUT" },
    { name: "errors that were already there", run: ran("PREEXISTING", { errorCount: 2 }), status: "PREEXISTING" },
    { name: "output that cannot be attributed", run: ran("ENVIRONMENT"), status: "ENVIRONMENT" },
    { name: "the tool could not be started when probed", run: ran("UNAVAILABLE", { exitCode: 127 }), status: "UNAVAILABLE" },
    { name: "the tool is not installed (known at discovery)", check: { missingTool: true }, status: "UNAVAILABLE", blocks: "UNAVAILABLE" },
    { name: "a configuration this checker cannot run", check: { skipReason: "solution-style" }, status: "NOT_APPLICABLE", blocks: "UNAVAILABLE" },
    { name: "the project scan was cut short", check: { skipReason: "too many projects", discoveryIncomplete: true }, status: "UNAVAILABLE", blocks: "UNAVAILABLE" },
  ];
  for (const row of rows) {
    const check = { ...CHECK, ...row.check };
    const enforced = typecheckProjectEvidence(check, true, { budgetSecs: 60, run: row.run }, AT);
    assert.equal(enforced.evidence.status, row.status, row.name);
    assert.equal(enforced.block?.kind, row.blocks, row.name);
    assert.equal(enforced.evidence.enforced, true, row.name);
    assert.deepEqual([enforced.evidence.tool, enforced.evidence.configPath, enforced.evidence.configSha256, enforced.evidence.toolSha256], ["tsc", "tsconfig.json", CHECK.configSha256, CHECK.toolSha256], row.name);
    // Record-only: the same evidence, and nothing blocks.
    const recorded = typecheckProjectEvidence(check, false, { budgetSecs: 60, run: row.run }, AT);
    assert.equal(recorded.block, undefined, row.name);
    assert.deepEqual({ ...recorded.evidence, enforced: true }, enforced.evidence, row.name);
  }
  // Counts, the baseline size, and an excerpt fenced as untrusted for anything but a pass.
  const failed = typecheckProjectEvidence(CHECK, true, { budgetSecs: 60, run: ran("FAILED", { errorCount: 3, introducedCount: 1, firstDiagnostics: ["a.ts(1,1): error TS1: x\u001b[31m"], version: "Version 5.9.3", output: "a.ts(1,1): error TS1: x" }), baseline: new Set(["a", "b"]) }, AT);
  assert.deepEqual([failed.evidence.errorCount, failed.evidence.introducedCount, failed.evidence.baselineErrorCount, failed.evidence.toolVersion, failed.evidence.scope], [3, 1, 2, "Version 5.9.3", "under tsconfig.json"]);
  assert.match(failed.evidence.excerpt ?? "", /^\(untrusted compiler output\)\n/);
  assert.equal(/\u001b/.test(JSON.stringify(failed.evidence)), false, "no raw control character from the compiler");
  assert.equal("excerpt" in typecheckProjectEvidence(CHECK, true, { budgetSecs: 60, run: ran("PASSED") }, AT).evidence, false);
  assert.match(failed.block?.message ?? "", /tsc type-check failed under tsconfig\.json/);
});

test("the combined record follows the status priority, and the worst block names the reason", () => {
  assert.deepEqual([...TYPECHECK_STATUS_PRIORITY], ["FAILED", "TIMED_OUT", "UNAVAILABLE", "NOT_APPLICABLE", "ENVIRONMENT", "PREEXISTING", "PASSED"]);
  const of = (status: TypecheckEvidence["status"]): TypecheckEvidence => ({ status, scope: `under ${status}`, at: AT });
  for (let i = 0; i < TYPECHECK_STATUS_PRIORITY.length; i++) {
    const lower = TYPECHECK_STATUS_PRIORITY.slice(i).map(of).reverse();
    assert.equal(combineTypecheckEvidence(lower).status, TYPECHECK_STATUS_PRIORITY[i]);
  }
  const one = combineTypecheckEvidence([of("PASSED")]);
  assert.deepEqual([one.scope, one.projects?.length], ["under PASSED", 1]);
  const two = combineTypecheckEvidence([of("PASSED"), of("FAILED")]);
  assert.deepEqual([two.status, two.scope, two.projects?.map((project) => project.status)], ["FAILED", "2 project check(s)", ["PASSED", "FAILED"]]);
  const block = (kind: TypecheckBlockKind) => ({ kind, message: kind });
  assert.equal(worstTypecheckBlock([block("UNAVAILABLE"), block("TIMED_OUT"), block("FAILED")])?.kind, "FAILED");
  assert.equal(worstTypecheckBlock([block("UNAVAILABLE"), block("TIMED_OUT")])?.kind, "TIMED_OUT");
  assert.equal(worstTypecheckBlock([block("UNAVAILABLE")])?.kind, "UNAVAILABLE");
  assert.equal(worstTypecheckBlock([]), undefined);
  assert.deepEqual(typecheckNotApplicable("off", AT), { status: "NOT_APPLICABLE", scope: "disabled by NEXUS_TYPECHECK / typecheck setting", at: AT });
  assert.equal(typecheckNotApplicable("enforce", AT).scope, "no configured type-check project found");
  assert.equal(typecheckProjectKey({ tool: "cargo", configPath: "core/Cargo.toml" }), "cargo\ncore/Cargo.toml");
});

// ---- A scripted compiler: the envelope the tool runner returns, per command ----

type Scripted = { exit: number | null; output?: string; timedOut?: boolean };
const envelope = (reply: Scripted) => ({ success: true, output: JSON.stringify({ exit_code: reply.exit, stdout: reply.output ?? "", stderr: "", timed_out: reply.timedOut === true }) });
/** Answers a `--version` probe with `probe` and a check with the reply for its project directory ("" for the root). */
const scripted = (replies: Record<string, Scripted>, probe: Scripted = { exit: 0, output: "Version 5.9.3" }): TimedExecutor => async (command) => {
  if (command.endsWith("--version")) return envelope(probe);
  const project = command.match(/^cd '([^']+)' && /)?.[1] ?? "";
  return envelope(replies[project] ?? { exit: 0 });
};

test("the baseline: a passing base gives an empty set, located errors give their signatures, anything else gives none", async () => {
  const sub = (name: string): DiscoveredTypecheck => ({ ...CHECK, command: `cd '${name}' && tsc`, configPath: `${name}/tsconfig.json` });
  const { baselines, records } = await captureTypecheckBaseline({
    checks: [sub("clean"), sub("legacy"), sub("broken"), sub("slow"), { ...sub("missing"), missingTool: true }, { ...sub("solution"), skipReason: "solution-style" }],
    execute: scripted({ legacy: { exit: 2, output: "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n" }, broken: { exit: 2, output: "error TS5083: Cannot read file\n" }, slow: { exit: null, timedOut: true } }),
    workspace: os.tmpdir(),
    deadlineSecs: 30,
  });
  assert.deepEqual(records, [
    { tool: "tsc", configPath: "clean/tsconfig.json", status: "PASSED", errorCount: 0 },
    { tool: "tsc", configPath: "legacy/tsconfig.json", status: "PREEXISTING", errorCount: 1 },
    { tool: "tsc", configPath: "broken/tsconfig.json", status: "ENVIRONMENT" },
    { tool: "tsc", configPath: "slow/tsconfig.json", status: "TIMED_OUT" },
    { tool: "tsc", configPath: "missing/tsconfig.json", status: "NOT_RUN" },
    { tool: "tsc", configPath: "solution/tsconfig.json", status: "NOT_RUN" },
  ]);
  assert.deepEqual([...baselines.keys()], ["tsc\nclean/tsconfig.json", "tsc\nlegacy/tsconfig.json"]);
  assert.deepEqual([...baselines.get("tsc\nlegacy/tsconfig.json")!], ["legacy/src/a.ts\nerror TS2322: Type 'string' is not assignable to type 'number'."]);
});

test("a budget that is used up leaves the remaining projects TIMED_OUT without running them", async () => {
  let clock = 0;
  const commands: string[] = [];
  const execute: TimedExecutor = async (command) => {
    commands.push(command);
    if (!command.endsWith("--version")) clock += 61_000;
    return envelope({ exit: 0, output: "Version 5.9.3" });
  };
  const second = { ...CHECK, command: "cd 'b' && tsc", configPath: "b/tsconfig.json" };
  const { evidence, blocks } = await collectTypecheckEvidence({ checks: [CHECK, second], enforced: true, execute, workspace: os.tmpdir(), modified: new Set(), budgetSecs: 60, now: () => clock });
  assert.deepEqual(evidence.projects?.map((project) => project.status), ["PASSED", "TIMED_OUT"]);
  assert.equal(evidence.status, "TIMED_OUT");
  assert.deepEqual(blocks.map((block) => block.kind), ["TIMED_OUT"]);
  assert.deepEqual(commands, [CHECK.probe, CHECK.command], "the second project was never started");
});

// ---- Parity with the agent's oracle ----

const TSCONFIG = JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ["src/*.ts"] });
const LOCAL_TSC = { "node_modules/.bin/tsc": "#!/bin/sh\nexit 0\n" };
const ERROR_IN = (file: string) => `${file}(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n`;

interface Scenario {
  name: string;
  files: Record<string, string>;
  replies?: Record<string, Scripted>;
  probe?: Scripted;
  /** Workspace-relative files the change modified. */
  modified?: string[];
  /** Signatures the base run had, for the root project. */
  baseline?: string[];
  /** A PATH with no tsc on it, so discovery reports the tool missing. */
  noTool?: boolean;
  status: TypecheckEvidence["status"];
  blocksWhenEnforced: boolean;
}

const ROOT = { "tsconfig.json": TSCONFIG, "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", ...LOCAL_TSC };
const SCENARIOS: Scenario[] = [
  { name: "a clean project", files: ROOT, status: "PASSED", blocksWhenEnforced: false },
  { name: "an error in a modified file", files: ROOT, replies: { "": { exit: 2, output: ERROR_IN("src/a.ts") } }, modified: ["src/a.ts"], status: "FAILED", blocksWhenEnforced: true },
  { name: "an error in an untouched file, no baseline", files: ROOT, replies: { "": { exit: 2, output: ERROR_IN("src/b.ts") } }, modified: ["src/a.ts"], status: "PREEXISTING", blocksWhenEnforced: false },
  { name: "an error in an untouched file that the base did not have", files: ROOT, replies: { "": { exit: 2, output: ERROR_IN("src/b.ts") } }, modified: ["src/a.ts"], baseline: [], status: "FAILED", blocksWhenEnforced: true },
  { name: "an error in an untouched file that the base had", files: ROOT, replies: { "": { exit: 2, output: ERROR_IN("src/b.ts") } }, modified: ["src/a.ts"], baseline: ["src/b.ts\nerror TS2322: Type 'string' is not assignable to type 'number'."], status: "PREEXISTING", blocksWhenEnforced: false },
  { name: "an error with no location", files: ROOT, replies: { "": { exit: 2, output: "error TS5083: Cannot read file 'tsconfig.json'.\n" } }, modified: ["src/a.ts"], status: "ENVIRONMENT", blocksWhenEnforced: false },
  { name: "no exit status", files: ROOT, replies: { "": { exit: null } }, status: "ENVIRONMENT", blocksWhenEnforced: false },
  { name: "the check timed out", files: ROOT, replies: { "": { exit: null, timedOut: true } }, status: "TIMED_OUT", blocksWhenEnforced: true },
  { name: "the tool cannot be started when probed", files: ROOT, probe: { exit: 127, output: "tsc: not found" }, status: "UNAVAILABLE", blocksWhenEnforced: false },
  { name: "the tool is not installed", files: { "tsconfig.json": TSCONFIG, "src/a.ts": "export const a = 1;\n" }, noTool: true, status: "UNAVAILABLE", blocksWhenEnforced: true },
  { name: "a solution-style configuration", files: { ...ROOT, "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./pkg" }] }) }, status: "NOT_APPLICABLE", blocksWhenEnforced: true },
  { name: "two projects, one failing", files: { ...ROOT, "pkg/tsconfig.json": TSCONFIG, "pkg/src/c.ts": "export const c = 1;\n", "pkg/node_modules/.bin/tsc": "#!/bin/sh\nexit 0\n" }, replies: { pkg: { exit: 2, output: ERROR_IN("src/c.ts") } }, modified: ["pkg/src/c.ts"], status: "FAILED", blocksWhenEnforced: true },
  { name: "two projects, one with old errors", files: { ...ROOT, "pkg/tsconfig.json": TSCONFIG, "pkg/src/c.ts": "export const c = 1;\n", "pkg/node_modules/.bin/tsc": "#!/bin/sh\nexit 0\n" }, replies: { pkg: { exit: 2, output: ERROR_IN("src/c.ts") } }, modified: ["src/a.ts"], status: "PREEXISTING", blocksWhenEnforced: false },
];

/** The evidence as it is serialised, without the clock. */
const comparable = (evidence: TypecheckEvidence): unknown => JSON.parse(JSON.stringify(evidence, (key, value) => (key === "at" ? undefined : value)));

test("parity: the agent's type-check oracle and collectTypecheckEvidence give the same evidence and block on the same results", async () => {
  const savedPath = process.env.PATH;
  const savedMode = process.env.NEXUS_TYPECHECK;
  delete process.env.NEXUS_TYPECHECK;
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-typecheck-evidence-bin-"));
  try {
    for (const scenario of SCENARIOS) {
      const repo = makeRepo(scenario.files);
      // Committed as executable, so the agent's oracle sees no uncommitted change (it would count the file as modified).
      const launchers = Object.keys(scenario.files).filter((file) => file.endsWith("node_modules/.bin/tsc"));
      for (const name of launchers) fs.chmodSync(path.join(repo, name), 0o755);
      if (launchers.length) execFileSync("git", ["commit", "-qam", "executable"], { cwd: repo, stdio: "ignore" });
      process.env.PATH = scenario.noTool ? emptyBin : savedPath;
      try {
        for (const enforced of [true, false]) {
          const label = `${scenario.name} (${enforced ? "enforce" : "record"})`;
          const execute = scripted(scenario.replies ?? {}, scenario.probe);
          const modified = new Set((scenario.modified ?? []).map((file) => path.join(repo, file)));
          const checks = discoverTypechecks(repo);
          assert.ok(checks.length > 0, label);

          // The agent's function, on an object that holds only what it reads.
          const agentBaseline = new Map<string, Set<string>>();
          if (scenario.baseline) agentBaseline.set(checks[0].command, new Set(scenario.baseline));
          const agent = {
            config: { workspace: repo, typecheck: enforced ? "enforce" : "record" },
            objective: undefined,
            modifiedFiles: modified,
            preTaskChanged: undefined,
            typecheckBaseline: agentBaseline,
            typecheckBaselineUnavailableAfterResume: false,
            lastTypecheck: undefined,
            ensureVerifierApproved: async () => true,
            activity: () => {},
            bridge: { executeTool: (_tool: string, args: { command: string; timeout_secs: number }) => execute(args.command, args.timeout_secs) },
          };
          const theirs = await runTypecheckOracleImpl.call(agent, { budgetSecs: 60, configured: false });

          const baselines = new Map<string, ReadonlySet<string>>();
          if (scenario.baseline) baselines.set(typecheckProjectKey(checks[0]), new Set(scenario.baseline));
          const ours = await collectTypecheckEvidence({ checks, enforced, execute, workspace: repo, modified, budgetSecs: 60, baselines });

          assert.deepEqual(comparable(ours.evidence), comparable(theirs.evidence), label);
          assert.equal(ours.evidence.status, scenario.status, label);
          assert.equal(ours.blocks.length > 0, theirs.block !== undefined, `${label}: both block or neither does`);
          assert.equal(ours.blocks.length > 0, enforced && scenario.blocksWhenEnforced, label);
          for (const block of ours.blocks) assert.ok(theirs.block!.includes(block.message), `${label}: the agent's refusal carries the same message`);
        }
      } finally {
        process.env.PATH = savedPath;
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  } finally {
    process.env.PATH = savedPath;
    if (savedMode !== undefined) process.env.NEXUS_TYPECHECK = savedMode;
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});
