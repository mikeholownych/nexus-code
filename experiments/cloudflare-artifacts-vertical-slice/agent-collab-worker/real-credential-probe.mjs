import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withBrokerSession } from "./credential-broker.mjs";

async function runRealProbe() {
	console.log("=== EXECUTING SINGLE BOUNDED REAL-CREDENTIAL PROBE ===");

	const namespace = "nexus-exp1-oct02";
	const repo = "external-git-proof";
	const remoteUrl = "https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/nexus-exp1-oct02/external-git-proof.git";
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "cf-real-probe-"));

	let probeOutcome = null;
	let activeTokensAfter = -1;

	try {
		console.log(`[1] Issuing read-scoped ephemeral token for ${namespace}/${repo}...`);
		probeOutcome = await withBrokerSession({
			namespace,
			repo,
			scope: "read",
			ttlSeconds: 900,
			workDir: tempDir,
		}, async (session) => {
			console.log(`[2] Ephemeral token issued with ID: ${session.tokenId}. Executing git ls-remote...`);
			const res = session.runGit(["ls-remote", remoteUrl, "HEAD"]);

			if (res.status !== 0) {
				throw new Error(`git ls-remote failed with status ${res.status}: ${res.stderr}`);
			}

			// Clean output verification
			const lines = res.stdout.trim().split("\n");
			const headCommit = lines[0] ? lines[0].split("\t")[0] : null;

			return {
				success: true,
				headCommit,
				stdoutLineCount: lines.length,
			};
		});

		console.log(`[3] Git ls-remote succeeded. Revocation completed in finally block.`);
	} catch (err) {
		console.error(`[ERROR] Real probe failed:`, err.message);
		process.exitCode = 1;
	} finally {
		await rm(tempDir, { recursive: true, force: true });

		// Verify zero active tokens remain
		const cfPath = process.env.CF_CLI_PATH || "/home/mike/.local/node-v24.11.1-linux-x64/bin/cf";
		const checkProc = spawnSync(cfPath, [
			"artifacts", "namespaces", "repos", "tokens", "list",
			"--namespace", namespace,
			"--name", repo,
			"--state", "active"
		], {
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				PATH: `/home/mike/.local/node-v24.11.1-linux-x64/bin:/home/mike/.local/bin:${process.env.PATH || ""}`
			}
		});

		if (checkProc.status === 0) {
			try {
				const activeList = JSON.parse(checkProc.stdout);
				activeTokensAfter = Array.isArray(activeList) ? activeList.length : 0;
			} catch {
				activeTokensAfter = -1;
			}
		}
	}

	console.log("\n=== PROBE RESULTS ===");
	console.log(`Probe success: ${probeOutcome?.success === true}`);
	console.log(`Remote HEAD verified: ${probeOutcome?.result?.headCommit}`);
	console.log(`Active tokens remaining on ${repo}: ${activeTokensAfter}`);

	if (probeOutcome?.success === true && activeTokensAfter === 0) {
		console.log("\nSUCCESS: Exactly one bounded real-credential probe completed safely.");
		process.exit(0);
	} else {
		console.error("\nFAILURE: Probe did not satisfy safety/verification criteria.");
		process.exit(1);
	}
}

runRealProbe().catch(err => {
	console.error("Fatal error:", err);
	process.exit(1);
});
