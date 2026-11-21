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
import { isBwrapAvailable, isDockerAvailable, setSandboxNetworkFlag, wrapSandboxedWorker, workerRuntimeFiles, DOCKER_WORKER_LABEL } from "../src/sandbox.js";
import { getBuildIdentity } from "../src/build_identity.js";

const core = resolveCoreBinary();
const SKIP = !isBwrapAvailable() ? "bwrap is not installed on this host" : !core ? "the Rust core is not built" : false;
const DOCKER_SKIP = process.platform !== "linux"
  ? "a containerised worker needs a Linux host"
  : !core
    ? "the Rust core is not built"
    : !(isDockerAvailable() && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0)
      ? "the docker daemon is not available"
      : false;

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

/** Check and clean up only the process group returned by this test's run_command call. */
function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function captureWorkerOutput(b: RustCoreBridge, channel: unknown): () => string {
  let stdout = "";
  let stderr = "";
  let exit = "running";
  const worker = (b as any).ensureRpcDaemon(channel) as { stdout?: NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream; on?: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void } | null;
  worker?.stdout?.on("data", (chunk: Buffer | string) => { stdout = (stdout + chunk.toString()).slice(-2_000); });
  worker?.stderr?.on("data", (chunk: Buffer | string) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
  worker?.on("exit", (code: number | null, signal: NodeJS.Signals | null) => { exit = `${code ?? "null"}/${signal ?? "none"}`; });
  return () => JSON.stringify({ exit, stdout, stderr });
}

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
    const b = bridge("bwrap");
    const command = await sh(b, "sleep 31337", { background: true });
    const pgid = `${command.stdout}\n${command.stderr}`.match(/\bpgid\s+(\d+)\b/)?.[1];
    assert.ok(pgid, `the runner returned the background process-group id: ${JSON.stringify(command)}`);
    const worker = (b as any).channels.primary.process as { pid?: number; once: (event: string, callback: () => void) => void; kill: (signal: NodeJS.Signals) => void } | null;
    assert.ok(worker?.pid, "the sandboxed worker is running");
    let workerExited = false;
    worker.once("exit", () => { workerExited = true; });
    b.shutdown();
    let groupExists = true;
    for (let i = 0; i < 50; i++) {
      groupExists = processGroupExists(Number(pgid));
      if (!groupExists && workerExited) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // If shutdown regresses, clean up only this test's process group and worker. Never signal
    // every bwrap process on the host: another test or user's session may own those.
    if (groupExists) {
      try {
        process.kill(-Number(pgid), "SIGKILL");
      } catch {
        /* gone */
      }
    }
    if (!workerExited) worker.kill("SIGKILL");
    assert.equal(groupExists, false, "the die-with-parent box ended the command process group owned by its worker");
    assert.equal(workerExited, true, "the worker ended with its client");
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

});

/** Containers started for this test process's workers (the label carries the owning pid). */
const workerContainers = (): string[] =>
  spawnSync("docker", ["ps", "-q", "--filter", `label=${DOCKER_WORKER_LABEL}=${process.pid}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

describe("CS-10 phase 2: file tools go to a separate files-only worker that never has a network", { skip: SKIP }, () => {
  const spawnargs = (b: RustCoreBridge, which: "files" | "primary"): string[] => (b as any).channels[which].process?.spawnargs ?? [];

  test("a sandboxed bridge starts the files worker for file tools and the command worker only when a command runs", async () => {
    const b = bridge("bwrap");
    assert.equal((await b.executeTool("read_file", { path: "a.txt" })).success, true);
    assert.ok(spawnargs(b, "files").length > 0, "the files worker is running");
    assert.equal((b as any).channels.primary.process, null, "no command worker until a command is run");
    assert.ok(spawnargs(b, "files").some((arg) => arg.includes("--files-only")), "it was started with --files-only");
    assert.equal((await b.executeTool("run_command", { command: "echo from-command-worker" })).success, true);
    assert.ok(spawnargs(b, "primary").length > 0, "the command worker started for the command");
    assert.equal(spawnargs(b, "primary").some((arg) => arg.includes("--files-only")), false);
    assert.notEqual((b as any).channels.primary.process.pid, (b as any).channels.files.process.pid, "two processes");
  });

  test("the files worker refuses to run a command even when asked directly, and the refused command does not run", async () => {
    const b = bridge("bwrap");
    await b.executeTool("read_file", { path: "a.txt" });
    const files = (b as any).channels.files;
    for (const method of ["run_command", "cancel", "end_background", "list_services"]) {
      const params = method === "run_command" ? { command: "echo x > refused.txt", shell: "bash" } : {};
      const res = await (b as any).executeViaRpc(method, params, { channel: files, ignoreTurnSignal: true });
      assert.equal(res.success, false, method);
      assert.match(String(res.error), /file tools only/, method);
    }
    assert.equal(fs.existsSync(path.join(workspace, "refused.txt")), false);
    // Baseline: the same request to the command worker runs.
    const ran = await (b as any).executeViaRpc("run_command", { command: "echo x > ran.txt", shell: "bash" });
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 200));
    assert.equal(fs.existsSync(path.join(workspace, "ran.txt")), true);
  });

  test("with the network allowed for commands, the files worker's box still has none", async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const probe = `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo CONNECTED || echo REFUSED`;
    setSandboxNetworkFlag(true);
    try {
      const b = bridge("bwrap");
      const filesLaunch = (b as any).workerLaunch(["rpc"], "files");
      const commandLaunch = (b as any).workerLaunch(["rpc"], "commands");
      assert.ok(filesLaunch.args.includes("--unshare-net"), "the files worker's box unshares the network");
      assert.equal(commandLaunch.args.includes("--unshare-net"), false, "the command worker's box has the network the operator allowed");
      // The files worker cannot run a probe (it refuses commands), so the probe runs as the process in each box.
      // A stand-in "worker" in its own directory (the profile binds the worker's directory read-only).
      const probeDir = fs.mkdtempSync(path.join(root, "probe-"));
      const probeScript = path.join(probeDir, "probe.sh");
      fs.writeFileSync(probeScript, `#!/bin/bash\n${probe}\n`, { mode: 0o755 });
      const inBox = (network: false | undefined) => {
        const launch = wrapSandboxedWorker(probeScript, [], workspace, { engines: ["bwrap"], network });
        assert.equal(launch.sandboxed, true, launch.warning);
        const run = spawnSync(launch.command!, launch.args!, { encoding: "utf8" });
        return `${run.stdout}${run.stderr}`;
      };
      assert.match(inBox(false), /REFUSED/, "the box a files worker gets");
      assert.match(inBox(undefined), /CONNECTED/, "baseline: the box a command worker gets reaches the listener");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("an unsandboxed bridge keeps one worker for everything (no files worker)", async () => {
    const b = bridge(false);
    assert.equal((await b.executeTool("read_file", { path: "a.txt" })).success, true);
    assert.equal((await b.executeTool("run_command", { command: "echo one-worker" })).success, true);
    assert.equal((b as any).channels.files.process, null);
    assert.equal(spawnargs(b, "primary").some((arg) => arg.includes("--files-only")), false);
  });

  test("a core that ignores --files-only is not trusted with the files role (handshake fails closed)", async () => {
    // A stand-in core that answers hello like a core built before the flag existed: no files_only field.
    const dir = fs.mkdtempSync(path.join(root, "old-core-"));
    const fake = path.join(dir, "harness-core");
    const version = getBuildIdentity().version === "unknown" ? "0.0.0" : getBuildIdentity().version;
    fs.writeFileSync(fake, `#!/bin/bash\nwhile IFS= read -r line; do id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p'); printf '{"id":%s,"result":{"protocol":1,"version":"${version}"}}\\n' "$id"; done\n`, { mode: 0o755 });
    const b = new RustCoreBridge(workspace, "bash", fake, false, false, "bwrap");
    bridges.push(b);
    const res = await (b as any).executeViaRpc("read_file", { path: "a.txt" });
    assert.equal(res.success, false);
    assert.match(String(res.error), /did not report files-only mode/);
    assert.equal((b as any).channels.files.process, null, "the untrusted worker was stopped");
  });
});

describe("CS-10: the worker inside a Docker container", { skip: DOCKER_SKIP }, () => {
  test("the worker's runtime files are resolved from the binary, or it is a static binary", () => {
    const runtime = workerRuntimeFiles(core!);
    assert.equal("error" in runtime, false, JSON.stringify(runtime));
  });

  test("runtime discovery parses an untrusted worker and ignores PATH-controlled ELF tools", () => {
    const fakeBin = fs.mkdtempSync(path.join(root, "fake-elf-tools-"));
    const marker = path.join(fakeBin, "executed");
    for (const name of ["ldd", "readelf", "ldconfig"]) {
      fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '%s' ran > '${marker}'\nexit 0\n`, { mode: 0o755 });
    }
    process.env.PATH = `${fakeBin}:${previousPath ?? "/usr/bin:/bin"}`;
    const runtime = workerRuntimeFiles(core!);
    assert.equal("error" in runtime, false, JSON.stringify(runtime));
    assert.equal(fs.existsSync(marker), false, "runtime discovery uses trusted absolute system tools");

    const untrusted = path.join(fakeBin, "workspace-worker");
    const sideEffect = path.join(fakeBin, "worker-executed");
    fs.writeFileSync(untrusted, `#!/bin/sh\nprintf '%s' ran > '${sideEffect}'\n`, { mode: 0o755 });
    const result = workerRuntimeFiles(untrusted);
    assert.equal("error" in result, true, "a script is rejected as a non-ELF worker");
    assert.equal(fs.existsSync(sideEffect), false, "the candidate worker is never executed on the host");
  });

  test("the host-built core starts in the pinned Docker image before RPC", () => {
    const launch = wrapSandboxedWorker(core!, ["--version"], workspace, { engines: ["docker"] });
    const runtime = workerRuntimeFiles(core!);
    const runtimeSummary = "error" in runtime
      ? runtime
      : {
        loader: runtime.loader ? path.basename(runtime.loader) : undefined,
        libraries: runtime.libraries.map((file) => path.basename(file)),
        libraryNames: runtime.libraryNames.map(({ name, path: file }) => `${name}=>${path.basename(file)}`),
      };
    assert.equal(launch.engine, "docker", launch.warning);
    const imageIndex = launch.args!.indexOf("-w") + 2;
    const loaderProbe = runtime && !("error" in runtime) && runtime.loader
      ? spawnSync(launch.command!, [
        ...launch.args!.slice(0, imageIndex + 1),
        "/nexus-worker/ld.so", "--library-path", "/nexus-worker", "--list", "/nexus-worker/harness-core",
      ], { encoding: "utf8", timeout: 15_000, maxBuffer: 16_000 })
      : null;
    assert.equal(loaderProbe?.status ?? 0, 0, JSON.stringify({ loaderProbe, runtime: runtimeSummary }));
    assert.doesNotMatch(loaderProbe?.stdout ?? "", /libc\.musl/, "glibc dependencies must resolve to the mounted host runtime, never the image's musl libraries");
    const result = spawnSync(launch.command!, launch.args!, { encoding: "utf8", timeout: 15_000, maxBuffer: 16_000 });
    assert.equal(result.status, 0, JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message, runtime: runtimeSummary }));
    assert.match(result.stdout, /harness-core/);
  });

  test("secrets under $HOME: readable unsandboxed, absent from the worker's container", async () => {
    assert.match((await sh(bridge(false), `cat ${home}/.ssh/id_canary`)).stdout, /PRIVATE-KEY-CANARY/, "baseline");
    const b = bridge("docker");
    const workerOutput = captureWorkerOutput(b, (b as any).channels.files);
    const boxed = await sh(b, `cat ${home}/.ssh/id_canary 2>&1; cat ${home}/.config/nexus/config.env 2>&1`, { shell: "sh" });
    assert.notEqual(boxed.exit, undefined, JSON.stringify({ boxed, worker: workerOutput() }).slice(0, 1_600));
    assert.doesNotMatch(boxed.stdout + boxed.stderr, /PRIVATE-KEY-CANARY|canary-secret/, "their contents are not readable");
    assert.equal((await sh(b, `ls -A ${home}`, { shell: "sh" })).stdout.trim(), "ws", "of the home directory only the workspace exists in the container");
  });

  test("writes outside the workspace fail; a write inside reaches the host", async () => {
    const b = bridge("docker");
    await sh(b, `echo x > ${outside}/docker.txt; echo y > /usr/docker.txt; echo z > ${home}/docker.txt`, { shell: "sh" });
    for (const target of [path.join(outside, "docker.txt"), "/usr/docker.txt", path.join(home, "docker.txt")]) assert.equal(fs.existsSync(target), false, target);
    const inside = await sh(b, "echo inside > docker-in.txt; cat docker-in.txt", { shell: "sh" });
    assert.equal(inside.exit, 0, JSON.stringify(inside).slice(0, 300));
    assert.equal(fs.readFileSync(path.join(workspace, "docker-in.txt"), "utf8"), "inside\n");
  });

  test("file tools work through the containerised files worker, and commands use the image's sh", async () => {
    const b = bridge("docker");
    assert.equal((await b.executeTool("write_file", { path: "dw.txt", content: "hello\n" })).success, true);
    assert.match((await b.executeTool("read_file", { path: "dw.txt" })).output, /hello/);
    assert.equal(fs.readFileSync(path.join(workspace, "dw.txt"), "utf8"), "hello\n");
    assert.match((await b.executeTool("search_code", { query: "alpha" })).output, /a\.txt/);
    const sent: Record<string, any>[] = [];
    const original = (b as any).executeViaRpc.bind(b);
    (b as any).executeViaRpc = async (tool: string, args: Record<string, any>, options?: unknown) => {
      if (tool === "run_command") sent.push({ ...args });
      return original(tool, args, options);
    };
    const res = await b.executeTool("run_command", { command: "echo from-container; cat /proc/1/comm" });
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 300));
    assert.match(res.output, /from-container/);
    assert.match(res.output, /docker-init/, "the command ran inside the worker's container");
    assert.deepEqual(sent.map((a) => [a.command, a.shell, a.argv]), [["echo from-container; cat /proc/1/comm", "sh", undefined]], "sent as is, not wrapped in a second docker run");
  });

  test("network: none in the container by default, present when the operator opts in, never for the files worker", async () => {
    const interfaces = "ls /sys/class/net | tr '\\n' ' '";
    assert.equal((await sh(bridge("docker"), interfaces, { shell: "sh" })).stdout.trim(), "lo", "only loopback by default");
    setSandboxNetworkFlag(true);
    const b = bridge("docker");
    assert.match((await sh(b, interfaces, { shell: "sh" })).stdout, /eth0/, "the one network switch covers the worker's container");
    assert.ok((b as any).workerLaunch(["rpc"], "files").args.join(" ").includes("--network none"), "the files worker's container has no network even then");
    assert.equal((b as any).workerLaunch(["rpc"], "commands").args.join(" ").includes("--network none"), false);
  });

  test("no worker container survives shutdown, including one with a background command", async () => {
    const b = bridge("docker");
    await b.executeTool("read_file", { path: "a.txt" });
    await sh(b, "sleep 31338 &", { shell: "sh" });
    assert.equal(workerContainers().length, 2, "a files container and a command container are running");
    b.shutdown();
    let left: string[] = [];
    for (let i = 0; i < 150; i++) {
      left = workerContainers();
      if (!left.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (left.length) spawnSync("docker", ["kill", ...left], { stdio: "ignore" });
    assert.deepEqual(left, [], "the containers ended with their client");
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
    assert.equal((b as any).channels.files.process, null, "nor a files worker");
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

  test("`--sandbox docker` with no Docker fails closed: no worker is started outside a container", { skip: process.platform !== "linux" ? "Linux only" : !core ? "the Rust core is not built" : false }, async () => {
    const empty = fs.mkdtempSync(path.join(root || "/var/tmp", "empty-path-"));
    process.env.PATH = empty;
    const b = new RustCoreBridge(workspace, "bash", core, false, false, "docker");
    bridges.push(b);
    for (const [tool, args] of [["read_file", { path: "a.txt" }], ["list_dir", { path: "." }]] as const) {
      const res = await b.executeTool(tool, args);
      assert.equal(res.success, false, tool);
      assert.match(String(res.error), /Worker isolation violation/, tool);
    }
    assert.equal((b as any).channels.primary.process, null);
    assert.equal((b as any).channels.files.process, null);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test("Docker installed but its daemon down: `--sandbox` (auto) falls back to the worker as before; `--sandbox docker` refuses and says why", { skip: process.platform !== "linux" ? "Linux only" : !core ? "the Rust core is not built" : false }, async () => {
    // A stand-in docker CLI that exists (`--version`) but cannot reach a daemon; no bwrap on this PATH.
    const fakeBin = fs.mkdtempSync(path.join(root || "/var/tmp", "docker-down-"));
    fs.writeFileSync(path.join(fakeBin, "docker"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "Docker version 0 (stand-in)"; exit 0; }\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = fakeBin;
    const auto = new RustCoreBridge(workspace, "bash", core, false, false, true);
    bridges.push(auto);
    const read = await auto.executeTool("read_file", { path: "a.txt" });
    assert.equal(read.success, true, JSON.stringify(read).slice(0, 200));
    assert.equal((auto as any).workerEngine(), "none");
    const required = new RustCoreBridge(workspace, "bash", core, false, false, "docker");
    bridges.push(required);
    const refused = await required.executeTool("read_file", { path: "a.txt" });
    assert.equal(refused.success, false);
    assert.match(String(refused.error), /Worker isolation violation: .*Docker daemon is not reachable/);
    fs.rmSync(fakeBin, { recursive: true, force: true });
  });

  test("auto mode refuses a files-only worker if its cached sandbox becomes unavailable", { skip: DOCKER_SKIP }, async () => {
    const available = fs.mkdtempSync(path.join(root, "docker-available-"));
    const unavailable = fs.mkdtempSync(path.join(root, "docker-unavailable-"));
    for (const bin of [available, unavailable]) {
      // Keep Bubblewrap out of the engine preference while leaving host tools and the real Docker CLI available.
      fs.writeFileSync(path.join(bin, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    fs.writeFileSync(path.join(unavailable, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${available}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const b = new RustCoreBridge(workspace, "bash", core, false, false, true);
    bridges.push(b);
    assert.equal((b as any).workerEngine(), "docker", "the command worker initially has a container");

    process.env.PATH = `${unavailable}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const result = await b.executeTool("read_file", { path: "a.txt" });
    assert.equal(result.success, false);
    assert.match(String(result.error), /Worker isolation violation/);
    assert.equal((b as any).channels.files.process, null, "the files worker did not start outside a sandbox");
  });

  test("which sandbox settings contain the worker", () => {
    for (const mode of ["none", false] as const) assert.equal((bridge(mode) as any).workerSandboxMode(), "off", String(mode));
    assert.equal((bridge("docker") as any).workerSandboxMode(), process.platform === "linux" ? "required" : "off");
    assert.deepEqual((bridge("docker") as any).workerEngines(), ["docker"]);
    assert.deepEqual((bridge("bwrap") as any).workerEngines(), ["bwrap"]);
    assert.deepEqual((bridge(true) as any).workerEngines(), ["bwrap", "docker"], "auto prefers Bubblewrap, then Docker");
    assert.equal((bridge("bwrap") as any).workerSandboxMode(), "required");
    assert.equal((bridge(true) as any).workerSandboxMode(), "preferred");
    assert.equal((bridge("auto") as any).workerSandboxMode(), "preferred");
  });
});
