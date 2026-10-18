#!/usr/bin/env node
// Infrastructure-only validation of a provisioned qualification host (eval/host/README.md). Run as the operator:
//   node eval/host/validate.mjs --heldout <sealed task store> [--json out.json]
// Uses no task corpus and no inference. Every check must pass; the report lists each result.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedArgv, grantRunAsAccess, normalizeRunAsPermissions, sandboxAvailable } from "../isolate.mjs";
import { resourceConfigProblem, resourceProbeProblem, spawnContained } from "../resources.mjs";
import { asUser, asUserSpec } from "../validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ACCOUNT = "nexus-eval";
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "eval/host/resource-profile.json"), "utf8"));
const resources = { cpuPercent: profile.cpuPercent, memoryBytes: profile.memoryBytes, tasks: profile.tasks, storageBytes: profile.storageBytes, workspaceRoot: profile.workspaceRoot };
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, pass: true, ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
  }
};
const run = (cmd, argv, options = {}) => spawnSync(cmd, argv, { encoding: "utf8", timeout: 60_000, ...options });
const must = (condition, message) => { if (!condition) throw new Error(message); };
const account = () => fs.readFileSync("/etc/passwd", "utf8").split("\n").map((line) => line.split(":")).find((parts) => parts[0] === ACCOUNT);

await check("evaluator account exists, is separate and cannot log in", () => {
  const entry = account();
  must(entry, `${ACCOUNT} is missing`);
  must(Number(entry[2]) !== process.getuid(), "evaluator uid equals the operator uid");
  must(/nologin|false$/.test(entry[6]), `login shell is ${entry[6]}`);
  return `uid=${entry[2]} shell=${entry[6]}`;
});

await check("sudo allows only Bubblewrap as the evaluator, in exactly the form the harness uses", () => {
  // The production invocation: eval/validate.mjs asUser, not a hand-written command.
  const harness = asUser(ACCOUNT, "/usr/bin/bwrap", ["--version"]);
  must(run(harness.cmd, harness.argv).status === 0, `the harness's own sudo invocation is refused: ${harness.cmd} ${harness.argv.join(" ")}`);
  for (const forbidden of [["/usr/bin/id"], ["/usr/bin/env", "id"], ["/bin/sh", "-c", "id"]]) {
    must(run("/usr/bin/sudo", ["-n", "-u", ACCOUNT, "--", ...forbidden]).status !== 0, `sudo also allows ${forbidden.join(" ")}`);
  }
});

await check("setfacl and Bubblewrap are available", () => {
  must(fs.existsSync("/usr/bin/setfacl"), "setfacl is missing");
  must(sandboxAvailable(), "Bubblewrap preflight failed");
});

await check("workspace root is the dedicated, operator-owned, size-capped tmpfs", () => {
  const live = run("findmnt", ["-n", "-b", "-o", "FSTYPE,SIZE", "--mountpoint", resources.workspaceRoot]).stdout.trim().split(/\s+/);
  must(live[0] === "tmpfs", `${resources.workspaceRoot} is not a tmpfs mount point (${live.join(" ") || "not mounted"})`);
  must(Number(live[1]) === resources.storageBytes, `tmpfs size ${live[1]} differs from storageBytes ${resources.storageBytes}`);
  const stat = fs.statSync(resources.workspaceRoot);
  must(stat.uid === process.getuid() && (stat.mode & 0o777) === 0o711, `owner/mode is ${stat.uid}/${(stat.mode & 0o777).toString(8)}, not operator/711`);
  const problem = resourceConfigProblem(resources);
  must(problem === null, problem);
  return `tmpfs ${live[1]} bytes`;
});

await check("the host applies and cleans up the resource contract", () => {
  const problem = resourceProbeProblem(resources);
  must(problem === null, problem);
});

await check("evaluator processes stay in the limited cgroup, and every one is reaped", async () => {
  const dir = fs.mkdtempSync(path.join(resources.workspaceRoot, "validate-"));
  try {
    grantRunAsAccess(ACCOUNT, [dir]);
    const contained = (spec) => new Promise((resolve) => {
      const { child, containment } = spawnContained(asUser(ACCOUNT, spec.cmd, spec.argv), resources, { cwd: "/", env: {}, stdio: ["ignore", "ignore", "pipe"], detached: true });
      child.on("close", async () => resolve(await containment.final));
    });
    // The harness's own sandbox, as the evaluator: right uid, inside the payload leaf.
    const sandboxed = await contained(isolatedArgv({ cwd: dir, home: false, command: "id -u > /workspace/uid; cat /proc/self/cgroup > /workspace/cgroup; mkdir -p /workspace/private; echo secret > /workspace/private/f; chmod 600 /workspace/private/f; chmod 700 /workspace/private", timeoutSec: 30 }));
    must(sandboxed?.cleaned === true, `containment report: ${JSON.stringify(sandboxed)}`);
    must(Number(fs.readFileSync(path.join(dir, "uid"), "utf8")) === Number(account()[2]), "payload did not run as the evaluator");
    must(/\/payload$/.test(fs.readFileSync(path.join(dir, "cgroup"), "utf8").trim()), "evaluator process is not in the payload cgroup");
    await normalizeRunAsPermissions(ACCOUNT, dir, asUserSpec);
    must(fs.readFileSync(path.join(dir, "private", "f"), "utf8") === "secret\n", "operator cannot read an evaluator-created 0600 file");
    // Without a PID namespace nothing but the cgroup can reap a daemon: the operator-side supervisor must find the
    // evaluator-owned survivor and kill it across uids.
    const daemon = await contained({ cmd: "/usr/bin/bwrap", argv: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--", "/bin/sh", "-c", "setsid sh -c 'exec sleep 300' </dev/null >/dev/null 2>&1 & sleep 0.5"] });
    must(daemon?.survivorsAfterExit >= 1, `the evaluator daemon was not left for the cgroup to reap: ${JSON.stringify(daemon)}`);
    must(daemon.cleaned === true, `evaluator daemon not reaped: ${JSON.stringify(daemon)}`);
    must(run("pgrep", ["-u", ACCOUNT]).status !== 0, "evaluator processes survived the run");
    return `limits ${JSON.stringify(sandboxed.limits)}; reaped ${daemon.survivorsAfterExit} evaluator survivor(s)`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("the evaluator cannot reach operator files or the held-out store", () => {
  // Paths are checked to exist operator-side first, so a missing path cannot pass the check vacuously.
  const heldout = path.resolve(process.argv[process.argv.indexOf("--heldout") + 1] ?? "");
  must(process.argv.includes("--heldout") && run("/usr/bin/sudo", ["-n", "/usr/bin/test", "-d", heldout]).status === 0, "pass --heldout <sealed task store> (an existing directory)");
  const home = os.homedir();
  must(fs.statSync(home).isDirectory(), "operator home is missing");
  // One real file inside the store, chosen operator-side and never printed, must be unreadable even by exact path.
  // The custodian's store is root-owned (0700), so root picks the file; its name is used, never printed or read.
  const storeFile = run("/usr/bin/sudo", ["-n", "/usr/bin/find", heldout, "-type", "f", "-print", "-quit"]).stdout.trim() || null;
  must(storeFile, "the held-out store contains no file to probe");
  const probe = `test ! -x "$1" || { echo "can traverse the operator home"; exit 1; }; ls "$2" >/dev/null 2>&1 && { echo "can list the held-out store"; exit 1; }; ls "$1" >/dev/null 2>&1 && { echo "can list the operator home"; exit 1; }; cat "$3" >/dev/null 2>&1 && { echo "can read a held-out file by path"; exit 1; }; exit 0`;
  const result = run("/usr/bin/sudo", ["-n", "-u", ACCOUNT, "--", "/usr/bin/bwrap", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-net", "--", "/bin/sh", "-c", probe, "sh", home, heldout, storeFile]);
  must(result.status === 0, `evaluator isolation failed: ${result.stdout.trim() || result.stderr.trim()}`);
  return `home and ${heldout} unreachable`;
});

await check("qualification preflight fails closed without the controls", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-qual-failclosed-"));
  try {
    const tasks = path.join(scratch, "tasks");
    fs.mkdirSync(tasks);
    const base = { name: "failclosed", qualification: true, endpoint: "http://127.0.0.1:9/v1", model: "m", runAs: ACCOUNT, sandboxRuntimePaths: [], sandboxRuntimeRoots: ["/opt/nexus-qual"] };
    const cases = [
      [{ ...base, resources: undefined }, /enforced CPU, memory, process-count, and workspace-storage limits/],
      [{ ...base, resources: { ...resources, workspaceRoot: os.tmpdir() } }, /tmpfs/],
      [{ ...base, runAs: undefined, resources }, /runAs/],
    ];
    for (const [index, [config, expected]] of cases.entries()) {
      const file = path.join(scratch, `config-${index}.json`);
      fs.writeFileSync(file, JSON.stringify(config));
      const result = run(process.execPath, [path.join(ROOT, "eval/run.mjs"), "--config", file, "--tasks", tasks, "--out", path.join(scratch, `out-${index}`)]);
      must(result.status === 2 && expected.test(result.stderr), `case ${index} did not refuse with ${expected}: exit ${result.status} ${result.stderr.slice(0, 600)}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

await check("no run directories are left in the workspace root", () => {
  const left = fs.readdirSync(resources.workspaceRoot);
  must(left.length === 0, `left behind: ${left.join(", ")}`);
});

const failed = results.filter((r) => !r.pass);
const report = { host: os.hostname(), at: new Date().toISOString(), profile: resources, results, pass: failed.length === 0 };
report.revision = {
  commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
  dirty: Boolean(spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()),
  profileSha256: createHash("sha256").update(fs.readFileSync(path.join(ROOT, "eval/host/resource-profile.json"))).digest("hex"),
  sourceDigests: ["eval/host/validate.mjs", "eval/host/provision.sh", "eval/host/rollback.sh", "eval/host/resource-profile.json", "eval/resources.mjs", "eval/cgroup_supervisor.mjs", "eval/isolate.mjs", "eval/validate.mjs"].map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex") })),
};
const out = process.argv.indexOf("--json");
if (out > 0) fs.writeFileSync(process.argv[out + 1], `${JSON.stringify(report, null, 2)}\n`);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
