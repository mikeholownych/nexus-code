#!/usr/bin/env node
// Marks runs that failed on infrastructure (the agent never reached the model), so they are rerun rather than scored as
// task failures. Signatures are each agent's own connection-failure message; Nexus reports INFERENCE_FAILED, or records
// in turn.providerRecovery how long it waited for an unavailable provider (over a minute: the run measured the outage).
// usage: eval/infra.mjs <out-dir-of-one-config>   → prints "task run" per infrastructure failure
import fs from "node:fs";
import path from "node:path";

const SIGNATURES = {
  goose: /Network error: Could not connect to/,
  opencode: /Cannot connect to API: Unable to connect/,
  aider: /litellm\.(InternalServerError|APIConnectionError).*Connection\s+error/s,
  nexus: null,
};
/** Total time a Nexus run waited for an unavailable provider, from its JSON report. */
function recoveryWaitMs(stdout) {
  try {
    const report = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    return (report.turn?.providerRecovery ?? []).reduce((sum, r) => sum + (r.waitedMs ?? 0), 0);
  } catch {
    return 0;
  }
}

const dir = process.argv[2];
for (const line of fs.readFileSync(path.join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(line);
  const logs = path.join(dir, r.logs ?? "");
  const text = ["agent.stdout.json", "agent.stderr.log"].map((f) => (fs.existsSync(path.join(logs, f)) ? fs.readFileSync(path.join(logs, f), "utf8") : "")).join("\n");
  const sig = SIGNATURES[r.agent];
  const infra = r.error || (r.agent === "nexus" ? r.turn?.reason === "INFERENCE_FAILED" || !r.turn || recoveryWaitMs(fs.existsSync(path.join(logs, "agent.stdout.json")) ? fs.readFileSync(path.join(logs, "agent.stdout.json"), "utf8") : "") > 60_000 : sig?.test(text) && !r.hiddenPass);
  if (infra) console.log(`${r.task} ${r.run}`);
}
