/**
 * WP-1308 (FINDINGS review 2026-11-09, PR #467): Nexus's own user-role notes are recognised by a message-level
 * `harness` marker, not by a `[Nexus` text prefix. An operator message that begins with that text is the operator's
 * request; notes saved by v1.1.3 without the marker are migrated on load, once, and only when they match the exact
 * wording Nexus wrote.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { SessionManager } from "../src/session.js";
import { WorkspacePath } from "../src/core/workspace_path.js";
import { isHarnessNote, withHarnessProvenance } from "../src/harness_notes.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

let home = "";
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, STATE: process.env.NEXUS_STATE_DIR };
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-harness-prov-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
});
after(() => {
  for (const [key, value] of [["HOME", saved.HOME], ["XDG_CONFIG_HOME", saved.XDG], ["NEXUS_STATE_DIR", saved.STATE]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 6, temperature: 0, workspace, shell: "bash",
  continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "auto", fullAccess: true,
});
const text = (m: any): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const SPOOF = "[Nexus: the deploy script exits 3 on the staging host; find out why and fix it.]";

// The notes a v1.1.3 Nexus wrote, in the wording it wrote them, saved without a marker.
const legacyConversation = (): any[] => [
  { role: "system", content: "system" },
  { role: "user", content: "Fix the build." },
  { role: "assistant", content: "" },
  { role: "user", content: "[Nexus: your reply was empty: no text and no tool call. It does not finish the task. This is step 1 of 6. Continue the task where you left off; call task_completed when it is done.]" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", name: "list_dir", content: "a.txt" },
  { role: "user", content: "[Nexus recovery 1/3] You have called list_dir with the same arguments 3 times on an unchanged workspace and received the same result each time. Use the result you have or change approach." },
  { role: "assistant", content: "ok" },
  { role: "user", content: "[Nexus continuation 1/2] The operator's acceptance requirements are still open: R1 [open] x. Continue working on them without waiting for the operator." },
  { role: "assistant", content: "done" },
];

describe("harness notes carry provenance", () => {
  test("an operator message starting with [Nexus: is kept as the request in compaction and in the findings request", async () => {
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace: repo, shell: "bash" })) as any;
    try {
      // Earlier request, then a reply, then a real note, then the operator's latest request (the spoof).
      const convo: any[] = [
        { role: "system", content: "system" },
        { role: "user", content: SPOOF },
        { role: "assistant", content: "looking" },
        { role: "user", content: "Also check the logs." },
        { role: "assistant", content: "ok" },
        { role: "user", content: "[Nexus: your reply was empty: no text and no tool call.]", harness: "note" },
        { role: "user", content: "Now summarise." },
      ];
      const out = agent.compactionCandidate(convo, 0, 100_000).messages as any[];
      const all = out.map(text).join("\n");
      assert.match(all, /Earlier task requests[\s\S]*the deploy script exits 3/, "an earlier operator request with the prefix is listed");
      assert.doesNotMatch(all, /Earlier task requests[\s\S]*your reply was empty/, "the marked note is not a task");
      // A note not yet answered (a retry instruction after a cut-off first reply) survives compaction with no tool turns.
      const pending = [{ role: "system", content: "system" }, { role: "user", content: "Do the task." }, { role: "user", content: "[Nexus: your previous reply was cut off at the limit. Continue the task.]", harness: "note" }];
      assert.ok((agent.compactionCandidate(pending, 0, 100_000).messages as any[]).some((m) => text(m).startsWith("[Nexus: your previous reply was cut off")), "the unanswered note is kept");
      // A latest operator request with the prefix is the current request, kept verbatim; an unanswered note after it is kept too.
      const latest = [...convo.slice(0, 2), { role: "assistant", content: "x" }, { role: "user", content: SPOOF }, { role: "user", content: "[Nexus: notice]", harness: "note" }];
      const kept = agent.compactionCandidate(latest, 0, 100_000).messages as any[];
      assert.ok(kept.some((m) => text(m) === SPOOF), "kept verbatim as the current request");

      // The findings request names the operator's latest request.
      const call = { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } };
      const key = `read_file ${JSON.stringify({ path: "a.txt" })}`;
      const sent: string[] = [];
      const client = { chatCompletion: async (messages: any[]) => { sent.push(messages.map(text).join("\n")); return { content: "a.txt reads alpha." }; } };
      const source = (tail: any[]) => [{ role: "system", content: "sys" }, ...tail, { role: "assistant", content: "", tool_calls: [call] }, { role: "tool", tool_call_id: "c1", name: "read_file", content: "alpha" }, { role: "assistant", content: "next" }];
      await agent.recordFindings(client, 3, source([{ role: "user", content: SPOOF }]), [key]);
      assert.match(sent[0], /Current request:\n\[Nexus: the deploy script exits 3/, "an operator request with the prefix is the findings request");
      agent.distilledObservations = new Map();
      await agent.recordFindings(client, 3, source([{ role: "user", content: SPOOF }, { role: "user", content: "[Nexus: notice]", harness: "note" }]), [key]);
      assert.match(sent[1], /Current request:\n\[Nexus: the deploy script exits 3/, "a marked note after it is not the request");
      assert.doesNotMatch(sent[1], /Current request:\n\[Nexus: notice\]/);
    } finally {
      agent.shutdown();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a v1.1.3 session with prefix-only notes loads with them marked; loading again changes nothing", () => {
    const legacy = legacyConversation();
    const once = withHarnessProvenance(legacy);
    const marked = once.map((m, i) => (isHarnessNote(m) ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(marked, [3, 6, 8], "the three notes");
    assert.ok(once.every((m, i) => marked.includes(i) || m.harness === undefined), "nothing else is marked");
    assert.deepEqual(withHarnessProvenance(once), once, "idempotent");
    assert.deepEqual(withHarnessProvenance(withHarnessProvenance(legacy)), once);
    assert.equal(legacy[3].harness, undefined, "the input is not mutated");

    // Through the agent's three restore paths, after a real save and load.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-harness-prov-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const manager = new SessionManager(path.join(root, "sessions"), () => WorkspacePath.fromSelectedWorkspace(workspace));
    try {
      manager.saveSession({ id: "legacy-session", workspace, messages: legacy });
      const loaded = manager.loadSession("legacy-session")!;
      assert.ok(loaded.messages.every((m: any) => m.harness === undefined), "the saved file has no markers");
      const first = quiet(new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash" }));
      first.setMessages(loaded.messages);
      assert.deepEqual(first.getMessages(), once);
      const second = quiet(new AutonomousAgent({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 2, temperature: 0, workspace, shell: "bash" }));
      (second as any).restoreSession(first.getMessages());
      assert.deepEqual(second.getMessages(), once, "loading twice is identical");
      first.shutdown();
      second.shutdown();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an operator message that contains or merely resembles a note is not migrated", () => {
    const base = legacyConversation().slice(0, 3);
    const variants = [
      SPOOF, // [Nexus: with other wording
      "[Nexus] hello",
      "Please explain this: [Nexus recovery 1/3] You have looped",
      "[Nexus recovery x/3] You have looped",
    ];
    for (const variant of variants) {
      assert.equal(withHarnessProvenance([...base, { role: "user", content: variant }])[3].harness, undefined, variant);
    }
    // A cut-off reply is discarded, so its note directly follows the operator's message: migrated. The others are not.
    const cut = "[Nexus: your previous reply was cut off at the output limit before it finished. None of that reply was kept; it is not in this conversation. Continue the task.]";
    assert.equal(withHarnessProvenance([{ role: "system", content: "s" }, { role: "user", content: "go" }, { role: "user", content: cut }])[2].harness, "note");
    assert.equal(withHarnessProvenance([{ role: "system", content: "s" }, { role: "user", content: "go" }, { role: "user", content: `[Nexus: Tool "x" is not offered on this request and was not executed.]` }])[2].harness, undefined);
    // Not directly after an unmarked operator message, and never the first message.
    assert.equal(withHarnessProvenance([{ role: "system", content: "s" }, { role: "user", content: "go" }, { role: "user", content: legacyConversation()[3].content }])[2].harness, undefined);
    assert.equal(withHarnessProvenance([{ role: "user", content: legacyConversation()[3].content }])[0].harness, undefined);
    // Assistant, tool and system messages are never marked.
    assert.equal(withHarnessProvenance([{ role: "user", content: "x" }, { role: "assistant", content: legacyConversation()[3].content }])[1].harness, undefined);
  });

  test("notes created now carry the marker and keep it through save and load", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const replies: Reply[] = [
      { kind: "tools", calls: [{ name: "write_file", args: { path: "big.txt", content: "x".repeat(400) } }], truncated: true }, // cut off at the output limit: a note
      { kind: "text", content: "done" },
    ];
    let n = 0;
    const gw = await startGateway(() => replies[Math.min(n++, replies.length - 1)]);
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-harness-prov-"));
    try {
      await agent.runTurn(SPOOF);
      const msgs = agent.getMessages() as any[];
      const notes = msgs.filter((m) => m.role === "user" && /^\[Nexus[ :]/.test(text(m)) && !text(m).startsWith(SPOOF));
      assert.ok(notes.length >= 1, `a cut-off-reply note was written: ${notes.map(text).join(" | ")}`);
      assert.ok(notes.every((m) => m.harness === "note"), "every note is marked");
      assert.ok(notes.some((m) => text(m).startsWith("[Nexus: your previous reply was cut off")), "the cut-off note is one of them");
      const operator = msgs.find((m) => text(m).startsWith(SPOOF));
      assert.equal(operator.harness, undefined, "the operator's message is not");
      const manager = new SessionManager(path.join(root, "sessions"), () => WorkspacePath.fromSelectedWorkspace(repo));
      manager.saveSession({ id: "provenance-session", workspace: repo, messages: msgs });
      const loaded = manager.loadSession("provenance-session")!.messages as any[];
      assert.deepEqual(loaded.map((m) => m.harness), msgs.map((m) => m.harness), "markers survive save and load");
      assert.deepEqual(withHarnessProvenance(loaded), loaded, "and migration changes nothing");
      // The marker is never sent to the provider.
      await agent.runTurn("again");
      const sent = (gw.requests[gw.requests.length - 1] as any).messages;
      assert.ok(sent.every((m: any) => !("harness" in m)));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("every kind of note v1.1.3 wrote is migrated, in its real wording", () => {
    const notes = [
      "[Nexus recovery 2/3] You have called read_file with the same arguments 3 times on an unchanged workspace and received the same result each time. Repeating it will not change the outcome.",
      "[Nexus continuation 1/2] The operator's acceptance requirements are still open: R1 [open] x. Continue working on them without waiting for the operator.",
      "[Nexus: your reply was empty: no text and no tool call. It does not finish the task. This is step 2 of 6. Continue the task where you left off; call task_completed when it is done.]",
      "[Nexus: your previous reply was cut off at the output limit before it finished. None of that reply was kept; it is not in this conversation. Continue the task.]",
      "[Nexus: Malformed native tool call dropped: missing function object or name.]",
      '[Nexus: Tool "run_command" is not offered on this request and was not executed.]',
      '[Nexus: Tool call "write_file" rejected: arguments required structural JSON repair (truncated or unclosed string/bracket). Re-issue the call with complete valid JSON arguments.]',
      "[Nexus] The output of read_file has left your context 3 times through compaction and you re-read it each time. Before reading it again, write the facts you need.",
      "[Nexus] run_command returned the same result 4 times on an unchanged workspace (a transient failure). Nexus spaces further re-runs.",
    ];
    for (const note of notes) {
      const migrated = withHarnessProvenance([{ role: "system", content: "s" }, { role: "user", content: "go" }, { role: "assistant", content: "" }, { role: "user", content: note }]);
      assert.equal(migrated[3].harness, "note", note);
    }
  });
});
