/**
 * MQ-4: the scheduled gateway conformance job. The matrix runner is replaced by a fake that writes a chosen result, so
 * no gateway is touched; what is under test is the claim protocol, the judgement, and the alert path.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../scripts/gateway_conformance.mjs");

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-conf-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const endpoint = (modelName: string, valid: number, attempts = 200) => ({ provider: "gateway", modelName, passed: valid === attempts, totals: { attempts, native_valid: valid, repaired: 0, schema_invalid: 0, invalid: attempts - valid } });

/** A fake matrix runner: writes `result` to the config's outputPath and exits `code` (or writes nothing when result is null). */
function setup(result: unknown, code = 1) {
  const out = path.join(dir, "out", "result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ outputPath: out }));
  const runner = path.join(dir, "runner.mjs");
  fs.writeFileSync(runner, `import fs from "node:fs";\nconst c = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));\nconst r = ${JSON.stringify(result)};\nif (r !== null) fs.writeFileSync(c.outputPath, JSON.stringify(r));\nprocess.exit(${code});\n`);
  return { config, runner, out, alertDir: path.dirname(out) };
}
const claims = () => path.join(dir, "claims");
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, NEXUS_CLAIMS_DIR: claims(), ...env } });
}
const log = () => { try { return fs.readFileSync(path.join(dir, "nexus-claims.log"), "utf8"); } catch { return ""; } };

describe("MQ-4 gateway conformance", () => {
  test("every alias conformant: exit 0, no alert, and the claim is released and logged", () => {
    const s = setup({ endpoints: [endpoint("engineering/deep", 200), endpoint("engineering/lead-reasoning", 200)] }, 0);
    const r = run(["--config", s.config, "--runner", s.runner]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /engineering\/deep 200\/200/);
    assert.equal(fs.existsSync(path.join(s.alertDir, "conformance-alert.json")), false);
    assert.equal(fs.existsSync(path.join(claims(), "GATEWAY")), false, "claim released");
    assert.match(log(), /GATEWAY released by gateway-conformance: conformance conformant/);
  });

  test("a forced failure (an alias below the bar) alerts: exit 1, alert file, alert command with the JSON on stdin, claim released", () => {
    const s = setup({ endpoints: [endpoint("engineering/deep", 200), endpoint("engineering/lead-reasoning", 150)] });
    const sink = path.join(dir, "alert-stdin.json");
    const r = run(["--config", s.config, "--runner", s.runner, "--alert-cmd", `cat > ${sink}`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ALERT: engineering\/lead-reasoning: 150\/200 native valid \(75\.0%\)/);
    const alert = JSON.parse(fs.readFileSync(path.join(s.alertDir, "conformance-alert.json"), "utf8"));
    assert.equal(alert.kind, "not-conformant");
    assert.equal(alert.problems.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(sink, "utf8")), alert, "the alert command received the same payload");
    assert.equal(fs.existsSync(path.join(claims(), "GATEWAY")), false);
    assert.match(log(), /conformance not-conformant/);
  });

  test("a drop from the baseline alerts even when the alias still clears the bar", () => {
    const s = setup({ endpoints: [endpoint("engineering/deep", 199)] }, 0);
    const baseline = path.join(dir, "baseline.json");
    fs.writeFileSync(baseline, JSON.stringify({ endpoints: [endpoint("engineering/deep", 200)] }));
    const ok = run(["--config", s.config, "--runner", s.runner, "--baseline", baseline]);
    assert.equal(ok.status, 0, "199/200 is 99.5%: above the bar, and the 0.5% drop is within the default 1%");
    const s2 = setup({ endpoints: [endpoint("engineering/deep", 199)] }, 0);
    const tight = run(["--config", s2.config, "--runner", s2.runner, "--baseline", baseline, "--max-drop", "0.002"]);
    assert.equal(tight.status, 1);
    assert.match(tight.stderr, /fell from 100\.0% to 99\.5% since the baseline/);
  });

  test("a held GATEWAY claim skips the run: exit 75, the runner never ran, the other holder's claim is untouched, no alert", () => {
    const s = setup({ endpoints: [endpoint("engineering/deep", 0)] });
    fs.mkdirSync(path.join(claims(), "GATEWAY"), { recursive: true });
    fs.writeFileSync(path.join(claims(), "GATEWAY", "owner.json"), '{"agent":"a human"}\n');
    const r = run(["--config", s.config, "--runner", s.runner]);
    assert.equal(r.status, 75);
    assert.match(r.stderr, /GATEWAY is claimed by .*a human/);
    assert.equal(fs.existsSync(s.out), false, "the runner did not run");
    assert.equal(fs.existsSync(path.join(s.alertDir, "conformance-alert.json")), false);
    assert.equal(fs.readFileSync(path.join(claims(), "GATEWAY", "owner.json"), "utf8"), '{"agent":"a human"}\n');
    assert.equal(log(), "", "nothing released that this run did not take");
  });

  test("a runner that produces no result alerts as run-failed and still releases the claim", () => {
    const s = setup(null, 3);
    const r = run(["--config", s.config, "--runner", s.runner]);
    assert.equal(r.status, 1);
    const alert = JSON.parse(fs.readFileSync(path.join(s.alertDir, "conformance-alert.json"), "utf8"));
    assert.equal(alert.kind, "run-failed");
    assert.match(alert.problems[0], /no result \(exit 3\)/);
    assert.equal(fs.existsSync(path.join(claims(), "GATEWAY")), false);
    assert.match(log(), /conformance run-failed/);
  });

  test("an alert command that fails does not hide the failure or keep the claim", () => {
    const s = setup({ endpoints: [endpoint("engineering/deep", 100)] });
    const r = run(["--config", s.config, "--runner", s.runner, "--alert-cmd", "exit 9"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /alert command exited 9/);
    assert.equal(fs.existsSync(path.join(s.alertDir, "conformance-alert.json")), true);
    assert.equal(fs.existsSync(path.join(claims(), "GATEWAY")), false);
  });

  test("a stale result file is never judged: the previous result is removed before the run", () => {
    const s = setup(null, 1);
    fs.writeFileSync(s.out, JSON.stringify({ endpoints: [endpoint("engineering/deep", 200)] }));
    const r = run(["--config", s.config, "--runner", s.runner]);
    assert.equal(r.status, 1, "an old passing result must not hide a run that produced nothing");
  });

  test("usage and setup errors exit 2 and release the claim", () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(["--config", path.join(dir, "missing.json")]).status, 2);
    assert.equal(fs.existsSync(path.join(claims(), "GATEWAY")), false);
    const noOut = path.join(dir, "no-output.json");
    fs.writeFileSync(noOut, "{}");
    assert.equal(run(["--config", noOut]).status, 2);
    assert.equal(fs.existsSync(path.join(claims(), "GATEWAY")), false);
  });

  test("judge() is pure and counts only native-valid calls", async () => {
    const mod = await import(pathToFileURL(SCRIPT).href);
    const j = mod.judge({ endpoints: [endpoint("a", 199), { modelName: "b", totals: { attempts: 0, native_valid: 0 } }] }, undefined, { minRatio: 0.995, maxDrop: 0.01 });
    assert.equal(j.problems.length, 1, "an alias with no attempts is below the bar; 199/200 clears it");
    assert.match(j.problems[0], /^b:/);
  });
});
