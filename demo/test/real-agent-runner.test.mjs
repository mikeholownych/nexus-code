import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RealAgentRunner } from "../lib/real-agent-runner.mjs";

test("consumer reassessment prompt is built from worker state and its verified producer commit", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "nexus-consumer-causality-test-"));
	const workDir = path.join(root, "consumer");
	await mkdir(path.join(workDir, "src"), { recursive: true });
	const candidateSha = "a".repeat(40);
	const adaptedSha = "b".repeat(40);
	const candidateStore = "export interface Contract { revision: 'from-producer'; }\n";
	const candidateTest = "if (true !== true) throw new Error('fixture');\n";
	const state = {
		schema: "nexus.agent-work-state.v1",
		event: "CONTRACT_UPDATED",
		producer: { candidateRef: "refs/heads/contest-demo/11111111-1111-4111-8111-111111111111/candidate/producer", candidateCommit: candidateSha },
		contract: { file: "src/customer-store.ts", changes: [{ property: "revision", action: "ADDED" }] },
	};
	const order = [];
	const substrate = {
		refFor(role) { return `contest-demo/11111111-1111-4111-8111-111111111111/${role}`; },
		runGit(_dir, args) {
			order.push(args[0]);
			if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") return candidateSha;
			if (args[0] === "show" && args[1] === `${candidateSha}:src/customer-store.ts`) return candidateStore;
			if (args[0] === "show" && args[1] === `${candidateSha}:test/store.test.ts`) return candidateTest;
			if (args[0] === "rev-parse" && args[1] === "HEAD") return adaptedSha;
			if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return "c".repeat(40);
			return "";
		},
		async publishCandidate() { order.push("publishCandidate"); return { ok: true }; },
	};
	let capturedPrompt = "";
	let capturedRequestId = "";
	const client = {
		async chatCompletion(messages, tools, requestId) {
			assert.deepEqual(tools, []);
			assert.ok(order.includes("fetch"), "candidate must be fetched before inference");
			assert.ok(order.indexOf("fetch") < order.indexOf("show"));
			capturedPrompt = messages[1].content;
			capturedRequestId = requestId;
			return { content: JSON.stringify({ adaptedCode: "export const result = true;\n", rationale: "Used the transferred contract revision." }) };
		},
	};
	const runner = new RealAgentRunner({
		display: { loopStep() {} },
		substrate,
		tscPath: "/usr/bin/node",
		client,
		generatedCodeExecutor: { validateProject() { order.push("validate"); return { ok: true }; } },
	});
	try {
		const result = await runner.runConsumerReassessment({
			workDir,
			workState: state,
			initialCode: "export const oldResult = false;\n",
			branchName: "candidate/consumer",
		});
		assert.match(capturedRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.ok(capturedPrompt.includes(JSON.stringify(state, null, 2)));
		assert.ok(capturedPrompt.includes(candidateStore));
		assert.ok(capturedPrompt.includes(candidateTest));
		assert.ok(capturedPrompt.includes(candidateSha));
		assert.ok(!capturedPrompt.includes("accountState"));
		assert.ok(!capturedPrompt.includes("code === \\\"ACT\\\""));
		assert.equal(result.producerCandidateCommit, candidateSha);
		assert.match(result.producerCandidateSourceDigest, /^[0-9a-f]{64}$/);
		assert.match(result.reassessmentInputDigest, /^[0-9a-f]{64}$/);
		assert.equal(result.inferenceRequestId, capturedRequestId);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
