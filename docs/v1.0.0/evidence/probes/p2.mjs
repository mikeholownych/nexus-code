import { RustCoreBridge } from "/tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad/snap/cli/dist/tools.js";
const b = new RustCoreBridge("/tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad/repro/ws");
for (const u of ["http://localtest.me:18731/","http://[::ffff:127.0.0.1]:18731/"]) { const r = await b.executeTool("fetch_web",{url:u}); console.log(u, JSON.stringify(r).slice(0,200)); }
b.shutdown(); process.exit(0);
