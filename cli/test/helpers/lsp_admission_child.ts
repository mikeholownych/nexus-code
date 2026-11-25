import { createInterface } from "node:readline";
import { LspBridgeManager } from "../../src/lsp.js";
import { SharedResourceAdmission } from "../../src/core/shared_resource_admission.js";

const [workspace, admissionDirectory, fakeServer, scenarioFile] = process.argv.slice(2);
if (!workspace || !admissionDirectory || !fakeServer || !scenarioFile) throw new Error("missing LSP admission worker arguments");

const manager = new LspBridgeManager(workspace, {
  servers: { ".ts": { cmd: process.execPath, args: [fakeServer, scenarioFile], languageId: "typescript" } },
  sharedAdmission: new SharedResourceAdmission(admissionDirectory, { operatorMaxUnits: 1 }),
  sharedServerLimit: 1,
  timings: { startMs: 500, coldStartMs: 0 },
});

async function query(): Promise<void> {
  const client = await manager.getClientForFile("a.ts");
  const result = client
    ? { status: "started", pid: client.pid() }
    : { status: "refused", detail: manager.serverStatus("a.ts")?.detail };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const input = createInterface({ input: process.stdin });
await query();
for await (const line of input) {
  if (line === "retry") await query();
  else if (line === "close") {
    await manager.shutdownAll();
    input.close();
    process.stdin.destroy();
    break;
  }
}
