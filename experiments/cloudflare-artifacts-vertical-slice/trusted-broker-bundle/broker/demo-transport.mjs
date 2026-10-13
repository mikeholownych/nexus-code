import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync, constants } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeBoundExecutable, executeBoundExecutable, openTrustedExecutable } from "./linux-bound-exec.mjs";

export const DEMO_REPOSITORY = Object.freeze({
	namespace: "nexus-exp1-oct02",
	name: "external-git-proof",
	id: "4v94nnw1eqf0sanw",
	remote: "https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git",
	defaultBranch: "main",
	defaultSha: "ec3affd0e916b895e3528de6747b632f428359c0",
});

export const DEMO_WORKER_ENDPOINT = "https://nexus-agent-collab-exp1-20261002.holownych.workers.dev/work-state";
export const ARTIFACT_CREDENTIAL_PATH = "/etc/nexus-cloudflare-broker/artifacts-git.token";
export const WORKER_BEARER_PATH = "/etc/nexus-cloudflare-broker/worker.bearer";

const roles = new Set(["baseline", "candidate/producer", "candidate/consumer", "candidate/control", "work-state", "integration"]);
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const runPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumBundleBytes = 16 * 1024 * 1024;
const maximumRequestBytes = 24 * 1024 * 1024;
const maximumWorkerResponseBytes = 1024 * 1024;

export function createDemoTransport(options = {}) {
	const repository = options.repository ?? (process.env.NEXUS_CF_NAMESPACE && process.env.NEXUS_CF_REPOSITORY && process.env.NEXUS_CF_REPOSITORY_ID && process.env.NEXUS_CF_ARTIFACTS_REMOTE ? Object.freeze({
		namespace: process.env.NEXUS_CF_NAMESPACE,
		name: process.env.NEXUS_CF_REPOSITORY,
		id: process.env.NEXUS_CF_REPOSITORY_ID,
		remote: process.env.NEXUS_CF_ARTIFACTS_REMOTE,
		defaultBranch: "main",
		defaultSha: process.env.NEXUS_CF_DEFAULT_SHA || null,
	}) : DEMO_REPOSITORY);
	const config = {
		repository,
		remote: options.remote ?? repository.remote,
		workerEndpoint: options.workerEndpoint ?? process.env.NEXUS_CF_WORKER_ENDPOINT ?? DEMO_WORKER_ENDPOINT,
		artifactCredentialPath: options.artifactCredentialPath ?? process.env.NEXUS_CF_ARTIFACT_CREDENTIAL_PATH ?? ARTIFACT_CREDENTIAL_PATH,
		workerBearerPath: options.workerBearerPath ?? process.env.NEXUS_CF_WORKER_BEARER_PATH ?? WORKER_BEARER_PATH,
		expectedFileOwner: options.expectedFileOwner ?? 0,
		expectedFileGroup: options.expectedFileGroup ?? options.expectedFileOwner ?? 0,
		gitExecutable: options.gitExecutable ?? "/usr/bin/git",
		expectedGitOwner: options.expectedGitOwner ?? 0,
		workerFetch: options.workerFetch ?? globalThis.fetch,
		tempDirectory: options.tempDirectory ?? os.tmpdir(),
		allowLocalRemoteForTest: options.allowLocalRemoteForTest === true,
		onGitInvocation: options.onGitInvocation,
		onGitResult: options.onGitResult,
	};
	if ((config.remote !== repository.remote || repository !== DEMO_REPOSITORY) && !options.allowLocalRemoteForTest && !process.env.NEXUS_CF_NAMESPACE) throw new Error("custom Artifacts repository requires explicit contest configuration");
	if (config.workerEndpoint !== DEMO_WORKER_ENDPOINT && !options.allowWorkerEndpointForTest && !process.env.NEXUS_CF_WORKER_ENDPOINT) throw new Error("custom Worker endpoint requires explicit contest configuration");

	return Object.freeze({
		handle: async (request) => {
			validateRequest(request);
			switch (request.operation) {
				case "capability-status": return capabilityStatus(config);
				case "repo-default": return exportDefault(config);
				case "repo-ref": return exportRef(config, request.runId, request.role);
				case "publish-ref": return publishRef(config, request);
				case "worker-work-state": return readWorkerWorkState(config, request);
				default: throw failure("OPERATION_NOT_ADMITTED");
			}
		},
	});
}

export async function runBrokerRequest(request, options = {}) {
	try {
		return { ok: true, ...(await createDemoTransport(options).handle(request)) };
	} catch (error) {
		return { ok: false, error: safeErrorCode(error) };
	}
}

export function parseRequestBytes(bytes) {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumRequestBytes) throw failure("INVALID_REQUEST");
	let value;
	try { value = JSON.parse(bytes.toString("utf8")); } catch { throw failure("INVALID_REQUEST"); }
	validateRequest(value);
	return value;
}

export async function readStdinRequest(stream = process.stdin) {
	const chunks = [];
	let length = 0;
	for await (const chunk of stream) {
		length += chunk.length;
		if (length > maximumRequestBytes) throw failure("INVALID_REQUEST");
		chunks.push(chunk);
	}
	return parseRequestBytes(Buffer.concat(chunks, length));
}

function validateRequest(request) {
	if (!request || typeof request !== "object" || Array.isArray(request)) throw failure("INVALID_REQUEST");
	const fields = {
		"capability-status": ["operation"],
		"repo-default": ["operation"],
		"repo-ref": ["operation", "runId", "role"],
		"publish-ref": ["operation", "runId", "role", "expectedOldSha", "commitSha", "bundleBase64"],
		"worker-work-state": ["operation", "runId", "expectedCommitSha", "expectedContentDigest"],
	};
	const allowed = fields[request.operation];
	if (!allowed || Object.keys(request).some((key) => !allowed.includes(key))) throw failure("INVALID_REQUEST");
	for (const key of allowed) if (!(key in request)) throw failure("INVALID_REQUEST");
	if (request.operation === "repo-default" || request.operation === "capability-status") return;
	if (!validRunId(request.runId)) throw failure("OPERATION_NOT_ADMITTED");
	if (request.operation === "repo-ref" || request.operation === "publish-ref") {
		if (!roles.has(request.role)) throw failure("OPERATION_NOT_ADMITTED");
	}
	if (request.operation === "publish-ref") {
		if (request.expectedOldSha !== null && !shaPattern.test(request.expectedOldSha)) throw failure("INVALID_REQUEST");
		if (!shaPattern.test(request.commitSha)) throw failure("INVALID_REQUEST");
		if (typeof request.bundleBase64 !== "string" || request.bundleBase64.length > maximumBundleBytes * 4 / 3 + 8) throw failure("INVALID_REQUEST");
		const bundle = Buffer.from(request.bundleBase64, "base64");
		if (bundle.length === 0 || bundle.length > maximumBundleBytes || bundle.toString("base64") !== request.bundleBase64) throw failure("INVALID_REQUEST");
	}
	if (request.operation === "worker-work-state" && (!shaPattern.test(request.expectedCommitSha) || !digestPattern.test(request.expectedContentDigest))) throw failure("INVALID_REQUEST");
}

function capabilityState(filePath, expectedOwner, expectedGroup) {
	try {
		const directory = lstatSync(path.dirname(filePath));
		if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== expectedOwner || directory.gid !== expectedGroup || (directory.mode & 0o7777) !== 0o700) return "CUSTODY_INVALID";
		const info = lstatSync(filePath);
		if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedOwner || info.gid !== expectedGroup || (info.mode & 0o7777) !== 0o400 || info.nlink !== 1 || info.size < 16 || info.size > 4096) return "CUSTODY_INVALID";
		return "CUSTODY_VALID";
	} catch (error) {
		if (error?.code === "ENOENT") return "NOT_PROVISIONED";
		return "CUSTODY_INVALID";
	}
}

function capabilityStatus(config) {
	return {
		operation: "capability-status",
		artifactsGitCredential: capabilityState(config.artifactCredentialPath, config.expectedFileOwner, config.expectedFileGroup),
		workerBearer: capabilityState(config.workerBearerPath, config.expectedFileOwner, config.expectedFileGroup),
	};
}

function validRunId(value) { return typeof value === "string" && runPattern.test(value); }
function refFor(runId, role) { return `refs/heads/contest-demo/${runId}/${role}`; }
function failure(code) { const error = new Error(code); error.code = code; return error; }
function safeErrorCode(error) {
	const allowed = new Set([
		"INVALID_REQUEST", "OPERATION_NOT_ADMITTED", "CREDENTIAL_NOT_PROVISIONED", "CREDENTIAL_CUSTODY_INVALID",
		"ARTIFACTS_AUTHENTICATION_FAILED", "ARTIFACTS_OPERATION_FAILED", "ARTIFACTS_BASELINE_MISMATCH",
		"REF_NOT_FOUND", "REF_STATE_MISMATCH", "INVALID_GIT_BUNDLE", "COMMIT_POLICY_REJECTED",
		"CREDENTIAL_REFLECTION_BLOCKED",
		"WORKER_CAPABILITY_NOT_PROVISIONED", "WORKER_CAPABILITY_CUSTODY_INVALID", "WORKER_AUTHENTICATION_FAILED",
		"WORKER_RESPONSE_INVALID", "WORKER_STATE_MISMATCH", "WORKER_UNAVAILABLE", "WORK_STATE_NOT_FOUND", "CANDIDATE_MISMATCH",
	]);
	return allowed.has(error?.code) ? error.code : "PROTECTED_OPERATION_FAILED";
}

function readProtectedSecret(filePath, expectedOwner, kind) {
	let fd = -1;
	try {
		const before = lstatSync(filePath);
		if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedOwner || (before.mode & 0o7777) !== 0o400 || before.nlink !== 1) throw failure("CREDENTIAL_CUSTODY_INVALID");
		fd = openSync(filePath, constants.O_RDONLY | constants.O_CLOEXEC | constants.O_NOFOLLOW);
		const after = fstatSync(fd);
		if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.uid !== expectedOwner || (after.mode & 0o7777) !== 0o400 || after.nlink !== 1 || after.size < 16 || after.size > 4096) throw failure("CREDENTIAL_CUSTODY_INVALID");
		const value = readFileSync(fd);
		const text = value.toString("utf8");
		if (!/^[\x21-\x7e]{16,4096}$/.test(text)) {
			value.fill(0);
			throw failure(kind === "CREDENTIAL" ? "CREDENTIAL_CUSTODY_INVALID" : "WORKER_CAPABILITY_CUSTODY_INVALID");
		}
		return value;
	} catch (error) {
		if (error?.code === "ENOENT") throw failure(kind === "CREDENTIAL" ? "CREDENTIAL_NOT_PROVISIONED" : "WORKER_CAPABILITY_NOT_PROVISIONED");
		const custodyCode = kind === "CREDENTIAL" ? "CREDENTIAL_CUSTODY_INVALID" : "WORKER_CAPABILITY_CUSTODY_INVALID";
		if (error?.code === custodyCode) throw error;
		throw failure(custodyCode);
	} finally { if (fd >= 0) closeSync(fd); }
}

function withScratch(config, fn) {
	const directory = mkdtempSync(path.join(config.tempDirectory, "nexus-demo-transport-"));
	try { return fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function gitEnv(token = null, localBundle = false, localRemoteTest = false) {
	const env = {
		HOME: "/nonexistent", PATH: "/usr/bin:/bin:/usr/lib/git-core", LANG: "C.UTF-8", LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EXEC_PATH: "/usr/lib/git-core",
		GIT_ALLOW_PROTOCOL: localBundle || localRemoteTest ? "file" : "https",
	};
	const entries = [
		["core.hooksPath", "/dev/null"],
		["credential.helper", ""],
		["diff.external", ""],
		["http.followRedirects", "false"],
	];
	if (token) entries.unshift(["http.extraHeader", `Authorization: Bearer ${Buffer.isBuffer(token) ? token.toString("ascii") : token}`]);
	env.GIT_CONFIG_COUNT = String(entries.length);
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

function runGit(config, args, { token = null, localBundle = false, operation = "git" } = {}) {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw failure("OPERATION_NOT_ADMITTED");
	const bound = openTrustedExecutable(config.gitExecutable, { expectedUid: config.expectedGitOwner ?? 0 });
	let result;
	try {
		config.onGitInvocation?.({ args: [...args], env: gitEnv(token, localBundle, config.allowLocalRemoteForTest) });
		result = executeBoundExecutable(bound, args, {
			cwd: "/", env: gitEnv(token, localBundle, config.allowLocalRemoteForTest), encoding: null, timeout: 30000,
			maxBuffer: maximumBundleBytes + 1024 * 1024,
		});
	} finally { closeBoundExecutable(bound); }
	config.onGitResult?.({ args: [...args], status: result.status, error: result.error?.code ?? null, stdout: Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout ?? "", stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr ?? "" });
	if (result.error || result.status !== 0) {
		const detail = Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)]).toString("utf8");
		throw failure(classifyGitFailure(detail, Boolean(token), operation));
	}
	return result.stdout;
}

export function classifyGitFailure(detail, authenticated, operation) {
	if (!authenticated && /not a git repository|could not find remote ref|does not appear to be a git repository/i.test(detail)) return "REF_NOT_FOUND";
	if (/authentication failed|unauthorized|forbidden|returned error: 401\b|returned error: 403\b|HTTP 401\b|HTTP 403\b|could not read Username/i.test(detail)) return "ARTIFACTS_AUTHENTICATION_FAILED";
	return operation === "bundle" ? "INVALID_GIT_BUNDLE" : "ARTIFACTS_OPERATION_FAILED";
}

function remoteSha(config, ref, token) {
	const output = runGit(config, ["ls-remote", "--refs", config.remote, ref], { token, operation: "remote-read" }).toString("utf8").trim();
	if (!output) return null;
	const lines = output.split("\n");
	if (lines.length !== 1) throw failure("ARTIFACTS_OPERATION_FAILED");
	const match = /^([0-9a-f]{40})\t(.+)$/.exec(lines[0]);
	if (!match || match[2] !== ref) throw failure("ARTIFACTS_OPERATION_FAILED");
	return match[1];
}

function fetchToBare(config, bare, ref, token) {
	runGit(config, ["--git-dir", bare, "fetch", "--no-tags", "--no-recurse-submodules", config.remote, `${ref}:${ref}`], { token, operation: "remote-fetch" });
}

function createExportBundle(config, ref, token) {
	return withScratch(config, (directory) => {
		const bare = path.join(directory, "repo.git");
		const bundlePath = path.join(directory, "export.bundle");
		runGit(config, ["init", "--bare", "--quiet", bare]);
		fetchToBare(config, bare, ref, token);
		assertNoCredentialInGitState(config, bare, ref, token);
		const sha = runGit(config, ["--git-dir", bare, "rev-parse", "--verify", `${ref}^{commit}`]).toString("ascii").trim();
		const tree = runGit(config, ["--git-dir", bare, "rev-parse", "--verify", `${sha}^{tree}`]).toString("ascii").trim();
		runGit(config, ["--git-dir", bare, "bundle", "create", bundlePath, ref]);
		const bundle = readFileSync(bundlePath);
		if (bundle.length > maximumBundleBytes) throw failure("ARTIFACTS_OPERATION_FAILED");
		return { sha, tree, bundleBase64: bundle.toString("base64") };
	});
}

function exportDefault(config) {
	const token = readProtectedSecret(config.artifactCredentialPath, config.expectedFileOwner, "CREDENTIAL");
	try {
		const symref = runGit(config, ["ls-remote", "--symref", config.remote, "HEAD"], { token, operation: "remote-read" }).toString("utf8");
		if (!symref.includes(`ref: refs/heads/${config.repository.defaultBranch}\tHEAD`)) throw failure("ARTIFACTS_BASELINE_MISMATCH");
		const sha = remoteSha(config, "refs/heads/main", token);
		if (config.repository.defaultSha && sha !== config.repository.defaultSha) throw failure("ARTIFACTS_BASELINE_MISMATCH");
		return { operation: "repo-default", repository: repositoryIdentity(config.repository), ref: "refs/heads/main", sha, ...createExportBundle(config, "refs/heads/main", token) };
	} finally { token.fill(0); }
}

function exportRef(config, runId, role) {
	const token = readProtectedSecret(config.artifactCredentialPath, config.expectedFileOwner, "CREDENTIAL");
	const ref = refFor(runId, role);
	try {
		const sha = remoteSha(config, ref, token);
		if (!sha) throw failure("REF_NOT_FOUND");
		const exported = createExportBundle(config, ref, token);
		if (exported.sha !== sha) throw failure("REF_STATE_MISMATCH");
		return { operation: "repo-ref", repository: repositoryIdentity(config.repository), runId, role, ref, ...exported };
	} finally { token.fill(0); }
}

function repositoryIdentity(repository = DEMO_REPOSITORY) { return { namespace: repository.namespace, name: repository.name, id: repository.id }; }

function publishRef(config, request) {
	const token = readProtectedSecret(config.artifactCredentialPath, config.expectedFileOwner, "CREDENTIAL");
	const ref = refFor(request.runId, request.role);
	const started = performance.now();
	const bundle = Buffer.from(request.bundleBase64, "base64");
	try {
		if (bundle.includes(token)) throw failure("CREDENTIAL_REFLECTION_BLOCKED");
		return withScratch(config, (directory) => {
			const bare = path.join(directory, "repo.git");
			const bundlePath = path.join(directory, "candidate.bundle");
			runGit(config, ["init", "--bare", "--quiet", bare]);
			const oldSha = remoteSha(config, ref, token);
			if (oldSha !== request.expectedOldSha) throw failure("REF_STATE_MISMATCH");
			if (oldSha && ["baseline", "work-state"].includes(request.role)) throw failure("REF_STATE_MISMATCH");
			if (request.role === "baseline") {
				const mainSha = remoteSha(config, "refs/heads/main", token);
				if (config.repository.defaultSha && mainSha !== config.repository.defaultSha) throw failure("ARTIFACTS_BASELINE_MISMATCH");
				fetchToBare(config, bare, "refs/heads/main", token);
			} else {
				const baseline = refFor(request.runId, "baseline");
				const baselineSha = remoteSha(config, baseline, token);
				if (!baselineSha) throw failure("REF_NOT_FOUND");
				fetchToBare(config, bare, baseline, token);
				if (oldSha) fetchToBare(config, bare, ref, token);
				if (request.role === "work-state") fetchToBare(config, bare, refFor(request.runId, "candidate/producer"), token);
				if (request.role === "integration") {
					fetchToBare(config, bare, refFor(request.runId, "candidate/producer"), token);
					fetchToBare(config, bare, refFor(request.runId, "candidate/consumer"), token);
				}
			}
			writeFileSync(bundlePath, bundle, { mode: 0o600, flag: "wx" });
			const listed = runGit(config, ["bundle", "list-heads", bundlePath], { localBundle: true, operation: "bundle" }).toString("utf8").trim().split("\n");
			const [bundleSha, bundleRef, ...extraFields] = (listed[0] ?? "").split(/\s+/);
			if (listed.length !== 1 || !shaPattern.test(bundleSha ?? "") || bundleRef !== ref || extraFields.length !== 0) throw failure("INVALID_GIT_BUNDLE");
			runGit(config, ["--git-dir", bare, "bundle", "verify", bundlePath], { localBundle: true, operation: "bundle" });
			runGit(config, ["--git-dir", bare, "fetch", "--no-tags", "--no-recurse-submodules", bundlePath, `${ref}:${ref}`], { localBundle: true, operation: "bundle" });
			const commitSha = runGit(config, ["--git-dir", bare, "rev-parse", "--verify", `${ref}^{commit}`]).toString("ascii").trim();
			if (commitSha !== request.commitSha) throw failure("INVALID_GIT_BUNDLE");
			assertNoCredentialInGitState(config, bare, ref, token);
			validateCommitPolicy(config, bare, request, ref, commitSha, oldSha, token);
			const lease = `--force-with-lease=${ref}:${oldSha ?? ""}`;
			runGit(config, ["--git-dir", bare, "push", "--porcelain", "--no-verify", lease, config.remote, `${ref}:${ref}`], { token, operation: "remote-push" });
			const observedSha = remoteSha(config, ref, token);
			if (observedSha !== commitSha) throw failure("REF_STATE_MISMATCH");
			return { operation: "publish-ref", repository: repositoryIdentity(config.repository), runId: request.runId, role: request.role, ref, sha: observedSha, tree: runGit(config, ["--git-dir", bare, "rev-parse", "--verify", `${commitSha}^{tree}`]).toString("ascii").trim(), elapsedMs: Math.round(performance.now() - started) };
		});
	} finally { bundle.fill(0); token.fill(0); }
}

function validateCommitPolicy(config, bare, request, ref, commitSha, oldSha, token) {
	const parentText = runGit(config, ["--git-dir", bare, "show", "-s", "--format=%P", commitSha]).toString("ascii").trim();
	const parents = parentText ? parentText.split(/\s+/) : [];
	if (request.role === "baseline") {
		if (parents.length !== 1 || (config.repository.defaultSha && parents[0] !== config.repository.defaultSha)) throw failure("COMMIT_POLICY_REJECTED");
	} else if (request.role !== "work-state") {
		const baseline = refFor(request.runId, "baseline");
		const baselineSha = runGit(config, ["--git-dir", bare, "rev-parse", "--verify", `${baseline}^{commit}`]).toString("ascii").trim();
		const ancestry = spawnGitStatus(config, ["--git-dir", bare, "merge-base", "--is-ancestor", baselineSha, commitSha]);
		if (ancestry !== 0) throw failure("COMMIT_POLICY_REJECTED");
		if (oldSha && spawnGitStatus(config, ["--git-dir", bare, "merge-base", "--is-ancestor", oldSha, commitSha]) !== 0) throw failure("COMMIT_POLICY_REJECTED");
	}
	if (request.role === "work-state") {
		if (parents.length !== 0) throw failure("COMMIT_POLICY_REJECTED");
		const paths = runGit(config, ["--git-dir", bare, "ls-tree", "-r", "--name-only", commitSha]).toString("utf8").trim().split("\n");
		if (paths.length !== 1 || paths[0] !== ".agent/work-state.json") throw failure("COMMIT_POLICY_REJECTED");
		const content = runGit(config, ["--git-dir", bare, "show", `${commitSha}:.agent/work-state.json`]).toString("utf8");
		let state;
		try { state = JSON.parse(content); } catch { throw failure("COMMIT_POLICY_REJECTED"); }
		const producerRef = refFor(request.runId, "candidate/producer");
		const producerSha = remoteSha(config, producerRef, token);
		if (!producerSha || state?.schema !== "nexus.agent-work-state.v1" || state?.producer?.candidateRef !== producerRef || state?.producer?.candidateCommit !== producerSha) throw failure("COMMIT_POLICY_REJECTED");
	}
	if (request.role === "integration") {
		for (const candidateRole of ["candidate/producer", "candidate/consumer"]) {
			const candidateRef = refFor(request.runId, candidateRole);
			const candidateSha = remoteSha(config, candidateRef, token);
			if (!candidateSha || spawnGitStatus(config, ["--git-dir", bare, "merge-base", "--is-ancestor", candidateSha, commitSha]) !== 0) throw failure("COMMIT_POLICY_REJECTED");
		}
	}
}

function assertNoCredentialInGitState(config, bare, ref, token) {
	const objects = runGit(config, ["--git-dir", bare, "rev-list", "--objects", ref]).toString("utf8");
	const objectIds = new Set();
	for (const line of objects.split("\n")) {
		if (!line) continue;
		if (Buffer.from(line).includes(token)) throw failure("CREDENTIAL_REFLECTION_BLOCKED");
		const objectId = line.split(" ", 1)[0];
		if (shaPattern.test(objectId)) objectIds.add(objectId);
		if (objectIds.size > 10000) throw failure("ARTIFACTS_OPERATION_FAILED");
	}
	for (const objectId of objectIds) {
		const type = runGit(config, ["--git-dir", bare, "cat-file", "-t", objectId]).toString("ascii").trim();
		if (!new Set(["commit", "tag", "blob"]).has(type)) continue;
		const content = runGit(config, ["--git-dir", bare, "cat-file", type, objectId]);
		if (content.includes(token)) throw failure("CREDENTIAL_REFLECTION_BLOCKED");
	}
}

function spawnGitStatus(config, args) {
	const bound = openTrustedExecutable(config.gitExecutable, { expectedUid: config.expectedGitOwner ?? 0 });
	let result;
	try { result = executeBoundExecutable(bound, args, { cwd: "/", env: gitEnv(null, true, config.allowLocalRemoteForTest), encoding: "utf8", timeout: 15000, maxBuffer: 128 * 1024 }); }
	finally { closeBoundExecutable(bound); }
	if (result.error) throw failure("ARTIFACTS_OPERATION_FAILED");
	return result.status ?? 126;
}

async function readWorkerWorkState(config, request) {
	const bearer = readProtectedSecret(config.workerBearerPath, config.expectedFileOwner, "WORKER");
	const ref = refFor(request.runId, "work-state");
		const url = new URL(config.workerEndpoint);
	url.searchParams.set("run", request.runId);
	try {
		let response;
		try {
		response = await config.workerFetch(url, { method: "GET", headers: { authorization: `Bearer ${bearer.toString("ascii")}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
		} catch { throw failure("WORKER_UNAVAILABLE"); }
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) throw failure("WORKER_AUTHENTICATION_FAILED");
			const errorBytes = await readWorkerBody(response, 4096);
			if (errorBytes.includes(bearer)) throw failure("WORKER_RESPONSE_INVALID");
			let errorBody;
			try { errorBody = JSON.parse(errorBytes.toString("utf8")); } catch { throw failure("WORKER_UNAVAILABLE"); }
			const message = errorBody && typeof errorBody === "object" && !Array.isArray(errorBody) && typeof errorBody.error === "string" ? errorBody.error : "";
			if (response.status === 404 && message === "Work state not found") throw failure("WORK_STATE_NOT_FOUND");
			if ((response.status === 409 && message === "Candidate reference changed") || (response.status === 502 && message === "Invalid candidate reference")) throw failure("CANDIDATE_MISMATCH");
			if ((response.status === 400 && message === "Invalid run identity") || (response.status === 413 && message === "Work state too large") || (response.status === 502 && ["Invalid work state", "Invalid producer state"].includes(message))) throw failure("WORKER_RESPONSE_INVALID");
			throw failure("WORKER_UNAVAILABLE");
		}
		const bytes = await readWorkerBody(response, maximumWorkerResponseBytes);
		if (bytes.includes(bearer)) throw failure("WORKER_RESPONSE_INVALID");
		let result;
		try { result = JSON.parse(bytes.toString("utf8")); } catch { throw failure("WORKER_RESPONSE_INVALID"); }
		const expected = {
			repository: repositoryIdentity(config.repository), ref, stateCommit: request.expectedCommitSha,
			stateContentSha256: request.expectedContentDigest,
		};
		if (result?.repository?.namespace !== expected.repository.namespace || result?.repository?.name !== expected.repository.name || result?.repository?.id !== expected.repository.id || result?.ref !== expected.ref || result?.stateCommit !== expected.stateCommit || !shaPattern.test(result?.stateTree ?? "") || result?.stateContentSha256 !== expected.stateContentSha256 || result?.state?.schema !== "nexus.agent-work-state.v1") throw failure("WORKER_STATE_MISMATCH");
		const actualDigest = createHash("sha256").update(JSON.stringify(result.state, null, 2)).digest("hex");
		if (actualDigest !== expected.stateContentSha256) throw failure("WORKER_STATE_MISMATCH");
		return { operation: "worker-work-state", repository: expected.repository, runId: request.runId, ref, stateCommit: result.stateCommit, stateTree: result.stateTree, stateContentSha256: result.stateContentSha256, responseStatus: response.status, state: result.state };
	} finally { bearer.fill(0); }
}

async function readLimitedBody(response, maximumBytes) {
	if (!response.body?.getReader) throw failure("WORKER_RESPONSE_INVALID");
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximumBytes) {
				await reader.cancel();
				throw failure("WORKER_RESPONSE_INVALID");
			}
			chunks.push(Buffer.from(value));
		}
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks, length);
}

async function readWorkerBody(response, maximumBytes) {
	try { return await readLimitedBody(response, maximumBytes); }
	catch (error) {
		if (error?.code === "WORKER_RESPONSE_INVALID") throw error;
		throw failure("WORKER_UNAVAILABLE");
	}
}

export async function main() {
	let result;
	try {
		const request = await readStdinRequest();
		result = await runBrokerRequest(request);
	} catch (error) { result = { ok: false, error: safeErrorCode(error) }; }
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
