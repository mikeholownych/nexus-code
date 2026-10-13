import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudflareSubstrateAdapter, fetchVerifiedWorkState } from "../lib/substrate-adapter.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "nexus-protected-adapter-test-"));
const env = {
	PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
};

function git(args, cwd = root, { allowFailure = false } = {}) {
	const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
	if (result.error || (!allowFailure && result.status !== 0)) throw new Error("SYNTHETIC_GIT_FIXTURE_FAILED");
	return { status: result.status, stdout: result.stdout.trim() };
}

function commit(cwd, message) {
	git(["add", "-A"], cwd);
	git(["-c", "user.name=Synthetic Adapter Test", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message], cwd);
	return git(["rev-parse", "HEAD"], cwd).stdout;
}

function refSha(bare, ref) {
	return git(["--git-dir", bare, "rev-parse", "--verify", `${ref}^{commit}`], root, { allowFailure: true });
}

try {
	const remote = path.join(root, "provider.git");
	const seed = path.join(root, "seed");
	git(["init", "--bare", "--initial-branch=main", remote]);
	git(["init", "--initial-branch=main", seed]);
	mkdirSync(path.join(seed, "src"));
	writeFileSync(path.join(seed, "README.md"), "synthetic baseline\n");
	writeFileSync(path.join(seed, "src", "baseline.ts"), "export const baseline = true;\n");
	const defaultSha = commit(seed, "synthetic baseline");
	git(["remote", "add", "origin", remote], seed);
	git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], seed);
	const defaultTree = git(["--git-dir", remote, "rev-parse", "main^{tree}"]).stdout;
	const defaultBundlePath = path.join(root, "default.bundle");
	git(["bundle", "create", defaultBundlePath, "refs/heads/main"], seed);
	const defaultBundle = readFileSync(defaultBundlePath).toString("base64");

	const operations = [];
	const artifactCanary = "SYNTHETIC_ARTIFACT_CREDENTIAL_CANARY_ONLY";
	const workerCanary = "SYNTHETIC_WORKER_BEARER_CANARY_ONLY";
	const runId = "123e4567-e89b-42d3-a456-426614174000";
	let tamperWorker = null;
	const repository = { namespace: "nexus-exp1-oct02", name: "external-git-proof", id: "4v94nnw1eqf0sanw" };

	async function protectedRequest(request) {
		operations.push(structuredClone(request));
		assert.equal(JSON.stringify(request).includes(artifactCanary), false);
		assert.equal(JSON.stringify(request).includes(workerCanary), false);
		if (request.operation === "repo-default") return { ok: true, operation: "repo-default", repository, ref: "refs/heads/main", sha: defaultSha, tree: defaultTree, bundleBase64: defaultBundle };
		if (request.operation === "publish-ref") {
			const ref = `refs/heads/contest-demo/${request.runId}/${request.role}`;
			const current = refSha(remote, ref);
			const oldSha = current.status === 0 ? current.stdout : null;
			assert.equal(request.expectedOldSha, oldSha, "publish request carries the exact previously observed old SHA");
			const bundlePath = path.join(root, `incoming-${randomUUID()}.bundle`);
			writeFileSync(bundlePath, Buffer.from(request.bundleBase64, "base64"));
			const listed = git(["bundle", "list-heads", bundlePath]).stdout.split("\n");
			assert.equal(listed.length, 1);
			assert.equal(listed[0].split(/\s+/)[1], ref);
			git(["--git-dir", remote, "fetch", "--no-tags", bundlePath, `+${ref}:${ref}`]);
			const sha = refSha(remote, ref).stdout;
			assert.equal(sha, request.commitSha);
			return { ok: true, operation: "publish-ref", repository, runId, role: request.role, ref, sha, tree: git(["--git-dir", remote, "rev-parse", `${sha}^{tree}`]).stdout, elapsedMs: 1 };
		}
		if (request.operation === "repo-ref") {
			const ref = `refs/heads/contest-demo/${request.runId}/${request.role}`;
			const found = refSha(remote, ref);
			assert.equal(found.status, 0);
			const sha = found.stdout;
			return { ok: true, operation: "repo-ref", repository, runId, role: request.role, ref, sha, tree: git(["--git-dir", remote, "rev-parse", `${sha}^{tree}`]).stdout };
		}
		if (request.operation === "worker-work-state") {
			const ref = `refs/heads/contest-demo/${request.runId}/work-state`;
			const stateBytes = Buffer.from(git(["--git-dir", remote, "show", `${ref}:.agent/work-state.json`]).stdout);
			const sha = refSha(remote, ref).stdout;
			const result = {
				ok: true, operation: "worker-work-state", repository, runId, ref,
				stateCommit: sha,
				stateTree: git(["--git-dir", remote, "rev-parse", `${sha}^{tree}`]).stdout,
				stateContentSha256: createHash("sha256").update(stateBytes).digest("hex"),
				responseStatus: 200,
				state: JSON.parse(stateBytes.toString("utf8")),
			};
			return tamperWorker ? tamperWorker(result) : result;
		}
		return { ok: false, error: "OPERATION_NOT_ADMITTED" };
	}

	const adapter = new CloudflareSubstrateAdapter({ runId, protectedRequest, testOnlyExpectedDefaultSha: defaultSha });
	await adapter.initialize();
	assert.equal(adapter.getRemoteUrl(), path.join(adapter.rootDir, "local-origin.git"), "ordinary local candidate Git uses a credential-free mirror");

	const baseline = path.join(root, "baseline-work");
	git(["clone", "--quiet", adapter.getRemoteUrl(), baseline]);
	const baselineRefName = adapter.refFor("baseline");
	git(["checkout", "--quiet", "-b", baselineRefName], baseline);
	writeFileSync(path.join(baseline, "demo-baseline.txt"), "baseline\n");
	const baselineCommit = commit(baseline, "demo baseline");
	await adapter.publishCandidate(baseline, "baseline");
	assert.equal((await adapter.observeRef("baseline")).sha, baselineCommit);

	const producer = path.join(root, "producer-work");
	git(["clone", "--quiet", adapter.getRemoteUrl(), producer]);
	adapter.checkoutBaseline(producer, "producer-start");
	const producerBranch = adapter.refFor("candidate/producer");
	git(["checkout", "--quiet", "-b", producerBranch], producer);
	writeFileSync(path.join(producer, "producer.txt"), "producer candidate\n");
	const producerSha = commit(producer, "producer candidate");
	const producerPublish = await adapter.publishCandidate(producer, "candidate/producer");
	assert.equal(producerPublish.sha, producerSha);
	assert.equal((await adapter.observeRef("candidate/producer")).sha, producerSha);

	const state = { schema: "nexus.agent-work-state.v1", event: "INTERFACE_BREAKING_CHANGE", producer: { candidateCommit: producerSha } };
	const publishedState = await adapter.publishWorkState(state, producer);
	const retrieved = await fetchVerifiedWorkState(adapter, producer, publishedState);
	assert.deepEqual(retrieved.state, state);
	assert.equal(retrieved.transport, "cloudflare-worker");
	assert.equal(retrieved.stateCommit, publishedState.stateCommitSha);
	assert.equal(retrieved.stateContentSha256, publishedState.stateDigest);
	assert.equal(JSON.stringify(retrieved).includes(artifactCanary), false);
	assert.equal(JSON.stringify(retrieved).includes(workerCanary), false);

	const integration = path.join(root, "integration-work");
	git(["clone", "--quiet", adapter.getRemoteUrl(), integration]);
	adapter.checkoutBaseline(integration, "integration-start");
	const integrationRefName = adapter.refFor("integration");
	git(["checkout", "--quiet", "-b", integrationRefName], integration);
	writeFileSync(path.join(integration, "integration.txt"), "validated integration\n");
	const integrationSha = commit(integration, "integration result");
	const publishedIntegration = await adapter.publishCandidate(integration, "integration");
	const observedIntegration = await adapter.observeRef("integration");
	assert.equal(publishedIntegration.sha, integrationSha);
	assert.equal(observedIntegration.sha, integrationSha);

	assert.throws(() => new CloudflareSubstrateAdapter({ namespace: "attacker", protectedRequest }), /CLOUDFLARE_REPOSITORY_OVERRIDE_REJECTED/);
	assert.throws(() => new CloudflareSubstrateAdapter({ runId: "../../main", protectedRequest }), /DEMO_RUN_ID_NOT_ADMITTED/);
	await assert.rejects(adapter.publishCandidate(integration, "main"), /CANDIDATE_ROLE_NOT_ADMITTED/);
	assert.deepEqual(operations.map((request) => request.operation), [
		"repo-default", "publish-ref", "repo-ref", "publish-ref", "repo-ref", "publish-ref", "worker-work-state", "publish-ref", "repo-ref",
	]);
	assert.equal(operations.some((request) => "args" in request || "url" in request || "credentialPath" in request), false);

	tamperWorker = (response) => ({ ...response, ref: "refs/heads/main" });
	await assert.rejects(adapter.fetchWorkState(), /Worker work-state ref mismatch/);
	tamperWorker = (response) => ({ ...response, responseStatus: 503 });
	await assert.rejects(adapter.fetchWorkState(), /WORKER_RESPONSE_STATUS_INVALID/);
	await assert.rejects(fetchVerifiedWorkState({
		isRealCloudflare: true,
		fetchWorkState: async () => ({ ...retrieved, transport: "local-git" }),
	}, producer, publishedState), /transport did not match/);

	console.log(JSON.stringify({
		result: "PASS",
		mode: "synthetic local bare repository and protected-operation seam",
		operations: operations.map((request) => request.operation),
		baselineSha: defaultSha,
		producerSha,
		workStateSha: publishedState.stateCommitSha,
		integrationSha,
		workerDerivedPayloadVerified: true,
		canaryValuesObservedByAdapter: false,
	}));
} finally {
	rmSync(root, { recursive: true, force: true });
}
