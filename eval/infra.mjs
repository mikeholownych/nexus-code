#!/usr/bin/env node
// Marks runs that failed on infrastructure (the agent never reached the model), so they are rerun rather than scored as
// task failures. Runs recorded through the harness's model proxy are classified by what it observed, the same way for
// every agent: the model never answered and the endpoint failed. A run whose model answered is always scored (a crash
// is a failure, not a rerun). Older records fall back to each agent's own connection-failure message.
// usage: eval/infra.mjs <out-dir-of-one-config>   → prints "task run" per infrastructure failure
import fs from "node:fs";
import path from "node:path";
import { isInfrastructureFailure } from "./model_proxy.mjs";

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
let legacy = 0;
for (const line of fs.readFileSync(path.join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(line);
  let infra;
  if (r.error || r.model) {
    // Observed by the harness's model proxy: the same rule for every agent (REQ-QUAL-106).
    infra = isInfrastructureFailure(r);
  } else {
    // Records from before the proxy: each agent's own failure message (Nexus: INFERENCE_FAILED or a long provider wait).
    legacy++;
    const logs = path.join(dir, r.logs ?? "");
    const read = (f) => (fs.existsSync(path.join(logs, f)) ? fs.readFileSync(path.join(logs, f), "utf8") : "");
    const text = [read("agent.stdout.json"), read("agent.stderr.log")].join("\n");
    infra = r.agent === "nexus"
      ? r.turn?.reason === "INFERENCE_FAILED" || recoveryWaitMs(read("agent.stdout.json")) > 60_000
      : SIGNATURES[r.agent]?.test(text) && !r.hiddenPass;
  }
  if (infra) console.log(`${r.task} ${r.run}`);
}
if (legacy) console.error(`infra: ${legacy} record(s) predate the model proxy; classified by agent failure messages`);
