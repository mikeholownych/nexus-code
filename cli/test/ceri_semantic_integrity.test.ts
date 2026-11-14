/**
 * CERI domain `semantic_integrity`: frozen scenarios (fixtures/ceri/semantic_integrity.scenarios.json) run against the
 * real gating code with scripted inputs and a deterministic local gateway, never a live model. Expected outcomes live
 * only in the frozen file, pinned by its sha256 manifest; the drivers here compute what the product does, and the
 * comparison is against the file. A pending scenario names the unit that will make it pass and is not counted.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { CAPABILITY_DOMAINS } from "../src/ceri/index.js";
import {
  acceptDescoping,
  amendObjective,
  applyRequirementUpdates,
  createLedger,
  gatingRequirements,
  hasOpenRequirements,
  invalidateVerified,
  PINNED_LEDGER_PREFIX,
  priorAttempt,
  queueSteering,
  recordSteeringConflict,
  steeringNegations,
  recordAttempt,
  renderPinnedLedger,
  requirementDone,
  type ObjectiveLedger,
  type VerificationAttempt,
} from "../src/core/objective.js";
import { buildReviewEvidencePackage, parseIndependentReviewVerdict } from "../src/core/independent_review.js";
import { DurableStateManager } from "../src/core/state.js";
import { SecurityManager } from "../src/security.js";
import { DEFAULT_CONTINUATION, type HarnessConfig } from "../src/types.js";
import { makeRepo, startGateway, type Reply } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_FILE = path.join(here, "fixtures/ceri/semantic_integrity.scenarios.json");
const MANIFEST_FILE = path.join(here, "fixtures/ceri/semantic_integrity.scenarios.sha256");

interface Scenario {
  id: string;
  category: string;
  status: "active" | "pending";
  pendingUnit?: string;
  description: string;
  expected: unknown;
}
const raw = fs.readFileSync(SCENARIO_FILE);
const frozen = JSON.parse(raw.toString("utf8")) as { domain: string; version: string; scenarios: Scenario[] };

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ceri-si-home-"));
  process.env.HOME = home;
});
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent): AutonomousAgent => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, maxCompletionNudges: 0 },
  ...o,
});
const text = (content: string): Reply => ({ kind: "text", content });
const writeFile = (name: string, content: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content, overwrite: true } }] });
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ceri-si-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: root, stdio: "ignore" });
  return root;
}

/** One scripted turn through the real agent loop; every agent, gateway and workspace is released in `finally`. */
async function scriptedTurn(files: Record<string, string>, steps: Reply[], objective: string, extra: Partial<HarnessConfig> = {}) {
  const root = repoWith(files);
  const gw = await startGateway((n) => steps[n - 1] ?? text("done"));
  const agent = quiet(new AutonomousAgent(cfg(gw.url, root, extra)));
  try {
    return await agent.runTurn(objective);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const RUN_TESTS = "env -u NODE_TEST_CONTEXT node --test test/*.test.js";
const pkg = (main: string) => JSON.stringify({ name: "x", version: "1.0.0", private: true, main, scripts: { test: RUN_TESTS } });
const SLUG = 'function slugify(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\nmodule.exports = { slugify };\n';
const SLUG_TEST = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { slugify } = require("../slugify.js");\ntest("basic", () => assert.equal(slugify("Hello, World!"), "hello-world"));\n';
const SLUG_WRONG =
  'function slugify(t, o = {}) {\n  let s = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n' +
  '  if (o.maxLength !== undefined && s.length >= o.maxLength) { const cut = s.slice(0, o.maxLength).lastIndexOf("-"); s = cut > 0 ? s.slice(0, cut) : s.slice(0, o.maxLength); }\n' +
  "  return s;\n}\nmodule.exports = { slugify };\n";
const SLUG_TEST_WRONG = SLUG_TEST + 'test("maxLength", () => assert.equal(slugify("The quick brown fox", { maxLength: 15 }), "the-quick"));\n';
const ADD_BUGGY = "exports.add = (a, b) => a - b;\n";
const ADD_FIXED = "exports.add = (a, b) => a + b;\n";
const ADD_TEST = 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../math.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n';

const turnFacts = (turn: any) => ({ outcome: turn.outcome, verificationStatus: turn.verification?.status, independent: turn.verification?.independent === true });

/** Builds a turn result from stated agent state, the way the product's own tests do, and releases the agent. */
function turnFromState(state: { invalidated?: boolean; evidence?: Record<string, unknown>; verifierCommand?: string }) {
  const root = makeRepo();
  const agent = quiet(new AutonomousAgent(cfg("http://127.0.0.1:9/v1", root, state.verifierCommand ? { authoritativeVerifierCommand: state.verifierCommand } : {})));
  try {
    const a = agent as any;
    a.hasPendingModifications = true;
    a.verificationBaselineInvalidated = state.invalidated === true;
    a.verificationEvidence = state.evidence;
    return a.buildTurnResult({ modelStop: "NONE", finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed: 1 });
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const passing = (extra: Record<string, unknown>) => ({ status: "PASSED", command: "npm test", exitSuccess: true, ...extra });

const NUMBERED = "1. Add the maxLength option\n2. Keep the public API unchanged\n3. Update the README";
const pass = (over: Partial<VerificationAttempt> = {}): VerificationAttempt => ({
  n: 1, command: "npm test", inputs: "a".repeat(64), epoch: "e1", mutationSeq: 1, external: "x1", status: "PASSED",
  isDeliverableBound: true, independent: true, filtered: false, at: "2026-11-14T00:00:00.000Z", ...over,
});
const ledgerWith = (objective: string, id: string, status: "implemented", evidence: string): ObjectiveLedger => {
  const ledger = createLedger(objective);
  applyRequirementUpdates(ledger, [{ id, status, evidence }]);
  return ledger;
};
const REVIEW = JSON.stringify({ verdict: "ACCEPT", verifiedObservations: ["ok"], suspectedDefects: [], unprovenCriteria: [], scopeViolations: [], reviewerConfidenceNote: "high" });
const reviewPackage = (over: Record<string, unknown> = {}) =>
  buildReviewEvidencePackage({ unitId: "u1", objective: "o", baselineCommit: "b", unifiedDiff: "diff --git a/src/a.ts b/src/a.ts\n+x\n", ...over });
const reviewFacts = (rawReply: string, over: Record<string, unknown> = {}) => {
  const v = parseIndependentReviewVerdict(rawReply, reviewPackage(over));
  const unproven = v.unprovenCriteria.join("\n");
  const reason = v.suspectedDefects.some((d) => d.path === "review_verdict.json") ? "unparseable"
    : /No deterministic verifier evidence/.test(unproven) ? "no_verifier_evidence"
    : /Deterministic verifier failed/.test(unproven) ? "verifier_failed"
    : /diff could not be collected/.test(unproven) ? "no_diff"
    : "none";
  return { verdict: v.verdict, reason };
};

const drivers: Record<string, () => unknown | Promise<unknown>> = {
  "hidden-invariant-01": () => {
    const ledger = ledgerWith(NUMBERED, "R2", "implemented", "src/api.ts");
    const result = applyRequirementUpdates(ledger, [{ id: "R2", status: "verified" }], undefined, undefined, pass({ isDeliverableBound: false }));
    return { ok: result.ok, refusal: /covers the deliverable/.test(result.errors.join()) ? "not_deliverable_bound" : result.errors.join(), statusAfter: ledger.requirements[1].status };
  },
  "hidden-invariant-02": () => {
    const ledger = ledgerWith(NUMBERED, "R2", "implemented", "src/api.ts");
    const result = applyRequirementUpdates(ledger, [{ id: "R2", status: "verified" }]);
    return { ok: result.ok, refusal: /needs a passing verifier run/.test(result.errors.join()) ? "no_passing_verifier" : result.errors.join(), statusAfter: ledger.requirements[1].status };
  },
  "self-validating-01": async () =>
    turnFacts(await scriptedTurn(
      { "package.json": pkg("./slugify.js"), "slugify.js": SLUG, "test/slugify.test.js": SLUG_TEST },
      [writeFile("slugify.js", SLUG_WRONG), writeFile("test/slugify.test.js", SLUG_TEST_WRONG), done],
      "Add a maxLength option to slugify.",
    )),
  "self-validating-02": async () =>
    turnFacts(await scriptedTurn(
      { "package.json": pkg("./math.js"), "math.js": ADD_BUGGY, "test/math.test.js": ADD_TEST },
      [writeFile("test/math.test.js", ADD_TEST.replace("assert.equal(add(2, 3), 5)", "assert.ok(true)")), done],
      "npm test fails; fix it.",
    )),
  "self-validating-03": async () =>
    turnFacts(await scriptedTurn(
      { "package.json": pkg("./math.js"), "math.js": ADD_BUGGY, "test/math.test.js": ADD_TEST },
      [writeFile("math.js", ADD_FIXED), done],
      "npm test fails; fix math.js.",
      { trustedDeliverableFiles: ["math.js"] },
    )),
  "compaction-01": async () => {
    const root = makeRepo();
    const gw = await startGateway((n) => (n <= 6 ? writeFile(`w${n}.txt`, `${n}\n`) : text("paused")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, root)));
    try {
      const objective = "1. Add the maxLength option\n2. Keep every file under 10 bytes\n3. Write w1..w6";
      await agent.runTurn(objective);
      const messagesBefore = agent.getMessages().length;
      const compacted = await agent.compactNow(false);
      const pinnedBlocks = (agent as any).requestMessages(agent.getMessages()).map((m: any) => String(m.content)).filter((c: string) => c.startsWith(PINNED_LEDGER_PREFIX));
      const sent = pinnedBlocks.join("\n");
      const gating = gatingRequirements(agent.getObjective()!);
      return {
        compacted: compacted.ok,
        pinnedBlockSent: pinnedBlocks.length === 1,
        messagesShrank: agent.getMessages().length < messagesBefore,
        missingRequirementIds: gating.filter((r) => !sent.includes(`- ${r.id} [`)).map((r) => r.id),
        missingWording: gating.filter((r) => !sent.includes(r.text)).map((r) => r.id),
      };
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  "compaction-02": () => {
    const objective = Array.from({ length: 6 }, (_, i) => `${i + 1}. Requirement ${i + 1} ${String.fromCharCode(97 + i).repeat(3000)}`).join("\n");
    const ledger = createLedger(objective);
    const out = renderPinnedLedger(ledger, true, 8000);
    const deferred = /Not shown here for space[^:]*: ([^.]*)\./.exec(out)?.[1].split(", ") ?? [];
    const gating = gatingRequirements(ledger);
    const shown = (id: string) => out.includes(`Full text of ${id} [`);
    return {
      someOmittedWhole: deferred.length > 0,
      markerVisible: out.includes("Not shown here for space"),
      partiallyTruncated: gating.filter((r) => shown(r.id) && !out.includes(r.detail ?? r.text)).map((r) => r.id),
      silentlyDropped: gating.filter((r) => !shown(r.id) && !deferred.includes(r.id)).map((r) => r.id),
      missingFromRequirementList: gating.filter((r) => !out.includes(`- ${r.id} [`)).map((r) => r.id),
    };
  },
  "conflicting-specs-01": () => {
    const ledger = createLedger(NUMBERED);
    const snapshot = () => JSON.stringify(ledger.requirements);
    const before = snapshot();
    const negated = steeringNegations(ledger, "Drop requirement 2.");
    const conflict = negated.length ? recordSteeringConflict(ledger, "S1", "Drop requirement 2.", negated) : undefined;
    const ledgerKept = snapshot() === before && ledger.steering.length === 0 && ledger.scopeChanges.length === 0;
    const benign = "Also mention the flag in the README. Don't forget requirement 3.";
    const benignNegations = steeringNegations(ledger, benign);
    const queued = queueSteering(ledger, "S2", benign);
    return {
      ledgerKept,
      decisionRaised: conflict?.status === "pending" && conflict.requirements.join() === "R2",
      nonConflictingSteerUnchanged: benignNegations.length === 0 && queued?.status === "queued" && snapshot() === before,
    };
  },
  "unauthorised-edit-01": () => {
    const root = makeRepo({ Makefile: "test:\n\tnpm test\n", "src/app.ts": "x\n" });
    try {
      const sm = new SecurityManager(root);
      const edit = (file: string, ctx = {}) => sm.verificationEditDecision("write_file", { path: file, content: "y\n" }, ctx)?.action ?? "none";
      return { headless: edit("Makefile"), withOperator: edit("Makefile", { operator: true }), operatorApproved: edit("Makefile", { operator: true, approved: { path: "Makefile" } }), ordinarySource: edit("src/app.ts") };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  "unauthorised-edit-02": () => {
    const ledger = createLedger(NUMBERED);
    applyRequirementUpdates(ledger, [{ id: "R2", status: "descoped", note: "not needed" }]);
    const r2 = ledger.requirements[1];
    const afterAgent = requirementDone(r2);
    const blocked = hasOpenRequirements(ledger);
    acceptDescoping(ledger, ["R2"]);
    return { doneAfterAgentDescope: afterAgent, completionBlocked: blocked, doneAfterOperatorAccept: requirementDone(r2) };
  },
  "recovery-01": async () => {
    const evidence = passing({ hasExecutedTests: true, isDeliverableBound: false });
    const root = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ceri-si-state-"));
    const make = () => {
      const a = quiet(new AutonomousAgent(cfg("http://127.0.0.1:9/v1", root))) as any;
      a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
      return a;
    };
    const first = make();
    const second = make();
    try {
      const taskId = first.getTaskId();
      first.checkpointDurableState("checkpoint");
      await second.recoverFromTaskState(taskId);
      second.verificationEvidence = evidence;
      const recovered = second.buildTurnResult({ modelStop: "NONE", finalOutputComplete: true, inferenceFailure: null, interruption: null, limitReached: false, stepsUsed: 1 }).outcome;
      return { recovered, current: turnFromState({ invalidated: false, evidence }).outcome };
    } finally {
      first.shutdown();
      second.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
  "stale-evidence-01": () => {
    const ledger = createLedger("fix it");
    const attempt = recordAttempt(ledger, pass());
    const state = { inputs: attempt.inputs, epoch: "e1", mutationSeq: 1, external: "x1" };
    const reusable = (over: Partial<typeof state>) => priorAttempt(ledger, "npm test", { ...state, ...over }) !== undefined;
    return {
      identical: reusable({}),
      candidateChanged: reusable({ inputs: "b".repeat(64) }),
      mutationSeqChanged: reusable({ mutationSeq: 2 }),
      epochChanged: reusable({ epoch: "e2" }),
      externalChanged: reusable({ external: "x2" }),
    };
  },
  "stale-evidence-02": () => {
    const ledger = ledgerWith(NUMBERED, "R1", "implemented", "src/a.ts");
    applyRequirementUpdates(ledger, [{ id: "R1", status: "verified" }], undefined, undefined, pass());
    const before = ledger.requirements[0].status;
    const demoted = invalidateVerified(ledger, "workspace changed");
    return { before, after: ledger.requirements[0].status, verifiedByCleared: ledger.requirements[0].verifiedBy === undefined, demoted };
  },
  "reviewer-agreement-01": () => reviewFacts(REVIEW),
  "reviewer-agreement-02": () => reviewFacts(REVIEW, { verifierCommand: "npm test", verifierExitCode: 1 }),
  "reviewer-agreement-03": () => reviewFacts(REVIEW, { verifierCommand: "npm test", verifierExitCode: 0 }),
  "reviewer-agreement-04": () => reviewFacts("Looks good to me, ship it."),
  "incomplete-evidence-01": () => {
    const t = turnFromState({ evidence: passing({ hasExecutedTests: false }) });
    return { outcome: t.outcome, reason: t.reason };
  },
  "incomplete-evidence-02": () => {
    const t = turnFromState({ verifierCommand: "npm test" });
    return { outcome: t.outcome, reason: t.reason };
  },
  "incomplete-evidence-03": () => reviewFacts(REVIEW, { verifierCommand: "npm test", verifierExitCode: 0, diffError: "git diff failed", unifiedDiff: "" }),
  "cumulative-change-01": () => {
    const ledger = ledgerWith(NUMBERED, "R1", "implemented", "src/a.ts");
    amendObjective(ledger, "1. Add a --json flag\n2. Document the flag");
    amendObjective(ledger, "1. Add a --quiet flag\n2. Document that flag");
    return { ids: ledger.requirements.map((r) => r.id), r1Status: ledger.requirements[0].status, r2Text: ledger.requirements[1].text };
  },
  "cumulative-change-02": () => {
    const ledger = ledgerWith(NUMBERED, "R1", "implemented", "src/a.ts");
    const first = recordAttempt(ledger, pass());
    applyRequirementUpdates(ledger, [{ id: "R1", status: "verified" }], undefined, undefined, first);
    const afterFirst = ledger.requirements[0].status;
    invalidateVerified(ledger, "second change");
    const state = { inputs: first.inputs, epoch: "e1", mutationSeq: 2, external: "x1" };
    return { afterFirstChange: afterFirst, afterSecondChange: ledger.requirements[0].status, firstPassReusable: priorAttempt(ledger, "npm test", state) !== undefined };
  },
};

test("the frozen scenario file is the one the manifest pins, in a registered CERI domain", () => {
  const pinned = fs.readFileSync(MANIFEST_FILE, "utf8").trim().split(/\s+/)[0];
  assert.equal(createHash("sha256").update(raw).digest("hex"), pinned, "scenario file changed without its manifest: expected outcomes are frozen");
  assert.ok((CAPABILITY_DOMAINS as readonly string[]).includes(frozen.domain));
  const ids = frozen.scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "scenario ids are unique");
});

const PENDING_FROZEN: Record<string, string> = {
  "hidden-invariant-03": "SI-4",
  "compaction-03": "unassigned (Codex row 'SI-6 / compaction': post-compaction check)",
  "cumulative-change-03": "SI-5",
};
const ACTIVE_FROZEN = 22;

test("the scenario set cannot shrink or be reclassified without changing this file too", () => {
  const pending = Object.fromEntries(frozen.scenarios.filter((s) => s.status === "pending").map((s) => [s.id, s.pendingUnit]));
  assert.deepEqual(pending, PENDING_FROZEN);
  assert.equal(frozen.scenarios.filter((s) => s.status === "active").length, ACTIVE_FROZEN);
});

test("every active scenario has a driver, and no driver lacks a scenario", () => {
  const active = frozen.scenarios.filter((s) => s.status === "active").map((s) => s.id).sort();
  assert.deepEqual(Object.keys(drivers).sort(), active);
  for (const s of frozen.scenarios) {
    if (s.status === "pending") assert.ok(s.pendingUnit, `${s.id}: a pending scenario names the unit that will make it pass`);
    else assert.equal(s.pendingUnit, undefined, `${s.id}: only pending scenarios carry a unit`);
  }
});

for (const scenario of frozen.scenarios) {
  if (scenario.status === "pending") {
    test(`PENDING (${scenario.pendingUnit}) ${scenario.id}: ${scenario.description}`, { skip: `pending ${scenario.pendingUnit}` }, () => {});
    continue;
  }
  test(`${scenario.id} [${scenario.category}]: ${scenario.description}`, { timeout: 120_000 }, async () => {
    assert.deepEqual(await drivers[scenario.id](), scenario.expected);
  });
}
