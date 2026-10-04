import { RustCoreBridge } from "/tmp/inv/cli/dist/tools.js";
import { execSync } from "node:child_process";
const b = new RustCoreBridge("/tmp/inv/ws", "bash");
const t = () => Math.round((Date.now() - T0) / 100) / 10;
const alive = (pat) => { try { return execSync(`pgrep -f '${pat}' | wc -l`).toString().trim(); } catch { return "0"; } };
let T0 = Date.now();
const run = async (label, args) => { const s = Date.now(); const r = await b.executeTool("run_command", args); console.log(label, `after ${((Date.now()-s)/1000).toFixed(1)}s`, "success=", r.success, "error=", r.error ? r.error.slice(0,80) : null, "output=", (r.output||"").slice(0,200).replace(/\n/g," ")); return r; };
const which = process.argv[2];
if (which === "E2") {
  // Rust-side timeout (2s) with a backgrounded descendant that holds the pipe for 20s
  await run("E2 rust-timeout+descendant", { command: "echo partial-before-timeout; bash -c 'sleep 20' & sleep 20", timeout_secs: 2 });
  console.log("sleep processes alive right after return:", alive("sleep 20"));
}
if (which === "E1") {
  // no timeout_secs: JS 35s default vs Rust 60s default
  await run("E1 default-timeouts (sleep 45)", { command: "echo started; sleep 45; touch /tmp/inv/ws/finished.marker" });
  console.log("sleep 45 alive after JS timeout:", alive("sleep 45"));
  const s = Date.now(); await run("E1b next request right after (echo hi)", { command: "echo hi" });
  console.log("next request waited", ((Date.now()-s)/1000).toFixed(1), "s");
}
b.shutdown?.(); process.exit(0);
