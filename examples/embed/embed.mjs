#!/usr/bin/env node
// Embedding Nexus in a Node program: start the sidecar through the library entry point, run one task that may only
// finish when a trusted verifier passes, and exit 0 only if the outcome is VERIFIED.
//   NEXUS_LIB   absolute path of the entry point (<nexus home>/lib/cli/dist/lib.js, or cli/dist/lib.js in a checkout);
//               without it the package is imported by name, which needs it in node_modules
//   NEXUS_ARGS  further sidecar options, for example "-e http://127.0.0.1:8000/v1 -m my-model"
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { spawnSidecar } = await import(process.env.NEXUS_LIB ?? "local-code-harness");

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-embed-"));
let client;
try {
  fs.cpSync(path.join(here, "project"), work, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.name=example", "-c", "user.email=example@example.invalid", ...args], { cwd: work, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "start");

  client = await spawnSidecar({
    workspace: work,
    // The operator's command, not the model's: it must pass before the task may complete.
    authoritativeVerifier: "node --test",
    // The product file the task is meant to change.
    deliverableFiles: ["add.js"],
    extraArgs: (process.env.NEXUS_ARGS ?? "").split(/\s+/).filter(Boolean),
  });

  // The sidecar asks before each command or edit. This embedder allows those three tools, one call at a time, and
  // nothing else; with no handler every request would be denied.
  const allowed = new Set(["run_command", "write_file", "edit_file"]);
  const result = await client.prompt("Fix add() in add.js so that the test in test/add.test.js passes.", {
    onApproval: (request) => (allowed.has(request.tool) ? "approve" : "deny"),
  });

  console.log(`outcome: ${result.turn.outcome}`);
  if (result.turn.outcome !== "VERIFIED") {
    const detail = result.turn.detail ? `: ${result.turn.detail}` : "";
    console.error(`verification: ${result.turn.reason ?? "no verification reason was recorded"}${detail}`);
  }
  process.exitCode = result.turn.outcome === "VERIFIED" ? 0 : 1;
} finally {
  await client?.shutdown();
  fs.rmSync(work, { recursive: true, force: true });
}
