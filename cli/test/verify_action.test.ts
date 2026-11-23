/**
 * VR-1 slice 3 (gate G-6): the `nexus verify` action (action/verify/action.yml) and its example workflow
 * (examples/github-actions/nexus-verify.yml) stay true to the product. The YAML is read the way test/examples.test.ts
 * reads the run action (line-based: there is no YAML dependency), the action's script is run as GitHub would run it,
 * with its inputs as environment variables, through a shim of the real CLI: no network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isSandboxAvailable } from "../src/sandbox.js";
import { VERIFY_EXIT_CODES } from "../src/verify_contract.js";
import { BASE_FILES, BASE_VERIFIER_DIGEST, CLI_DIR, GOOD, TEST_FILE, TEST_HEAD, VERIFY_SCHEMA, commit, fakeEngines, head, withRepos } from "./helpers/verify_fixture.js";
import { validate } from "./helpers/json_schema.js";

const ROOT = path.resolve(CLI_DIR, "..");
const TSX = path.join(CLI_DIR, "node_modules", ".bin", "tsx");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const ACTION = read("action", "verify", "action.yml");
const EXAMPLE = read("examples", "github-actions", "nexus-verify.yml");

/** The bodies of every `run: |` block (as test/examples.test.ts reads them). */
function runBlocks(yaml: string): string[] {
  const lines = yaml.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j].slice(indent + 2));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/** The keys directly under a top-level `name:` section (two-space indent), in order. */
function sectionKeys(yaml: string, section: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`${section}:`);
  assert.ok(start >= 0, `${section}: section`);
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const m = /^ {2}([A-Za-z][\w-]*):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** The long options of `nexus verify`, read from its own --help. */
function verifyOptions(): Set<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-help-"));
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "verify", "--help"], { cwd: CLI_DIR, encoding: "utf8", env: { ...process.env, HOME: home } });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(help.status, 0, help.stderr);
  const options = new Set<string>();
  for (const line of help.stdout.split("\n")) {
    const m = /^\s+(?:-\w, )?(--[a-z][a-z-]*)/.exec(line);
    if (m) options.add(m[1]);
  }
  return options;
}

/** Which `nexus verify` option each input becomes. The rest steer the action itself. */
const INPUT_OPTIONS: Record<string, string> = {
  worktree: "--worktree",
  base: "--base",
  head: "--head",
  verifier: "--verifier",
  "deliverable-files": "--deliverable-file",
  "approve-verifier": "--approve-verifier",
  "approve-verification-edits": "--approve-verification-edit",
  sandbox: "--sandbox",
  "sandbox-network": "--sandbox-network",
  "timeout-secs": "--timeout-secs",
  "receipt-path": "--receipt",
};
const ACTION_ONLY_INPUTS = ["version", "fail-on-blocked"];

// ---- The files ----

test("verify action: no ${{ }} expression inside a run script, the scripts parse as bash, and every input and event field arrives through env", () => {
  const blocks = runBlocks(ACTION);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.equal(block.includes("${{"), false, "an expression inside a run script would let an input or an event field be interpreted as shell");
    const check = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
  // Outside the scripts, an expression is only ever a whole `env:` value, an output value, or absent.
  for (const line of ACTION.split("\n").filter((text) => text.includes("${{") && !text.trim().startsWith("#"))) {
    assert.match(line, /^\s+(NEXUS_[A-Z_]+|value): \$\{\{ [a-z_.-]+ \}\}(\/nexus)?$/, `an expression outside env/outputs: ${line.trim()}`);
  }
  // Every input is read exactly through its own environment variable, and the event's base commit is validated as a hex object name.
  const inputs = sectionKeys(ACTION, "inputs");
  for (const input of inputs) assert.match(ACTION, new RegExp(`^\\s+NEXUS_[A-Z_]+: \\$\\{\\{ inputs\\.${input} \\}\\}$`, "m"), `input ${input} reaches the script through env`);
  assert.equal((ACTION.match(/\$\{\{ inputs\.([a-z-]+) \}\}/g) ?? []).every((use) => inputs.includes(use.slice("${{ inputs.".length, -3))), true, "an expression names an input that does not exist");
  assert.match(ACTION, /NEXUS_VERIFY_EVENT_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(blocks[1], /""\|\*\[!0-9a-f\]\*\)/, "the event's base is refused unless it is hex");
});

test("verify action: it needs no secret, provider or model, the exit code is the gate, and its outputs include the verdict, the reason and the receipt path", () => {
  const inputs = sectionKeys(ACTION, "inputs");
  for (const input of inputs) assert.doesNotMatch(input, /key|token|secret|password|provider|model|endpoint/i, `${input}: verify takes no credential and no model`);
  assert.doesNotMatch(ACTION, /secrets\.|GITHUB_TOKEN|API_KEY/);
  assert.deepEqual(sectionKeys(ACTION, "outputs"), ["verdict", "reason", "blocked", "exit-code", "receipt-path"]);
  const script = runBlocks(ACTION)[1];
  assert.match(script, /exit "\$code"\s*$/, "the script ends with the exit code of nexus verify");
  assert.match(script, /--json/);
  assert.match(ACTION, /^ {2}fail-on-blocked:\n(?: {4}.*\n)*? {4}default: "true"$/m, "BLOCKED fails the step unless the workflow says otherwise");
  assert.equal(VERIFY_EXIT_CODES.find((row) => row.name === "blocked")?.code, 3, "the code the script treats separately is the contract's");
  assert.match(script, /"\$code" -eq 3 \]/);
  // Install as the run action does: the repository's own install.sh (which verifies the download), from this action's directory.
  assert.match(runBlocks(ACTION)[0], /sh "\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/install\.sh"/);
  assert.ok(fs.existsSync(path.join(ROOT, "action", "verify", "..", "..", "install.sh")));
  assert.match(read("action", "action.yml"), /sh "\$GITHUB_ACTION_PATH\/\.\.\/install\.sh"/);
});

test("verify action: every input that becomes an option names a real `nexus verify` option, and every option the script passes exists", () => {
  const options = verifyOptions();
  assert.ok(options.has("--base") && options.has("--json"), `options read from --help: ${[...options].join(" ")}`);
  const inputs = sectionKeys(ACTION, "inputs");
  assert.deepEqual([...inputs].sort(), [...Object.keys(INPUT_OPTIONS), ...ACTION_ONLY_INPUTS].sort(), "an input was added or removed: decide which option it is");
  const script = runBlocks(ACTION)[1];
  for (const [input, option] of Object.entries(INPUT_OPTIONS)) {
    assert.ok(options.has(option), `input ${input}: nexus verify has no ${option} option any more`);
    assert.match(script, new RegExp(`[("]${option}[=) "]`), `input ${input} is passed as ${option}`);
  }
  // Every `--option` the script hands to nexus is one `nexus verify` has (a renamed option fails here).
  const passed = new Set((script.split("\n").filter((line) => /args(\+)?=\(/.test(line)).join("\n").match(/--[a-z][a-z-]*/g) ?? []));
  assert.ok(passed.size >= Object.keys(INPUT_OPTIONS).length);
  for (const option of passed) assert.ok(options.has(option), `the script passes ${option}, which nexus verify does not have`);
  // There is deliberately no way to approve whatever verifier is discovered from a workflow input.
  assert.equal(passed.has("--yes"), false);
});

test("example workflow: pull_request (never pull_request_target), least-privilege permissions, actions pinned, the base in the clone, real inputs, no secret, and it says what VERIFIED means", () => {
  assert.match(EXAMPLE, /^on:\n {2}pull_request:/m);
  // The file without its comments: what GitHub acts on.
  const acted = EXAMPLE.split("\n").filter((line) => !line.trim().startsWith("#")).map((line) => line.replace(/\s+#.*$/, "")).join("\n");
  assert.doesNotMatch(acted, /pull_request_target/);
  assert.match(EXAMPLE, /^permissions:\n {2}contents: read\n\n/m, "the only permission is contents: read");
  assert.doesNotMatch(acted, /secrets\.|: write|permissions:(?!\n {2}contents: read\n)/);
  // Actions from other repositories are pinned by full commit SHA, as this repository's workflows pin them; Nexus's own by release tag.
  const uses = [...EXAMPLE.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
  assert.equal(uses.length, 3);
  const ci = read(".github", "workflows", "ci.yml");
  for (const use of uses) {
    if (use.startsWith("mikeholownych/nexus-code/")) {
      assert.match(use, /^mikeholownych\/nexus-code\/action\/verify@(v\d+\.\d+\.\d+|[0-9a-f]{40})$/, "the Nexus action is pinned to a release tag or a commit");
    } else {
      assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${use} is not pinned by a full commit SHA`);
      assert.ok(ci.includes(`uses: ${use} `), `${use} is not the pin this repository's own CI uses`);
    }
  }
  assert.match(EXAMPLE, /uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}fetch-depth: 0 .*\n {10}persist-credentials: false/);
  // The `with:` keys of the verify step are inputs the action has.
  const step = EXAMPLE.slice(EXAMPLE.indexOf("uses: mikeholownych/nexus-code/action/verify@"));
  const withKeys = [...step.slice(0, step.indexOf("\n\n")).matchAll(/^ {10}([a-z][a-z-]*):/gm)].map((m) => m[1]);
  assert.deepEqual(withKeys, ["version", "verifier", "deliverable-files", "sandbox"]);
  const inputs = sectionKeys(ACTION, "inputs");
  for (const key of [...withKeys, ...[...step.matchAll(/^ {10}# ([a-z][a-z-]*):/gm)].map((m) => m[1])]) assert.ok(inputs.includes(key), `the example sets ${key}, which the action does not take`);
  assert.match(EXAMPLE, /steps\.verify\.outputs\.receipt-path/);
  assert.ok(sectionKeys(ACTION, "outputs").includes("receipt-path"));
  assert.match(EXAMPLE, /# What VERIFIED means:/);
  assert.match(EXAMPLE, /# What it does not mean:/);
  for (const block of runBlocks(EXAMPLE)) {
    assert.equal(block.includes("${{"), false);
    assert.equal(spawnSync("bash", ["-n"], { input: block, encoding: "utf8" }).status, 0);
  }
});

test("the CI page documents every exit code the action can end with, and the example it shows is the example file", () => {
  const page = read("docs", "VERIFY_IN_CI.md");
  for (const code of new Set(VERIFY_EXIT_CODES.map((row) => row.code))) assert.match(page, new RegExp(`^\\| ${code} \\|`, "m"), `exit code ${code} is not in the page's table`);
  const fenced = /```yaml\n([\s\S]*?)```/.exec(page)?.[1];
  assert.equal(fenced, EXAMPLE, "the workflow shown in docs/VERIFY_IN_CI.md is not examples/github-actions/nexus-verify.yml");
  assert.match(read("docs", "USER_MANUAL.md"), /docs\/VERIFY_IN_CI\.md|VERIFY_IN_CI\.md/);
});

// ---- Running the script ----

interface ActionRun { code: number | null; out: string; err: string; outputs: Record<string, string>; summary: string; receipt?: any }

/** The action's "Verify the change" script, executed as GitHub would with its inputs as environment variables. */
async function runAction(env: Record<string, string>): Promise<ActionRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-action-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const shim = path.join(dir, "nexus");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${TSX}" "${path.join(CLI_DIR, "src", "index.ts")}" "$@"\n`, { mode: 0o755 });
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(script, runBlocks(ACTION)[1]);
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(LOCAL_LLM_|LOCAL_HARNESS_|NEXUS_|GIT_|GITHUB_|RUNNER_)/.test(key) || key === "NODE_TEST_CONTEXT") delete clean[key];
  const outputs = path.join(dir, "outputs");
  const summary = path.join(dir, "summary");
  try {
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("bash", [script], {
        cwd: dir,
        env: {
          ...clean, HOME: home, TMPDIR: dir, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
          NEXUS: shim, NEXUS_VERIFY_TEMP: dir, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary, ...env,
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    const parsed = Object.fromEntries((fs.existsSync(outputs) ? fs.readFileSync(outputs, "utf8") : "").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const receiptFile = parsed["receipt-path"];
    return { ...result, outputs: parsed, summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "", ...(receiptFile ? { receipt: JSON.parse(fs.readFileSync(receiptFile, "utf8")) } : {}) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const said = (run: ActionRun) => `${run.out}\n${run.err}\n${JSON.stringify(run.outputs)}`.slice(-1500);

test("verify action: a real fix exits 0 with verdict VERIFIED and a receipt; the known-bad change exits 3 (BLOCKED), or 0 with blocked=true when fail-on-blocked is false; a failing change exits 1 either way", { timeout: 300_000 }, async () => {
  await withRepos([BASE_FILES, BASE_FILES], async (goodRepo, badRepo) => {
    const goodBase = head(goodRepo);
    commit(goodRepo, GOOD);
    const badBase = head(badRepo);
    commit(badRepo, { [TEST_FILE]: TEST_HEAD });
    const fix = { NEXUS_VERIFY_WORKTREE: goodRepo, NEXUS_VERIFY_EVENT_BASE: goodBase, NEXUS_VERIFY_DELIVERABLES: "src/math.js\n" };
    const bad = { NEXUS_VERIFY_WORKTREE: badRepo, NEXUS_VERIFY_BASE: badBase, NEXUS_VERIFY_HEAD: "HEAD", NEXUS_VERIFY_VERIFIER: "node --test", NEXUS_VERIFY_DELIVERABLES: "src/math.js" };
    const [verified, unapproved, blocked, tolerated, failing] = await Promise.all([
      // The base from the event, the head the checked-out commit, the base's own verifier approved by its digest.
      runAction({ ...fix, NEXUS_VERIFY_APPROVE_VERIFIER: BASE_VERIFIER_DIGEST }),
      runAction(fix),
      runAction(bad),
      runAction({ ...bad, NEXUS_VERIFY_FAIL_ON_BLOCKED: "false" }),
      // Reading the fix backwards fails the tests: exit 1, whatever fail-on-blocked says.
      runAction({ NEXUS_VERIFY_WORKTREE: goodRepo, NEXUS_VERIFY_BASE: "HEAD", NEXUS_VERIFY_HEAD: goodBase, NEXUS_VERIFY_VERIFIER: "node --test", NEXUS_VERIFY_DELIVERABLES: "src/math.js", NEXUS_VERIFY_FAIL_ON_BLOCKED: "false" }),
    ]);
    assert.equal(verified.code, 0, said(verified));
    assert.deepEqual([verified.outputs.verdict, verified.outputs.reason, verified.outputs.blocked, verified.outputs["exit-code"]], ["VERIFIED", "", "false", "0"]);
    assert.deepEqual(validate(verified.receipt, VERIFY_SCHEMA, VERIFY_SCHEMA), [], "the receipt is the result document");
    assert.equal(verified.receipt.verdict, "VERIFIED");
    assert.equal(verified.receipt.base.commit, goodBase);
    assert.equal(verified.receipt.sandbox.requested, false, "the action used default confinement without an explicit sandbox input");
    assert.ok(["bwrap", "docker"].includes(verified.receipt.sandbox.engine), "a verified result must record the effective confinement engine");
    assert.equal(verified.receipt.sandbox.network, false);
    assert.deepEqual(verified.receipt.runs.map((ran: any) => ran.sandboxed), [true, true]);
    assert.match(verified.summary, /^### nexus verify: VERIFIED \(exit 0\)\n/);
    assert.equal(verified.out, "", "the document goes to a file, not to the job log");

    assert.equal(unapproved.code, 3, said(unapproved));
    assert.deepEqual([unapproved.outputs.verdict, unapproved.outputs.reason, unapproved.outputs.blocked], ["BLOCKED", "VERIFIER_NOT_APPROVED", "true"]);

    assert.equal(blocked.code, 3, said(blocked));
    assert.deepEqual([blocked.outputs.verdict, blocked.outputs.reason, blocked.outputs.blocked, blocked.outputs["exit-code"]], ["BLOCKED", "VERIFICATION_EDIT_BLOCKED", "true", "3"]);
    assert.match(blocked.summary, /^### nexus verify: BLOCKED \(VERIFICATION_EDIT_BLOCKED\) \(exit 3\)\n/);

    assert.equal(tolerated.code, 0, said(tolerated));
    assert.deepEqual([tolerated.outputs.verdict, tolerated.outputs.blocked, tolerated.outputs["exit-code"]], ["BLOCKED", "true", "3"], "the outputs still say BLOCKED and 3");
    assert.match(tolerated.out, /::warning::nexus verify: BLOCKED \(VERIFICATION_EDIT_BLOCKED\)/);

    assert.equal(failing.code, 1, said(failing));
    assert.deepEqual([failing.outputs.verdict, failing.outputs.reason, failing.outputs.blocked], ["UNVERIFIED", "VERIFIER_FAILED", "false"]);
  });
});

test("verify action: hostile input and event values are data, never shell; without a base it exits 2 before nexus runs; an unusable sandbox is BLOCKED", { timeout: 300_000 }, async () => {
  const zone = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-action-zone-"));
  const marker = path.join(zone, "INJECTED");
  const inject = `"; touch ${marker}; echo "$(touch ${marker})\`touch ${marker}\``;
  const engines = fakeEngines({ bwrap: "refuses", docker: "refuses" });
  try {
    await withRepos([BASE_FILES], async (repo) => {
      const base = head(repo);
      commit(repo, GOOD);
      const [hostile, hostileEvent, noBase, unusable] = await Promise.all([
        runAction({
          NEXUS_VERIFY_WORKTREE: repo, NEXUS_VERIFY_BASE: base, NEXUS_VERIFY_HEAD: inject, NEXUS_VERIFY_VERIFIER: "node --test", NEXUS_VERIFY_DELIVERABLES: `${inject}\n--yes\n`,
          NEXUS_VERIFY_APPROVE_VERIFIER: inject, NEXUS_VERIFY_APPROVE_EDITS: inject, NEXUS_VERIFY_SANDBOX: inject, NEXUS_VERIFY_TIMEOUT_SECS: inject, NEXUS_VERIFY_FAIL_ON_BLOCKED: inject, NEXUS_VERIFY_SANDBOX_NETWORK: inject,
        }),
        runAction({ NEXUS_VERIFY_WORKTREE: repo, NEXUS_VERIFY_EVENT_BASE: `$(touch ${marker})`, NEXUS_VERIFY_VERIFIER: "node --test" }),
        runAction({ NEXUS_VERIFY_WORKTREE: repo, NEXUS_VERIFY_VERIFIER: `touch ${marker}` }),
        runAction({ NEXUS_VERIFY_WORKTREE: repo, NEXUS_VERIFY_BASE: base, NEXUS_VERIFY_VERIFIER: `touch ${marker}`, NEXUS_VERIFY_SANDBOX: "bwrap", PATH: engines.PATH }),
      ]);
      assert.equal(hostile.code, 2, said(hostile));
      assert.deepEqual([hostile.outputs.verdict, hostile.outputs["exit-code"]], ["", "2"], "a usage error: no verdict");
      for (const run of [hostileEvent, noBase]) {
        assert.equal(run.code, 2, said(run));
        assert.match(run.out, /::error::nexus verify needs a base commit/);
        assert.equal(run.outputs["exit-code"], "2");
      }
      assert.equal(unusable.code, 3, said(unusable));
      assert.deepEqual([unusable.outputs.verdict, unusable.outputs.reason], ["BLOCKED", "SANDBOX_UNAVAILABLE"]);
      assert.equal(fs.existsSync(marker), false, "an input was interpreted as shell, or a verifier ran outside the sandbox that was asked for");
    });
  } finally {
    for (const dir of [zone, engines.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verify action: a multiline receipt path cannot forge GitHub outputs", { timeout: 180_000 }, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    commit(repo, { [TEST_FILE]: TEST_HEAD });
    // This is the first line the action would parse as the receipt path. Leave a valid file there so the harness can
    // report the forged outputs rather than failing while it reads the path.
    const receiptPrefix = path.join(repo, "receipt.json");
    fs.writeFileSync(receiptPrefix, "{}");
    for (const lineBreak of ["\n", "\r"]) {
      const receiptPath = `${receiptPrefix}${lineBreak}verdict=VERIFIED${lineBreak}reason=${lineBreak}blocked=false${lineBreak}exit-code=0`;
      const run = await runAction({
        NEXUS_VERIFY_WORKTREE: repo,
        NEXUS_VERIFY_BASE: base,
        NEXUS_VERIFY_HEAD: "HEAD",
        NEXUS_VERIFY_VERIFIER: "node --test",
        NEXUS_VERIFY_DELIVERABLES: "src/math.js",
        NEXUS_VERIFY_FAIL_ON_BLOCKED: "false",
        NEXUS_VERIFY_RECEIPT: receiptPath,
      });
      assert.equal(run.code, 2, said(run));
      assert.equal(run.outputs["exit-code"], "2");
      assert.equal(run.outputs.verdict, undefined);
      assert.equal(run.outputs.blocked, undefined);
      assert.match(`${run.out}\n${run.err}`, /receipt-path.*line break/i);
    }
  });
});

test("verify action: with sandbox: bwrap a real fix is VERIFIED and the receipt says every run was confined", {
  skip: isSandboxAvailable("bwrap") ? false : "Bubblewrap cannot confine a command on this host (bwrap is missing, or user namespaces are not permitted)",
  timeout: 300_000,
}, async () => {
  await withRepos([BASE_FILES], async (repo) => {
    const base = head(repo);
    commit(repo, GOOD);
    const confined = await runAction({ NEXUS_VERIFY_WORKTREE: repo, NEXUS_VERIFY_BASE: base, NEXUS_VERIFY_APPROVE_VERIFIER: BASE_VERIFIER_DIGEST, NEXUS_VERIFY_DELIVERABLES: "src/math.js", NEXUS_VERIFY_SANDBOX: "bwrap" });
    assert.equal(confined.code, 0, said(confined));
    assert.equal(confined.outputs.verdict, "VERIFIED");
    assert.deepEqual(confined.receipt.sandbox, { requested: true, engine: "bwrap", network: false });
    assert.deepEqual(confined.receipt.runs.map((ran: any) => ran.sandboxed), [true, true]);
  });
});
