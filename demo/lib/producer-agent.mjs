// Producer Agent for Nexus Contest Demo
// Bounded execution that autonomously observes baseline, refactors interface, and synthesizes work-state

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

export class ProducerAgent {
	constructor(options = {}) {
		this.agentId = "agent-producer-01";
		this.name = "Producer Agent (Store Team)";
		this.substrate = options.substrate;
		this.display = options.display;
		this.workDir = options.workDir;
		this.tscPath = options.tscPath || findTscPath();
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

	async executeRefactor(branchName = "candidate/producer") {
		const display = this.display;
		const git = (args, extraEnv = {}) => this.substrate.runGit(this.workDir, args, extraEnv);

		// Clone or checkout candidate branch
		display.loopStep(this.name, "OBSERVED", "Reading baseline repository state from substrate.");
		await display.pace(0.5);

		git(["checkout", "-b", branchName]);

		display.loopStep(this.name, "ASSESS", "Assessing task: Refactor Customer contract to support structured verification.", {
			Target: "src/customer-store.ts",
			OldContract: "Customer.status: 'active' | 'suspended'",
			NewContract: "Customer.accountState: { code: 'ACT' | 'SUS', verified: boolean }",
		});
		await display.pace(0.8);

		// Implement breaking change in src/customer-store.ts
		const newStoreCode = `export interface Customer {
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
`;
		await writeFile(path.join(this.workDir, "src", "customer-store.ts"), newStoreCode);

		// Update unit test
		const newStoreTest = `import { readCustomer } from "../src/customer-store.js";
const c = readCustomer("cust-1");
if (c.id !== "cust-1" || c.name !== "Ada" || c.accountState.code !== "ACT" || !c.accountState.verified) {
	throw new Error("Store contract assertion failed");
}
console.log("Store test PASS");
`;
		await writeFile(path.join(this.workDir, "test", "store.test.ts"), newStoreTest);

		display.loopStep(this.name, "ACT", "Refactored store interface and updated unit tests.");
		await display.pace(0.5);

		// Compile and validate locally
		const tscRes = this.runTsc(this.workDir);
		if (tscRes.status !== 0) {
			throw new Error(`Producer TypeScript compilation failed: ${tscRes.stderr || tscRes.stdout}`);
		}

		const testRes = this.runNode(path.join(this.workDir, "dist", "test", "store.test.js"), this.workDir);
		if (testRes.status !== 0) {
			throw new Error(`Producer test execution failed: ${testRes.stderr || testRes.stdout}`);
		}

		display.loopStep(this.name, "VALIDATE", "Producer candidate verified locally (tsc: PASS, unit test: PASS).");

		// Commit candidate
		git(["add", "."]);
		git(["commit", "-m", "refactor(store): replace customer status with structured accountState"]);
		const candidateCommitSha = git(["rev-parse", "HEAD"]);
		const candidateTreeHash = git(["rev-parse", "HEAD^{tree}"]);

		display.loopStep(this.name, "ACT", `Committed candidate ${candidateCommitSha.slice(0, 10)} on refs/heads/candidate/producer.`);
		await display.pace(0.5);

		// Push candidate ref to substrate
		await this.substrate.publishCandidate(this.workDir, "candidate/producer");
		display.loopStep(this.name, "ACT", "Pushed candidate ref to substrate.");

		// Synthesize machine-readable work-state
		const workStatePayload = {
			schema: "nexus.agent-work-state.v1",
			event: "INTERFACE_BREAKING_CHANGE",
			timestamp: new Date().toISOString(),
			producer: {
				actorId: this.agentId,
				candidateCommit: candidateCommitSha,
				candidateTree: candidateTreeHash,
			candidateRef: `refs/heads/${branchName}`,
			},
			contract: {
				file: "src/customer-store.ts",
				type: "BREAKING_INTERFACE_CHANGE",
				symbols: ["Customer", "readCustomer"],
				changes: [
					{ property: "status", action: "REMOVED" },
					{ property: "accountState", action: "ADDED", type: "{ code: 'ACT' | 'SUS', verified: boolean }" },
				],
			},
			status: "PRODUCER_CANDIDATE_READY",
		};

		display.loopStep(this.name, "DERIVED", "Synthesizing machine-readable work-state (nexus.agent-work-state.v1).");
		await display.pace(0.5);

		const publishResult = await this.substrate.publishWorkState(workStatePayload, this.workDir);
		display.loopStep(this.name, "ACT", `Published work-state to substrate (digest: ${publishResult.stateDigest.slice(0, 16)}...).`);

		return {
			commitSha: candidateCommitSha,
			treeHash: candidateTreeHash,
			ref: `refs/heads/${branchName}`,
			workState: workStatePayload,
			workStateDigest: publishResult.stateDigest,
		};
	}
}
