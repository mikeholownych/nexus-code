/**
 * Run as a process of its own by lsp_lifecycle.test.ts: starts the scripted fake through a manager, prints the server's
 * pid, and ends with process.exit WITHOUT waiting for any shutdown ("stopping": with one begun and dropped). What is left
 * to end the server is the manager's process-exit backstop.
 * argv: workspace, fake server script, scenario file, "running" | "stopping".
 */
import { LspBridgeManager } from "../../src/lsp.js";

const [workspace, fake, scenario, how] = process.argv.slice(2);
const mgr = new LspBridgeManager(workspace, { servers: { ".ts": { cmd: process.execPath, args: [fake, scenario], languageId: "typescript" } }, timings: { coldStartMs: 0 } });
await mgr.hover("a.ts", 1, 1);
process.stdout.write(`${mgr.serverPids()[0]}\n`);
if (how === "stopping") void mgr.shutdownAll();
process.exit(0);
