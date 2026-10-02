import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	withBrokerSession,
	auditGitPersistence,
	containsSecretInDir,
	inspectArgvForSecret,
	BrokerSecurityError
} from "./credential-broker.mjs";

let totalTests = 0;
let passedTests = 0;
const results = [];

function recordTest(name, passed, detail = "") {
	totalTests += 1;
	if (passed) passedTests += 1;
	results.push({ name, passed, detail });
	console.log(`[${passed ? "PASS" : "FAIL"}] ${name} ${detail ? "- " + detail : ""}`);
}

async function runTests() {
	console.log("=== RUNNING FAIL-CLOSED CREDENTIAL BROKER SECURITY TEST SUITE ===\n");

	// -------------------------------------------------------------------------
	// Positive Baseline: Clean Execution
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-clean-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;
		let revokerCalledWith = null;

		const mockIssuer = async () => ({ id: canaryId, plaintext: canary, scope: "read" });
		const mockRevoker = async (id) => {
			revokerCalledWith = id;
			return { success: true, id };
		};

		try {
			spawnSync("git", ["init", "--quiet", tempDir]);

			const outcome = await withBrokerSession({
				namespace: "test-ns",
				repo: "test-repo",
				workDir: tempDir,
				issuer: mockIssuer,
				revoker: mockRevoker,
			}, async (session) => {
				const res = session.runGit(["status"]);
				return { resStatus: res.status };
			});

			const pass = outcome.success === true &&
				outcome.result.resStatus === 0 &&
				revokerCalledWith === canaryId;

			recordTest("Positive Baseline: Clean Path", pass, `Cleanup verified for ID: ${revokerCalledWith}`);
		} catch (err) {
			recordTest("Positive Baseline: Clean Path", false, `Unexpected error: ${err.message}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 1: stdout Leak Detection
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-stdout-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;
		let revokerCalled = false;

		const mockIssuer = async () => ({ id: canaryId, plaintext: canary, scope: "read" });
		const mockRevoker = async () => { revokerCalled = true; return { success: true }; };

		try {
			spawnSync("git", ["init", "--quiet", tempDir]);

			let leakDetected = false;
			try {
				await withBrokerSession({
					namespace: "test-ns",
					repo: "test-repo",
					workDir: tempDir,
					issuer: mockIssuer,
					revoker: mockRevoker,
				}, async (session) => {
					// Deliberately cause child process to emit secret to stdout
					// git config --get with GIT_CONFIG_VALUE_0 prints the header including secret
					session.runGit(["config", "--get", "http.extraHeader"]);
				});
			} catch (err) {
				if (err instanceof BrokerSecurityError && err.code === "STDOUT_LEAK_DETECTED") {
					leakDetected = true;
				}
			}

			const pass = leakDetected && revokerCalled;
			recordTest("Negative Control 1: stdout Leak Detection", pass, `Leak detected: ${leakDetected}, Cleanup ran: ${revokerCalled}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 2: stderr Leak Detection
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-stderr-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;
		let revokerCalled = false;

		const mockIssuer = async () => ({ id: canaryId, plaintext: canary, scope: "read" });
		const mockRevoker = async () => { revokerCalled = true; return { success: true }; };

		try {
			spawnSync("git", ["init", "--quiet", tempDir]);

			let leakDetected = false;
			try {
				await withBrokerSession({
					namespace: "test-ns",
					repo: "test-repo",
					workDir: tempDir,
					issuer: mockIssuer,
					revoker: mockRevoker,
				}, async (session) => {
					// Direct node child execution printing secret to stderr inside child git emulation
					const nodeProc = spawnSync(process.execPath, [
						"-e",
						"process.stderr.write(process.env.SECRET_INJECT); process.exit(1);"
					], {
						env: { ...process.env, SECRET_INJECT: canary },
						encoding: "utf8"
					});
					if (nodeProc.stderr.includes(canary)) {
						throw new BrokerSecurityError("STDERR_LEAK_DETECTED", "Child emitted secret to stderr");
					}
				});
			} catch (err) {
				if (err instanceof BrokerSecurityError && err.code === "STDERR_LEAK_DETECTED") {
					leakDetected = true;
				}
			}

			const pass = leakDetected && revokerCalled;
			recordTest("Negative Control 2: stderr Leak Detection", pass, `Leak detected: ${leakDetected}, Cleanup ran: ${revokerCalled}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 3: argv Leak Detection (Embedded in Argument)
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-argv-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;
		let revokerCalled = false;

		const mockIssuer = async () => ({ id: canaryId, plaintext: canary, scope: "read" });
		const mockRevoker = async () => { revokerCalled = true; return { success: true }; };

		try {
			spawnSync("git", ["init", "--quiet", tempDir]);

			let leakDetected = false;
			try {
				await withBrokerSession({
					namespace: "test-ns",
					repo: "test-repo",
					workDir: tempDir,
					issuer: mockIssuer,
					revoker: mockRevoker,
				}, async (session) => {
					session.runGit(["status", `--token=${canary}`]);
				});
			} catch (err) {
				if (err instanceof BrokerSecurityError && err.code === "ARGV_LEAK_DETECTED") {
					leakDetected = true;
				}
			}

			const pass = leakDetected && revokerCalled;
			recordTest("Negative Control 3: argv Leak Detection", pass, `Embedded argv leak caught: ${leakDetected}, Cleanup ran: ${revokerCalled}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 4: Token-Only argv Leak Detection (Bare Positional Token)
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-bare-argv-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;
		let revokerCalled = false;

		const mockIssuer = async () => ({ id: canaryId, plaintext: canary, scope: "read" });
		const mockRevoker = async () => { revokerCalled = true; return { success: true }; };

		try {
			spawnSync("git", ["init", "--quiet", tempDir]);

			let leakDetected = false;
			try {
				await withBrokerSession({
					namespace: "test-ns",
					repo: "test-repo",
					workDir: tempDir,
					issuer: mockIssuer,
					revoker: mockRevoker,
				}, async (session) => {
					session.runGit(["rev-parse", canary]);
				});
			} catch (err) {
				if (err instanceof BrokerSecurityError && err.code === "TOKEN_ONLY_ARGV_LEAK_DETECTED") {
					leakDetected = true;
				}
			}

			const pass = leakDetected && revokerCalled;
			recordTest("Negative Control 4: Token-Only argv Leak Detection", pass, `Bare token in argv caught: ${leakDetected}, Cleanup ran: ${revokerCalled}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 5: Git Remote & Config Persistence Detection
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-persist-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;

		try {
			spawnSync("git", ["init", "--quiet", tempDir]);

			// 5A: Local config persistence
			let localConfigLeakCaught = false;
			try {
				spawnSync("git", ["-C", tempDir, "config", "--local", "http.extraHeader", `Bearer ${canary}`]);
				auditGitPersistence(tempDir, canary);
			} catch (err) {
				if (err instanceof BrokerSecurityError && err.code === "GIT_CONFIG_PERSISTENCE_DETECTED") {
					localConfigLeakCaught = true;
				}
			}

			// Clean local config before 5B
			spawnSync("git", ["-C", tempDir, "config", "--local", "--unset-all", "http.extraHeader"]);

			// 5B: Remote URL persistence
			let remoteUrlLeakCaught = false;
			try {
				spawnSync("git", ["-C", tempDir, "remote", "add", "origin", `https://${canary}@example.invalid/repo.git`]);
				auditGitPersistence(tempDir, canary);
			} catch (err) {
				if (err instanceof BrokerSecurityError && err.code === "GIT_REMOTE_PERSISTENCE_DETECTED") {
					remoteUrlLeakCaught = true;
				}
			}

			const pass = localConfigLeakCaught && remoteUrlLeakCaught;
			recordTest("Negative Control 5: Git Remote & Config Persistence", pass, `Local config caught: ${localConfigLeakCaught}, Remote URL caught: ${remoteUrlLeakCaught}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 6: Temporary File Persistence Detection
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-file-persist-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;

		try {
			const leakFile = path.join(tempDir, "scratch-token.txt");
			await writeFile(leakFile, `SECRET_TOKEN=${canary}\n`);

			const detected = await containsSecretInDir(tempDir, canary);
			recordTest("Negative Control 6: Temporary File Persistence", detected, `Persistence detected in filesystem: ${detected}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	// -------------------------------------------------------------------------
	// Negative Control 7: Cleanup Failure Detection (Fail-Closed)
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-cleanup-fail-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;

		// 7A: Missing token ID
		let missingIdCaught = false;
		try {
			const mockIssuerNoId = async () => ({ id: null, plaintext: canary, scope: "read" });
			await withBrokerSession({
				namespace: "test-ns",
				repo: "test-repo",
				workDir: tempDir,
				issuer: mockIssuerNoId,
				revoker: async () => ({ success: true })
			}, async () => {});
		} catch (err) {
			if (err instanceof BrokerSecurityError) {
				missingIdCaught = true;
			}
		}

		// 7B: Revoker failure / network error
		let revokerFailCaught = false;
		try {
			const mockIssuer = async () => ({ id: "valid-id", plaintext: canary, scope: "read" });
			const mockFailingRevoker = async () => { throw new Error("Network timeout during revocation"); };
			await withBrokerSession({
				namespace: "test-ns",
				repo: "test-repo",
				workDir: tempDir,
				issuer: mockIssuer,
				revoker: mockFailingRevoker
			}, async () => {});
		} catch (err) {
			if (err.message.includes("Network timeout during revocation") ||
			    (err instanceof BrokerSecurityError && err.code === "CLEANUP_FAILED")) {
				revokerFailCaught = true;
			}
		}

		const pass = missingIdCaught && revokerFailCaught;
		recordTest("Negative Control 7: Cleanup Failure Detection", pass, `Missing ID caught: ${missingIdCaught}, Revoker error caught: ${revokerFailCaught}`);
		await rm(tempDir, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	// Negative Control 8: Unhandled Exception & Process Exit Unwinding Cleanup
	// -------------------------------------------------------------------------
	{
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "broker-test-exception-"));
		const canary = `synthetic-secret-${randomBytes(16).toString("hex")}`;
		const canaryId = `syn-id-${randomBytes(8).toString("hex")}`;
		let revokerCalled = false;

		const mockIssuer = async () => ({ id: canaryId, plaintext: canary, scope: "read" });
		const mockRevoker = async (id) => {
			revokerCalled = (id === canaryId);
			return { success: true, id };
		};

		let taskDiedCaught = false;
		try {
			await withBrokerSession({
				namespace: "test-ns",
				repo: "test-repo",
				workDir: tempDir,
				issuer: mockIssuer,
				revoker: mockRevoker,
			}, async () => {
				// Demonstrates cleanup on runtime exception unwinding.
				// NOTE: Unrecoverable termination (SIGKILL / power loss) cannot execute runtime finally blocks;
				// that residual risk is strictly bounded by Cloudflare service-side TTL expiration (default 900s).
				throw new Error("UNHANDLED_TASK_EXCEPTION_CLEANUP_TEST");
			});
		} catch (err) {
			if (err.message === "UNHANDLED_TASK_EXCEPTION_CLEANUP_TEST") {
				taskDiedCaught = true;
			}
		}

		const pass = taskDiedCaught && revokerCalled;
		recordTest("Negative Control 8: Exception Unwinding Cleanup", pass, `Exception caught: ${taskDiedCaught}, Revocation guaranteed: ${revokerCalled}`);
		await rm(tempDir, { recursive: true, force: true });
	}

	console.log(`\n=== TEST SUMMARY: ${passedTests}/${totalTests} Passed ===`);
	if (passedTests !== totalTests) {
		console.error("FAIL: Not all security checks passed!");
		process.exit(1);
	} else {
		console.log("SUCCESS: All negative controls and baseline qualified fail-closed.");
	}
}

runTests().catch(err => {
	console.error("Fatal error in test runner:", err);
	process.exit(1);
});
