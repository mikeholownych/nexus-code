// Consumer Agent for Nexus Contest Demo
// Bounded execution that creates consumer candidate and reacts to machine-readable work-state

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findTscPath() {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(__dirname, "..", "node_modules", "typescript", "bin", "tsc"),
		path.join(process.cwd(), "demo", "node_modules", "typescript", "bin", "tsc"),
		path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
		process.env.TSC_PATH,
	];
	for (const p of candidates) {
		if (p && existsSync(p)) return p;
	}
	return "tsc";
}

export class ConsumerAgent {
	constructor(options = {}) {
		this.agentId = "agent-consumer-02";
		this.name = "Consumer Agent (Analytics Team)";
		this.substrate = options.substrate;
		this.display = options.display;
		this.workDir = options.workDir;
		this.tscPath = options.tscPath || findTscPath();
		this.initialCommitSha = null;
		this.adaptedCommitSha = null;
	}

	runTsc(dir) {
		return spawnSync("node", [this.tscPath, "-p", path.join(dir, "tsconfig.json")], {
			encoding: "utf8",
			timeout: 15000,
		});
	}

	runNode(file, cwd) {
		return spawnSync(process.execPath, [file], {
			cwd,
			encoding: "utf8",
			timeout: 10000,
		});
	}

	async executeInitialCandidate(branchName = "candidate/consumer", candidateRole = "candidate/consumer") {
		const display = this.display;
		const git = (args, extraEnv = {}) => this.substrate.runGit(this.workDir, args, extraEnv);

		display.loopStep(this.name, "OBSERVED", "Reading baseline Customer contract from repository.");
		await display.pace(0.5);

		git(["checkout", "-b", branchName]);

		display.loopStep(this.name, "ASSESS", "Assessing task: Implement CustomerSummary helper under current contract.", {
			ActiveAssumption: "Customer.status: 'active' | 'suspended'",
			TargetFile: "src/customer-summary.ts",
		});
		await display.pace(0.8);

		// Write initial implementation assuming Customer.status
		const summaryCode = `import { readCustomer } from "./customer-store.js";

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
`;
		await writeFile(path.join(this.workDir, "src", "customer-summary.ts"), summaryCode);

		// Write summary test
		const summaryTest = `import { getCustomerSummary } from "../src/customer-summary.js";
const s = getCustomerSummary("cust-1");
if (s.id !== "cust-1" || s.name !== "Ada" || s.isActive !== true) {
	throw new Error("Summary contract assertion failed");
}
console.log("Summary test PASS");
`;
		await writeFile(path.join(this.workDir, "test", "summary.test.ts"), summaryTest);

		display.loopStep(this.name, "ACT", "Implemented CustomerSummary using baseline contract assumption.");
		await display.pace(0.5);

		// Validate locally against baseline
		const tscRes = this.runTsc(this.workDir);
		if (tscRes.status !== 0) {
			throw new Error(`Consumer initial compilation failed: ${tscRes.stderr || tscRes.stdout}`);
		}
		const nodeRes = this.runNode(path.join(this.workDir, "dist", "test", "summary.test.js"), this.workDir);
		if (nodeRes.status !== 0) {
			throw new Error(`Consumer initial test failed: ${nodeRes.stderr || nodeRes.stdout}`);
		}

		display.loopStep(this.name, "VALIDATE", "Initial candidate verified against baseline (tsc: PASS, test: PASS).");

		// Commit and push candidate
		git(["add", "."]);
		git(["commit", "-m", "feat(summary): initial customer summary implementation"]);
		this.initialCommitSha = git(["rev-parse", "HEAD"]);

		display.loopStep(this.name, "ACT", `Committed initial candidate ${this.initialCommitSha.slice(0, 10)} on refs/heads/${branchName}.`);
		await display.pace(0.5);

		await this.substrate.publishCandidate(this.workDir, candidateRole);
		display.loopStep(this.name, "ACT", `Pushed candidate to substrate on refs/heads/${branchName}.`);

		return {
			commitSha: this.initialCommitSha,
			branch: branchName,
		};
	}

	async observeAndReassess(workState, branchName = "candidate/consumer") {
		const display = this.display;
		const git = (args, extraEnv = {}) => this.substrate.runGit(this.workDir, args, extraEnv);

		display.loopStep(this.name, "OBSERVED", `Received machine-readable work-state event: ${workState.event}`, {
			ProducerRef: `${workState.producer?.candidateRef} (${workState.producer?.candidateCommit?.slice(0, 10)})`,
			ContractFile: workState.contract?.file,
			ChangeSummary: workState.contract?.changes?.map((c) => `${c.action} ${c.property}`).join(", "),
		});
		await display.pace(0.8);

		display.loopStep(this.name, "DERIVED", "Synthesizing cross-worktree impact: Local file 'src/customer-summary.ts' references deleted property 'status'.");
		await display.pace(0.8);

		display.loopStep(this.name, "INFERRED", "Predicted integration failure: TypeScript error TS2339 on integration merge.");
		await display.pace(0.8);

		display.loopStep(this.name, "REASSESS", "Invalidating stale assumption: Adapting implementation to handle structured 'accountState' contract.");
		await display.pace(0.8);

		// Proactive adaptation
		const adaptedCode = `import { readCustomer } from "./customer-store.js";

export interface CustomerSummary {
	id: string;
	name: string;
	isActive: boolean;
}

export function getCustomerSummary(id: string): CustomerSummary {
	const c = readCustomer(id);
	// Proactive adaptation: adapt directly to Customer.accountState contract
	return {
		id: c.id,
		name: c.name,
		isActive: c.accountState.code === "ACT",
	};
}
`;
		await writeFile(path.join(this.workDir, "src", "customer-summary.ts"), adaptedCode);

		git(["add", "."]);
		git(["commit", "-m", "fix(summary): adapt to updated customer accountState contract"]);
		this.adaptedCommitSha = git(["rev-parse", "HEAD"]);

		display.loopStep(this.name, "ACT", `Committed proactive adaptation ${this.adaptedCommitSha.slice(0, 10)} prior to integration.`);
		await display.pace(0.5);

		await this.substrate.publishCandidate(this.workDir, "candidate/consumer");
		display.loopStep(this.name, "ACT", `Pushed proactive adaptation to refs/heads/${branchName}.`);

		return {
			adapted: true,
			initialCommitSha: this.initialCommitSha,
			adaptedCommitSha: this.adaptedCommitSha,
			errorAvoided: "TS2339: Property 'status' does not exist on type 'Customer'",
		};
	}
}
