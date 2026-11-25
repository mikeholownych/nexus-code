/**
 * PF-2: the machine contract of `nexus run`: the versioned JSON document `--json` prints (docs/protocol/run-result-v1.schema.json,
 * generated from src/run_contract.ts), the exit-code table (the same in code and in docs/USER_MANUAL.md), and the task
 * read from `--input-json` or stdin. The consumer tests spawn the real CLI against a scripted gateway.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ApplicationCore } from "../src/core/app.js";
import { exitCodeForTurn, type TurnResult } from "../src/core/turn.js";
import {
  RUN_EXIT_CODES, RUN_EXIT_FOR_COMPLETED_OUTCOME, RUN_EXIT_FOR_EXECUTION, RUN_INPUT_MAX_BYTES, RUN_INPUT_SCHEMA_VERSION, RUN_RESULT_SCHEMA_VERSION,
  parseRunInput, resolveRunTask, runExitCode, runExitNameForTurn, runJsonResult, type RunExitName,
} from "../src/run_contract.js";
import { sha256 } from "../scripts/gen_protocol_schema.mjs";
import { generateRunResultSchema, runResultLedgerProblem, runResultSchemaFile, RUN_RESULT_LEDGER_FILE } from "../scripts/gen_run_result_schema.mjs";
import { validate, type Schema } from "./helpers/json_schema.js";
import { startGateway, makeRepo, makeHome, type Reply } from "./helpers/fixtures.js";
import { mute } from "./helpers/capacity_fixture.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANUAL = path.resolve(CLI_DIR, "..", "docs", "USER_MANUAL.md");
const checkedIn = fs.readFileSync(runResultSchemaFile(RUN_RESULT_SCHEMA_VERSION), "utf8");
const schema: Schema = JSON.parse(checkedIn);
const errorsOf = (doc: unknown, branch?: "RunJsonResult" | "RunJsonError") => validate(doc, branch ? { $ref: `#/$defs/${branch}` } : schema, schema);

// ---- The document built from a real runTask ----
// This test is the first in the file on purpose: runTask captures process.stdout while it runs (with `json` or `quiet`),
// and node:test reports through the same stdout, so the reports of tests that finished just before it would be lost.

test("the document built from a real runTask validates, has schema_version first and round-trips through JSON", async () => {
  const savedHome = process.env.HOME;
  const home = makeHome();
  process.env.HOME = home;
  const gateway = await startGateway(() => ({ kind: "text", content: "the answer" }));
  const repo = makeRepo();
  const app = new ApplicationCore({ endpoint: gateway.url, model: "m", maxSteps: 3, temperature: 0, workspace: repo, shell: "bash" } as any);
  mute(app.getAgent());
  try {
    const result = await app.runTask("answer briefly", { quiet: true });
    const doc = runJsonResult(result);
    assert.equal(Object.keys(doc)[0], "schema_version");
    assert.equal(doc.schema_version, RUN_RESULT_SCHEMA_VERSION);
    assert.equal("cloudUsage" in doc, false, "no cloud request, no cloudUsage");
    // Every result member is carried unchanged.
    const { schema_version: _version, ...rest } = doc;
    assert.deepEqual(rest, result);
    const text = JSON.stringify(doc);
    const parsed = JSON.parse(text);
    assert.equal(Object.keys(parsed)[0], "schema_version");
    assert.deepEqual(errorsOf(parsed), []);
    assert.deepEqual(errorsOf(parsed, "RunJsonResult"), []);
    assert.equal(JSON.stringify(parsed), text, "round trip");
    assert.equal(parsed.output, "the answer");
    assert.equal(parsed.exitCode, runExitCode(runExitNameForTurn(parsed.turn)));

    const totals = { requests: 1, inputTokens: 2, outputTokens: 3, costUsd: 0, unpricedRequests: 0, uncertainRequests: 0, estimatedRequests: 0, cachedTokens: 0, cacheReportedPromptTokens: 0 };
    const withCloud = JSON.parse(JSON.stringify(runJsonResult(result, totals)));
    assert.deepEqual(withCloud.cloudUsage, totals);
    assert.deepEqual(errorsOf(withCloud, "RunJsonResult"), []);
    assert.equal("cloudUsage" in runJsonResult(result, { ...totals, requests: 0 }), false);

    // The schema rejects what a consumer must be able to rely on.
    assert.ok(errorsOf({ ...parsed, schema_version: 2 }).length > 0);
    const { schema_version: _dropped, ...unversioned } = parsed;
    assert.ok(errorsOf(unversioned).some((error) => /missing required schema_version/.test(error)));
    assert.ok(errorsOf({ ...parsed, exitCode: "0" }, "RunJsonResult").some((error) => /\$\.exitCode: expected number/.test(error)));
    assert.deepEqual(errorsOf({ ...parsed, added_later: true }), [], "a member added later is ignored");
  } finally {
    app.shutdown();
    await gateway.close();
    process.env.HOME = savedHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- Schema, ledger and exit-code table ----

test("the checked-in run-result schema equals a fresh generation from src/run_contract.ts", () => {
  const generated = generateRunResultSchema();
  assert.equal(generated.version, RUN_RESULT_SCHEMA_VERSION);
  assert.equal(
    checkedIn,
    generated.text,
    "docs/protocol/run-result schema is out of date: run `node cli/scripts/gen_run_result_schema.mjs`, then record the version decision in docs/protocol/RUN_RESULT_VERSIONS.json",
  );
});

test("the newest run-result ledger entry records the current schema and schema_version", () => {
  const ledger = JSON.parse(fs.readFileSync(RUN_RESULT_LEDGER_FILE, "utf8"));
  assert.equal(runResultLedgerProblem(checkedIn, ledger, RUN_RESULT_SCHEMA_VERSION), undefined);
  for (const entry of ledger) {
    assert.ok(Number.isInteger(entry.schema_version) && /^[0-9a-f]{64}$/.test(entry.schemaSha256) && typeof entry.note === "string" && entry.note.trim(), "each entry has schema_version, schemaSha256 and a note");
  }
  // The rule itself: a changed schema, or a version bump, without a new entry is a failure.
  assert.match(runResultLedgerProblem(`${checkedIn} `, ledger, RUN_RESULT_SCHEMA_VERSION) ?? "", /add an entry/);
  assert.match(runResultLedgerProblem(checkedIn, ledger, RUN_RESULT_SCHEMA_VERSION + 1) ?? "", /RUN_RESULT_SCHEMA_VERSION is/);
  assert.match(runResultLedgerProblem(checkedIn, [], RUN_RESULT_SCHEMA_VERSION) ?? "", /no entries/);
  assert.equal(ledger[ledger.length - 1].schemaSha256, sha256(checkedIn));
});

test("the schema is a union of a result and an error document, both open and both carrying schema_version", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.$defs.RunJsonOutput.anyOf, [{ $ref: "#/$defs/RunJsonError" }, { $ref: "#/$defs/RunJsonResult" }]);
  for (const name of ["RunJsonResult", "RunJsonError"]) {
    const branch = schema.$defs[name];
    assert.equal(branch.properties.schema_version.const, RUN_RESULT_SCHEMA_VERSION);
    assert.ok(branch.required.includes("schema_version"));
    assert.notEqual(branch.additionalProperties, false, "the document stays open to members added later");
  }
  // What tells the two apart: only a result has `turn` and `exitCode`.
  assert.ok(schema.$defs.RunJsonResult.required.includes("turn") && schema.$defs.RunJsonResult.required.includes("exitCode"));
  assert.ok(!("turn" in schema.$defs.RunJsonError.properties) && !("exitCode" in schema.$defs.RunJsonError.properties));
});

test("the exit-code table gives every turn ending the code exitCodeForTurn computes", () => {
  // The states and outcomes come from the published schema (so from the types): a new one fails here until its row is decided.
  const executions: string[] = schema.$defs.ExecutionState.enum;
  const outcomes: string[] = schema.$defs.EngineeringOutcome.enum;
  assert.deepEqual([...Object.keys(RUN_EXIT_FOR_EXECUTION), "COMPLETED"].sort(), [...executions].sort());
  assert.deepEqual(Object.keys(RUN_EXIT_FOR_COMPLETED_OUTCOME).sort(), [...outcomes].sort());
  for (const execution of executions) {
    for (const outcome of outcomes) {
      const turn = { execution, outcome } as TurnResult;
      assert.equal(exitCodeForTurn(turn), runExitCode(runExitNameForTurn(turn)), `${execution}/${outcome}`);
    }
  }
  assert.equal(new Set(RUN_EXIT_CODES.map((row) => row.name)).size, RUN_EXIT_CODES.length, "row names are unique");
  assert.deepEqual([...new Set(RUN_EXIT_CODES.map((row) => row.code))], [0, 1, 2, 130], "no code was added or changed");
  assert.deepEqual([runExitCode("ok"), runExitCode("failed"), runExitCode("unverified"), runExitCode("usage"), runExitCode("interrupted")], [0, 1, 2, 2, 130]);
});

test("the manual's exit-code table is the exported table", () => {
  const manual = fs.readFileSync(MANUAL, "utf8");
  const start = manual.indexOf("### Exit codes of `nexus run`");
  assert.ok(start >= 0, "the manual has the section");
  const rows = manual.slice(start).split("\n").slice(1);
  const first = rows.findIndex((line) => line.startsWith("|"));
  const table: string[] = [];
  for (let i = first; i < rows.length && rows[i].startsWith("|"); i++) table.push(rows[i]);
  const cells = table.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.deepEqual(cells[0], ["Code", "Name", "When"]);
  assert.match(cells[1].join(""), /^[-: ]+$/);
  assert.deepEqual(
    cells.slice(2).map(([code, name, when]) => ({ code: Number(code), name: name.replace(/`/g, ""), when })),
    RUN_EXIT_CODES.map((row) => ({ ...row })),
  );
});

// ---- Consumer: the real CLI ----

interface CliRun { code: number | null; stdout: string; stderr: string }

/** Runs `nexus run <args>` (the source entry) with a throwaway HOME and no operator environment. `stdin`: text piped in and closed. */
function runCli(home: string, args: string[], stdin?: string): Promise<CliRun> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_)/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "run", ...args], {
      cwd: CLI_DIR,
      env: { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache") },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin!.on("error", () => {}); // the child may exit (a usage error) before taking all of it
      child.stdin!.end(stdin);
    }
  });
}

interface Scenario { script: (n: number) => Reply; files?: Record<string, string>; args: (repo: string, home: string) => string[]; stdin?: string }

/** One CLI run against a scripted gateway in a fresh repository and HOME; `check` runs before they are removed. */
async function scenario<T>(s: Scenario, check: (run: CliRun, at: { repo: string; requests: number }) => T): Promise<T> {
  const gateway = await startGateway(s.script);
  const repo = makeRepo(s.files ?? {});
  const home = makeHome();
  try {
    const run = await runCli(home, ["-e", gateway.url, "-m", "m", "-w", repo, ...s.args(repo, home)], s.stdin);
    return check(run, { repo, requests: gateway.requests.length });
  } finally {
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** What a consumer does: stdout is exactly one JSON document, valid against the published schema. */
function consume(run: CliRun): any {
  let doc: any;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    assert.fail(`stdout is not one JSON document: ${run.stdout.slice(0, 200)}\nstderr: ${run.stderr.slice(0, 400)}`);
  }
  assert.equal(run.stdout, `${JSON.stringify(doc, null, 2)}\n`, "nothing but the document on stdout");
  assert.equal(Object.keys(doc)[0], "schema_version");
  assert.equal(doc.schema_version, RUN_RESULT_SCHEMA_VERSION);
  assert.deepEqual(errorsOf(doc), []);
  return doc;
}

/** A finished task: the result branch, and the process exit code is the table's code for the turn's ending. */
function consumeResult(run: CliRun, expected: RunExitName): any {
  const doc = consume(run);
  assert.deepEqual(errorsOf(doc, "RunJsonResult"), []);
  assert.equal(runExitNameForTurn(doc.turn), expected, `${doc.turn.execution}/${doc.turn.outcome}: ${doc.turn.reason}`);
  assert.equal(run.code, runExitCode(expected));
  assert.equal(doc.exitCode, run.code, "exitCode repeats the process exit code");
  assert.equal(doc.success, run.code === 0);
  return doc;
}

const text = (content: string) => (): Reply => ({ kind: "text", content });
const writeThenDone = (n: number): Reply => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hello\n" } }] } : { kind: "text", content: "done" });

// A project whose only test fails until math.js is fixed; the scripted model fixes it, runs the tests and completes.
const FIXABLE_PROJECT = {
  "package.json": JSON.stringify({ name: "run-contract-fixture", version: "1.0.0", private: true, main: "./math.js", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/*.test.js" } }),
  "math.js": "exports.add = (a, b) => a - b;\n",
  "test/add.test.js": 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n',
};
const FIX_REPLIES: Reply[] = [
  { kind: "tools", calls: [{ name: "run_command", args: { command: "printf 'exports.add = (a, b) => a + b;\\n' > math.js" } }] },
  { kind: "tools", calls: [{ name: "run_command", args: { command: "npm test" } }] },
  { kind: "tools", calls: [{ name: "task_completed", args: { summary: "Fixed addition" } }] },
  { kind: "text", content: "Done." },
];
const fixScript = (n: number): Reply => FIX_REPLIES[Math.min(n, FIX_REPLIES.length) - 1];

test("consumer: a verified success prints one valid document and exits 0", async () => {
  await scenario({ script: fixScript, files: FIXABLE_PROJECT, args: () => ["-y", "--deliverable-file", "math.js", "-s", "5", "--json", "Fix the failing addition test, then complete the task."] }, (run) => {
    const doc = consumeResult(run, "ok");
    assert.equal(doc.turn.outcome, "VERIFIED");
    assert.equal(doc.status, "completed");
  });
});

test("consumer: completed-but-unverified endings exit 2 and the document says which", async () => {
  await Promise.all([
    scenario({ script: writeThenDone, args: () => ["-y", "--json", "write x.txt"] }, (run, at) => {
      const doc = consumeResult(run, "unverified");
      assert.equal(doc.turn.outcome, "UNVERIFIED");
      assert.equal(doc.status, "completed");
      assert.equal(fs.readFileSync(path.join(at.repo, "x.txt"), "utf8"), "hello\n");
    }),
    // The same fix as the verified run, without a declared deliverable: the tests pass but do not cover the change.
    scenario({ script: fixScript, files: FIXABLE_PROJECT, args: () => ["-y", "-s", "5", "--json", "Fix the failing addition test, then complete the task."] }, (run) => {
      assert.equal(consumeResult(run, "unverified").turn.outcome, "REGRESSION_FREE");
    }),
  ]);
});

test("consumer: an answer that changes nothing exits 0; an inference failure exits 1", async () => {
  await Promise.all([
    scenario({ script: text("the answer"), args: () => ["--json", "answer briefly"] }, (run) => {
      const doc = consumeResult(run, "ok");
      assert.equal(doc.turn.outcome, "NOT_REQUIRED");
      assert.equal(doc.output, "the answer");
      assert.equal(doc.prompt, "answer briefly");
    }),
    scenario({ script: () => ({ kind: "http", status: 500, body: '{"error":"scripted"}' }), args: () => ["--json", "answer briefly"] }, (run) => {
      const doc = consumeResult(run, "failed");
      assert.equal(doc.turn.execution, "FAILED");
      assert.equal(doc.status, "failed");
    }),
  ]);
});

test("consumer: a run that throws before a result prints the error document; exit 2 there is not 'unverified'", async () => {
  await scenario({ script: text("unused"), args: () => ["--json", "--resume", "no-such-task-id"] }, (run, at) => {
    const doc = consume(run);
    assert.deepEqual(errorsOf(doc, "RunJsonError"), []);
    assert.ok(errorsOf(doc, "RunJsonResult").length > 0, "an error document is not a result");
    assert.equal("turn" in doc || "exitCode" in doc, false);
    assert.equal(doc.success, false);
    assert.equal(doc.status, "failed");
    assert.match(doc.error, /Task state not found/);
    assert.equal(run.code, runExitCode("task_not_found"));
    assert.equal(run.code, runExitCode("unverified"), "the overlap the manual documents: the code alone does not tell these apart");
    assert.equal(at.requests, 0);
  });
});

test("consumer: the stream-json result event carries the same versioned result object", async () => {
  await scenario({ script: text("the answer"), args: () => ["--output", "stream-json"], stdin: "answer briefly\n" }, (run) => {
    const events = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const result = events.at(-1);
    assert.equal(result.type, "result", run.stderr.slice(0, 300));
    assert.equal(result.schema_version, RUN_RESULT_SCHEMA_VERSION);
    assert.deepEqual(errorsOf(result, "RunJsonResult"), []);
    assert.equal(result.prompt, "answer briefly", "the task came from stdin");
    assert.equal(run.code, result.exitCode);
  });
});

// ---- The task from --input-json or stdin ----

test("the task is read from an --input-json file, from --input-json - and as plain text on stdin", async () => {
  const input = JSON.stringify({ schema_version: RUN_INPUT_SCHEMA_VERSION, task: "  answer briefly\nin two lines  ", note: "an unknown member is ignored" });
  const expectTask = (run: CliRun) => {
    const doc = consumeResult(run, "ok");
    assert.equal(doc.prompt, "answer briefly\nin two lines");
    assert.equal(doc.output, "the answer");
  };
  await Promise.all([
    scenario({ script: text("the answer"), args: (_repo, home) => { fs.writeFileSync(path.join(home, "task.json"), input); return ["--json", "--input-json", path.join(home, "task.json")]; } }, expectTask),
    scenario({ script: text("the answer"), args: () => ["--json", "--input-json", "-"], stdin: input }, expectTask),
    scenario({ script: text("the answer"), args: () => ["--json"], stdin: "answer briefly\nin two lines\n" }, expectTask),
    // An argument wins over stdin: stdin is not read for the task.
    scenario({ script: text("the answer"), args: () => ["--json", "from the argument"], stdin: "from stdin" }, (run) => assert.equal(consumeResult(run, "ok").prompt, "from the argument")),
  ]);
});

test("an invalid task input is a usage error: its message on stderr, exit code 2, nothing on stdout, no request sent", async () => {
  const doc = (value: unknown) => JSON.stringify(value);
  const cases: Array<{ name: string; args: string[]; stdin?: string; file?: string; message: RegExp }> = [
    { name: "not JSON", args: ["--input-json", "-"], stdin: "{ task: nope", message: /^error: --input-json: the input is not valid JSON$/m },
    { name: "not an object", args: ["--input-json", "-"], stdin: doc(["task"]), message: /^error: --input-json: the input must be a JSON object$/m },
    { name: "no version", args: ["--input-json", "-"], stdin: doc({ task: "t" }), message: /^error: --input-json: schema_version is missing \(this nexus reads schema_version 1\)$/m },
    { name: "unknown version", args: ["--input-json", "-"], stdin: doc({ schema_version: 2, task: "t" }), message: /^error: --input-json: unsupported schema_version 2 \(this nexus reads schema_version 1\)$/m },
    { name: "version as text", args: ["--input-json", "-"], stdin: doc({ schema_version: "1", task: "t" }), message: /^error: --input-json: unsupported schema_version "1"/m },
    { name: "no task", args: ["--input-json", "-"], stdin: doc({ schema_version: 1 }), message: /^error: --input-json: "task" must be a non-empty string$/m },
    { name: "blank task", args: ["--input-json", "-"], stdin: doc({ schema_version: 1, task: " \n" }), message: /"task" must be a non-empty string/ },
    { name: "task not text", args: ["--input-json", "-"], stdin: doc({ schema_version: 1, task: ["t"] }), message: /"task" must be a non-empty string/ },
    { name: "oversized stdin document", args: ["--input-json", "-"], stdin: doc({ schema_version: 1, task: "t".repeat(RUN_INPUT_MAX_BYTES) }), message: new RegExp(`^error: --input-json: the input is larger than ${RUN_INPUT_MAX_BYTES} bytes$`, "m") },
    { name: "oversized file", args: ["--input-json", "FILE"], file: doc({ schema_version: 1, task: "t".repeat(RUN_INPUT_MAX_BYTES) }), message: /--input-json: the input is larger than 1048576 bytes/ },
    { name: "missing file", args: ["--input-json", "FILE"], message: /^error: --input-json: cannot read .*task\.json \(ENOENT\)$/m },
    { name: "argument and input", args: ["--input-json", "-", "a task"], stdin: doc({ schema_version: 1, task: "t" }), message: /^error: give the task either as an argument or with --input-json, not both$/m },
    { name: "empty stdin", args: [], stdin: "", message: /^error: no task: stdin was empty/m },
    { name: "blank stdin", args: [], stdin: " \n\t\n", message: /^error: no task: stdin was empty/m },
    { name: "oversized stdin task", args: [], stdin: "t".repeat(RUN_INPUT_MAX_BYTES + 1), message: /^error: the task on stdin is larger than 1048576 bytes$/m },
  ];
  await Promise.all(cases.map((c) =>
    scenario({
      script: text("must not be asked"),
      args: (_repo, home) => {
        const file = path.join(home, "task.json");
        if (c.file !== undefined) fs.writeFileSync(file, c.file);
        return ["--json", ...c.args.map((arg) => (arg === "FILE" ? file : arg))];
      },
      stdin: c.stdin,
    }, (run, at) => {
      assert.match(run.stderr, c.message, c.name);
      assert.equal(run.code, runExitCode("usage"), c.name);
      assert.equal(run.stdout, "", c.name);
      assert.equal(at.requests, 0, c.name);
    })));
});

test("an input document cannot widen authority: approval, mode, workspace and endpoint members have no effect", async () => {
  const elsewhere = makeRepo();
  try {
    // Without --yes a file write needs approval, which a headless run cannot give: the run is blocked and writes nothing.
    const blocked = (run: CliRun, at: { repo: string; requests: number }) => {
      const doc = consumeResult(run, "failed");
      assert.equal(fs.existsSync(path.join(at.repo, "x.txt")), false, "nothing was written");
      assert.equal(fs.existsSync(path.join(elsewhere, "x.txt")), false, "nor in the workspace the document named");
      return { execution: doc.turn.execution, outcome: doc.turn.outcome, reason: doc.turn.reason, prompt: doc.prompt, requests: at.requests };
    };
    const forbidden = { schema_version: 1, task: "write x.txt", yes: true, mode: "auto", approve: false, approvalMode: "auto", sandbox: false, readOnly: false, workspace: elsewhere, endpoint: "http://127.0.0.1:9/v1", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-not-a-key", model: "other" };
    const [plain, withForbidden, allowed] = await Promise.all([
      scenario({ script: writeThenDone, args: () => ["--json", "write x.txt"] }, blocked),
      scenario({ script: writeThenDone, args: () => ["--json", "--input-json", "-"], stdin: JSON.stringify(forbidden) }, blocked),
      // The command line still decides: the same document with --yes on the command line does write.
      scenario({ script: writeThenDone, args: () => ["--json", "-y", "--input-json", "-"], stdin: JSON.stringify(forbidden) }, (run, at) => {
        consumeResult(run, "unverified");
        return fs.existsSync(path.join(at.repo, "x.txt")) && !fs.existsSync(path.join(elsewhere, "x.txt"));
      }),
    ]);
    assert.equal(plain.execution, "BLOCKED");
    assert.deepEqual(withForbidden, plain, "the run behaves exactly as without the extra members");
    assert.equal(allowed, true);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("resolveRunTask: which source supplies the task", async () => {
  const stdin = (content: string, isTTY = false) => Object.assign(Readable.from([Buffer.from(content)]), { isTTY });
  const never = Object.assign(Readable.from((async function* () { throw new Error("stdin must not be read"); })()), { isTTY: false });
  assert.equal(await resolveRunTask({ prompt: "arg", resuming: false, stdin: never }), "arg");
  assert.equal(await resolveRunTask({ prompt: "", resuming: true, stdin: never }), "", "a resume without a task is left to the caller");
  assert.equal(await resolveRunTask({ prompt: "", resuming: false, stdin: Object.assign(never, { isTTY: true }) }), "", "a terminal on stdin is not read: the caller reports the missing prompt");
  never.isTTY = false;
  assert.equal(await resolveRunTask({ prompt: "", resuming: false, stdin: stdin(" piped task \n") }), "piped task");
  assert.equal(await resolveRunTask({ prompt: "", resuming: true, inputJson: "-", stdin: stdin('{"schema_version":1,"task":"continue with this"}') }), "continue with this");
  await assert.rejects(resolveRunTask({ prompt: "arg", inputJson: "-", resuming: false, stdin: never }), /not both/);
  await assert.rejects(resolveRunTask({ prompt: "", resuming: false, stdin: stdin("") }), /stdin was empty/);
  await assert.rejects(resolveRunTask({ prompt: "", resuming: false, stdin: Object.assign(Readable.from([Buffer.from([0xff, 0xfe])]), { isTTY: false }) }), /not valid UTF-8/);
  assert.equal(parseRunInput('{"schema_version":1,"task":"t","yes":true}'), "t");
  // At the bound exactly the input is accepted; one byte more is refused.
  assert.equal((await resolveRunTask({ prompt: "", resuming: false, stdin: stdin("t".repeat(RUN_INPUT_MAX_BYTES)) })).length, RUN_INPUT_MAX_BYTES);
  await assert.rejects(resolveRunTask({ prompt: "", resuming: false, stdin: stdin("t".repeat(RUN_INPUT_MAX_BYTES + 1)) }), /larger than 1048576 bytes/);
});
