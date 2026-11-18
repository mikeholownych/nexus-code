/**
 * VC-3 real executor: runs one command on one stdin input inside the product's sandbox (no network), with a 30 s
 * timeout and output capped at 1 MiB. If no sandbox engine is available the run is refused (an error, so the input is
 * inconclusive); a differential never runs unsandboxed.
 */
import { spawn } from "node:child_process";
import { wrapSandboxedCommand } from "../sandbox.js";
import { DIFFERENTIAL_MAX_OUTPUT_CHARS, type DifferentialExecutor } from "./regression_obligations.js";

export const DIFFERENTIAL_TIMEOUT_MS = 30_000;

export function sandboxedExecutor(workspace: string): DifferentialExecutor {
  return (command, input) => new Promise((resolve) => {
    const w = wrapSandboxedCommand(command, workspace, { network: false });
    if (!w.sandboxed || !w.argv?.length) return resolve({ exit: null, output: "", error: w.warning ?? "no sandbox engine available" });
    const child = spawn(w.argv[0], w.argv.slice(1), { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let capped = false;
    const take = (d: Buffer) => {
      output += d.toString("utf8");
      if (output.length > DIFFERENTIAL_MAX_OUTPUT_CHARS && !capped) { capped = true; child.kill("SIGKILL"); }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, DIFFERENTIAL_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ exit: null, output: "", error: String(e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit: code, output, timedOut, ...(capped ? { error: "output over the cap" } : {}) });
    });
  });
}
