import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeBoundExecutable, executeBoundExecutable, openTrustedExecutable } from "./linux-bound-exec.mjs";
import { CredentialState, initialCredentialLifecycle, transitionCredentialLifecycle } from "./credential-lifecycle.mjs";
import { classifyPostRevokeGit, classifyRevokeResponse } from "./artifact-token-response.mjs";

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
const syntheticProgramHashes = { cli: "89a90307eac5203d41003d220bd8c6673f77d00299aefa6522c9b88fd9a422cc", git: "bf4aa39f786ee1a2ee1ea3e370cf9aac5dd9ffe40f0eec63e94565ef65033704" };
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
const cf = syntheticMode ? syntheticCfPath : "/opt/nexus-cloudflare-broker/runtime/node";
const gitExecutable = syntheticMode ? syntheticGitPath : "/usr/bin/git";
const cfProductionTarget = "/opt/nexus-cloudflare-broker/cf-runtime/node_modules/cf/bin/cf";
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
		executablePath = syntheticMode ? syntheticCfPath : cf;
		policy = syntheticMode
			? { expectedUid: process.getuid(), expectedSha256: syntheticProgramHashes.cli }
			: { expectedUid: 0 };
	} else if (command === gitExecutable) {
		executablePath = gitExecutable;
		policy = syntheticMode
			? { expectedUid: process.getuid(), expectedSha256: syntheticProgramHashes.git }
			: { expectedUid: 0 };
	} else {
		throw new Error("executable is not in the fixed allowlist");
	}
	let bound;
	try {
		bound = openTrustedExecutable(executablePath, policy);
	} catch (cause) {
		const error = new Error("trusted child could not be opened before process start");
		error.beforeSubmission = true;
		error.code = typeof cause?.code === "string" ? cause.code : "EXECUTABLE_VALIDATION_FAILED";
		throw error;
	}
	try {
		const executionArgs = !syntheticMode && command === cf ? [cfProductionTarget, ...args] : args;
		return executeBoundExecutable(bound, executionArgs, {
			cwd: options.cwd ?? (command === cf ? "/" : undefined),
			env: options.env || (syntheticMode
				? { ...productionCfEnv, CF_FAKE_STATE: process.env.CF_FAKE_STATE, CF_FAKE_MODE: process.env.CF_FAKE_MODE, CF_FAKE_GIT_MODE: process.env.CF_FAKE_GIT_MODE, CF_TEST_CANARY: process.env.CF_TEST_CANARY }
				: (command === cf ? productionCfEnv : { PATH: PATH_VALUE, HOME: "/nonexistent", LANG: "C.UTF-8" })),
			timeout: options.timeout || 15000,
			maxBuffer: 256 * 1024,
		});
	} catch (cause) {
		const error = new Error("trusted child execution failed after executable validation");
		error.beforeSubmission = false;
		error.code = typeof cause?.code === "string" ? cause.code : "CHILD_EXECUTION_FAILED";
		throw error;
	} finally {
		closeBoundExecutable(bound);
	}
}

function tokenFields(jsonText) {
	const value = JSON.parse(jsonText);
	const token = value?.result ?? (value?.token && typeof value.token === "object" ? value.token : value);
	const plaintext = token?.plaintext ?? token?.token;
	const id = token?.id;
	const scope = token?.scope;
	const expiresAt = token?.expires_at ?? token?.expiresAt;
	return { plaintext, id, scope, expiresAt };
}

function safeTokenId(id) {
	return typeof id === "string" && /^[0-9a-z]{16}$/.test(id);
}

function isPermissionDenied(output) {
	return /\b(401|403)\b|permission denied|not authorized|unauthorized|forbidden|authentication error/i.test(output);
}

async function revokeExact(id, secret = "") {
	if (!safeTokenId(id)) return { acknowledged: false, attempts: 0, acknowledgedAt: null, classification: "REVOKE_AMBIGUOUS", evidence: [], permissionDenied: false, outputClean: true };
	// Installed cf help documents that revoke-by-ID can return 404 within about one second after creation and says to retry after a short delay.
	const retryDelayMs = 1200;
	const evidence = [];
	let outputClean = true;
	for (let index = 0; index < 2; index += 1) {
		if (index === 1) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		let result;
		try {
			result = invoke(cf, ["artifacts", "namespaces", "tokens", "revoke", id, "--namespace", namespace, "-f"]);
		} catch (error) {
			const classification = "REVOKE_TRANSPORT_FAILURE";
			evidence.push({ attempt: index + 1, classification, reason: "trusted_child_invocation_threw", childErrorCode: typeof error?.code === "string" ? error.code : null });
			return { acknowledged: false, attempts: index + 1, acknowledgedAt: null, classification, evidence, permissionDenied: false, outputClean };
		}
		const classified = classifyRevokeResponse(result, id);
		outputClean &&= !secret || (!(result.stdout || "").includes(secret) && !(result.stderr || "").includes(secret));
		const attemptEvidence = { attempt: index + 1, ...classified };
		result.stdout = "";
		result.stderr = "";
		if (!outputClean) {
			evidence.push({ ...attemptEvidence, classification: "REVOKE_AMBIGUOUS", reason: "credential_reflected_in_child_output" });
			return { acknowledged: false, attempts: index + 1, acknowledgedAt: null, classification: "REVOKE_AMBIGUOUS", evidence, permissionDenied: false, outputClean };
		}
		evidence.push(attemptEvidence);
		if (classified.classification === "REVOKE_ACKNOWLEDGED") return { acknowledged: true, attempts: index + 1, acknowledgedAt: new Date().toISOString(), classification: classified.classification, evidence, permissionDenied: false, outputClean };
		if (classified.classification !== "REVOKE_TRANSIENT_RETRY_ELIGIBLE") {
			return { acknowledged: false, attempts: index + 1, acknowledgedAt: null, classification: classified.classification, evidence, permissionDenied: classified.classification === "REVOKE_PERMISSION_DENIED", outputClean };
		}
		if (index === 1) return { acknowledged: false, attempts: index + 1, acknowledgedAt: null, classification: "REVOKE_TRANSIENT_RETRY_EXHAUSTED", evidence, permissionDenied: false, outputClean };
	}
	return { acknowledged: false, attempts: evidence.length, acknowledgedAt: null, classification: "REVOKE_AMBIGUOUS", evidence, permissionDenied: false, outputClean };
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
	let revokeAck = false;
	let revokeAttempts = 0;
	let revokeAckAt = null;
	let revokeClassification = "NOT_ATTEMPTED";
	let revokeEvidence = [];
	let firstRejectedAt = null;
	let rejectionElapsedMs = null;
	let postRevocationClassification = "NOT_ATTEMPTED";
	let postRevocationEvidence = [];
	let permissionDenied = false;
	let gitSucceeded = false;
	let headMatches = false;
	let persistentFilesClean = false;
	let scanErrorObserved = false;
	let scopeVerified = false;
	let issuerOutputClean = true;
	let gitOutputClean = true;
	let revokeOutputClean = true;
	let processArgsClean = true;
	let remoteUrlClean = false;
	let gitPersistentConfigClean = false;
	let issuanceCleanupAmbiguous = false;
	let argvGuardRejected = false;
	let issueOutcome = "DEFINITE_FAILURE_BEFORE_SUBMISSION";
	let providerRejected = false;
	let createAttempts = 0;
	let lifecycle = initialCredentialLifecycle();
	let revocationAuthenticationRejected = false;
	let postRevocationOutputClean = true;
	let expiresAt = null;
	let tokenRequestStartedAt = null;
	let expiryMetadataMatchesRequestedTtl = false;
	const scratchParent = syntheticMode ? syntheticRoot : os.tmpdir();
	const scratch = await mkdtemp(path.join(scratchParent, "artifacts-read-probe-"));
	let lockHandle = null;
	try {
		lockHandle = await open(path.join(os.tmpdir(), "nexus-artifact-probe.lock"), "wx", 0o600);
		await new Promise((resolve) => setImmediate(resolve));
		if (signalReceived) throw new Error("termination requested");
		lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-requested" });
		createAttempts = 1;
		tokenRequestStartedAt = Date.now();
		try {
			issueResult = invoke(cf, ["artifacts", "namespaces", "tokens", "create", namespace, "--repo", repository, "--scope", "read", "--ttl", "300"]);
		} catch (error) {
			issueOutcome = error?.beforeSubmission === true ? "DEFINITE_FAILURE_BEFORE_SUBMISSION" : "AMBIGUOUS_ISSUANCE";
			throw new Error("credential creation could not be submitted");
		}
		try { issued = tokenFields(issueResult.stdout); } catch { issued = null; }
		token = typeof issued?.plaintext === "string" && issued.plaintext.length >= 8 ? issued.plaintext : null;
		tokenId = safeTokenId(issued?.id) ? issued.id : null;
		expiresAt = typeof issued?.expiresAt === "string" ? issued.expiresAt : null;
		const expiryMs = Date.parse(expiresAt || "");
		expiryMetadataMatchesRequestedTtl = Number.isFinite(expiryMs) && Math.abs(expiryMs - (tokenRequestStartedAt + 300_000)) <= 30_000;
		scopeVerified = issued?.scope === "read";
		const apiRejected = issueResult.status !== 0 && isPermissionDenied(`${issueResult.stdout || ""}\n${issueResult.stderr || ""}`);
		const envelopeRejected = (() => { try { return JSON.parse(issueResult.stdout)?.success === false; } catch { return false; } })();
		permissionDenied = isPermissionDenied(`${issueResult.stdout || ""}\n${issueResult.stderr || ""}`);
		if (apiRejected || envelopeRejected) {
			issueOutcome = "DEFINITE_PROVIDER_REJECTION";
			providerRejected = true;
			throw new Error("Cloudflare rejected credential creation");
		}
		if (issueResult.status === 0 && !issueResult.error && tokenId && token && expiresAt && issued?.scope) {
			issueOutcome = "SUCCESS_WITH_ID";
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-response-valid", id: tokenId, scope: issued.scope, expiresAt });
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "inventory-skipped-contest-mode" });
		} else {
			issueOutcome = "AMBIGUOUS_ISSUANCE";
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "issue-response-ambiguous" });
		}
		await new Promise((resolve) => setImmediate(resolve));
		if (signalReceived) throw new Error("termination requested");
		if (issueOutcome !== "SUCCESS_WITH_ID") throw new Error("credential issuance was not confirmed");
		if (!token) throw new Error("token response plaintext is missing");
		if (!tokenId) throw new Error("token response ID is invalid");
		if (!scopeVerified) throw new Error("issued token scope is not read");
		if (!expiryMetadataMatchesRequestedTtl) throw new Error("token expiry metadata does not match requested TTL");
		issuerOutputClean = !issueResult.stderr.includes(token);

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
		processArgsClean = !gitArgs.some((arg) => arg.includes(token) || arg.includes(header)) && !remote.includes(token);
		try {
			const remoteUrl = new URL(remote);
			remoteUrlClean = remoteUrl.username === "" && remoteUrl.password === "" && !remote.includes(token);
		} catch { remoteUrlClean = false; }
		lifecycle = transitionCredentialLifecycle(lifecycle, { type: "use-started" });
		const git = invoke(gitExecutable, gitArgs, { cwd: scratch, env: gitEnv, timeout: 20000 });
		await new Promise((resolve) => setImmediate(resolve));
		if (signalReceived) throw new Error("termination requested");
		let gitStdout = git.stdout || "";
		let gitStderr = git.stderr || "";
		const outputLeaked = gitStdout.includes(token) || gitStderr.includes(token);
		gitOutputClean = !outputLeaked;
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
		const configEnv = { PATH: PATH_VALUE, HOME: scratch, LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
		const configCheck = invoke(gitExecutable, ["config", "--get-all", "http.extraHeader"], { cwd: scratch, env: configEnv });
		gitPersistentConfigClean = configCheck.status === 1 && !configCheck.error && !(configCheck.stdout || "") && !(configCheck.stderr || "");
		configCheck.stdout = "";
		configCheck.stderr = "";
		if (!gitPersistentConfigClean) throw new Error("persistent Git extraHeader configuration exists");
		if (!gitSucceeded || !headMatches) throw new Error("authenticated read did not return expected baseline HEAD");
	} catch {
		// Do not forward child output, errors, response bodies, or credential fields.
	}

	if (lifecycle.state === CredentialState.ISSUANCE_ATTEMPTED) {
		try {
			lifecycle = transitionCredentialLifecycle(lifecycle, issueOutcome === "DEFINITE_PROVIDER_REJECTION"
				? { type: "issue-authoritatively-rejected", serviceRejected: true, credentialCreated: false }
				: issueOutcome === "DEFINITE_FAILURE_BEFORE_SUBMISSION" && !issueResult ? { type: "issue-not-submitted" }
				: { type: "issue-response-ambiguous" });
		} catch {}
	}
	if (issueOutcome === "SUCCESS_WITH_ID" && tokenId && token) {
		try {
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revoke-requested", id: tokenId });
			const revokeResult = await revokeExact(tokenId, token);
			revokeAck = revokeResult.acknowledged;
			revokeAttempts = revokeResult.attempts;
			revokeAckAt = revokeResult.acknowledgedAt;
			revokeClassification = revokeResult.classification;
			revokeEvidence = revokeResult.evidence;
			permissionDenied ||= revokeResult.permissionDenied;
			revokeOutputClean &&= revokeResult.outputClean;
			lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revoke-command-succeeded", commandSucceeded: revokeAck });
		} catch {
			try {
				if (lifecycle.state === CredentialState.REVOCATION_ATTEMPTED) lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revoke-command-ambiguous" });
			} catch {}
			revokeAck = false;
		}
	} else if (issueOutcome === "AMBIGUOUS_ISSUANCE") {
		issuanceCleanupAmbiguous = true;
	}

	if (revokeAck && token && gitEnv) {
		for (let attempt = 0; attempt < 7; attempt += 1) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
			try {
				const authCheck = invoke(gitExecutable, ["ls-remote", remote, "HEAD"], { cwd: scratch, env: gitEnv, timeout: 20000 });
				const classified = classifyPostRevokeGit(authCheck, expectedHead);
				postRevocationOutputClean &&= !(authCheck.stdout || "").includes(token) && !(authCheck.stderr || "").includes(token);
				authCheck.stdout = "";
				authCheck.stderr = "";
				postRevocationEvidence.push({ attempt: attempt + 1, ...classified });
				postRevocationClassification = classified.classification;
				if (!postRevocationOutputClean) {
					postRevocationClassification = "POST_REVOKE_GIT_OUTPUT_UNSAFE";
					break;
				}
				if (classified.classification === "POST_REVOKE_AUTHENTICATION_REJECTED") {
					firstRejectedAt = new Date().toISOString();
					rejectionElapsedMs = Date.parse(firstRejectedAt) - Date.parse(revokeAckAt);
					revocationAuthenticationRejected = true;
				}
				if (revocationAuthenticationRejected || classified.classification !== "POST_REVOKE_CREDENTIAL_STILL_ACCEPTED") break;
			} catch {
				postRevocationOutputClean = false;
				postRevocationClassification = "POST_REVOKE_GIT_UNRELATED_FAILURE";
				break;
			}
		}
		if (revocationAuthenticationRejected) {
			try { lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revocation-verified-no-inventory", authenticationRejected: true }); } catch {}
		} else if ([CredentialState.REVOCATION_ATTEMPTED, CredentialState.REVOCATION_AMBIGUOUS].includes(lifecycle.state)) {
			try { lifecycle = transitionCredentialLifecycle(lifecycle, { type: "revocation-observation-inconclusive", inventoryAbsent: false }); } catch {}
		}
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
	const passed = !signalReceived && !scanErrorObserved && issueOutcome === "SUCCESS_WITH_ID" && scopeVerified && gitSucceeded && headMatches && persistentFilesClean && issuerOutputClean && gitOutputClean && revokeOutputClean && processArgsClean && remoteUrlClean && gitPersistentConfigClean && postRevocationOutputClean && revokeAck && revocationAuthenticationRejected && lifecycle.state === CredentialState.REVOKED_CONFIRMED;
	process.stdout.write(JSON.stringify({
		syntheticOnly: syntheticMode,
		testMode: syntheticMode,
		lifecycleMode: "CREATE_ONCE_NO_INVENTORY",
		createAttemptCount: createAttempts,
		createOutcome: issueOutcome,
		providerRejected,
		permissionDenied,
		credentialLifecycleState: lifecycle.state,
		issuanceCleanupAmbiguous,
		tokenIdValidated: tokenId !== null,
		tokenId,
		scopeVerified,
		scope: issued?.scope ?? null,
		expiresAt,
		expiryMetadataPresent: expiresAt !== null,
		expiryMetadataMatchesRequestedTtl,
		ttlEnforcement: "TTL_ENFORCEMENT_UNPROVEN",
		gitReadSucceeded: gitSucceeded,
		issuedIdFormatValid: tokenId !== null,
		argvGuardRejected,
		expectedHeadMatched: headMatches,
		persistentFilesClean,
		scanErrorObserved,
		credentialOutputClean: issuerOutputClean && gitOutputClean && revokeOutputClean && postRevocationOutputClean,
		processArgsClean,
		remoteUrlClean,
		gitPersistentConfigClean,
		plaintextReturnedToCaller: false,
		tokenInventoryUsed: false,
		revocationCommandSucceeded: revokeAck,
		revokeClassification,
		revokeEvidence,
		revocationAcknowledgedAt: revokeAckAt,
		revocationAttempts: revokeAttempts,
		revocationAuthenticationRejected,
		postRevocationClassification,
		postRevocationEvidence,
		firstAuthenticationRejectionAt: firstRejectedAt,
		revocationToRejectionElapsedMs: rejectionElapsedMs,
		postRevocationOutputClean,
		passed,
	}) + "\n");
	process.exitCode = passed ? 0 : 1;
}

main().catch(() => {
	process.stdout.write(JSON.stringify({ syntheticOnly: false, passed: false, fatalErrorSuppressed: true }) + "\n");
	process.exitCode = 1;
});
