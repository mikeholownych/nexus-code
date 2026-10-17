import * as http from "node:http";
const SNAP = "/tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad/snap/cli/src";
const { LocalLlmClient } = await import(`${SNAP}/client.ts`);
const s = http.createServer((q, r) => { r.writeHead(500); r.end("upstream key=sk-ant-api03-" + "A".repeat(40) + " " + "x".repeat(200000)); });
await new Promise<void>(r => s.listen(0, "127.0.0.1", () => r()));
const c = new LocalLlmClient({ endpoint: `http://127.0.0.1:${(s.address() as any).port}/v1`, model: "m", apiKey: "local", workspace: "/tmp", maxSteps: 1 } as any);
try { await c.chatCompletionStream([{ role: "user", content: "hi" }], [], undefined, "r"); } catch (e: any) { console.log("message length:", e.message.length, "contains sk-ant:", e.message.includes("sk-ant-api03"), "kind:", e.kind, e.condition, e.execution); }
s.close(); process.exit(0);
