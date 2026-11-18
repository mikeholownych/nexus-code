#!/usr/bin/env node
// MQ-4 scheduled gateway conformance. Run it from a local timer (docs/GATEWAY_CONFORMANCE.md): the gateway is not reachable
// from hosted runners. It takes the GATEWAY claim without waiting (so it never collides with a human or another agent's run),
// runs the unmodified tool-call matrix runner (eval/tool_grammar_matrix.mjs) with a prepared private config, judges each alias's
// native-valid ratio against the 99.5% bar and against the previous result, and alerts when an alias falls below the bar or
// drops. The claim is released on every exit path.
//
//   node scripts/gateway_conformance.mjs --config <private-config.json> [--baseline <previous-result.json>]
//        [--runner <path>] [--min-ratio 0.995] [--max-drop 0.01] [--alert-cmd "<shell command>"]
//
// Exit 0: every alias conforms. 1: not conformant, or the run itself failed (the alert fired). 2: usage or setup error.
// 75: skipped because the GATEWAY claim is held (not a failure; no alert).
//
// The pass rule here is the native-valid ratio, not the runner's `passed` flag: an alias served with reasoning off cannot
// satisfy the runner's hybrid-reasoning check and would alert on every run (docs/evidence/v1.2.1/G1.1-4-v1.2.1-other-aliases.md).
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKIPPED = 75;
const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = { minRatio: 0.995, maxDrop: 0.01 };
  const keys = { "--config": "config", "--baseline": "baseline", "--runner": "runner", "--alert-cmd": "alertCmd", "--min-ratio": "minRatio", "--max-drop": "maxDrop", "--agent": "agent" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option ${argv[i]}`);
    out[key] = key === "minRatio" || key === "maxDrop" ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!out.config) throw new Error("--config <private matrix config> is required");
  if (!(out.minRatio > 0 && out.minRatio <= 1) || !(out.maxDrop >= 0 && out.maxDrop <= 1)) throw new Error("--min-ratio must be in (0,1] and --max-drop in [0,1]");
  return out;
}

const ratioOf = (endpoint) => (endpoint.totals?.attempts ? endpoint.totals.native_valid / endpoint.totals.attempts : 0);
const nameOf = (endpoint) => endpoint.modelName ?? endpoint.provider ?? "unknown";

/** Problems found in a matrix result, judged alone and against an optional previous result. Pure: no I/O. */
export function judge(result, baseline, { minRatio, maxDrop }) {
  const problems = [];
  const summary = [];
  const before = new Map((baseline?.endpoints ?? []).map((e) => [nameOf(e), ratioOf(e)]));
  for (const endpoint of result.endpoints ?? []) {
    const name = nameOf(endpoint);
    const ratio = ratioOf(endpoint);
    summary.push({ alias: name, attempts: endpoint.totals?.attempts ?? 0, native_valid: endpoint.totals?.native_valid ?? 0, ratio });
    if (ratio < minRatio) problems.push(`${name}: ${endpoint.totals?.native_valid ?? 0}/${endpoint.totals?.attempts ?? 0} native valid (${(ratio * 100).toFixed(1)}%) is below the ${(minRatio * 100).toFixed(1)}% bar`);
    const prior = before.get(name);
    if (prior !== undefined && prior - ratio > maxDrop) problems.push(`${name}: native-valid ratio fell from ${(prior * 100).toFixed(1)}% to ${(ratio * 100).toFixed(1)}% since the baseline`);
  }
  if (!summary.length) problems.push("the matrix result names no alias");
  return { problems, summary };
}

function claimsDir() {
  if (process.env.NEXUS_CLAIMS_DIR) return process.env.NEXUS_CLAIMS_DIR;
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here, encoding: "utf8" }).trim();
  return path.join(common, "nexus-claims");
}

/** The alert: a JSON file next to the result, and the operator's command (if any) with the same JSON on stdin. */
function raise(alertDir, alertCmd, payload) {
  fs.mkdirSync(alertDir, { recursive: true });
  const file = path.join(alertDir, "conformance-alert.json");
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`gateway conformance ALERT: ${payload.problems.join("; ")}\n`);
  if (alertCmd) {
    const ran = spawnSync("sh", ["-c", alertCmd], { input: JSON.stringify(payload), encoding: "utf8", timeout: 60_000 });
    if (ran.status !== 0) process.stderr.write(`alert command exited ${ran.status ?? "by signal"}: ${(ran.stderr ?? "").slice(0, 200)}\n`);
  }
  return file;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`gateway conformance: ${error.message}\n`);
    return 2;
  }
  const agent = args.agent ?? "gateway-conformance";
  const claims = claimsDir();
  fs.mkdirSync(claims, { recursive: true });
  const claim = path.join(claims, "GATEWAY");
  try {
    fs.mkdirSync(claim);
  } catch {
    let owner = "unknown";
    try { owner = fs.readFileSync(path.join(claim, "owner.json"), "utf8").trim(); } catch { /* unreadable owner is still a held claim */ }
    process.stderr.write(`gateway conformance skipped: GATEWAY is claimed by ${owner}\n`);
    return SKIPPED;
  }
  let outcome = "aborted";
  try {
    fs.writeFileSync(path.join(claim, "owner.json"), `${JSON.stringify({ agent, branch: "conformance", since: new Date().toISOString(), pid: process.pid })}\n`);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(args.config, "utf8"));
    } catch (error) {
      process.stderr.write(`gateway conformance: cannot read ${args.config}: ${error.message}\n`);
      outcome = "setup-error";
      return 2;
    }
    const outputPath = config.outputPath;
    if (typeof outputPath !== "string") {
      process.stderr.write("gateway conformance: the config has no outputPath\n");
      outcome = "setup-error";
      return 2;
    }
    const alertDir = path.dirname(outputPath);
    fs.rmSync(outputPath, { force: true });
    const runner = args.runner ?? path.join(here, "..", "eval", "tool_grammar_matrix.mjs");
    const ran = spawnSync(process.execPath, [runner, "--config", args.config], { encoding: "utf8", env: process.env });
    // The runner exits 1 when an alias fails its own pass rule; the result file, not the exit code, is what this job judges.
    let result;
    try {
      result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch {
      outcome = "run-failed";
      raise(alertDir, args.alertCmd, { at: new Date().toISOString(), kind: "run-failed", problems: [`the matrix run produced no result (exit ${ran.status ?? "signal"}): ${(ran.stderr ?? "").trim().slice(0, 300)}`], endpoints: [] });
      return 1;
    }
    let baseline;
    if (args.baseline) {
      try { baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8")); } catch { baseline = undefined; }
    }
    const { problems, summary } = judge(result, baseline, args);
    if (problems.length) {
      outcome = "not-conformant";
      raise(alertDir, args.alertCmd, { at: new Date().toISOString(), kind: "not-conformant", problems, endpoints: summary });
      return 1;
    }
    outcome = "conformant";
    process.stdout.write(`gateway conformance ok: ${summary.map((s) => `${s.alias} ${s.native_valid}/${s.attempts}`).join(", ")}\n`);
    return 0;
  } finally {
    fs.appendFileSync(path.join(claims, "..", "nexus-claims.log"), `${new Date().toISOString()} GATEWAY released by ${agent}: conformance ${outcome}\n`);
    fs.rmSync(claim, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
