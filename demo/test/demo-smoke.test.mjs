// Smoke test for Nexus Contest Demo Runner
// Validates end-to-end execution in fast mode

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoCli = path.join(__dirname, "..", "nexus-demo.mjs");

console.log("=== RUNNING NEXUS DEMO SMOKE TEST ===");

const proc = spawnSync(process.execPath, [demoCli, "--fast"], {
	cwd: path.join(__dirname, ".."),
	encoding: "utf8",
	// Restricted UID validation adds process setup for each compile/test stage.
	timeout: 90000,
});

if (proc.status !== 0) {
	console.error("[FAIL] Demo smoke test exited with non-zero status:", proc.status);
	console.error(proc.stderr || proc.stdout);
	process.exit(1);
}

const stdout = proc.stdout;

const requiredSnippets = [
	"SUBSTRATE: LOCAL FIXTURE",
	"[1] BASELINE REPOSITORY ESTABLISHED",
	"[2] CONSUMER AGENT INITIATES WORK",
	"[3] PRODUCER CONSEQUENTIAL REFACTOR",
	"[4] MACHINE-READABLE WORK-STATE PUBLICATION",
	"[5] AGENT COGNITIVE LOOP & REASSESSMENT",
	"[6] EMPIRICAL CONTRAST: CONTROL VS TREATMENT",
	"[7] AUTOMATED INTEGRATION VALIDATION",
	"[8] VERIFIABLE GIT RESULT",
	"CONTEST_SLICE_VALIDATION: PASS",
	"DEMONSTRATION VERIFICATION COMPLETE",
];

let failed = false;
for (const snippet of requiredSnippets) {
	if (!stdout.includes(snippet)) {
		console.error(`[FAIL] Missing expected snippet in demo output: "${snippet}"`);
		failed = true;
	}
}

if (failed) {
	console.error("\nFull demo stdout:");
	console.error(stdout);
	process.exit(1);
}

console.log("[PASS] All 8 demo stages executed cleanly in local fast mode!");
console.log("[PASS] Demo smoke test passed.");
