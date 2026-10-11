import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { classifyGitFailure, createDemoTransport, DEMO_REPOSITORY, runBrokerRequest } from "./demo-transport.mjs";

const tokenCanary = "SYNTHETIC_ARTIFACT_GIT_CREDENTIAL_CANARY_8e30d4";
const workerCanary = "SYNTHETIC_WORKER_BEARER_CANARY_90c2bf";
const uid = process.getuid();

function git(args, cwd, extraEnv = {}) {
	const result = spawnSync("/usr/bin/git", args, {
		cwd, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024,
		env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
	});
	if (result.status !== 0) throw new Error(`fixture Git command failed: ${args[0]} ${result.stderr.replaceAll(tokenCanary, "[CANARY]").replaceAll(workerCanary, "[CANARY]").trim()}`);
	return result.stdout.trim();
}

function identityEnv() {
	return { GIT_AUTHOR_NAME: "Synthetic Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Synthetic Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
}

function commitFile(repo, file, content, message) {
	const target = path.join(repo, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
	git(["add", "--", file], repo);
	git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message], repo, identityEnv());
	return git(["rev-parse", "HEAD"], repo);
}

function bundleFor(repo, ref, out) {
	git(["update-ref", ref, "HEAD"], repo);
	git(["bundle", "create", out, ref], repo);
	return readFileSync(out).toString("base64");
}

function writeSecret(file, value, mode = 0o400) {
	writeFileSync(file, value, { mode });
	chmodSync(file, mode);
}

function setupFixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "nexus-demo-transport-test-"));
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "seed");
	const artifactPath = path.join(root, "artifacts.token");
	const workerPath = path.join(root, "worker.token");
	const brokerScratch = path.join(root, "broker-scratch");
	mkdirSync(brokerScratch);
	git(["init", "--bare", "--initial-branch=main", origin], root);
	git(["init", "--initial-branch=main", work], root);
	commitFile(work, "README.md", "synthetic baseline\n", "baseline");
	git(["remote", "add", "origin", origin], work);
	git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], work);
	const defaultSha = git(["rev-parse", "HEAD"], work);
	writeSecret(artifactPath, tokenCanary);
	writeSecret(workerPath, workerCanary);
	const repository = { namespace: "synthetic", name: "fixture", id: "fixture-repository-id", remote: origin, defaultBranch: "main", defaultSha };
	const observedInvocations = [];
	const observedResults = [];
	const credentialConfigReads = [];
	const options = {
		repository, remote: origin, allowLocalRemoteForTest: true, allowWorkerEndpointForTest: true,
		artifactCredentialPath: artifactPath, workerBearerPath: workerPath, expectedFileOwner: uid, expectedFileGroup: process.getgid(),
		workerEndpoint: "https://worker.invalid/work-state", onGitInvocation: (record) => {
			observedInvocations.push(record);
			const gitDirIndex = record.args.indexOf("--git-dir");
			if (gitDirIndex >= 0) {
				const configPath = path.join(record.args[gitDirIndex + 1], "config");
				try {
					const contents = readFileSync(configPath, "utf8");
					credentialConfigReads.push(!contents.includes(tokenCanary) && !contents.includes("Authorization:"));
				} catch { /* not every invocation operates in a repository */ }
			}
		}, onGitResult: (record) => observedResults.push({ ...record, stdout: record.stdout.replaceAll(tokenCanary, "[CANARY]"), stderr: record.stderr.replaceAll(tokenCanary, "[CANARY]") }),
		tempDirectory: brokerScratch,
	};
	return { root, origin, work, artifactPath, workerPath, repository, defaultSha, observedInvocations, observedResults, credentialConfigReads, options };
}

function cleanup(fixture) { rmSync(fixture.root, { recursive: true, force: true }); }

test("fixed request schema rejects caller-selected credentials, remotes, URLs, paths, refs, and commands", async () => {
	const fixture = setupFixture();
	try {
		const transport = createDemoTransport(fixture.options);
		for (const request of [
			{ operation: "repo-default", remote: fixture.origin },
			{ operation: "repo-default", credentialPath: fixture.artifactPath },
			{ operation: "repo-default", args: ["push", "--force"] },
			{ operation: "repo-ref", runId: randomUUID(), role: "main" },
			{ operation: "repo-ref", runId: "../../main", role: "baseline" },
			{ operation: "worker-work-state", runId: randomUUID(), expectedCommitSha: "a".repeat(40), expectedContentDigest: "b".repeat(64), url: "https://attacker.invalid" },
		]) {
			await assert.rejects(() => transport.handle(request));
		}
		assert.throws(() => createDemoTransport({ ...fixture.options, allowLocalRemoteForTest: false }));
	} finally { cleanup(fixture); }
});

test("capability status is bounded, distinguishes absent from invalid custody, and never returns secret material", async () => {
	const fixture = setupFixture();
	try {
		const ready = await runBrokerRequest({ operation: "capability-status" }, fixture.options);
		assert.deepEqual(ready, { ok: true, operation: "capability-status", artifactsGitCredential: "CUSTODY_VALID", workerBearer: "CUSTODY_VALID" });
		assert.equal(JSON.stringify(ready).includes(tokenCanary), false);
		assert.equal(JSON.stringify(ready).includes(workerCanary), false);
		assert.equal(JSON.stringify(ready).includes(fixture.artifactPath), false);
		assert.equal(JSON.stringify(ready).includes(fixture.workerPath), false);

		const missingOptions = { ...fixture.options, artifactCredentialPath: path.join(fixture.root, "absent.token"), workerBearerPath: path.join(fixture.root, "absent.bearer") };
		const missing = await runBrokerRequest({ operation: "capability-status" }, missingOptions);
		assert.deepEqual(missing, { ok: true, operation: "capability-status", artifactsGitCredential: "NOT_PROVISIONED", workerBearer: "NOT_PROVISIONED" });

		chmodSync(fixture.artifactPath, 0o600);
		const invalid = await runBrokerRequest({ operation: "capability-status" }, fixture.options);
		assert.equal(invalid.artifactsGitCredential, "CUSTODY_INVALID");
		assert.equal(invalid.workerBearer, "CUSTODY_VALID");
		const wrongOwner = await runBrokerRequest({ operation: "capability-status" }, { ...fixture.options, expectedFileOwner: 0, expectedFileGroup: 0 });
		assert.equal(wrongOwner.artifactsGitCredential, "CUSTODY_INVALID");
		assert.equal(wrongOwner.workerBearer, "CUSTODY_INVALID");
		rmSync(fixture.artifactPath);
		mkdirSync(fixture.artifactPath);
		const wrongType = await runBrokerRequest({ operation: "capability-status" }, fixture.options);
		assert.equal(wrongType.artifactsGitCredential, "CUSTODY_INVALID");
		assert.equal(wrongType.workerBearer, "CUSTODY_VALID");
		chmodSync(fixture.root, 0o755);
		const unsafeDirectory = await runBrokerRequest({ operation: "capability-status" }, fixture.options);
		assert.equal(unsafeDirectory.artifactsGitCredential, "CUSTODY_INVALID");
		assert.equal(unsafeDirectory.workerBearer, "CUSTODY_INVALID");
		chmodSync(fixture.root, 0o700);
		await assert.rejects(() => createDemoTransport(fixture.options).handle({ operation: "capability-status", artifactCredentialPath: fixture.artifactPath }));
	} finally { cleanup(fixture); }
});

test("synthetic local Git exports and publishes only admitted refs with ancestry and compare-and-swap checks", async () => {
	const fixture = setupFixture();
	try {
		const transport = createDemoTransport(fixture.options);
		const runId = randomUUID();
		const initial = await transport.handle({ operation: "repo-default" });
		assert.equal(initial.sha, fixture.defaultSha);
		assert.deepEqual(initial.repository, { namespace: "synthetic", name: "fixture", id: "fixture-repository-id" });
		assert.ok(initial.bundleBase64.length > 0);
		assert.equal(JSON.stringify(initial).includes(tokenCanary), false);

		const baselineWork = path.join(fixture.root, "baseline-work");
		git(["clone", "--quiet", fixture.origin, baselineWork], fixture.root);
		commitFile(baselineWork, "src/customer-store.ts", "export const baseline = true;\n", "scenario baseline");
		const baselineSha = git(["rev-parse", "HEAD"], baselineWork);
		const runBaselineRef = `refs/heads/contest-demo/${runId}/baseline`;
		const baselineBundle = bundleFor(baselineWork, runBaselineRef, path.join(fixture.root, "baseline.bundle"));
		let baselineResult;
		try { baselineResult = await transport.handle({ operation: "publish-ref", runId, role: "baseline", expectedOldSha: null, commitSha: baselineSha, bundleBase64: baselineBundle }); }
		catch (error) { throw new Error(`${error.message}: ${fixture.observedResults.slice(-5).map((row) => row.stderr).join(" ")}`); }
		assert.equal(baselineResult.sha, baselineSha);

		const producer = path.join(fixture.root, "producer");
		git(["clone", "--quiet", fixture.origin, producer], fixture.root);
		const baselineRef = `refs/heads/contest-demo/${runId}/baseline`;
		git(["fetch", "--quiet", "origin", `${baselineRef}:${baselineRef}`], producer);
		git(["checkout", "--quiet", "-B", "producer", baselineRef], producer);
		commitFile(producer, "src/customer-store.ts", "export const producer = true;\n", "producer candidate");
		const producerSha = git(["rev-parse", "HEAD"], producer);
		const producerRef = `refs/heads/contest-demo/${runId}/candidate/producer`;
		const producerBundle = bundleFor(producer, producerRef, path.join(fixture.root, "producer.bundle"));
		const producerResult = await transport.handle({ operation: "publish-ref", runId, role: "candidate/producer", expectedOldSha: null, commitSha: producerSha, bundleBase64: producerBundle });
		assert.equal(producerResult.sha, producerSha);
		assert.equal(JSON.stringify(producerResult).includes(tokenCanary), false);

		const malicious = path.join(fixture.root, "malicious-candidate");
		git(["clone", "--quiet", fixture.origin, malicious], fixture.root);
		git(["fetch", "--quiet", "origin", `${baselineRef}:${baselineRef}`], malicious);
		git(["checkout", "--quiet", "-B", "malicious", baselineRef], malicious);
		commitFile(malicious, "src/accidental-secret.txt", tokenCanary, "synthetic canary negative control");
		const maliciousSha = git(["rev-parse", "HEAD"], malicious);
		const maliciousRef = `refs/heads/contest-demo/${runId}/candidate/control`;
		const maliciousBundle = bundleFor(malicious, maliciousRef, path.join(fixture.root, "malicious.bundle"));
		const blockedSecret = await runBrokerRequest({ operation: "publish-ref", runId, role: "candidate/control", expectedOldSha: null, commitSha: maliciousSha, bundleBase64: maliciousBundle }, fixture.options);
		assert.deepEqual(blockedSecret, { ok: false, error: "CREDENTIAL_REFLECTION_BLOCKED" });
		assert.deepEqual(readdirSync(path.join(fixture.root, "broker-scratch")), []);
		assert.equal(git(["ls-remote", fixture.origin, maliciousRef], fixture.root), "");

		const stateRepo = path.join(fixture.root, "state");
		git(["init", "--initial-branch=main", stateRepo], fixture.root);
		const state = { schema: "nexus.agent-work-state.v1", event: "INTERFACE_BREAKING_CHANGE", producer: { candidateCommit: producerSha, candidateRef: producerRef } };
		const stateFile = path.join(stateRepo, ".agent", "work-state.json");
		mkdirSync(path.dirname(stateFile), { recursive: true });
		writeFileSync(stateFile, JSON.stringify(state, null, 2));
		git(["add", ".agent/work-state.json"], stateRepo);
		git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "work state"], stateRepo, identityEnv());
		const stateSha = git(["rev-parse", "HEAD"], stateRepo);
		const stateRef = `refs/heads/contest-demo/${runId}/work-state`;
		const stateBundle = bundleFor(stateRepo, stateRef, path.join(fixture.root, "state.bundle"));
		const statePublish = await transport.handle({ operation: "publish-ref", runId, role: "work-state", expectedOldSha: null, commitSha: stateSha, bundleBase64: stateBundle });
		assert.equal(statePublish.sha, stateSha);
		const exportedState = await transport.handle({ operation: "repo-ref", runId, role: "work-state" });
		assert.equal(exportedState.sha, stateSha);

		const integration = path.join(fixture.root, "integration");
		const consumer = path.join(fixture.root, "consumer");
		git(["clone", "--quiet", fixture.origin, consumer], fixture.root);
		git(["fetch", "--quiet", "origin", `${baselineRef}:${baselineRef}`], consumer);
		git(["checkout", "--quiet", "-B", "consumer", baselineRef], consumer);
		commitFile(consumer, "src/customer-summary.ts", "export const consumer = true;\n", "consumer candidate");
		const consumerSha = git(["rev-parse", "HEAD"], consumer);
		const consumerRef = `refs/heads/contest-demo/${runId}/candidate/consumer`;
		const consumerBundle = bundleFor(consumer, consumerRef, path.join(fixture.root, "consumer.bundle"));
		assert.equal((await transport.handle({ operation: "publish-ref", runId, role: "candidate/consumer", expectedOldSha: null, commitSha: consumerSha, bundleBase64: consumerBundle })).sha, consumerSha);

		const beforeRejectedUpdate = git(["ls-remote", fixture.origin, producerRef], fixture.root);
		const wrongOld = await runBrokerRequest({ operation: "publish-ref", runId, role: "candidate/producer", expectedOldSha: "f".repeat(40), commitSha: producerSha, bundleBase64: producerBundle }, fixture.options);
		assert.deepEqual(wrongOld, { ok: false, error: "REF_STATE_MISMATCH" });
		assert.equal(git(["ls-remote", fixture.origin, producerRef], fixture.root), beforeRejectedUpdate);

		git(["clone", "--quiet", fixture.origin, integration], fixture.root);
		git(["fetch", "--quiet", "origin"], integration);
		git(["checkout", "--quiet", "-B", "integration", producerSha], integration);
		git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--quiet", "--no-ff", "-m", "integration", consumerSha], integration, identityEnv());
		const integrationSha = git(["rev-parse", "HEAD"], integration);
		const integrationRef = `refs/heads/contest-demo/${runId}/integration`;
		const integrationBundle = bundleFor(integration, integrationRef, path.join(fixture.root, "integration.bundle"));
		assert.equal((await transport.handle({ operation: "publish-ref", runId, role: "integration", expectedOldSha: null, commitSha: integrationSha, bundleBase64: integrationBundle })).sha, integrationSha);

		const exported = await transport.handle({ operation: "repo-ref", runId, role: "integration" });
		assert.equal(exported.sha, integrationSha);
		assert.equal(exported.repository.id, fixture.repository.id);
		const exportedBundlePath = path.join(fixture.root, "exported.bundle");
		writeFileSync(exportedBundlePath, Buffer.from(exported.bundleBase64, "base64"));
		assert.match(git(["bundle", "list-heads", exportedBundlePath], fixture.root), new RegExp(integrationSha));
		assert.ok(fixture.observedInvocations.some(({ env }) => Object.values(env).some((value) => value?.includes?.(tokenCanary))));
		for (const { args, env } of fixture.observedInvocations) {
			assert.equal(args.some((arg) => arg.includes(tokenCanary)), false);
			if (Object.values(env).some((value) => value?.includes?.(tokenCanary))) assert.equal(env.GIT_CONFIG_VALUE_0.includes(tokenCanary), true);
			assert.equal(args.some((arg) => arg.includes("Authorization")), false);
		}
		assert.ok(fixture.credentialConfigReads.length > 0);
		assert.ok(fixture.credentialConfigReads.every(Boolean));
		assert.deepEqual(readdirSync(path.join(fixture.root, "broker-scratch")), []);
		const finalRefs = git(["for-each-ref", "--format=%(refname)"], fixture.origin);
		assert.match(finalRefs, new RegExp(runId));
		assert.equal(finalRefs.split("\n").some((ref) => ref === "refs/heads/main" && !ref.startsWith(`refs/heads/contest-demo/${runId}/`)), true);
	} finally { cleanup(fixture); }
});

test("Worker operation uses only the fixed endpoint and returns validated work state without bearer material", async () => {
	const fixture = setupFixture();
	try {
		const runId = randomUUID();
		const state = { schema: "nexus.agent-work-state.v1", event: "INTERFACE_BREAKING_CHANGE", producer: { candidateCommit: "a".repeat(40) } };
		const digest = createHash("sha256").update(JSON.stringify(state, null, 2)).digest("hex");
		const response = { repository: { namespace: fixture.repository.namespace, name: fixture.repository.name, id: fixture.repository.id }, ref: `refs/heads/contest-demo/${runId}/work-state`, stateCommit: "b".repeat(40), stateTree: "c".repeat(40), stateContentSha256: digest, state };
		let observedUrl;
		let observedAuthorization;
		const options = { ...fixture.options, workerFetch: async (url, init) => {
			observedUrl = String(url);
			observedAuthorization = init.headers.authorization;
			return Response.json(response);
		} };
		const result = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, options);
		assert.equal(result.ok, true);
		assert.deepEqual(result.state, state);
		assert.equal(result.ref, response.ref);
		assert.equal(observedAuthorization, `Bearer ${workerCanary}`);
		assert.equal(new URL(observedUrl).origin + new URL(observedUrl).pathname, "https://worker.invalid/work-state");
		assert.equal(JSON.stringify(result).includes(workerCanary), false);
		assert.equal(JSON.stringify(result).includes(tokenCanary), false);

		const mismatch = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: "d".repeat(40), expectedContentDigest: digest }, options);
		assert.deepEqual(mismatch, { ok: false, error: "WORKER_STATE_MISMATCH" });
		const denied = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => new Response("", { status: 401 }) });
		assert.deepEqual(denied, { ok: false, error: "WORKER_AUTHENTICATION_FAILED" });
		const transportFailure = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => { throw new TypeError("synthetic transport failure"); } });
		assert.deepEqual(transportFailure, { ok: false, error: "WORKER_UNAVAILABLE" });
		const bodyTransportFailure = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic body transport failure")); } }), { status: 503 }) });
		assert.deepEqual(bodyTransportFailure, { ok: false, error: "WORKER_UNAVAILABLE" });
		const missingState = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => Response.json({ error: "Work state not found" }, { status: 404 }) });
		assert.deepEqual(missingState, { ok: false, error: "WORK_STATE_NOT_FOUND" });
		const candidateMismatch = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => Response.json({ error: "Candidate reference changed" }, { status: 409 }) });
		assert.deepEqual(candidateMismatch, { ok: false, error: "CANDIDATE_MISMATCH" });
		const invalidPayload = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => Response.json({ error: "Invalid work state" }, { status: 502 }) });
		assert.deepEqual(invalidPayload, { ok: false, error: "WORKER_RESPONSE_INVALID" });
		const secretFailureBody = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => Response.json({ error: workerCanary }, { status: 404 }) });
		assert.deepEqual(secretFailureBody, { ok: false, error: "WORKER_RESPONSE_INVALID" });
		assert.equal(JSON.stringify([transportFailure, bodyTransportFailure, missingState, candidateMismatch, invalidPayload, secretFailureBody]).includes(workerCanary), false);
		const brokenJson = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => new Response("not-json", { status: 200 }) });
		assert.deepEqual(brokenJson, { ok: false, error: "WORKER_RESPONSE_INVALID" });
		const reflected = await runBrokerRequest({ operation: "worker-work-state", runId, expectedCommitSha: response.stateCommit, expectedContentDigest: digest }, { ...options, workerFetch: async () => new Response(JSON.stringify({ ...response, state: { ...state, note: workerCanary } }), { status: 200 }) });
		assert.equal(reflected.ok, false);
		assert.equal(JSON.stringify(reflected).includes(workerCanary), false);
	} finally { cleanup(fixture); }
});

test("missing or unsafe capability files fail closed and errors never reflect canaries", async () => {
	const fixture = setupFixture();
	try {
		const missing = await runBrokerRequest({ operation: "repo-default" }, { ...fixture.options, artifactCredentialPath: path.join(fixture.root, "missing.token") });
		assert.deepEqual(missing, { ok: false, error: "CREDENTIAL_NOT_PROVISIONED" });
		const unsafePath = path.join(fixture.root, "unsafe.token");
		writeSecret(unsafePath, tokenCanary, 0o600);
		const unsafe = await runBrokerRequest({ operation: "repo-default" }, { ...fixture.options, artifactCredentialPath: unsafePath });
		assert.deepEqual(unsafe, { ok: false, error: "CREDENTIAL_CUSTODY_INVALID" });
		const missingWorker = await runBrokerRequest({ operation: "worker-work-state", runId: randomUUID(), expectedCommitSha: "a".repeat(40), expectedContentDigest: "b".repeat(64) }, { ...fixture.options, workerBearerPath: path.join(fixture.root, "missing-worker") });
		assert.deepEqual(missingWorker, { ok: false, error: "WORKER_CAPABILITY_NOT_PROVISIONED" });
		assert.equal(JSON.stringify([missing, unsafe, missingWorker]).includes(tokenCanary), false);
		assert.equal(JSON.stringify([missing, unsafe, missingWorker]).includes(workerCanary), false);
	} finally { cleanup(fixture); }
});

test("provider child output containing a credential is reduced to a sanitized result", async () => {
	const fixture = setupFixture();
	try {
		const fakeSource = path.join(fixture.root, "fake-git.c");
		const fakeGit = path.join(fixture.root, "fake-git");
		writeFileSync(fakeSource, "#include <stdio.h>\n#include <stdlib.h>\nint main(void){const char*v=getenv(\"GIT_CONFIG_VALUE_0\");fprintf(stdout,\"%s\",v?v:\"\");fprintf(stderr,\"%s\",v?v:\"\");return 1;}\n");
		const compiled = spawnSync("/usr/bin/cc", ["-o", fakeGit, fakeSource], { encoding: "utf8", timeout: 15000 });
		assert.equal(compiled.status, 0);
		chmodSync(fakeGit, 0o500);
		const result = await runBrokerRequest({ operation: "repo-default" }, { ...fixture.options, gitExecutable: fakeGit, expectedGitOwner: uid });
		assert.deepEqual(result, { ok: false, error: "ARTIFACTS_OPERATION_FAILED" });
		assert.equal(JSON.stringify(result).includes(tokenCanary), false);
		assert.equal(JSON.stringify(result).includes("Authorization: Bearer"), false);
	} finally { cleanup(fixture); }
});

test("request parser rejects malformed and oversized input without echoing bytes", async () => {
	const { parseRequestBytes } = await import("./demo-transport.mjs");
	assert.throws(() => parseRequestBytes(Buffer.from(`not-json-${tokenCanary}`)));
	assert.throws(() => parseRequestBytes(Buffer.alloc(24 * 1024 * 1024 + 1)));
	assert.equal(DEMO_REPOSITORY.remote.includes(tokenCanary), false);
});

test("Git auth classification requires authentication evidence and does not treat provider 5xx as auth denial", () => {
	assert.equal(classifyGitFailure("fatal: Authentication failed for https://artifacts.invalid/repo", true, "remote-read"), "ARTIFACTS_AUTHENTICATION_FAILED");
	assert.equal(classifyGitFailure("The requested URL returned error: 403", true, "remote-read"), "ARTIFACTS_AUTHENTICATION_FAILED");
	assert.equal(classifyGitFailure("The requested URL returned error: 503", true, "remote-read"), "ARTIFACTS_OPERATION_FAILED");
	assert.equal(classifyGitFailure("Could not resolve host: artifacts.invalid", true, "remote-read"), "ARTIFACTS_OPERATION_FAILED");
	assert.equal(classifyGitFailure("could not find remote ref refs/heads/missing", false, "bundle"), "REF_NOT_FOUND");
});

console.log(JSON.stringify({ syntheticOnly: true, cloudflareOperations: 0, passed: true }));
