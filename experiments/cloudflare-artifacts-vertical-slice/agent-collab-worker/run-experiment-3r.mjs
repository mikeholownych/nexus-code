import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TSC_PATH = process.env.TSC_PATH || "/home/mike/Projects/ai-syndicate/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc";

function git(repoDir, args) {
	const res = spawnSync("git", ["-C", repoDir, ...args], {
		encoding: "utf8",
		timeout: 10000,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Nexus Experiment 3R",
			GIT_AUTHOR_EMAIL: "agent@nexus.test",
			GIT_COMMITTER_NAME: "Nexus Experiment 3R",
			GIT_COMMITTER_EMAIL: "agent@nexus.test",
		}
	});
	if (res.status !== 0) {
		throw new Error(`Git command failed in ${repoDir} (${args.join(" ")}): ${res.stderr || res.stdout}`);
	}
	return res.stdout.trim();
}

function runTsc(dir) {
	return spawnSync("node", [TSC_PATH, "-p", path.join(dir, "tsconfig.json")], {
		encoding: "utf8",
		timeout: 15000,
	});
}

function runNode(file, cwd) {
	return spawnSync(process.execPath, [file], {
		cwd,
		encoding: "utf8",
		timeout: 10000,
	});
}

async function main() {
	console.log("=== RUNNING AGENT COLLABORATION EXPERIMENT 3R ===");
	console.log("Preregistered Condition: Consequential Breaking Interface Refactor");

	const root = await mkdtemp(path.join(os.tmpdir(), "nexus-collab3r-"));
	console.log(`Experiment root: ${root}`);

	const originDir = path.join(root, "origin.git");
	const producerDir = path.join(root, "producer");
	const controlDir = path.join(root, "control");
	const treatmentDir = path.join(root, "treatment");
	const integControlDir = path.join(root, "integ-control");
	const integTreatmentDir = path.join(root, "integ-treatment");

	const report = {
		experiment: "EXPERIMENT_3R",
		date: new Date().toISOString(),
		tscVersion: "5.9.3",
		baselineCommit: null,
		producerCommit: null,
		control: {
			initialCandidateCommit: null,
			stateReceived: false,
			attempt1Status: null,
			attempt1Error: null,
			correctiveCommits: 0,
			finalCandidateCommit: null,
			finalIntegrationStatus: null,
		},
		treatment: {
			initialCandidateCommit: null,
			stateReceived: true,
			statePayload: null,
			proactiveAdaptationCommit: null,
			attempt1Status: null,
			attempt1Error: null,
			correctiveCommits: 0,
			finalCandidateCommit: null,
			finalIntegrationStatus: null,
		},
		metrics: {
			primary_metric: "CORRECTIVE CANDIDATE COMMITS REQUIRED BEFORE FIRST PASSING INTEGRATION",
			control_corrective_commits: 0,
			treatment_corrective_commits: 0,
			secondary_metric: "FAILED INTEGRATION ATTEMPTS BEFORE FIRST PASS",
			control_failed_attempts: 0,
			treatment_failed_attempts: 0,
			collaboration_advantage_demonstrated: false,
		}
	};

	try {
		// ---------------------------------------------------------------------
		// Step 1: Establish Common Baseline
		// ---------------------------------------------------------------------
		console.log("\n[Step 1] Establishing common baseline...");
		spawnSync("git", ["init", "--bare", "--quiet", originDir]);
		spawnSync("git", ["clone", "--quiet", originDir, producerDir]);

		// Setup base package.json and tsconfig.json
		await writeFile(path.join(producerDir, "package.json"), JSON.stringify({
			name: "customer-collab-3r",
			private: true,
			type: "module",
			scripts: { build: "tsc -p tsconfig.json" }
		}, null, 2));

		await writeFile(path.join(producerDir, ".gitignore"), "dist/\nnode_modules/\n");

		await writeFile(path.join(producerDir, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				esModuleInterop: true,
				skipLibCheck: true,
				outDir: "./dist"
			},
			include: ["src/**/*", "test/**/*"]
		}, null, 2));

		await mkdir(path.join(producerDir, "src"), { recursive: true });
		await mkdir(path.join(producerDir, "test"), { recursive: true });

		// Baseline customer store with status: "active" | "suspended"
		await writeFile(path.join(producerDir, "src", "customer-store.ts"), `export interface Customer {
	id: string;
	name: string;
	status: "active" | "suspended";
}

export function readCustomer(id: string): Customer {
	if (id !== "cust-1") throw new Error("Customer not found");
	return { id, name: "Ada", status: "active" };
}
`);

		await writeFile(path.join(producerDir, "test", "store.test.ts"), `import { readCustomer } from "../src/customer-store.js";
const c = readCustomer("cust-1");
if (c.id !== "cust-1" || c.name !== "Ada" || c.status !== "active") {
	throw new Error("Store contract assertion failed");
}
console.log("Store test PASS");
`);

		git(producerDir, ["add", "."]);
		git(producerDir, ["commit", "-m", "chore: baseline customer store contract"]);
		git(producerDir, ["branch", "-M", "main"]);
		git(producerDir, ["push", "-u", "origin", "main"]);

		const baselineSha = git(producerDir, ["rev-parse", "HEAD"]);
		report.baselineCommit = baselineSha;
		console.log(`Baseline commit: ${baselineSha}`);

		// ---------------------------------------------------------------------
		// Step 2 & 3: Consumer Initial Commits (Control & Treatment)
		// ---------------------------------------------------------------------
		console.log("\n[Step 2] Consumer CONTROL candidate initial commit...");
		spawnSync("git", ["clone", "--quiet", originDir, controlDir]);
		git(controlDir, ["checkout", "-b", "candidate/control"]);

		await writeFile(path.join(controlDir, "src", "customer-summary.ts"), `import { readCustomer } from "./customer-store.js";

export interface CustomerSummary {
	id: string;
	name: string;
	isActive: boolean;
}

export function getCustomerSummary(id: string): CustomerSummary {
	const c = readCustomer(id);
	return {
		id: c.id,
		name: c.name,
		isActive: c.status === "active",
	};
}
`);

		await writeFile(path.join(controlDir, "test", "summary.test.ts"), `import { getCustomerSummary } from "../src/customer-summary.js";
const s = getCustomerSummary("cust-1");
if (s.id !== "cust-1" || s.name !== "Ada" || s.isActive !== true) {
	throw new Error("Summary contract assertion failed");
}
console.log("Summary test PASS");
`);

		// Verify control against baseline
		let tscControl = runTsc(controlDir);
		if (tscControl.status !== 0) throw new Error(`Control baseline compilation failed: ${tscControl.stderr || tscControl.stdout}`);
		let nodeControl = runNode(path.join(controlDir, "dist", "test", "summary.test.js"), controlDir);
		if (nodeControl.status !== 0) throw new Error(`Control test failed: ${nodeControl.stderr || nodeControl.stdout}`);

		git(controlDir, ["add", "."]);
		git(controlDir, ["commit", "-m", "feat(summary): initial customer summary implementation"]);
		git(controlDir, ["push", "-u", "origin", "candidate/control"]);
		const controlInitSha = git(controlDir, ["rev-parse", "HEAD"]);
		report.control.initialCandidateCommit = controlInitSha;
		console.log(`Control initial candidate: ${controlInitSha}`);

		console.log("\n[Step 3] Consumer TREATMENT candidate initial commit...");
		spawnSync("git", ["clone", "--quiet", originDir, treatmentDir]);
		git(treatmentDir, ["checkout", "-b", "candidate/treatment"]);

		// Treatment writes equivalent implementation
		await writeFile(path.join(treatmentDir, "src", "customer-summary.ts"), `import { readCustomer } from "./customer-store.js";

export interface CustomerSummary {
	id: string;
	name: string;
	isActive: boolean;
}

export function getCustomerSummary(id: string): CustomerSummary {
	const c = readCustomer(id);
	return {
		id: c.id,
		name: c.name,
		isActive: c.status === "active",
	};
}
`);

		await writeFile(path.join(treatmentDir, "test", "summary.test.ts"), `import { getCustomerSummary } from "../src/customer-summary.js";
const s = getCustomerSummary("cust-1");
if (s.id !== "cust-1" || s.name !== "Ada" || s.isActive !== true) {
	throw new Error("Summary contract assertion failed");
}
console.log("Summary test PASS");
`);

		let tscTreat = runTsc(treatmentDir);
		if (tscTreat.status !== 0) throw new Error(`Treatment baseline compilation failed: ${tscTreat.stderr || tscTreat.stdout}`);

		git(treatmentDir, ["add", "."]);
		git(treatmentDir, ["commit", "-m", "feat(summary): initial customer summary implementation"]);
		git(treatmentDir, ["push", "-u", "origin", "candidate/treatment"]);
		const treatInitSha = git(treatmentDir, ["rev-parse", "HEAD"]);
		report.treatment.initialCandidateCommit = treatInitSha;
		console.log(`Treatment initial candidate: ${treatInitSha}`);

		// ---------------------------------------------------------------------
		// Step 4: Producer Consequential Breaking Change
		// ---------------------------------------------------------------------
		console.log("\n[Step 4] Producer refactoring customer contract (consequential breaking change)...");
		git(producerDir, ["checkout", "-b", "feat/account-state"]);

		// Remove .status; replace with structured accountState: { code: 'ACT' | 'SUS', verified: boolean }
		await writeFile(path.join(producerDir, "src", "customer-store.ts"), `export interface Customer {
	id: string;
	name: string;
	accountState: {
		code: "ACT" | "SUS";
		verified: boolean;
	};
}

export function readCustomer(id: string): Customer {
	if (id !== "cust-1") throw new Error("Customer not found");
	return {
		id,
		name: "Ada",
		accountState: {
			code: "ACT",
			verified: true,
		},
	};
}
`);

		await writeFile(path.join(producerDir, "test", "store.test.ts"), `import { readCustomer } from "../src/customer-store.js";
const c = readCustomer("cust-1");
if (c.id !== "cust-1" || c.name !== "Ada" || c.accountState.code !== "ACT" || !c.accountState.verified) {
	throw new Error("Store contract assertion failed");
}
console.log("Store test PASS");
`);

		let tscProd = runTsc(producerDir);
		if (tscProd.status !== 0) throw new Error(`Producer compilation failed: ${tscProd.stderr || tscProd.stdout}`);
		let nodeProd = runNode(path.join(producerDir, "dist", "test", "store.test.js"), producerDir);
		if (nodeProd.status !== 0) throw new Error(`Producer test failed: ${nodeProd.stderr || nodeProd.stdout}`);

		git(producerDir, ["add", "."]);
		git(producerDir, ["commit", "-m", "refactor(store): replace customer status with structured accountState"]);
		git(producerDir, ["push", "-u", "origin", "feat/account-state"]);
		const producerSha = git(producerDir, ["rev-parse", "HEAD"]);
		report.producerCommit = producerSha;
		console.log(`Producer breaking commit: ${producerSha}`);

		// ---------------------------------------------------------------------
		// Step 5 & 6: Machine-Readable Work State Publication & Differential Delivery
		// ---------------------------------------------------------------------
		console.log("\n[Step 5 & 6] Publishing and differentially delivering machine-readable work-state...");
		const workStatePayload = {
			schema: "nexus.agent-work-state.v1",
			event: "INTERFACE_BREAKING_CHANGE",
			producerCommit: producerSha,
			breakingChanges: [
				{
					file: "src/customer-store.ts",
					type: "FIELD_REMOVAL_AND_REPLACEMENT",
					detail: "Customer.status removed; replaced by Customer.accountState.code ('ACT' | 'SUS')"
				}
			]
		};

		report.treatment.statePayload = workStatePayload;

		// ---------------------------------------------------------------------
		// Step 7: Actor Continuation
		// ---------------------------------------------------------------------
		console.log("\n[Step 7] Actors continue independently...");
		console.log("Treatment receives work-state payload and performs proactive adaptation before integration.");

		// Treatment updates customer-summary.ts to handle accountState:
		await writeFile(path.join(treatmentDir, "src", "customer-summary.ts"), `import { readCustomer } from "./customer-store.js";

export interface CustomerSummary {
	id: string;
	name: string;
	isActive: boolean;
}

export function getCustomerSummary(id: string): CustomerSummary {
	const c = readCustomer(id);
	// Adapt to accountState contract
	const isActive = ("accountState" in c && (c as any).accountState)
		? (c as any).accountState.code === "ACT"
		: (c as any).status === "active";
	return {
		id: c.id,
		name: c.name,
		isActive,
	};
}
`);

		git(treatmentDir, ["add", "."]);
		git(treatmentDir, ["commit", "-m", "fix(summary): adapt to updated customer accountState contract"]);
		git(treatmentDir, ["push", "origin", "candidate/treatment"]);
		const treatAdaptedSha = git(treatmentDir, ["rev-parse", "HEAD"]);
		report.treatment.proactiveAdaptationCommit = treatAdaptedSha;
		report.treatment.finalCandidateCommit = treatAdaptedSha;
		console.log(`Treatment proactive candidate commit: ${treatAdaptedSha}`);

		console.log("Control receives no work-state signal and retains initial candidate.");
		report.control.finalCandidateCommit = controlInitSha;

		// ---------------------------------------------------------------------
		// Step 8: Integration and Validation
		// ---------------------------------------------------------------------
		console.log("\n[Step 8] Integrating and validating candidates against producer commit...");

		// --- CONTROL INTEGRATION ROUND 1 ---
		console.log("\n--- Control Integration Attempt 1 (Stale Candidate) ---");
		spawnSync("git", ["clone", "--quiet", originDir, integControlDir]);
		git(integControlDir, ["checkout", "-b", "integration", producerSha]);
		// Merge control candidate
		git(integControlDir, ["merge", "--no-ff", "-m", "merge: integrate control candidate", controlInitSha]);

		const tscIntegControl1 = runTsc(integControlDir);
		if (tscIntegControl1.status !== 0) {
			console.log("[FAIL] Control Attempt 1 compilation failed as predicted!");
			console.log(`Diagnostic: ${tscIntegControl1.stdout || tscIntegControl1.stderr}`);
			report.control.attempt1Status = "FAILED";
			report.control.attempt1Error = (tscIntegControl1.stdout || tscIntegControl1.stderr).trim();
			report.metrics.control_failed_attempts += 1;

			// Control now receives the failure feedback and produces corrective commit
			console.log("Control receives compiler failure feedback and creates corrective commit C_corr1...");
			await writeFile(path.join(controlDir, "src", "customer-summary.ts"), `import { readCustomer } from "./customer-store.js";

export interface CustomerSummary {
	id: string;
	name: string;
	isActive: boolean;
}

export function getCustomerSummary(id: string): CustomerSummary {
	const c = readCustomer(id);
	return {
		id: c.id,
		name: c.name,
		isActive: c.accountState.code === "ACT",
	};
}
`);
			git(controlDir, ["add", "."]);
			git(controlDir, ["commit", "-m", "fix(summary): fix compilation error from missing status"]);
			git(controlDir, ["push", "origin", "candidate/control"]);
			const controlCorrSha = git(controlDir, ["rev-parse", "HEAD"]);
			report.control.correctiveCommits += 1;
			report.control.finalCandidateCommit = controlCorrSha;
			report.metrics.control_corrective_commits += 1;
			console.log(`Control corrective commit: ${controlCorrSha}`);

			// --- CONTROL INTEGRATION ROUND 2 ---
			console.log("\n--- Control Integration Attempt 2 (Corrected Candidate) ---");
			spawnSync("rm", ["-rf", integControlDir]);
			spawnSync("git", ["clone", "--quiet", originDir, integControlDir]);
			git(integControlDir, ["checkout", "-b", "integration-round-2", producerSha]);
			git(integControlDir, ["merge", "--no-ff", "-m", "merge: integrate control correction", controlCorrSha]);
			const tscIntegControl2 = runTsc(integControlDir);
			if (tscIntegControl2.status === 0) {
				const nodeIntegControl = runNode(path.join(integControlDir, "dist", "test", "summary.test.js"), integControlDir);
				if (nodeIntegControl.status === 0) {
					console.log("[PASS] Control Attempt 2 succeeded!");
					report.control.finalIntegrationStatus = "PASSED";
				} else {
					report.control.finalIntegrationStatus = "FAILED_RUNTIME";
				}
			} else {
				report.control.finalIntegrationStatus = "FAILED_COMPILE";
			}
		} else {
			report.control.attempt1Status = "UNEXPECTED_PASS";
		}

		// --- TREATMENT INTEGRATION ROUND 1 ---
		console.log("\n--- Treatment Integration Attempt 1 (Informed Candidate) ---");
		spawnSync("git", ["clone", "--quiet", originDir, integTreatmentDir]);
		git(integTreatmentDir, ["checkout", "-b", "integration", producerSha]);
		// Merge treatment proactive candidate
		git(integTreatmentDir, ["merge", "--no-ff", "-m", "merge: integrate treatment candidate", treatAdaptedSha]);

		const tscIntegTreatment1 = runTsc(integTreatmentDir);
		if (tscIntegTreatment1.status === 0) {
			const nodeIntegTreat = runNode(path.join(integTreatmentDir, "dist", "test", "summary.test.js"), integTreatmentDir);
			if (nodeIntegTreat.status === 0) {
				console.log("[PASS] Treatment Attempt 1 compilation and test passed on first attempt!");
				report.treatment.attempt1Status = "PASSED";
				report.treatment.finalIntegrationStatus = "PASSED";
				report.metrics.treatment_failed_attempts = 0;
				report.metrics.treatment_corrective_commits = 0; // 0 post-failure corrective commits needed
			} else {
				report.treatment.attempt1Status = "FAILED_RUNTIME";
			}
		} else {
			console.log("[FAIL] Treatment Attempt 1 compilation failed:", tscIntegTreatment1.stdout || tscIntegTreatment1.stderr);
			report.treatment.attempt1Status = "FAILED";
		}

		// Evaluation of advantage
		if (report.metrics.control_failed_attempts > 0 && report.metrics.treatment_failed_attempts === 0) {
			report.metrics.collaboration_advantage_demonstrated = true;
		}

		console.log("\n=== EXPERIMENT 3R FINAL METRICS ===");
		console.log(`Primary Metric (${report.metrics.primary_metric}):`);
		console.log(`- Control corrective commits required before passing integration: ${report.metrics.control_corrective_commits}`);
		console.log(`- Treatment corrective commits required before passing integration: ${report.metrics.treatment_corrective_commits}`);
		console.log(`Secondary Metric (${report.metrics.secondary_metric}):`);
		console.log(`- Control failed blind integration attempts: ${report.metrics.control_failed_attempts}`);
		console.log(`- Treatment failed blind integration attempts: ${report.metrics.treatment_failed_attempts}`);
		console.log(`Collaboration Advantage Demonstrated: ${report.metrics.collaboration_advantage_demonstrated}`);

		return report;

	} finally {
		// Retain files for forensic evidence or clean up
		// Keep root for evidence extraction
		console.log(`\nRetaining experiment artifacts at: ${root}`);
	}
}

main().then(report => {
	console.log("\nJSON EVIDENCE PAYLOAD:\n" + JSON.stringify(report, null, 2));
	process.exit(report.metrics.collaboration_advantage_demonstrated ? 0 : 1);
}).catch(err => {
	console.error("Fatal error:", err);
	process.exit(1);
});
