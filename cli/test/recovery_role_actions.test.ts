/**
 * The RECOVERY_REQUIRED context offers only actions the agent may take: a restricted role (reviewer, specialist) or
 * read-only mode refuses edits and commands at dispatch, and update_requirements exists only for agents that own the
 * ledger, so "Permitted next actions" must not point the agent at them. Checked on both renderings: the pinned ledger
 * sent with every request and the context built for the constrained note.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AutonomousAgent } from "../src/agent.js";
import { createLedger, renderRecoveryContext } from "../src/core/objective.js";
import { createTracking, ExecutionTracker } from "../src/core/execution_tracking.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-recovery-roles-"));
const OBJECTIVE = "Fix add so it returns the sum.";

function constrainedAgent(o: { role?: string; depth?: number; readOnly?: boolean }) {
  const agent = new AutonomousAgent(
    { endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash", role: o.role, readOnly: o.readOnly } as any,
    o.depth ?? 0,
  );
  const ledger = createLedger(OBJECTIVE);
  ledger.execution = createTracking();
  ledger.execution.recovery.stage = "constrained";
  (agent as any).objective = ledger;
  (agent as any).durable = true;
  return { agent, ledger };
}

/** The "Permitted next actions" lines of each rendering the agent produces. */
function permittedActions(agent: AutonomousAgent, ledger: { execution?: unknown }): string[] {
  const section = (text: string) => {
    const lines = text.split("\n");
    const at = lines.indexOf("Permitted next actions:");
    assert.ok(at >= 0, text);
    return lines.slice(at + 1, at + 3).join("\n");
  };
  const note = (agent as any).recoveryContext(new ExecutionTracker(ledger.execution as any), 30, OBJECTIVE) as string;
  const pinned = ((agent as any).requestMessages([{ role: "system", content: "sys" }, { role: "user", content: "later" }]) as any[])
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n");
  return [section(note), section(pinned)];
}

const ORIGINAL =
  "- Use the output already in this conversation; read lines or files not listed above; search for a specific symbol or string; edit files; run a build, test or command;\n" +
  '- record a finding or a blocker with update_requirements (status "blocked" with the reason); or finish with a final message reporting what you found.';

test("without a restriction the permitted actions are unchanged", () => {
  const t = createTracking();
  t.recovery.stage = "constrained";
  const text = renderRecoveryContext({ objective: OBJECTIVE, open: [], execution: t });
  assert.ok(text.includes(`Permitted next actions:\n${ORIGINAL}`), text);
  const { agent, ledger } = constrainedAgent({});
  for (const actions of permittedActions(agent, ledger)) assert.equal(actions, ORIGINAL);
});

test("reviewer and read-only specialist roles are not offered edits, commands or update_requirements", () => {
  for (const role of ["reviewer", "security_reviewer", "acceptance_reviewer", "semantic_explorer", "call_site_analyzer"]) {
    const { agent, ledger } = constrainedAgent({ role, depth: 1 });
    for (const actions of permittedActions(agent, ledger)) {
      assert.match(actions, /read lines or files not listed above; search for a specific symbol or string;/, role);
      assert.doesNotMatch(actions, /edit files|run a build|update_requirements/, `${role}: ${actions}`);
      assert.match(actions, /^- finish with a final message reporting what you found\.$/m, role);
    }
  }
});

test("failure_debugger may run commands but not edit; read-only mode removes both", () => {
  const debuggerAgent = constrainedAgent({ role: "failure_debugger", depth: 1 });
  for (const actions of permittedActions(debuggerAgent.agent, debuggerAgent.ledger)) {
    assert.match(actions, /run a build, test or command;/);
    assert.doesNotMatch(actions, /edit files|update_requirements/, actions);
  }
  const readOnly = constrainedAgent({ readOnly: true });
  for (const actions of permittedActions(readOnly.agent, readOnly.ledger)) {
    assert.doesNotMatch(actions, /edit files|run a build/, actions);
    assert.match(actions, /update_requirements/, "the top-level agent still owns its ledger");
  }
});

test("an implementer sub-agent keeps every action", () => {
  const { agent, ledger } = constrainedAgent({ role: "implementer", depth: 1 });
  for (const actions of permittedActions(agent, ledger)) assert.equal(actions, ORIGINAL);
});
