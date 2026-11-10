/**
 * v1.1.4 gate I-3: one session reports the same approval mode, read-only flag, context tokens used, context limit,
 * model, endpoint kind and session id on every surface. The REPL's /status and the sidecar's session.state event
 * (the TUI status line renders that event) are driven over one session and compared field by field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { InteractiveRepl } from "../src/repl.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome } from "./helpers/fixtures.js";

const ANSI = /\u001b\[[0-9;]*m/g;

/** What the REPL's /status prints, read back as the six fields (a field that is not printed comes back undefined). */
function replSurface(output: string) {
  const text = output.replace(ANSI, "");
  const pick = (re: RegExp) => text.match(re)?.[1];
  const tokens = pick(/^CONTEXT\s+(\d+) of \d+ tokens$/m);
  const limit = pick(/^CONTEXT\s+\d+ of (\d+) tokens$/m);
  return {
    mode: pick(/^mode: (\S+)/m),
    read_only: pick(/^READ-ONLY\s+(yes|no)$/m),
    context_tokens: tokens === undefined ? undefined : Number(tokens),
    context_limit: limit === undefined ? undefined : Number(limit),
    model: pick(/^MODEL\s+(.+?)(?:\s{2}·\s.*)?$/m),
    endpoint_kind: pick(/^RUNTIME\s+\S+\s+\((local|cloud)\)/m),
    session: pick(/^session (\S+) ·/m),
  };
}

async function agree(provider: string | undefined, expectedModel: string) {
  const gw = await startGateway(() => ({ kind: "text", content: "Done." }));
  const repo = makeRepo();
  const home = makeHome();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const realLog = console.log;
  const capture = (fn: () => void): string => {
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try { fn(); } finally { console.log = realLog; }
    return logs.join("\n");
  };
  try {
    const app = new ApplicationCore({ endpoint: gw.url, model: "m", ...(provider ? { provider } : {}), maxSteps: 6, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION }, approvalMode: "read-only", readOnly: true } as HarnessConfig);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "read-only", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history") });
    server.start();
    // Some conversation (saved under the sidecar's session), so context tokens are not just the empty-session baseline.
    await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "Say done." }));
    await server.idle();

    // The same session through the sidecar: its latest session.state event.
    const saved = events.filter((e) => e.type === "session.state").at(-1);
    assert.ok(saved?.session, "the sidecar emitted a session.state event naming its session");

    // The same session through the REPL: it resumes the saved session by id and reports the id it holds itself.
    const repl = new InteractiveRepl(app, "read-only", saved.session);
    // Resuming reloads the conversation into the shared agent, so the sidecar reports again over what the REPL now holds.
    (server as any).emitSessionState();
    const state = events.filter((e) => e.type === "session.state").at(-1);
    const repl_ = replSurface(capture(() => (repl as any).printStatus(true)));

    const sidecar_ = {
      mode: state.mode,
      read_only: state.read_only === undefined ? undefined : state.read_only ? "yes" : "no",
      context_tokens: state.context_tokens,
      context_limit: state.context_limit,
      model: state.model,
      endpoint_kind: state.endpoint_kind,
      session: state.session,
    };

    for (const field of ["mode", "read_only", "context_tokens", "context_limit", "model", "endpoint_kind", "session"] as const) {
      assert.notEqual(repl_[field], undefined, `REPL /status reports ${field}`);
      assert.notEqual(sidecar_[field], undefined, `sidecar session.state reports ${field}`);
      assert.deepEqual(repl_[field], sidecar_[field], `${field}: REPL /status says ${repl_[field]}, sidecar session.state says ${sidecar_[field]}`);
    }
    // And they are the session's real values, not two copies of one wrong default.
    assert.equal(sidecar_.mode, "read-only");
    assert.equal(sidecar_.read_only, "yes");
    assert.ok((sidecar_.context_tokens as number) > 0, "a conversation has taken context");
    assert.ok((sidecar_.context_limit as number) >= (sidecar_.context_tokens as number));
    assert.equal(sidecar_.model, expectedModel);
    assert.equal(sidecar_.endpoint_kind, "local");
    assert.ok(typeof sidecar_.session === "string" && sidecar_.session.length > 0);
    // The non-verbose header keeps the bare model it always printed.
    assert.match(capture(() => (repl as any).printStatus(false)).replace(ANSI, ""), /^MODEL\s+m(?:\s{2}·.*)?$/m);

    await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
    await server.idle();
    app.shutdown();
  } finally {
    console.log = realLog;
    await gw.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("I-3: REPL /status and sidecar session.state agree on the six fields for one session", async () => {
  await agree(undefined, "m");
});

test("I-3: the same holds for a provider session, whose model reads \"provider · model\"", async () => {
  await agree("compatible", "compatible · m");
});
