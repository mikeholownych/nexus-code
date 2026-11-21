/**
 * CS-10: with `--sandbox bwrap` (and `--sandbox` where Bubblewrap exists) the native worker itself runs inside the sandbox.
 * The worker can run any command, so each test acts as the compromised worker through the real RPC: what a worker
 * could read, write or reach is what its commands can. Every claim has an unsandboxed baseline proving the check is not
 * vacuous. Design: docs/v1.2.2/CS10_WORKER_ISOLATION.md.
 */
import "./helpers/leak_guard.js";
import { describe, test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RustCoreBridge, resolveCoreBinary } from "../src/tools.js";
import { isBwrapAvailable, setSandboxNetworkFlag } from "../src/sandbox.js";

const core = resolveCoreBinary();
const SKIP = !isBwrapAvailable() ? "bwrap is not installed on this host" : !core ? "the Rust core is not built" : false;

let root = "";
let home = "";
let workspace = "";
let outside = "";
let previousHome: string | undefined;
let previousPath: string | undefined;
const bridges: RustCoreBridge[] = [];

const bridge = (sandbox: boolean | string): RustCoreBridge => {
  const b = new RustCoreBridge(workspace, "bash", undefined, false, false, sandbox);
  bridges.push(b);
  return b;
};

/**
 * A command sent straight to the worker over RPC, skipping the CLI's per-command sandbox wrap. This is what a compromised
 * worker (or any command the worker runs on its own account) can do: it is confined only if the worker itself is.
 * Going through `executeTool` would test the older per-command wrap and could not tell the two apart.
 */
const sh = async (b: RustCoreBridge, command: string, extra: Record<string, unknown> = {}) => {
  const res = await (b as any).executeViaRpc("run_command", { command, shell: "bash", ...extra });
  let parsed: any = {};
  try {
    parsed = JSON.parse(res?.output || "{}");
  } catch {
    /* not JSON */
  }
  return { ...res, stdout: String(parsed.stdout ?? ""), stderr: String(parsed.stderr ?? ""), exit: parsed.exit_code as number | undefined };
};

before(() => {
  root = fs.mkdtempSync(path.join("/var/tmp", "nexus-cs10-"));
  home = path.join(root, "home");
  workspace = path.join(home, "ws");
  outside = path.join(root, "outside");
  for (const d of [workspace, outside, path.join(home, ".ssh"), path.join(home, ".config", "nexus")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_canary"), "PRIVATE-KEY-CANARY\n");
  fs.writeFileSync(path.join(home, ".config", "nexus", "config.env"), "LOCAL_LLM_API_KEY=canary-secret\n");
  fs.writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
  previousHome = process.env.HOME;
  previousPath = process.env.PATH;
  process.env.HOME = home;
});

afterEach(() => {
  for (const b of bridges.splice(0)) b.shutdown();
  setSandboxNetworkFlag(false);
  if (previousPath !== undefined) process.env.PATH = previousPath;
});

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the native worker inside the sandbox", { skip: SKIP }, () => {
  test("secrets under $HOME are readable by an unsandboxed worker and invisible to a sandboxed one", async () => {
    const plain = await sh(bridge(false), `cat ${home}/.ssh/id_canary; cat ${home}/.config/nexus/config.env`);
    assert.match(plain.stdout, /PRIVATE-KEY-CANARY/, "baseline: the unsandboxed worker reads the canary");
    assert.match(plain.stdout, /canary-secret/);
    const boxedWorker = bridge("bwrap");
    const boxed = await sh(boxedWorker, `cat ${home}/.ssh/id_canary 2>&1; cat ${home}/.config/nexus/config.env 2>&1`);
    assert.doesNotMatch(boxed.stdout + boxed.stderr, /PRIVATE-KEY-CANARY|canary-secret/, "the sandboxed worker cannot read their contents");
    const listing = await sh(boxedWorker, `ls -A ${home}/.ssh ${home}/.config/nexus 2>/dev/null`);
    assert.equal(listing.stdout.trim(), "", "nor see that they exist");
    const plainListing = await sh(bridge(false), `ls -A ${home}/.ssh 2>/dev/null`);
    assert.match(plainListing.stdout, /id_canary/, "baseline: an unsandboxed worker lists them");
  });

  test("a sandboxed worker cannot write outside the workspace, and can write inside it", async () => {
    const plain = await sh(bridge(false), `echo x > ${outside}/plain.txt`);
    assert.equal(plain.exit, 0);
    assert.equal(fs.existsSync(path.join(outside, "plain.txt")), true, "baseline: the unsandboxed worker writes anywhere");
    const boxed = bridge("bwrap");
    await sh(boxed, `echo x > ${outside}/boxed.txt; echo y > /usr/boxed.txt; echo z > ${home}/boxed.txt`);
    for (const target of [path.join(outside, "boxed.txt"), "/usr/boxed.txt", path.join(home, "boxed.txt")]) {
      assert.equal(fs.existsSync(target), false, target);
    }
    const inside = await sh(boxed, "echo inside > in.txt; cat in.txt");
    assert.equal(inside.exit, 0);
    assert.equal(fs.readFileSync(path.join(workspace, "in.txt"), "utf8"), "inside\n", "the workspace is writable and the write reaches the host");
  });

  test("the file tools still work through a sandboxed worker (the RPC surface is intact)", async () => {
    const b = bridge("bwrap");
    assert.equal((await b.executeTool("write_file", { path: "w.txt", content: "hello\n" })).success, true);
    const read = await b.executeTool("read_file", { path: "w.txt" });
    assert.equal(read.success, true);
    assert.match(read.output, /hello/);
    assert.match((await b.executeTool("list_dir", { path: "." })).output, /w\.txt/);
    assert.equal(fs.readFileSync(path.join(workspace, "w.txt"), "utf8"), "hello\n");
    assert.match((await b.executeTool("search_code", { query: "alpha" })).output, /a\.txt/);
  });

  test("network: reachable from an unsandboxed worker, refused in the box, allowed only when the operator opts in", async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const probe = `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo CONNECTED || echo REFUSED`;
    try {
      assert.match((await sh(bridge(false), probe)).stdout, /CONNECTED/, "baseline: the listener is reachable");
      assert.match((await sh(bridge("bwrap"), probe)).stdout, /REFUSED/, "no network in the box by default");
      setSandboxNetworkFlag(true);
      assert.match((await sh(bridge("bwrap"), probe)).stdout, /CONNECTED/, "the one network switch covers the worker and its commands");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("the operator's credentials are not in the worker's environment, sandboxed or not", async () => {
    process.env.FAKE_PROVIDER_API_KEY = "env-canary-value";
    try {
      for (const sandbox of [false, "bwrap"] as const) {
        const out = await sh(bridge(sandbox), "env; cat /proc/self/environ | tr '\\0' '\\n'");
        assert.doesNotMatch(out.stdout, /env-canary-value/, `sandbox=${String(sandbox)}`);
      }
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  });

  test("the worker and its children end with the CLI: no sandbox process survives shutdown", async () => {
    const pids = (): Set<number> => new Set(spawnSync("pgrep", ["-x", "bwrap"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number));
    const existing = pids();
    const b = bridge("bwrap");
    await sh(b, "sleep 31337", { background: true });
    assert.ok([...pids()].some((p) => !existing.has(p)), "a sandbox process is running");
    b.shutdown();
    let left: number[] = [];
    for (let i = 0; i < 50; i++) {
      left = [...pids()].filter((p) => !existing.has(p));
      if (!left.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const p of left) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    assert.deepEqual(left, [], "the die-with-parent box ended everything inside it");
  });

  test("changing the sandbox setting restarts the worker under the new one", async () => {
    const b = bridge(false);
    assert.match((await sh(b, `cat ${home}/.ssh/id_canary`)).stdout, /PRIVATE-KEY-CANARY/);
    b.setSandbox("bwrap");
    assert.doesNotMatch((await sh(b, `cat ${home}/.ssh/id_canary 2>&1`)).stdout, /PRIVATE-KEY-CANARY/);
  });

  test("a command through the CLI is not wrapped a second time inside the worker's box (no nested bwrap)", async () => {
    for (const [sandbox, wrapped] of [["bwrap", false], [false, false]] as const) {
      const b = bridge(sandbox);
      const sent: string[] = [];
      const original = (b as any).executeViaRpc.bind(b);
      (b as any).executeViaRpc = async (tool: string, args: Record<string, any>, options?: unknown) => {
        if (tool === "run_command") sent.push(String(args.command));
        return original(tool, args, options);
      };
      const res = await b.executeTool("run_command", { command: "echo plain-command" });
      assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
      assert.deepEqual(sent, ["echo plain-command"], `sandbox=${String(sandbox)}: the worker's box is the sandbox, the command is sent as is`);
      assert.equal(wrapped, false);
    }
  });

  test("a docker-confined host keeps wrapping commands itself (the worker is outside Docker)", async () => {
    const b = bridge("docker");
    assert.equal((b as any).workerSandboxMode(), "off");
    assert.equal((b as any).workerIsSandboxed(), false);
  });
});

describe("what happens when the box cannot be built", () => {
  test("`--sandbox bwrap` with no Bubblewrap fails closed: no worker is started outside the box", async () => {
    const empty = fs.mkdtempSync(path.join(root || "/var/tmp", "empty-path-"));
    process.env.PATH = empty;
    const b = new RustCoreBridge(workspace, "bash", core, false, false, "bwrap");
    bridges.push(b);
    const res = await b.executeTool("read_file", { path: "a.txt" });
    assert.equal(res.success, false);
    assert.match(String(res.error), /Worker isolation violation/);
    assert.equal((b as any).rpcProcess ?? null, null, "no worker process exists");
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test("`--sandbox` (auto) without Bubblewrap keeps today's behaviour: the worker starts as before", async () => {
    const empty = fs.mkdtempSync(path.join(root || "/var/tmp", "empty-path-"));
    process.env.PATH = empty;
    const b = new RustCoreBridge(workspace, "bash", core, false, false, true);
    bridges.push(b);
    const res = await b.executeTool("read_file", { path: "a.txt" });
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test("Docker and none never contain the worker (they confine commands only, as before)", () => {
    for (const mode of ["docker", "none", false] as const) assert.equal((bridge(mode) as any).workerSandboxMode(), "off", String(mode));
    assert.equal((bridge("bwrap") as any).workerSandboxMode(), "required");
    assert.equal((bridge(true) as any).workerSandboxMode(), "preferred");
    assert.equal((bridge("auto") as any).workerSandboxMode(), "preferred");
  });
});
