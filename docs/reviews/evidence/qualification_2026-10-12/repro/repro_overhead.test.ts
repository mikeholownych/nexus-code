import { test } from "node:test";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, makeHome } from "./helpers/fixtures.js";

test("first-request overhead", async () => {
  const gw = await startGateway(() => ({ kind: "text", content: "hi" }));
  const repo = makeRepo();
  const home = makeHome();
  process.env.HOME = home;
  const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 30, temperature: 0, workspace: repo, shell: "bash", continuation: { ...DEFAULT_CONTINUATION } } as HarnessConfig);
  const server = new SidecarServer({ app, mode: "auto", write: () => {}, historyFile: path.join(home, "h") });
  server.start();
  await server.handleLine(JSON.stringify({ v: 1, type: "prompt.submit", id: "t1", text: "hello" }));
  await server.idle();
  const body: any = gw.requests[0];
  const sys = body.messages.filter((m: any) => m.role === "system").map((m: any) => String(m.content)).join("");
  const tools = JSON.stringify(body.tools ?? []);
  console.log("OVERHEAD", JSON.stringify({ tools: (body.tools ?? []).length, systemChars: sys.length, toolSchemaChars: tools.length, totalBodyChars: JSON.stringify(body).length, estTokensAt4CharsPerToken: Math.round(JSON.stringify(body).length / 4), toolNames: (body.tools ?? []).map((t: any) => t.function.name) }));
  app.shutdown();
  await gw.close();
});
