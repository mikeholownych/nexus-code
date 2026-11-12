// D-15: `/resume` with no argument must not reload the session the operator is already in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { routeSlash } from "../src/slash/router.js";
import type { SlashHost, SlashReply } from "../src/slash/catalog.js";

function rig(current: string, ids: string[]) {
  const asked: Array<string | undefined> = [];
  const host = {
    sessionId: () => current,
    app: {
      getSessionManager: () => ({
        listSessions: () => ids.map((id) => ({ id, title: id, updatedAt: "2026-11-07T19:21:59Z", workspace: "/w", messageCount: 3 })),
      }),
    },
    resumeSession: (id?: string) => {
      asked.push(id);
      return { ok: true, message: `Resumed session ${id}.` };
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
