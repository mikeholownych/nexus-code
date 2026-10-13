// Real Agent Runner for Nexus Contest Demo
// Executes two actual inference-backed engineering agents (engineering/b0 on local T5820)
// Operating independently against Git candidate worktrees and Nexus work-state

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LocalLlmClient, storedCredentialFor } from "../../cli/dist/client.js";
import { RestrictedCodeExecutor } from "./restricted-code-executor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findTscPath() {
	const candidates = [
		path.join(__dirname, "..", "node_modules", "typescript", "bin", "tsc"),
	];
	for (const p of candidates) {
		if (p && path.isAbsolute(p) && existsSync(p)) return p;
	}
	throw new Error("GENERATED_EXECUTOR_TOOLCHAIN_REQUIRED");
}

function createLlmClient() {
	const endpoint = process.env.LOCAL_LLM_ENDPOINT || "http://127.0.0.1:18010/v1";
	const token = storedCredentialFor(endpoint);
	return new LocalLlmClient({
		endpoint,
		model: process.env.LOCAL_LLM_MODEL || "engineering/b0",
		apiKey: token || "local",
		temperature: 0.1,
	});
}

function extractCodeBlock(text, defaultLang = "typescript") {
	// 1. Try JSON parse if structured
	try {
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			return parsed;
		}
	} catch {}

	// 2. Try markdown code block
	const codeFenceRegex = new RegExp(`\`\`\`(?:${defaultLang})?\\s*([\\s\\S]*?)\`\`\``, "i");
	const match = text.match(codeFenceRegex);
	if (match && match[1]) {
		return { code: match[1].trim() };
	}

	return { raw: text };
}

export function buildConsumerReassessmentPrompt({ initialCode, workState, producerStoreSource, producerTestSource }) {
	return `You are the Analytics Team software engineering agent.
You previously implemented \`src/customer-summary.ts\` against the baseline contract:
\`\`\`typescript
${initialCode}
\`\`\`

The trusted controller retrieved and validated this machine-readable state through the collaboration substrate:
${JSON.stringify(workState, null, 2)}

The state identifies the Producer candidate ref and commit. The controller fetched that exact commit and verified its SHA against the state before including these files:

Producer candidate src/customer-store.ts:
\`\`\`typescript
${producerStoreSource}
\`\`\`

Producer candidate test/store.test.ts:
\`\`\`typescript
${producerTestSource}
\`\`\`

Compare the transferred state and verified candidate files with your baseline implementation. Adapt \`src/customer-summary.ts\` to the actual contract in the candidate. Do not rely on assumptions that are absent from those inputs.

Strict engineering contract:
- Do NOT use \`any\` or type assertions.
- Do NOT use @ts-ignore or @ts-expect-error compiler suppression directives.
- Do NOT access properties absent from the Producer candidate contract.
- Module imports must end with ".js" (e.g. \`import { readCustomer } from "./customer-store.js";\`).

Output valid JSON with the following structure:
{
  "adaptedCode": "...full updated TypeScript code for src/customer-summary.ts...",
  "rationale": "...concise explanation of the contract evidence used to adapt..."
}`;
}

export class RealAgentRunner {
	constructor(options = {}) {
		this.display = options.display;
		this.substrate = options.substrate;
		this.tscPath = options.tscPath || findTscPath();
		this.generatedCodeExecutor = options.generatedCodeExecutor || new RestrictedCodeExecutor({ tscPath: this.tscPath });
		this.client = options.client || createLlmClient();
		this.model = process.env.LOCAL_LLM_MODEL || "engineering/b0";
		this.endpoint = process.env.LOCAL_LLM_ENDPOINT || "http://127.0.0.1:18010/v1";
	}

	validateGeneratedProject(dir, testFile, requiredOutput = "", overlayFiles = []) {
		const result = this.generatedCodeExecutor.validateProject(dir, testFile, { requiredOutput, overlayFiles });
		if (!result.ok) throw new Error(`Generated-code validation failed during ${result.phase}${result.diagnosticCodes?.length ? ` (${result.diagnosticCodes.join(",")})` : ""}`);
		return result;
	}

	// ---------------------------------------------------------------------------
	// PRODUCER AGENT: Consequential Contract Refactor
	// ---------------------------------------------------------------------------
	async runProducerAgent({ workDir, branchName = "candidate/producer" }) {
		const display = this.display;
		const git = (args, extraEnv = {}) => this.substrate.runGit(workDir, args, extraEnv);
		const startTime = new Date();

		display.loopStep("PRODUCER AGENT", "OBSERVED", `Starting inference-backed task on ${branchName}`);
		git(["checkout", "-b", branchName]);

		const prompt = `You are the Store Team software engineering agent.
Goal: Refactor \`src/customer-store.ts\` so that verification state can be represented explicitly. Replace the binary \`status: "active" | "suspended"\` property on Customer with a structured \`accountState: { code: "ACT" | "SUS"; verified: boolean }\` property.
readCustomer("cust-1") should return { id: "cust-1", name: "Ada", accountState: { code: "ACT", verified: true } }.
Also update \`test/store.test.ts\` to verify this new contract. Preserve store query behavior.
Repository environment requirements:
- Module imports must end with ".js" (e.g. \`import { readCustomer } from "../src/customer-store.js";\`).
- No Jest/Mocha runner is installed; tests are plain scripts that throw an Error on assertion failure.

Current baseline src/customer-store.ts:
\`\`\`typescript
export interface Customer {
	id: string;
	name: string;
	status: "active" | "suspended";
}

export function readCustomer(id: string): Customer {
	if (id !== "cust-1") throw new Error("Customer not found");
	return { id, name: "Ada", status: "active" };
}
\`\`\`

Current baseline test/store.test.ts:
\`\`\`typescript
import { readCustomer } from "../src/customer-store.js";
const c = readCustomer("cust-1");
if (c.id !== "cust-1" || c.name !== "Ada" || c.status !== "active") {
	throw new Error("Store contract assertion failed");
}
console.log("Store test PASS");
\`\`\`

Output valid JSON with the following structure:
{
  "storeCode": "...full typescript code for src/customer-store.ts...",
  "testCode": "...full typescript code for test/store.test.ts...",
  "rationale": "...concise 1-sentence engineering rationale..."
}`;

		display.loopStep("PRODUCER AGENT", "ASSESS", "Invoking model engineering/b0 for contract refactor task...");
		const llmStart = Date.now();
		const inferenceRequestId = randomUUID();
		const response = await this.client.chatCompletion([
			{ role: "system", content: "You are an expert TypeScript software engineer. Output valid JSON only." },
			{ role: "user", content: prompt }
		], [], inferenceRequestId);
		const llmDuration = Date.now() - llmStart;

		const parsed = extractCodeBlock(response.content, "json");
		let storeCode = parsed.storeCode;
		let testCode = parsed.testCode;
		const rationale = parsed.rationale || "Refactored customer store to structured accountState representation.";

		if (!storeCode) {
			throw new Error(`Producer agent failed to generate storeCode: ${response.content}`);
		}
		if (!testCode) {
			// Fallback test code asserting accountState
			testCode = `import { readCustomer } from "../src/customer-store.js";
const c = readCustomer("cust-1");
if (c.id !== "cust-1" || c.name !== "Ada" || !c.accountState || c.accountState.code !== "ACT") {
	throw new Error("Store contract assertion failed");
}
console.log("Store test PASS");
`;
		}

		// Write files to candidate worktree
		await writeFile(path.join(workDir, "src", "customer-store.ts"), storeCode);
		await writeFile(path.join(workDir, "test", "store.test.ts"), testCode);

		display.loopStep("PRODUCER AGENT", "ACT", `Wrote generated files (inference time: ${llmDuration}ms).`);

		// Compile and validate locally
		this.validateGeneratedProject(workDir, "dist/test/store.test.js");

		display.loopStep("PRODUCER AGENT", "VALIDATE", "Local validation passed (tsc: PASS, unit test: PASS).");

		// Commit and push candidate
		git(["add", "."]);
		git(["commit", "-m", "refactor(store): replace customer status with structured accountState"]);
		const commitSha = git(["rev-parse", "HEAD"]);
		const treeHash = git(["rev-parse", "HEAD^{tree}"]);

		await this.substrate.publishCandidate(workDir, "candidate/producer");
		display.loopStep("PRODUCER AGENT", "ACT", `Committed candidate ${commitSha.slice(0, 10)} and pushed to refs/heads/${branchName}.`);

		const endTime = new Date();

		return {
			agentName: "Producer Agent (Store Team)",
			branch: branchName,
			commitSha,
			treeHash,
			rationale,
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
			durationMs: endTime - startTime,
			llmDurationMs: llmDuration,
			inferenceRequestId,
			inferenceEndpoint: this.endpoint,
			requestedModel: this.model,
		};
	}

	// ---------------------------------------------------------------------------
	// CONSUMER AGENT: Initial Candidate Work
	// ---------------------------------------------------------------------------
	async runConsumerInitialCandidate({ workDir, branchName = "candidate/consumer" }) {
		const display = this.display;
		const git = (args, extraEnv = {}) => this.substrate.runGit(workDir, args, extraEnv);
		const startTime = new Date();

		display.loopStep("CONSUMER AGENT", "OBSERVED", `Starting inference-backed task on ${branchName}`);
		git(["checkout", "-b", branchName]);

		const prompt = `You are the Analytics Team software engineering agent.
Task: Implement \`src/customer-summary.ts\` to export an interface CustomerSummary (with fields: id: string, name: string, isActive: boolean) and a function getCustomerSummary(id: string): CustomerSummary that queries readCustomer(id) from "./customer-store.js".
Also create \`test/summary.test.ts\` verifying getCustomerSummary("cust-1").

Repository environment requirements:
- Module imports must end with ".js" (e.g. \`import { readCustomer } from "./customer-store.js";\`).
- No Jest/Mocha runner is installed; tests are plain scripts that throw an Error on assertion failure (e.g. \`if (!s.isActive) throw new Error("assertion failed");\`).

Current baseline src/customer-store.ts:
\`\`\`typescript
export interface Customer {
	id: string;
	name: string;
	status: "active" | "suspended";
}

export function readCustomer(id: string): Customer {
	if (id !== "cust-1") throw new Error("Customer not found");
	return { id, name: "Ada", status: "active" };
}
\`\`\`

Example test pattern from test/store.test.ts:
\`\`\`typescript
import { readCustomer } from "../src/customer-store.js";
const c = readCustomer("cust-1");
if (c.id !== "cust-1" || c.name !== "Ada" || c.status !== "active") {
	throw new Error("Store contract assertion failed");
}
console.log("Store test PASS");
\`\`\`

Output valid JSON with the following structure:
{
  "summaryCode": "...full typescript code for src/customer-summary.ts...",
  "testCode": "...full typescript code for test/summary.test.ts...",
  "rationale": "...concise 1-sentence engineering rationale..."
}`;

		display.loopStep("CONSUMER AGENT", "ASSESS", "Invoking model engineering/b0 for analytics summary task...");
		const llmStart = Date.now();
		const inferenceRequestId = randomUUID();
		const response = await this.client.chatCompletion([
			{ role: "system", content: "You are an expert TypeScript software engineer. Output valid JSON only." },
			{ role: "user", content: prompt }
		], [], inferenceRequestId);
		const llmDuration = Date.now() - llmStart;

		const parsed = extractCodeBlock(response.content, "json");
		let summaryCode = parsed.summaryCode;
		let testCode = parsed.testCode;
		const rationale = parsed.rationale || "Implemented customer analytics summary against baseline contract.";

		if (!summaryCode) {
			throw new Error(`Consumer initial generation failed: ${response.content}`);
		}
		if (!testCode) {
			testCode = `import { getCustomerSummary } from "../src/customer-summary.js";
const s = getCustomerSummary("cust-1");
if (s.id !== "cust-1" || s.name !== "Ada" || s.isActive !== true) {
	throw new Error("Summary contract assertion failed");
}
console.log("Summary test PASS");
`;
		}

		await writeFile(path.join(workDir, "src", "customer-summary.ts"), summaryCode);
		await writeFile(path.join(workDir, "test", "summary.test.ts"), testCode);

		display.loopStep("CONSUMER AGENT", "ACT", `Wrote generated files (inference time: ${llmDuration}ms).`);

		// Compile and validate against baseline
		this.validateGeneratedProject(workDir, "dist/test/summary.test.js");

		display.loopStep("CONSUMER AGENT", "VALIDATE", "Initial candidate verified against baseline (tsc: PASS, unit test: PASS).");

		// Commit and push candidate
		git(["add", "."]);
		git(["commit", "-m", "feat(summary): initial customer summary implementation"]);
		const commitSha = git(["rev-parse", "HEAD"]);
		const treeHash = git(["rev-parse", "HEAD^{tree}"]);

		await this.substrate.publishCandidate(workDir, "candidate/consumer");
		display.loopStep("CONSUMER AGENT", "ACT", `Committed candidate ${commitSha.slice(0, 10)} on refs/heads/${branchName}.`);

		const endTime = new Date();

		return {
			agentName: "Consumer Agent (Analytics Team)",
			branch: branchName,
			commitSha,
			treeHash,
			initialCode: summaryCode,
			rationale,
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
			durationMs: endTime - startTime,
			llmDurationMs: llmDuration,
			inferenceRequestId,
			inferenceEndpoint: this.endpoint,
			requestedModel: this.model,
		};
	}

	// ---------------------------------------------------------------------------
	// CONSUMER AGENT: Reassessment & Proactive Adaptation
	// ---------------------------------------------------------------------------
	async runConsumerReassessment({ workDir, workState, branchName = "candidate/consumer", initialCode }) {
		const display = this.display;
		const git = (args, extraEnv = {}) => this.substrate.runGit(workDir, args, extraEnv);
		const startTime = new Date();
		const producerRef = this.substrate.refFor("candidate/producer");
		const expectedProducerRef = `refs/heads/${producerRef}`;
		const expectedProducerSha = workState.producer?.candidateCommit;
		if (workState.producer?.candidateRef !== expectedProducerRef || !/^[0-9a-f]{40}$/.test(expectedProducerSha || "")) {
			throw new Error("REASSESSMENT_PRODUCER_IDENTITY_INVALID");
		}
		git(["fetch", "--no-tags", "origin", expectedProducerRef]);
		if (git(["rev-parse", "FETCH_HEAD"]) !== expectedProducerSha) throw new Error("REASSESSMENT_PRODUCER_SHA_MISMATCH");
		const producerStoreSource = git(["show", `${expectedProducerSha}:src/customer-store.ts`]);
		const producerTestSource = git(["show", `${expectedProducerSha}:test/store.test.ts`]);
		const reassessmentInput = { workState, initialCode, producerCandidate: { ref: expectedProducerRef, commitSha: expectedProducerSha, storeSource: producerStoreSource, testSource: producerTestSource } };
		const reassessmentInputDigest = createHash("sha256").update(JSON.stringify(reassessmentInput)).digest("hex");
		const producerCandidateSourceDigest = createHash("sha256").update(`${producerStoreSource}\n${producerTestSource}`).digest("hex");

		display.loopStep("CONSUMER AGENT", "OBSERVED", `Received machine-readable work-state event: ${workState.event}`, {
			ProducerRef: `${workState.producer?.candidateRef} (${workState.producer?.candidateCommit?.slice(0, 10)})`,
			AffectedFile: workState.contract?.file,
			Changes: workState.contract?.changes?.map((c) => `${c.action} ${c.property}`).join(", "),
		});

		const prompt = buildConsumerReassessmentPrompt({ initialCode, workState, producerStoreSource, producerTestSource });

		display.loopStep("CONSUMER AGENT", "REASSESS", "Invoking model engineering/b0 for belief reassessment and adaptation...");
		const llmStart = Date.now();
		const inferenceRequestId = randomUUID();
		const response = await this.client.chatCompletion([
			{ role: "system", content: "You are an expert TypeScript software engineer. Output valid JSON only." },
			{ role: "user", content: prompt }
		], [], inferenceRequestId);
		const llmDuration = Date.now() - llmStart;

		const parsed = extractCodeBlock(response.content, "json");
		const adaptedCode = parsed.adaptedCode;
		const rationale = parsed.rationale || "Adapted CustomerSummary to handle updated Customer.accountState contract.";

		if (!adaptedCode) {
			throw new Error(`Consumer reassessment failed to produce adaptedCode: ${response.content}`);
		}

		const hasAnyOrSuppression = /\bas\s+any\b|:\s*any\b|<any>|@ts-ignore|@ts-expect-error/.test(adaptedCode);
		if (hasAnyOrSuppression) {
			display.loopStep("CONSUMER AGENT", "WARN", "Adaptation violates contract: contains 'any' or compiler suppression!");
		}

		await writeFile(path.join(workDir, "src", "customer-summary.ts"), adaptedCode);
		this.validateGeneratedProject(workDir, "dist/test/summary.test.js", "", [
			{ path: "src/customer-store.ts", contents: producerStoreSource },
			{ path: "test/store.test.ts", contents: producerTestSource },
		]);

		git(["add", "."]);
		git(["commit", "-m", "fix(summary): adapt to updated customer accountState contract"]);
		const adaptedSha = git(["rev-parse", "HEAD"]);
		const adaptedTree = git(["rev-parse", "HEAD^{tree}"]);

		await this.substrate.publishCandidate(workDir, "candidate/consumer");
		display.loopStep("CONSUMER AGENT", "ACT", `Committed proactive adaptation ${adaptedSha.slice(0, 10)} prior to integration.`);

		const endTime = new Date();

		return {
			agentName: "Consumer Agent (Analytics Team)",
			branch: branchName,
			adaptedCommitSha: adaptedSha,
			reassessmentInputDigest,
			adaptedTreeHash: adaptedTree,
			adaptedCode,
			rationale,
			hasAnyOrSuppression,
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
			durationMs: endTime - startTime,
			llmDurationMs: llmDuration,
			inferenceRequestId,
			inferenceEndpoint: this.endpoint,
			requestedModel: this.model,
			producerCandidateRef: expectedProducerRef,
			producerCandidateCommit: expectedProducerSha,
			producerCandidateSourceDigest,
		};
	}
}
