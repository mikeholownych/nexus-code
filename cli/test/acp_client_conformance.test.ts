import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AcpStdioServer } from "../src/acp_stdio.js";
import { encodeMessage } from "../src/acp/jsonrpc.js";
import { startGateway, makeRepo, makeHome } from "./helpers/fixtures.js";

type CapturedExchange = {
  sequence: number;
  direction: "client_to_agent" | "agent_to_client";
  message: any;
};
type ClientFixture = {
  formatVersion: number;
  client: { name: string; version: string };
  exchange: CapturedExchange[];
};

function readFixture(name: string): ClientFixture {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/acp/clients/${name}`, import.meta.url), "utf8"));
}

function parseOutput(output: string[]): any[] {
  return output.flatMap((line) => line.trim() ? [JSON.parse(line)] : []);
}

async function until(output: string[], predicate: (items: any[]) => boolean): Promise<any[]> {
  // A real turn has been seen past 10 s under load.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const current = parseOutput(output);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ACP output; got ${JSON.stringify(parseOutput(output))}`);
}

async function replayClientFixture(name: string): Promise<void> {
  const fixture = readFixture(name);
  assert.equal(fixture.formatVersion, 1);
  const requests = fixture.exchange
    .filter((entry) => entry.direction === "client_to_agent" && typeof entry.message.method === "string")
    .map((entry) => structuredClone(entry.message));
  assert.deepEqual(requests.map((message) => message.method), ["initialize", "session/new", "session/prompt"]);

  const gateway = await startGateway(() => ({ kind: "text", content: "AC2 local fixture completed." }));
  const repo = makeRepo({ "README.md": "Disposable ACP conformance workspace.\n" });
  const home = makeHome();
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = `${home}/.config`;
  const output: string[] = [];
  let server: AcpStdioServer | undefined;
  try {
    server = new AcpStdioServer({
      config: {
        endpoint: gateway.url,
        model: "m",
        maxSteps: 4,
        temperature: 0,
        workspace: repo,
        shell: "bash",
        approvalMode: "read-only",
        readOnly: true,
      } as any,
      version: "fixture-replay",
      write: (line) => output.push(line),
    });
    const send = (message: object) => server!.push(Buffer.from(encodeMessage(message)));

    const initialize = requests[0];
    send(initialize);
    const initialized = await until(output, (items) => items.some((item) => item.id === initialize.id && item.result));
    const initializeReply = initialized.find((item) => item.id === initialize.id);
    assert.equal(initializeReply.result.protocolVersion, 1);

    const create = requests[1];
    create.params.cwd = repo;
    send(create);
    const created = await until(output, (items) => items.some((item) => item.id === create.id && item.result?.sessionId));
    const actualSessionId = created.find((item) => item.id === create.id).result.sessionId as string;
    assert.match(actualSessionId, /^session_/);

    const prompt = requests[2];
    prompt.params.sessionId = actualSessionId;
    send(prompt);
    const completed = await until(output, (items) => items.some((item) => item.id === prompt.id && item.result?.stopReason));
    const promptReply = completed.find((item) => item.id === prompt.id);
    assert.equal(promptReply.result.stopReason, "end_turn");
    assert.equal(promptReply.result._meta["nexus/verification"].execution, "COMPLETED");
    assert.ok(completed.some((item) => item.method === "session/update"
      && item.params.update.sessionUpdate === "agent_message_chunk"
      && item.params.update.content.text === "AC2 local fixture completed."));
    assert.ok(completed.some((item) => item.method === "session/update"
      && item.params.update.sessionUpdate === "session_info_update"
      && item.params.update._meta["nexus/verification"].execution === "COMPLETED"));
    assert.equal(gateway.requests.length, 1);

    const outputCount = output.length;
    await server.close();
    send({ jsonrpc: "2.0", id: "after-close", method: "session/new", params: { cwd: repo, mcpServers: [] } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(output.length, outputCount, "closed ACP connection must not emit another response");
  } finally {
    if (server) await server.close();
    await gateway.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
  }
}

for (const [name, file] of [
  ["CodeCompanion.nvim 20.3.0", "codecompanion-20.3.0.json"],
  ["Zed 1.29.3", "zed-1.29.3.json"],
] as const) {
  test(`captured ${name} ACP exchange replays through the real stdio adapter`, async () => {
    await replayClientFixture(file);
  });
}
