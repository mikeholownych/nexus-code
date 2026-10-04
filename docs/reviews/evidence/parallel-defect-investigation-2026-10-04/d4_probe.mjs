import http from "node:http"; import fs from "node:fs";
import { AutonomousAgent } from "/tmp/inv/cli/dist/agent.js";
import { ApplicationCore } from "/tmp/inv/cli/dist/core/app.js";
let requests = 0, bodies = [];
const srv = http.createServer((req, res) => { let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ if (req.url.endsWith("/models")) { res.end(JSON.stringify({data:[{id:"m"}]})); return; }
  requests++; const j=JSON.parse(b); bodies.push(j.messages.length);
  res.writeHead(200,{"content-type":"text/event-stream"});
  const big = requests===1 && process.argv[2]==="grow";
  const delta = big ? {tool_calls:[{index:0,id:"c1",type:"function",function:{name:"read_file",arguments:JSON.stringify({path:"big.txt"})}}]} : {content:"ok"};
  res.write("data: "+JSON.stringify({choices:[{delta,finish_reason:big?"tool_calls":"stop"}]})+"\n\ndata: [DONE]\n\n"); res.end(); });});
await new Promise(r=>srv.listen(0,"127.0.0.1",r)); const port=srv.address().port;
fs.mkdirSync("/tmp/inv/ws4",{recursive:true}); fs.writeFileSync("/tmp/inv/ws4/big.txt","word ".repeat(40000));
const limit = Number(process.argv[3]||15000);
const cfg = { endpoint:`http://127.0.0.1:${port}/v1`, model:"m", maxSteps:5, temperature:0, workspace:"/tmp/inv/ws4", shell:"bash", contextLimit:limit };
process.env.HOME="/tmp/inv/home"; fs.mkdirSync("/tmp/inv/home",{recursive:true});
const app = new ApplicationCore(cfg); const agent = app.getAgent();
const show = (l)=>{ const m=agent.getMessages(); console.log(l.padEnd(34), "messages:", m.map(x=>x.role[0]).join(""), "| gateway requests:", requests); };
show("initial");
const r1 = await app.runTask("first objective: do the thing", {quiet:true});
console.log("runTask result:", r1.turn.execution, r1.turn.outcome, r1.turn.reason, (r1.turn.detail||"").slice(0,60), "| success", r1.success, "exit", r1.exitCode, "| error:", (r1.error||"").slice(0,70));
show("after failed turn 1");
for (let i=2;i<=3;i++){ try { await agent.runTurn(`retry ${i}`); } catch(e){ console.log(`retry ${i} threw:`, e.name); } show(`after retry ${i}`); }
const rep = await agent.compactConversation(false); console.log("/compact ->", rep); show("after /compact");
try { await agent.runTurn("after compact"); } catch(e){ console.log("post-compact turn threw:", e.name); } show("after post-compact turn");
agent.resetConversation(); show("after /clear (resetConversation)");
try { const r = await agent.runTurn("after clear"); console.log("post-clear turn:", r.execution, r.reason||""); } catch(e){ console.log("post-clear threw:", e.name); } show("after post-clear turn");
console.log("saved task state status:", app.getTaskState().status, "| lastTurn:", app.getTaskState().lastTurn?.execution);
app.shutdown(); srv.close(); process.exit(0);
