/** Bounded, network-free package health checks used before/after switching and recovery. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// A separate supervisor keeps a timer running while the synchronous caller waits.
// The executable gets its own process group, so timeout kills shell descendants too.
const SUPERVISOR = `
const {spawn}=require('node:child_process');
const child=spawn(process.argv[1],process.argv.slice(3),{detached:true,stdio:['ignore','pipe','pipe']});
let expired=false,bytes=0;
const kill=()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}};
const timer=setTimeout(()=>{expired=true;kill()},Number(process.argv[2]));
for(const [input,output] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]) input.on('data',d=>{bytes+=d.length;if(bytes>1048576){expired=true;kill()}else output.write(d)});
child.on('error',()=>{clearTimeout(timer);process.exitCode=1});
child.on('close',code=>{clearTimeout(timer);kill();process.exitCode=expired?124:(code??1)});
`;
export function boundedPackageProbe(executable: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): { ok: boolean; stdout: string; error?: string } {
  const limit = Math.max(50, Math.min(timeoutMs, 30000));
  const result = spawnSync(process.execPath, ["-e", SUPERVISOR, executable, String(limit), ...args], {
    env, encoding: "utf8", timeout: limit + 2000, maxBuffer: 2 * 1024 * 1024,
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout || "", error: result.error?.message || (result.status === 0 ? undefined : `runtime probe failed (exit ${result.status})`) };
}
export function verifyInstalledRuntime(root: string, expectedVersion: string, timeoutMs = 5000): { healthy: boolean; error?: string } {
  const absolute = path.resolve(root);
  const required = ["VERSION", "bin/nexus", "lib/core/harness-core", "lib/core/nexus-tui", "lib/cli/dist/index.js"];
  try {
    if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isDirectory()) throw new Error("installation root is not a real directory");
    for (const relative of required) {
      const file = path.join(absolute, relative);
      if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error(`missing or redirected runtime ${relative}`);
      if (relative === "bin/nexus" || relative.startsWith("lib/core/")) fs.accessSync(file, fs.constants.X_OK);
    }
    const normalized = expectedVersion.replace(/^[vV]/, "");
    const legacy = ["0.1.0-alpha.1", "0.1.0-alpha.2"].includes(normalized);
    // These exact components were inspected from the official historical
    // release assets and bound to their published SHA256SUMS. They shipped
    // core 1.2.1 and predate the TUI --version protocol.
    if (legacy) {
      const hashes:Record<string,string> = {
        "bin/nexus":"408f0b08ad8596d143b89a6f88d9d206de8f608c9715f5de8cae10a0432bda94",
        "lib/core/harness-core":"60e4266f43e944bcb64ac5258b96f1516b80874a3f5033322aa577c9794209f6",
        "lib/core/nexus-tui":"3075bee74abc5c6810cb65add2b5b43f9fa78fe55aecc24f0760af3ef436b327",
      };
      for (const [relative, digest] of Object.entries(hashes)) if (crypto.createHash("sha256").update(fs.readFileSync(path.join(absolute,relative))).digest("hex") !== digest) throw new Error(`Historical component does not match official release: ${relative}`);
      if (JSON.parse(fs.readFileSync(path.join(absolute,"lib/cli/package.json"),"utf8")).version !== normalized) throw new Error("Historical CLI package version mismatch");
    }

    if (fs.readFileSync(path.join(absolute, "VERSION"), "utf8").trim().replace(/^[vV]/, "") !== normalized) throw new Error("VERSION does not match expected release");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-upgrade-health-"));
    try {
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".local/state"), NEXUS_HOME: absolute, NEXUS_UPGRADE_HEALTH_CHECK: "1" };
      const version = boundedPackageProbe(path.join(absolute, "bin/nexus"), ["--version"], timeoutMs, env);
      const reported = version.stdout.trim().match(/^(?:Nexus(?: Code)?\s+)?[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s+\([^\n]*\))?$/i);
      if (!version.ok || reported?.[1] !== normalized) throw new Error(version.error || "launcher reported a different or invalid release version");
      const matchesVersion = (text:string, expected = normalized) => text.trim().match(/(?:^|\s)[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)?.[1] === expected;
      const coreVersion = boundedPackageProbe(path.join(absolute, "lib/core/harness-core"), ["--version"], timeoutMs, env);
      if (!coreVersion.ok || !matchesVersion(coreVersion.stdout, legacy ? "1.2.1" : normalized)) throw new Error("core reported a different or invalid release version");
      if (!legacy) {
        const tuiVersion = boundedPackageProbe(path.join(absolute, "lib/core/nexus-tui"), ["--version"], timeoutMs, env);
        if (!tuiVersion.ok || !matchesVersion(tuiVersion.stdout)) throw new Error("TUI reported a different or invalid release version");
      }
      const core = boundedPackageProbe(path.join(absolute, "lib/core/harness-core"), ["--help"], timeoutMs, env);
      if (!core.ok) throw new Error(`core ${core.error}`);
      const snapshot = path.join(home, "snapshot.json");
      fs.writeFileSync(snapshot, JSON.stringify({ model:"upgrade-health", workspace:home, task_id:"upgrade-health", objective:"package health", activity:[], plan:[], validation:null, context:"0 messages", status:"IDLE", theme:"default" }));
      const tui = boundedPackageProbe(path.join(absolute, "lib/core/nexus-tui"), ["--plain", snapshot], timeoutMs, env);
      if (!tui.ok || !tui.stdout.includes("NEXUS")) throw new Error(tui.error || "TUI did not render its package health snapshot");
      return { healthy:true };
    } finally { fs.rmSync(home, { recursive:true, force:true }); }
  } catch (error: any) { return { healthy:false, error:error.message }; }
}
