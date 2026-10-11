import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeBoundExecutable, executeBoundExecutable, openTrustedExecutable } from "./linux-bound-exec.mjs";
import { CredentialState, initialCredentialLifecycle, transitionCredentialLifecycle } from "./credential-lifecycle.mjs";

const namespace = "nexus-exp1-oct02";
const repository = "external-git-proof";
const remote = "https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git";
const expectedHead = "ec3affd0e916b895e3528de6747b632f428359c0";
const syntheticMode = process.argv.includes("--synthetic-test");
const realMode = process.argv.includes("--real-probe");
if (syntheticMode === realMode) {
	process.stdout.write(JSON.stringify({ syntheticOnly: syntheticMode, passed: false, explicitModeRequired: true }) + "\n");
	process.exit(1);
}
const syntheticRoot = syntheticMode && process.env.CF_BROKER_TEST_SCRATCH_ROOT ? path.resolve(process.env.CF_BROKER_TEST_SCRATCH_ROOT) : "";
const syntheticCfPath = syntheticMode && process.env.CF_CLI_PATH ? path.resolve(process.env.CF_CLI_PATH) : "";
const syntheticGitPath = syntheticMode && process.env.GIT_CLI_PATH ? path.resolve(process.env.GIT_CLI_PATH) : "";
const syntheticProgramHashes = { cli: "cf510f92654ee675d3712d07ded4541dc4deb8a88aa8f3b77c7f90b7830ded13", git: "4b29d8e2e7336cf95110ab9e681dc9ea5452ad892bd4fa6309f20c09f346c6b7" };
function isPinnedRegularFile(file, expectedHash) {
	try {
		const stat = lstatSync(file);
		const canonical = realpathSync(file);
		return stat.isFile() && !stat.isSymbolicLink() && canonical === file && createHash("sha256").update(readFileSync(file)).digest("hex") === expectedHash;
	} catch {
		return false;
	}
}
const syntheticPathsValid = syntheticRoot && syntheticCfPath.startsWith(`${syntheticRoot}${path.sep}`) && path.basename(syntheticCfPath) === "fake-cf.mjs" && syntheticGitPath.startsWith(`${syntheticRoot}${path.sep}`) && path.basename(syntheticGitPath).startsWith("fake-git-") && process.env.CF_TEST_CANARY && isPinnedRegularFile(syntheticCfPath, syntheticProgramHashes.cli) && isPinnedRegularFile(syntheticGitPath, syntheticProgramHashes.git);
if (syntheticMode && !syntheticPathsValid) {
	process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: false, isolatedFakeCommandsRequired: true }) + "\n");
	process.exit(1);
}
const cf = syntheticMode ? syntheticCfPath : "/home/mike/.local/node-v24.11.1-linux-x64/bin/cf";
const gitExecutable = syntheticMode ? syntheticGitPath : "/usr/bin/git";
const cfProductionTarget = "/home/mike/.local/node-v24.11.1-linux-x64/lib/node_modules/cf/bin/cf";
const PATH_VALUE = "/usr/bin:/bin";
const productionCfEnv = Object.freeze({
	PATH: PATH_VALUE,
	HOME: "/home/mike",
	XDG_CONFIG_HOME: "/home/mike/.config",
	LANG: "C.UTF-8",
});
let signalReceived = false;
process.on("SIGINT", () => { signalReceived = true; });
process.on("SIGTERM", () => { signalReceived = true; });

function invoke(command, args, options = {}) {
	let executablePath;
	let policy;
	if (command === cf) {
		executablePath = syntheticMode ? syntheticCfPath : cfProductionTarget;
		policy = syntheticMode
			? { expectedUid: process.getuid(), expectedSha256: syntheticProgramHashes.cli }
			: { expectedUid: process.getuid() };
	} else if (command === gitExecutable) {
		executablePath = gitExecutable;
		policy = syntheticMode
			? { expectedUid: process.getuid(), expectedSha256: syntheticProgramHashes.git }
			: { expectedUid: 0 };
	} else {
		throw new Error("executable is not in the fixed allowlist");
	}
	const bound = openTrustedExecutable(executablePath, policy);
	try {
		return executeBoundExecutable(bound, args, {
			cwd: options.cwd ?? (command === cf ? "/" : undefined),
			env: options.env || (syntheticMode
				? { ...productionCfEnv, CF_FAKE_STATE: process.env.CF_FAKE_STATE, CF_FAKE_MODE: process.env.CF_FAKE_MODE, CF_FAKE_GIT_MODE: process.env.CF_FAKE_GIT_MODE, CF_TEST_CANARY: process.env.CF_TEST_CANARY }
				: (command === cf ? productionCfEnv : { PATH: PATH_VALUE, HOME: "/nonexistent", LANG: "C.UTF-8" })),
			timeout: options.timeout || 15000,
			maxBuffer: 256 * 1024,
		});
	} finally {
		closeBoundExecutable(bound);
	}
}

function recordsFrom(jsonText) {
	const value = JSON.parse(jsonText);
	if (Array.isArray(value)) return value;
	for (const key of ["tokens", "data", "items", "results"]) {
		if (Array.isArray(value?.[key])) return value[key];
	}
	throw new Error("unrecognized token inventory response");
}

function tokenFields(jsonText) {
	const value = JSON.parse(jsonText);
	const token = value?.token && typeof value.token === "object" ? value.token : value;
	const plaintext = token?.plaintext ?? token?.token;
	const id = token?.id;
	const scope = token?.scope;
	const expiresAt = token?.expires_at;
	return { plaintext, id, scope, expiresAt };
}

function listActive() {
	const all = [];
	for (let page = 1; page <= 20; page += 1) {
		const result = invoke(cf, ["artifacts", "namespaces", "repos", "tokens", "list", "--namespace", namespace, "--name", repository, "--state", "active", "--page", String(page), "--per-page", "100"]);
		if (result.status !== 0 || result.error) throw new Error("active-token inventory failed");
		const items = recordsFrom(result.stdout);
		if (items.some((item) => typeof item?.id !== "string" || !item.id)) throw new Error("active-token inventory item lacks an ID");
		all.push(...items.map((item) => item.id));
		if (items.length < 100) return [...new Set(all)];
	}
	throw new Error("active-token inventory pagination limit reached");
}

function safeTokenId(id, secret = "") {
	return typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id) && (!secret || (!id.includes(secret) && !secret.includes(id)));
}

function revoke(id, secret = "") {
	if (!safeTokenId(id, secret)) return false;
	const result = invoke(cf, ["artifacts", "namespaces", "tokens", "revoke", id, "--namespace", namespace, "-f"]);
	return result.status === 0 && !result.error;
}

async function scanFor(root, secret) {
	async function visit(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const target = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (await visit(target)) return true;
			} else if (entry.isFile()) {
				const data = await readFile(target);
				if (data.includes(Buffer.from(secret))) return true;
			}
		}
		return false;
	}
	return visit(root);
}

async function main() {
	let token = null;
	let tokenId = null;
	let issued = null;
	let issueResult = null;
	let gitEnv = null;
	let header = null;
	let revoked = false;
	let tokenAbsentAfter = false;
	let tokenInventoryState = "unknown";
	let gitSucceeded = false;
	let headMatches = false;
	let persistentFilesClean = false;
	let scanErrorObserved = false;
	let scopeVerified = false;
	let issuanceCleanupAmbiguous = false;
	let tokenIdCredentialDisjoint = false;
	let argvGuardRejected = false;
	let issueStatus = "not-started";
	let lifecycle = initialCredentialLifecycle();
	let inventoryBefore = [];
	let inventoryAfter = [];
	let revocationAuthenticationRejected = false;
	let postRevocationOutputClean = true;
	let expiresAt = null;
	let tokenRequestStartedAt = null;
	let expiryMetadataMatchesRequestedTtl = false;
	let newlyObservedTokenCount = 0;
	const scratchParent = syntheticMode ? syntheticRoot : os.tmpdir();
	const scratch = await mkdtemp(path.join(scratchParent, "artifacts-read-probe-"));
	let lockHandle = null;
	try {
		lockHandle = await open(path.join(os.tmpdir(), "nexus-artifact-probe.lock"), "wx", 0o600);
		await new Promise((resolve) => setImmediate(resolve));
		if (signalReceived) throw new Error("termination requested");
		inventoryBefore = listActive();
		lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-requested" });
		tokenRequestStartedAt = Date.now();
		issueResult = invoke(cf, ["artifacts", "namespaces", "tokens", "create", namespace, "--repo", repository, "--scope", "read", "--ttl", "300"]);
		issueStatus = issueResult.status === 0 && !issueResult.error ? "success" : "failed";
		try { issued = tokenFields(issueResult.stdout); } catch { issued = null; }
		token = typeof issued?.plaintext === "string" && issued.plaintext.length >= 8 ? issued.plaintext : null;
		tokenId = safeTokenId(issued?.id, token || "") ? issued.id : null;
		expiresAt = typeof issued?.expiresAt === "string" ? issued.expiresAt : null;
		const expiryMs = Date.parse(expiresAt || "");
		expiryMetadataMatchesRequestedTtl = Number.isFinite(expiryMs) && Math.abs(expiryMs - (tokenRequestStartedAt + 300_000)) <= 30_000;
		tokenIdCredentialDisjoint = Boolean(tokenId && token && !tokenId.includes(token) && !token.includes(tokenId));
		scopeVerified = issued?.scope === "read";
		if (tokenId && expiresAt && issued?.scope) {
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-response-valid", id: tokenId, scope: issued.scope, expiresAt });
		} else {
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-response-ambiguous" });
		}
		inventoryAfter = listActive();
		newlyObservedTokenCount = inventoryAfter.filter((id) => !inventoryBefore.includes(id)).length;
		if (tokenId && lifecycle.state === CredentialState.ISSUED_CONFIRMED) {
			if (inventoryAfter.includes(tokenId)) {
				lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issued-inventory-confirmed", id: tokenId, state: "active" });
			} else {
				lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issued-inventory-ambiguous" });
			}
		}
		await new Promise((resolve) => setImmediate(resolve));
		if (signalReceived) throw new Error("termination requested");
		if (issueStatus !== "success") throw new Error("token issuance failed");
		if (!token) throw new Error("token response plaintext is missing");
		if (!tokenId) throw new Error("token response ID is invalid");
		if (!scopeVerified) throw new Error("issued token scope is not read");
		if (!expiryMetadataMatchesRequestedTtl) throw new Error("token expiry metadata does not match requested TTL");
		if (issueResult.stderr.includes(token)) throw new Error("credential reflected on issuer stderr");

		header = `Authorization: Bearer ${token}`;
		gitEnv = {
			PATH: PATH_VALUE,
			HOME: scratch,
			LANG: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: header,
		};
		if (syntheticMode) {
			gitEnv.GIT_BROKER_TEST_EXPECTED = process.env.CF_TEST_CANARY;
			gitEnv.GIT_BROKER_TEST_OBSERVATION_FILE = process.env.CF_BROKER_TEST_GIT_OBSERVATION;
			gitEnv.GIT_BROKER_TEST_STATE = process.env.GIT_BROKER_TEST_STATE;
			gitEnv.CF_FAKE_GIT_MODE = process.env.CF_FAKE_GIT_MODE;
		}
		const gitArgs = ["ls-remote", remote, "HEAD"];
		if (syntheticMode && process.argv.includes("--synthetic-test-argv-leak")) gitArgs.push(header);
		if (gitArgs.some((arg) => arg.includes(token) || arg.includes(header))) {
			argvGuardRejected = true;
			throw new Error("credential appeared in Git argv");
		}
		lifecycle = transitionCredentialLifecycle(lifecycle, { type: "use-started" });
		const git = invoke(gitExecutable, gitArgs, { cwd: scratch, env: gitEnv, timeout: 20000 });
		await new Promise((resolve) => setImmediate(resolve));
		if (signalReceived) throw new Error("termination requested");
		let gitStdout = git.stdout || "";
		let gitStderr = git.stderr || "";
		const outputLeaked = gitStdout.includes(token) || gitStderr.includes(token);
		git.stdout = "";
		git.stderr = "";
		if (outputLeaked) throw new Error("Git reflected credential in captured output");
		gitSucceeded = git.status === 0 && !git.error;
		const head = gitSucceeded ? gitStdout.trim().split(/\s+/)[0] : "";
		gitStdout = "";
		gitStderr = "";
		headMatches = head === expectedHead;
		try {
			persistentFilesClean = !(await scanFor(scratch, token));
		} catch {
			scanErrorObserved = true;
			throw new Error("scratch scan failed");
		}
		if (!persistentFilesClean) throw new Error("credential persisted in probe scratch files");
		if (!gitSucceeded || !headMatches) throw new Error("authenticated read did not return expected baseline HEAD");
	} catch {
		// Do not forward child output, errors, response bodies, or credential fields.
	}

	if (lifecycle.state === CredentialState.ISSUANCE_ATTEMPTED) {
		try { lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-response-ambiguous" }); } catch {}
	}
	if (tokenId && [CredentialState.ISSUED_CONFIRMED, CredentialState.IN_USE, CredentialState.ISSUANCE_AMBIGUOUS].includes(lifecycle.state)) {
		try {
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revoke-requested", id: tokenId, exactRequestCorrelation: true });
			revoked = revoke(tokenId, token || "");
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revoke-command-succeeded", commandSucceeded: revoked });
		} catch {
			try {
				if (lifecycle.state === CredentialState.REVOCATION_ATTEMPTED) lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revoke-command-ambiguous" });
			} catch {}
			revoked = false;
		}
	} else if (issueStatus !== "not-started") {
		issuanceCleanupAmbiguous = true;
	}

	let activeAfterCount = -1;
	try {
		inventoryAfter = listActive();
		activeAfterCount = inventoryAfter.length;
		newlyObservedTokenCount = inventoryAfter.filter((id) => !inventoryBefore.includes(id)).length;
		tokenAbsentAfter = tokenId ? !inventoryAfter.includes(tokenId) : false;
		tokenInventoryState = tokenId ? (tokenAbsentAfter ? "absent" : "active") : "unknown";
	} catch {
		activeAfterCount = -1;
		tokenInventoryState = "unknown";
	}
	if (!tokenId && issueStatus !== "not-started") {
		// A repository-wide delta cannot safely identify which concurrent actor created a token.
		issuanceCleanupAmbiguous = true;
	}
	if (tokenId && token && gitEnv && lifecycle.state !== CredentialState.REVOKED_CONFIRMED) {
		try {
			const authCheck = invoke(gitExecutable, ["ls-remote", remote, "HEAD"], { cwd: scratch, env: gitEnv, timeout: 20000 });
			const stderr = authCheck.stderr || "";
			const stdout = authCheck.stdout || "";
			postRevocationOutputClean = !stdout.includes(token) && !stderr.includes(token);
			revocationAuthenticationRejected = postRevocationOutputClean && authCheck.status !== 0 && !authCheck.error && /authentication failed|http 401|http 403|access denied|invalid credentials/i.test(stderr);
			if (authCheck.stdout) authCheck.stdout = "";
			if (authCheck.stderr) authCheck.stderr = "";
		} catch { postRevocationOutputClean = false; }
		try {
			if (tokenInventoryState === "absent" && revocationAuthenticationRejected) {
				lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revocation-verified", inventoryAbsent: true, authenticationRejected: true });
			} else if (tokenInventoryState === "active" && [CredentialState.REVOCATION_ATTEMPTED, CredentialState.REVOCATION_AMBIGUOUS].includes(lifecycle.state)) {
				lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revocation-observed-active" });
			} else if ([CredentialState.REVOCATION_ATTEMPTED, CredentialState.REVOCATION_AMBIGUOUS].includes(lifecycle.state)) {
				lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revocation-observation-inconclusive", inventoryAbsent: tokenInventoryState === "absent" });
			}
		} catch {}
	}

	try {
		persistentFilesClean = token ? (persistentFilesClean && !(await scanFor(scratch, token))) : persistentFilesClean;
	} catch {
		scanErrorObserved = true;
		persistentFilesClean = false;
	}
	if (issued) issued.plaintext = "";
	if (issueResult) {
		issueResult.stdout = "";
		issueResult.stderr = "";
	}
	if (gitEnv) gitEnv.GIT_CONFIG_VALUE_0 = "";
	if (gitEnv) gitEnv.GIT_BROKER_TEST_EXPECTED = "";
	header = "";
	token = null;
	try {
		await rm(scratch, { recursive: true, force: true });
	} catch {
		persistentFilesClean = false;
	} finally {
		if (lockHandle) {
			try { await lockHandle.close(); } catch { persistentFilesClean = false; }
			lockHandle = null;
			try { await rm(path.join(os.tmpdir(), "nexus-artifact-probe.lock"), { force: true }); } catch { persistentFilesClean = false; }
		}
	}

	await new Promise((resolve) => setImmediate(resolve));
	const passed = !signalReceived && !scanErrorObserved && issueStatus === "success" && scopeVerified && gitSucceeded && headMatches && persistentFilesClean && postRevocationOutputClean && revoked && tokenAbsentAfter && revocationAuthenticationRejected && lifecycle.state === CredentialState.REVOKED_CONFIRMED;
	process.stdout.write(JSON.stringify({
		syntheticOnly: syntheticMode,
		testMode: syntheticMode,
		probeAttempted: issueStatus !== "not-started",
		issueStatus,
		credentialLifecycleState: lifecycle.state,
		issuanceCleanupAmbiguous,
		tokenIdValidated: tokenId !== null,
		scopeVerified,
		expiryMetadataPresent: expiresAt !== null,
		expiryMetadataMatchesRequestedTtl,
		ttlEnforcement: "TTL_ENFORCEMENT_UNPROVEN",
		gitReadSucceeded: gitSucceeded,
		issuedIdFormatValid: issued ? /^[A-Za-z0-9_-]{8,64}$/.test(issued.id || "") : false,
		issuedIdCredentialDisjoint: tokenIdCredentialDisjoint,
		argvGuardRejected,
		expectedHeadMatched: headMatches,
		persistentFilesClean,
		scanErrorObserved,
		revocationCommandSucceeded: revoked,
		tokenAbsentFromInventory: tokenAbsentAfter,
		tokenInventoryState,
		revocationAuthenticationRejected,
		postRevocationOutputClean,
		issuanceCleanupAmbiguous,
		newlyObservedTokenCount,
		activeTokensAfter: activeAfterCount,
		passed,
	}) + "\n");
	process.exitCode = passed ? 0 : 1;
}

main().catch(() => {
	process.stdout.write(JSON.stringify({ syntheticOnly: false, passed: false, fatalErrorSuppressed: true }) + "\n");
	process.exitCode = 1;
});
