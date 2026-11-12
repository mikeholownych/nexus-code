// D-15: `/resume` with no argument must not reload the session the operator is already in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { routeSlash } from "../src/slash/router.js";
import type { SlashHost, SlashReply } from "../src/slash/catalog.js";

type Sess = string | { id: string; workspace: string; broken?: boolean };

function rig(current: string, sessions: Sess[], workspace = "/w") {
  const asked: Array<string | undefined> = [];
  const list = sessions.map((x) => (typeof x === "string" ? { id: x, workspace, broken: false } : { broken: false, ...x }));
  const host = {
    sessionId: () => current,
    app: {
      getConfig: () => ({ workspace }),
      getSessionManager: () => ({
        listSessions: () => list.map((x) => ({ id: x.id, title: x.id, updatedAt: "2026-11-07T19:21:59Z", workspace: x.workspace, messageCount: 3 })),
      }),
    },
    resumeSession: (id?: string) => {
      asked.push(id);
      const hit = list.find((x) => x.id === id);
      return hit?.broken ? { ok: false, message: `Session not found: ${id}` } : { ok: true, message: `Resumed session ${id}.` };
    },
  } as unknown as SlashHost;
  const run = async (args = "") => (await routeSlash(host, "resume", args, new AbortController().signal)) as SlashReply;
  return { asked, run };
}

test("D-15: /resume with no argument resumes the most recent OTHER session, never the current one", async () => {
  const { asked, run } = rig("cur", ["cur", "older", "oldest"]);
  const out = await run();
  assert.deepEqual(asked, ["older"]);
  assert.equal(out.success, true);
});

test("D-15: /resume with no argument and no other session says so and resumes nothing", async () => {
  const { asked, run } = rig("cur", ["cur"]);
  const out = await run();
  assert.deepEqual(asked, []);
  assert.equal(out.success, false);
  assert.match(out.output, /no other saved session/i);
  assert.match(out.output, /\/resume <id>|\/sessions/);
});

test("D-15: /resume with no argument and nothing saved says so", async () => {
  const { asked, run } = rig("cur", []);
  const out = await run();
  assert.deepEqual(asked, []);
  assert.equal(out.success, false);
});

test("D-15: an explicit id or 'latest' is passed through unchanged (including the current session)", async () => {
  const { asked, run } = rig("cur", ["cur", "older"]);
  await run("cur");
  await run("latest");
  assert.deepEqual(asked, ["cur", "latest"]);
});

test("D-15: the newest session belongs to another workspace: the older one of this workspace resumes", async () => {
  const { asked, run } = rig("cur", ["cur", { id: "foreign", workspace: "/other" }, "mine"]);
  const out = await run();
  assert.deepEqual(asked, ["mine"], "the other workspace's record is never asked for");
  assert.equal(out.success, true);
});

test("D-15: only other workspaces' sessions exist: the message says none in this workspace", async () => {
  const { asked, run } = rig("cur", ["cur", { id: "foreign", workspace: "/other" }]);
  const out = await run();
  assert.deepEqual(asked, []);
  assert.equal(out.success, false);
  assert.match(out.output, /no other saved session in this workspace/i);
});

test("D-15: a newest session that cannot be loaded falls through to the next, naming the one skipped", async () => {
  const { asked, run } = rig("cur", ["cur", { id: "bad", workspace: "/w", broken: true }, "good"]);
  const out = await run();
  assert.deepEqual(asked, ["bad", "good"]);
  assert.equal(out.success, true);
  assert.match(out.output, /Resumed session good/);
  assert.match(out.output, /skipped bad/);
});

test("D-15: every candidate unloadable: the honest message names them", async () => {
  const { run } = rig("cur", ["cur", { id: "bad1", workspace: "/w", broken: true }, { id: "bad2", workspace: "/w", broken: true }]);
  const out = await run();
  assert.equal(out.success, false);
  assert.match(out.output, /Could not load: bad1, bad2/);
});
