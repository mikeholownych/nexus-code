// Substrate Adapter Boundary for Nexus Contest Demo
// Supports both Local Fixture Mode (offline testing) and Real Cloudflare Mode (Artifacts + Workers)

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const candidateRoles = new Set(["baseline", "candidate/producer", "candidate/consumer", "candidate/control", "work-state", "integration"]);
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roleAllowedForRead = (role) => candidateRoles.has(role);

export class SubstrateAdapterBase {
	constructor(options = {}) {
		this.options = options;
		this.mode = options.mode || "local";
		this.isRealCloudflare = false;
		this.runId = options.runId || randomUUID();
	}

	async initialize() {
		throw new Error("initialize() must be implemented");
	}

	getRemoteUrl() {
		throw new Error("getRemoteUrl() must be implemented");
	}

	runGit(dir, args, extraEnv = {}) {
		throw new Error("runGit() must be implemented");
	}

	async publishWorkState(workStateObj) {
		throw new Error("publishWorkState() must be implemented");
	}

	async fetchWorkState(consumerDir) {
		throw new Error("fetchWorkState() must be implemented");
	}

	async teardown() {
		throw new Error("teardown() must be implemented");
	}

	refFor(name) {
		return `contest-demo/${this.runId}/${name}`;
	}

	async publishCandidate(dir, role) {
		if (!roleAllowedForRead(role)) throw new Error("CANDIDATE_ROLE_NOT_ADMITTED");
		const ref = `refs/heads/${this.refFor(role)}`;
		this.runGit(dir, ["push", "-u", "origin", `${ref}:${ref}`]);
		return { ref, sha: this.runGit(dir, ["rev-parse", "--verify", `${ref}^{commit}`]) };
	}

	async observeRef(role) {
		const ref = `refs/heads/${this.refFor(role)}`;
		const output = this.runGit(this.originDir, ["ls-remote", "--refs", this.originDir, ref]);
		const [sha] = output.split(/\s+/);
		if (!/^[0-9a-f]{40}$/.test(sha || "")) throw new Error("CANDIDATE_REF_NOT_FOUND");
		return { ref, sha };
	}

	checkoutBaseline(dir, localBranch) {
		const baselineRef = this.refFor("baseline");
		this.runGit(dir, ["fetch", "origin", `refs/heads/${baselineRef}`]);
		this.runGit(dir, ["checkout", "-b", localBranch, "FETCH_HEAD"]);
	}
}

// -----------------------------------------------------------------------------
// LOCAL FIXTURE SUBSTRATE ADAPTER
// Offline, fast, fully reproducible without Cloudflare token mutations
// -----------------------------------------------------------------------------
export class LocalSubstrateAdapter extends SubstrateAdapterBase {
	constructor(options = {}) {
		super({ ...options, mode: "local" });
		this.isRealCloudflare = false;
		this.rootDir = null;
		this.originDir = null;
		this.latestWorkState = null;
		this.latestWorkStateDigest = null;
	}

	async initialize() {
		this.rootDir = await mkdtemp(path.join(os.tmpdir(), "nexus-demo-local-"));
		this.originDir = path.join(this.rootDir, "origin.git");

		// Initialize bare origin repository
		const initRes = spawnSync("git", ["init", "--bare", "--quiet", this.originDir], {
			encoding: "utf8",
			timeout: 10000,
		});
		if (initRes.status !== 0) {
			throw new Error(`Failed to initialize local bare git repo: ${initRes.stderr}`);
		}

		return {
			rootDir: this.rootDir,
			remoteUrl: this.originDir,
			mode: "local",
			isRealCloudflare: false,
		};
	}

	getRemoteUrl() {
		return this.originDir;
	}

	runGit(dir, args, extraEnv = {}) {
		const res = spawnSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			timeout: 15000,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Nexus Local Agent",
				GIT_AUTHOR_EMAIL: "local-agent@nexus.demo",
				GIT_COMMITTER_NAME: "Nexus Local Agent",
				GIT_COMMITTER_EMAIL: "local-agent@nexus.demo",
				...extraEnv,
			},
		});

		if (res.status !== 0) {
			const err = res.stderr || res.stdout;
			throw new Error(`Git error in ${dir} (git ${args.join(" ")}): ${err.trim()}`);
		}
		return res.stdout.trim();
	}

	async publishWorkState(workStateObj, producerDir) {
		this.latestWorkState = workStateObj;
		const jsonBuffer = Buffer.from(JSON.stringify(workStateObj, null, 2));
		this.latestWorkStateDigest = createHash("sha256").update(jsonBuffer).digest("hex");

		// Publish to a per-run work-state ref without rewriting main.
		const stateWorktree = path.join(this.rootDir, "publisher-work-state");
		if (existsSync(stateWorktree)) {
			await rm(stateWorktree, { recursive: true, force: true });
		}

		this.runGit(this.rootDir, ["clone", "--quiet", this.originDir, stateWorktree]);

		const stateBranch = this.refFor("work-state");
		this.runGit(stateWorktree, ["checkout", "--orphan", stateBranch]);
		this.runGit(stateWorktree, ["reset", "--hard"]);

		await mkdir(path.join(stateWorktree, ".agent"), { recursive: true });
		await writeFile(path.join(stateWorktree, ".agent", "work-state.json"), jsonBuffer);

		this.runGit(stateWorktree, ["add", ".agent/work-state.json"]);
		this.runGit(stateWorktree, ["commit", "-m", "chore(state): publish machine-readable work-state v1"]);
		const stateCommitSha = this.runGit(stateWorktree, ["rev-parse", "HEAD"]);
		// This per-run work-state ref is intentionally rewritten when deterministic
		// mode republishes its identical role state during the staged walkthrough.
		this.runGit(stateWorktree, ["push", "-u", "origin", "--force", `HEAD:refs/heads/${stateBranch}`]);

		return {
			stateCommitSha,
			stateDigest: this.latestWorkStateDigest,
			ref: `refs/heads/${stateBranch}`,
			payload: workStateObj,
		};
	}

	async fetchWorkState(consumerDir) {
		// Fetch work-state branch from local origin
		const stateBranch = this.refFor("work-state");
		this.runGit(consumerDir, ["fetch", "origin", `refs/heads/${stateBranch}:refs/remotes/origin/${stateBranch}`]);
		const content = this.runGit(consumerDir, ["show", `refs/remotes/origin/${stateBranch}:.agent/work-state.json`]);
		const parsed = JSON.parse(content);
		return {
			state: parsed,
			repository: { name: "local-fixture" },
			ref: `refs/heads/${stateBranch}`,
			stateCommit: this.runGit(consumerDir, ["rev-parse", `refs/remotes/origin/${stateBranch}`]),
			stateTree: this.runGit(consumerDir, ["rev-parse", `refs/remotes/origin/${stateBranch}^{tree}`]),
			stateContentSha256: createHash("sha256").update(Buffer.from(content)).digest("hex"),
			transport: "local-git",
		};
	}

	async teardown() {
		if (this.rootDir && !this.options.retainWorkspace) {
			try {
				await rm(this.rootDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup error
			}
		}
	}
}

// -----------------------------------------------------------------------------
// REAL CLOUDFLARE SUBSTRATE ADAPTER
// Connects to Cloudflare Artifacts Git & Workers via ephemeral credential broker
// -----------------------------------------------------------------------------
export class CloudflareSubstrateAdapter extends SubstrateAdapterBase {
	constructor(options = {}) {
		super({ ...options, mode: "cloudflare" });
		this.isRealCloudflare = true;
		if ((options.namespace && options.namespace !== "nexus-exp1-oct02") || (options.repo && options.repo !== "external-git-proof")) throw new Error("CLOUDFLARE_REPOSITORY_OVERRIDE_REJECTED");
		this.namespace = "nexus-exp1-oct02";
		this.repo = "external-git-proof";
		this.repositoryId = "4v94nnw1eqf0sanw";
		if (!runIdPattern.test(this.runId)) throw new Error("DEMO_RUN_ID_NOT_ADMITTED");
		this.expectedDefaultSha = options.testOnlyExpectedDefaultSha || "ec3affd0e916b895e3528de6747b632f428359c0";
		this.remoteUrl = `https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/${this.namespace}/${this.repo}.git`;
		this.rootDir = null;
		this.originDir = null;
		this.latestWorkStateDigest = null;
		this.latestWorkStateCommit = null;
		this.publishedShas = new Map();
		this.protectedRequest = options.protectedRequest || invokeProtectedTransport;
	}

	async initialize() {
		this.rootDir = await mkdtemp(path.join(os.tmpdir(), "nexus-demo-cf-"));
		this.originDir = path.join(this.rootDir, "local-origin.git");
		const initial = await this.requestProtected({ operation: "repo-default" });
		if (initial.repository?.namespace !== this.namespace || initial.repository?.name !== this.repo || initial.repository?.id !== this.repositoryId || initial.ref !== "refs/heads/main" || initial.sha !== this.expectedDefaultSha) throw new Error("PROTECTED_REPOSITORY_IDENTITY_MISMATCH");
		const bundlePath = path.join(this.rootDir, "default.bundle");
		writeFileSync(bundlePath, decodeBundle(initial.bundleBase64), { mode: 0o600, flag: "wx" });
		this.runGit(this.rootDir, ["init", "--bare", "--quiet", this.originDir]);
		this.runGit(this.rootDir, ["--git-dir", this.originDir, "fetch", "--no-tags", bundlePath, "refs/heads/main:refs/heads/main"]);
		this.runGit(this.rootDir, ["--git-dir", this.originDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
		if (this.runGit(this.rootDir, ["--git-dir", this.originDir, "rev-parse", "--verify", "refs/heads/main^{commit}"]) !== initial.sha) throw new Error("PROTECTED_REPOSITORY_BUNDLE_SHA_MISMATCH");
		await rm(bundlePath, { force: true });
		return { rootDir: this.rootDir, remoteUrl: this.remoteUrl, mode: "cloudflare", isRealCloudflare: true, namespace: this.namespace, repo: this.repo };
	}

	getRemoteUrl() {
		if (!this.originDir) throw new Error("CLOUDFLARE_ADAPTER_NOT_INITIALIZED");
		return this.originDir;
	}

	runGit(dir, args, extraEnv = {}) {
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("LOCAL_GIT_REQUEST_INVALID");
		const res = spawnSync("git", ["-C", dir, ...args], {
			encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
			env: {
				PATH: "/usr/bin:/bin", HOME: this.rootDir || "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C",
				GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
				GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
				GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "",
				GIT_CONFIG_KEY_2: "diff.external", GIT_CONFIG_VALUE_2: "",
				GIT_AUTHOR_NAME: "Nexus Cloudflare Agent", GIT_AUTHOR_EMAIL: "contest-agent@nexus.cloud",
				GIT_COMMITTER_NAME: "Nexus Cloudflare Agent", GIT_COMMITTER_EMAIL: "contest-agent@nexus.cloud",
				...(extraEnv?.GIT_AUTHOR_NAME ? { GIT_AUTHOR_NAME: extraEnv.GIT_AUTHOR_NAME } : {}),
				...(extraEnv?.GIT_AUTHOR_EMAIL ? { GIT_AUTHOR_EMAIL: extraEnv.GIT_AUTHOR_EMAIL } : {}),
				...(extraEnv?.GIT_COMMITTER_NAME ? { GIT_COMMITTER_NAME: extraEnv.GIT_COMMITTER_NAME } : {}),
				...(extraEnv?.GIT_COMMITTER_EMAIL ? { GIT_COMMITTER_EMAIL: extraEnv.GIT_COMMITTER_EMAIL } : {}),
			},
		});
		if (res.error || res.status !== 0) throw new Error("CLOUDFLARE_LOCAL_GIT_OPERATION_FAILED");
		return res.stdout.trim();
	}

	async requestProtected(request) {
		const result = await this.protectedRequest(request);
		if (!result || typeof result !== "object") throw new Error("PROTECTED_TRANSPORT_RESPONSE_INVALID");
		if (result.ok === false) throw new Error(typeof result.error === "string" && /^[A-Z0-9_]+$/.test(result.error) ? result.error : "PROTECTED_OPERATION_FAILED");
		return result.ok === true ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok")) : result;
	}

	async publishCandidate(dir, role) {
		if (!roleAllowedForRead(role)) throw new Error("CANDIDATE_ROLE_NOT_ADMITTED");
		const ref = `refs/heads/${this.refFor(role)}`;
		const localSha = this.runGit(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
		const expectedOldSha = this.publishedShas.get(role) ?? null;
		this.runGit(dir, ["push", "-u", "origin", `${ref}:${ref}`]);
		const bundlePath = path.join(this.rootDir, `publish-${randomUUID()}.bundle`);
		try {
			this.runGit(dir, ["bundle", "create", bundlePath, ref]);
			const bundle = readFileSync(bundlePath);
			if (bundle.length > 16 * 1024 * 1024) throw new Error("CANDIDATE_BUNDLE_TOO_LARGE");
			const result = await this.requestProtected({ operation: "publish-ref", runId: this.runId, role, expectedOldSha, commitSha: localSha, bundleBase64: bundle.toString("base64") });
			if (result.repository?.namespace !== this.namespace || result.repository?.name !== this.repo || result.repository?.id !== this.repositoryId || result.ref !== ref || result.sha !== localSha) throw new Error("PROTECTED_PUBLISH_RESULT_MISMATCH");
			this.publishedShas.set(role, localSha);
			return result;
		} finally { await rm(bundlePath, { force: true }); }
	}

	async observeRef(role) {
		if (!roleAllowedForRead(role)) throw new Error("CANDIDATE_ROLE_NOT_ADMITTED");
		const ref = `refs/heads/${this.refFor(role)}`;
		const result = await this.requestProtected({ operation: "repo-ref", runId: this.runId, role });
		if (result.repository?.namespace !== this.namespace || result.repository?.name !== this.repo || result.repository?.id !== this.repositoryId || result.ref !== ref || !/^[0-9a-f]{40}$/.test(result.sha || "")) throw new Error("PROTECTED_REF_RESULT_MISMATCH");
		return { ...result, ref, sha: result.sha };
	}

	async publishWorkState(workStateObj) {
		const jsonBuffer = Buffer.from(JSON.stringify(workStateObj, null, 2));
		this.latestWorkStateDigest = createHash("sha256").update(jsonBuffer).digest("hex");
		const stateDir = path.join(this.rootDir, "work-state-publisher");
		await rm(stateDir, { recursive: true, force: true });
		this.runGit(this.rootDir, ["clone", "--quiet", this.originDir, stateDir]);
		const stateBranch = this.refFor("work-state");
		this.runGit(stateDir, ["checkout", "--orphan", stateBranch]);
		this.runGit(stateDir, ["reset", "--hard"]);
		await mkdir(path.join(stateDir, ".agent"), { recursive: true });
		await writeFile(path.join(stateDir, ".agent", "work-state.json"), jsonBuffer);
		this.runGit(stateDir, ["add", ".agent/work-state.json"]);
		this.runGit(stateDir, ["commit", "-m", "chore(state): publish machine-readable work-state v1"]);
		this.latestWorkStateCommit = this.runGit(stateDir, ["rev-parse", "HEAD"]);
		const published = await this.publishCandidate(stateDir, "work-state");
		return { stateCommitSha: published.sha, stateDigest: this.latestWorkStateDigest, ref: `refs/heads/${stateBranch}`, payload: workStateObj };
	}

	async fetchWorkState() {
		const result = await this.requestProtected({ operation: "worker-work-state", runId: this.runId, expectedCommitSha: this.latestWorkStateCommit, expectedContentDigest: this.latestWorkStateDigest });
		if (result.responseStatus !== 200) throw new Error("WORKER_RESPONSE_STATUS_INVALID");
		const validated = validateWorkerWorkState({
			repository: result.repository, ref: result.ref, stateCommit: result.stateCommit,
			stateTree: result.stateTree, stateContentSha256: result.stateContentSha256, state: result.state,
		}, {
			namespace: this.namespace, repository: this.repo, repositoryId: this.repositoryId,
			ref: `refs/heads/${this.refFor("work-state")}`,
			expectedContentDigest: this.latestWorkStateDigest, expectedCommitSha: this.latestWorkStateCommit,
		});
		return { ...validated, transport: "cloudflare-worker", responseStatus: result.responseStatus };
	}

	async teardown() {
		if (this.rootDir && !this.options.retainWorkspace) {
			try { await rm(this.rootDir, { recursive: true, force: true }); } catch { /* bounded temporary cleanup */ }
		}
	}
}

function decodeBundle(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 24 * 1024 * 1024) throw new Error("PROTECTED_REPOSITORY_BUNDLE_INVALID");
	const bytes = Buffer.from(value, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== value) throw new Error("PROTECTED_REPOSITORY_BUNDLE_INVALID");
	return bytes;
}

function invokeProtectedTransport(request) {
	const executable = process.env.NEXUS_PROTECTED_TRANSPORT;
	if (!executable || !path.isAbsolute(executable)) throw new Error("PROTECTED_TRANSPORT_NOT_CONFIGURED");
	const result = spawnSync(executable, ["demo-transport"], {
		input: `${JSON.stringify(request)}\n`, encoding: "utf8", timeout: 45000, maxBuffer: 32 * 1024 * 1024,
		env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" },
	});
	let response;
	try { response = JSON.parse(result.stdout || ""); } catch { throw new Error("PROTECTED_TRANSPORT_RESPONSE_INVALID"); }
	if (result.error || result.status !== 0) {
		const code = response?.error;
		throw new Error(typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "PROTECTED_OPERATION_FAILED");
	}
	return response;
}

export async function fetchVerifiedWorkState(substrate, consumerDir, published) {
	const retrieved = await substrate.fetchWorkState(consumerDir);
	if (!retrieved || !retrieved.state || retrieved.state.schema !== "nexus.agent-work-state.v1") {
		throw new Error("No valid work-state was retrieved from the configured substrate");
	}
	if (retrieved.stateCommit !== published.stateCommitSha || retrieved.stateContentSha256 !== published.stateDigest || retrieved.ref !== published.ref) {
		throw new Error("Retrieved work-state does not match the published Git state");
	}
	const expectedTransport = substrate.isRealCloudflare ? "cloudflare-worker" : "local-git";
	if (retrieved.transport !== expectedTransport) throw new Error("Work-state retrieval transport did not match the selected mode");
	return retrieved;
}

export function validateWorkerWorkState(result, expected) {
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Worker returned an invalid work-state response");
	if (result.repository?.namespace !== expected.namespace || result.repository?.name !== expected.repository || result.repository?.id !== expected.repositoryId) {
		throw new Error("Worker repository identity mismatch");
	}
	if (result.ref !== expected.ref) throw new Error("Worker work-state ref mismatch");
	if (!/^[0-9a-f]{40}$/.test(result.stateCommit || "") || !/^[0-9a-f]{40}$/.test(result.stateTree || "")) {
		throw new Error("Worker returned invalid Git identity");
	}
	if (expected.expectedCommitSha && result.stateCommit !== expected.expectedCommitSha) throw new Error("Worker work-state commit mismatch");
	if (!/^[0-9a-f]{64}$/.test(result.stateContentSha256 || "") || result.stateContentSha256 !== expected.expectedContentDigest) {
		throw new Error("Worker work-state content digest mismatch");
	}
	if (result.state?.schema !== "nexus.agent-work-state.v1") throw new Error("Worker returned an unsupported work-state schema");
	const responseStateDigest = createHash("sha256").update(JSON.stringify(result.state, null, 2)).digest("hex");
	if (responseStateDigest !== result.stateContentSha256) throw new Error("Worker state body does not match its content digest");
	return result;
}

export function createSubstrateAdapter(options = {}) {
	if (options.mode === "cloudflare") {
		return new CloudflareSubstrateAdapter(options);
	}
	return new LocalSubstrateAdapter(options);
}
