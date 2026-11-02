import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startGateway } from "./helpers/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runNode(argv: string[], timeoutMs = 60_000): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
  });
}

/** Exercise the built Nexus CLI and capture its actual post-prompt provider requests. */
test("versioned dataset candidate receives stimulus without oracle sentinels", { timeout: 90_000 }, async (t) => {
  const sentinel = "ORACLE_SENTINEL_WP1103_PRIVATE_VALIDATOR";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dataset-cli-test-"));
  const dataset = path.join(root, "dataset");
  const absoluteHiddenPath = path.join(dataset, "tasks", "selftest-add", "hidden", "math.hidden.test.js");
  const gateway = await startGateway((request, body) => {
    const toolCount = (body?.messages ?? []).filter((message: any) => message.role === "tool").length;
    const calls = toolCount === 0
      ? [{ name: "file_tree", args: { path: ".", max_depth: 4 } }]
      : toolCount === 1
        ? [{ name: "read_file", args: { path: "hidden/math.hidden.test.js" } }]
        : toolCount === 2
          ? [{ name: "run_command", args: { command: `if test -f package.json; then printf 'DATASET_TEST_FIXTURE_REPO_VISIBLE\\n'; else printf 'DATASET_TEST_FIXTURE_REPO_MISSING\\n'; fi; if grep -F ' /workspace ' /proc/self/mountinfo >/dev/null; then printf 'DATASET_TEST_WORKSPACE_MOUNT_PRESENT\\n'; else printf 'DATASET_TEST_WORKSPACE_MOUNT_MISSING\\n'; fi; if awk -v root='${dataset}' '$4 == root || index($4, root "/") == 1 { found = 1 } END { exit !found }' /proc/self/mountinfo; then printf 'DATASET_ROOT_MOUNT_PRESENT\\n'; else printf 'DATASET_ROOT_MOUNT_ABSENT\\n'; fi; if test -r '${absoluteHiddenPath}'; then printf 'DATASET_ABSOLUTE_HIDDEN_PATH_READABLE\\n'; cat '${absoluteHiddenPath}'; else printf 'DATASET_ABSOLUTE_HIDDEN_PATH_UNREADABLE\\n'; fi`, timeout_secs: 10 } }]
          : toolCount === 3
        ? [{ name: "write_file", args: { path: "math.js", content: "exports.add = (a, b) => a + b;\n" } }]
        : [{ name: "task_completed", args: { summary: "math.js added" } }];
    return { kind: "tools", calls };
  });
  try {
    fs.cpSync(path.join(ROOT, "eval/datasets/core-v1"), dataset, { recursive: true });
    const taskDir = path.join(dataset, "tasks", "selftest-add");
    fs.appendFileSync(path.join(taskDir, "hidden/math.hidden.test.js"), `\n// ${sentinel}\n`);

    const examplesFile = path.join(dataset, "examples.jsonl");
    const examples = fs.readFileSync(examplesFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    examples[0].minutes = 1;
    const examplesBytes = Buffer.from(`${examples.map((row) => JSON.stringify(row)).join("\n")}\n`);
    fs.writeFileSync(examplesFile, examplesBytes);

    const oraclesFile = path.join(dataset, "oracles.jsonl");
    const oracles = fs.readFileSync(oraclesFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    oracles[0].hidden.command += ` # ${sentinel}`;
    const oraclesBytes = Buffer.from(`${oracles.map((row) => JSON.stringify(row)).join("\n")}\n`);
    fs.writeFileSync(oraclesFile, oraclesBytes);

    const { taskTreeDigest } = await import(path.join(ROOT, "eval/validate.mjs"));
    const manifestFile = path.join(dataset, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.files["examples.jsonl"] = createHash("sha256").update(examplesBytes).digest("hex");
    manifest.files["oracles.jsonl"] = createHash("sha256").update(oraclesBytes).digest("hex");
    manifest.tasks["selftest-add"] = taskTreeDigest(taskDir);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ name: "versioned-core", agent: "nexus", endpoint: gateway.url, model: "m", runs: 1, steps: 20, minutes: 1 }));
    const out = path.join(root, "out");
    const result = await runNode([path.join(ROOT, "eval/run.mjs"), "--config", config, "--out", out, "--dataset", dataset, "--split", "regression"]);
    assert.equal(result.timedOut, false, `gatewayModelRequests=${gateway.modelRequests} gatewayChatRequests=${gateway.requests.length}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, `gatewayModelRequests=${gateway.modelRequests} gatewayChatRequests=${gateway.requests.length}\n${result.stdout}\n${result.stderr}`);

    const records = fs.readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const runManifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(records.map((record: any) => record.task), ["selftest-add"]);
    assert.equal(runManifest.dataset.name, "core-v1");
    assert.equal(runManifest.dataset.version, "1.1.0");
    assert.equal(runManifest.dataset.manifestSha256, createHash("sha256").update(fs.readFileSync(manifestFile)).digest("hex"));
    assert.ok(runManifest.harness.sourceDigests.some((entry: any) => entry.file === "eval/dataset.mjs"), "run identity includes the dataset loader source");
    assert.ok(gateway.requests.some((body: any) => JSON.stringify(body).includes("1. Add math.js")), "provider request contains the selected stimulus");
    assert.ok(gateway.requests.every((body: any) => !JSON.stringify(body).includes(sentinel)), "oracle sentinel never reaches a candidate request or tool result");
    const toolResults = gateway.requests.flatMap((body: any) => body.messages ?? []).filter((message: any) => message.role === "tool");
    await t.test("versioned dataset candidate workspace excludes evaluator files", () => {
      assert.ok(toolResults.length > 0, "candidate inspected its staged workspace");
      assert.ok(toolResults.every((message: any) => !JSON.stringify(message).includes(sentinel)), "oracle sentinel never reaches a candidate tool result");
      assert.ok(!JSON.stringify(toolResults[0]).includes("math.hidden.test.js"), "candidate workspace tree excludes hidden validator path");
      assert.ok(toolResults.some((message: any) => /not found|does not exist|no such file/i.test(String(message.content))), "candidate cannot read the evaluator-only hidden validator path");
      const mountProbeMessage = toolResults.find((message: any) => message.name === "run_command");
      assert.ok(mountProbeMessage, "the candidate executed the dataset mount-view probe");
      const mountProbe = JSON.parse(mountProbeMessage.content);
      assert.equal(mountProbe.exit_code, 0, mountProbe.stderr);
      assert.match(mountProbe.stdout, /DATASET_TEST_FIXTURE_REPO_VISIBLE/, "the candidate sees the fixture repository it must work in");
      assert.match(mountProbe.stdout, /DATASET_TEST_WORKSPACE_MOUNT_PRESENT/, "the candidate observes its declared workspace mount");
      assert.match(mountProbe.stdout, /DATASET_ROOT_MOUNT_ABSENT/, "the dataset staging root is absent from the candidate mount view");
      assert.match(mountProbe.stdout, /DATASET_ABSOLUTE_HIDDEN_PATH_UNREADABLE/, "the absolute evaluator validator path cannot be read by the candidate");
      assert.doesNotMatch(mountProbe.stdout, /DATASET_ABSOLUTE_HIDDEN_PATH_READABLE|ORACLE_SENTINEL_WP1103_PRIVATE_VALIDATOR/, "the evaluator validator path and sentinel never enter candidate-visible output");
    });
    await t.test("versioned dataset oracle scores after candidate exit", () => {
      assert.equal(records[0].hiddenPass, true, `root=${root} ${JSON.stringify(records[0])}`);
    });
  } finally {
    await gateway.close();
    if (process.env.NEXUS_KEEP_DATASET_TMP !== "1") fs.rmSync(root, { recursive: true, force: true });
  }
});
