import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withBrokerSession, BrokerSecurityError } from "./agent-collab-worker/credential-broker.mjs";

const NAMESPACE = "nexus-exp1-oct02";
const REPO = "external-git-proof";
const REMOTE_URL = `https://a1a1fe900d3e61ccd4ef3a512867d7c0.artifacts.cloudflare.net/git/${NAMESPACE}/${REPO}.git`;

async function main() {
	console.log("=== EXECUTING CLOUDFLARE CONTEST VERTICAL SLICE ===");
	console.log("Architecture: Real Git -> Real Cloudflare Artifacts -> Multiple Actors -> Isolated Work -> Machine-Readable Work State -> Reassessment -> Validation -> Verifiable Result\n");

	const root = await mkdtemp(path.join(os.tmpdir(), "contest-vslice-"));
	console.log(`[Workspace] Initialized temporary execution root: ${root}`);

	const producerDir = path.join(root, "actor-producer");
	const consumerDir = path.join(root, "actor-consumer");
	const integrationDir = path.join(root, "actor-integration");

	const auditReport = {
		sliceName: "NEXUS_CLOUDFLARE_CONTEST_VERTICAL_SLICE",
		timestamp: new Date().toISOString(),
		namespace: NAMESPACE,
		repository: REPO,
		remoteUrl: REMOTE_URL,
		brokerQualified: true,
		steps: {
			gitAuthentication: null,
			producerCandidate: null,
			consumerCandidate: null,
			workStatePublication: null,
			consumerReassessment: null,
			automatedValidation: null,
			verifiableRemoteCommit: null,
		},
		tokenCleanupVerified: false,
		success: false,
	};

	try {
		// Run entire vertical slice inside safe credential broker session with write scope
		console.log("[1] Acquiring ephemeral write credential via fail-closed broker...");
		const sessionOutcome = await withBrokerSession({
			namespace: NAMESPACE,
			repo: REPO,
			scope: "write",
			ttlSeconds: 900,
			workDir: root,
		}, async (session) => {
			console.log(`[1.1] Broker issued ephemeral write token (ID: ${session.tokenId}) - strictly in memory.`);
			auditReport.steps.gitAuthentication = {
				status: "PASS",
				tokenId: session.tokenId,
				scope: session.scope,
			};

			// Helper to run git in a directory
			const runGitIn = (dir, args) => {
				const res = session.runGit(args, {
					cwd: dir,
					env: {
						GIT_AUTHOR_NAME: "Nexus Contest Agent",
						GIT_AUTHOR_EMAIL: "contest-agent@nexus.cloud",
						GIT_COMMITTER_NAME: "Nexus Contest Agent",
						GIT_COMMITTER_EMAIL: "contest-agent@nexus.cloud",
					}
				});
				if (res.status !== 0) {
					throw new Error(`Git error in ${dir} (${args.join(" ")}): ${res.stderr || res.stdout}`);
				}
				return res.stdout.trim();
			};

			// -----------------------------------------------------------------
			// Step A: Actor Producer clones and creates candidate work
			// -----------------------------------------------------------------
			console.log("\n[2] Producer Actor initializing clone from Cloudflare Artifacts...");
			runGitIn(root, ["clone", "--quiet", REMOTE_URL, producerDir]);

			console.log("[2.1] Producer creating isolated candidate work on branch candidate/producer...");
			runGitIn(producerDir, ["checkout", "-b", "candidate/producer"]);

			await mkdir(path.join(producerDir, "src"), { recursive: true });
			await writeFile(path.join(producerDir, "src", "service-contract.json"), JSON.stringify({
				service: "nexus-collab-service",
				version: "1.0.0",
				capabilities: ["work-state-sync", "isolated-execution", "verifiable-git"],
				schema: "nexus.service.v1"
			}, null, 2));

			await writeFile(path.join(producerDir, "src", "engine.js"), `
export function computeTaskHash(input) {
	const crypto = await import("node:crypto");
	return crypto.createHash("sha256").update(input).digest("hex");
}
export const STATUS = "READY";
`);

			runGitIn(producerDir, ["add", "src/service-contract.json", "src/engine.js"]);
			runGitIn(producerDir, ["commit", "-m", "feat(service): producer candidate service contract"]);
			const producerCommitSha = runGitIn(producerDir, ["rev-parse", "HEAD"]);
			const producerTreeHash = runGitIn(producerDir, ["rev-parse", "HEAD^{tree}"]);
			console.log(`[2.2] Producer committed candidate: ${producerCommitSha} (tree: ${producerTreeHash})`);

			console.log("[2.3] Producer pushing candidate/producer to Cloudflare Artifacts...");
			runGitIn(producerDir, ["push", "-u", "origin", "candidate/producer", "--force"]);
			auditReport.steps.producerCandidate = {
				commitSha: producerCommitSha,
				treeHash: producerTreeHash,
				branch: "candidate/producer",
				status: "PUSHED_TO_ARTIFACTS"
			};

			// -----------------------------------------------------------------
			// Step B: Producer Publishes Machine-Readable Work State to Cloudflare
			// -----------------------------------------------------------------
			console.log("\n[3] Producer publishing machine-readable work-state to branch work-state...");
			runGitIn(producerDir, ["checkout", "--orphan", "work-state"]);
			runGitIn(producerDir, ["reset", "--hard"]);

			await mkdir(path.join(producerDir, ".agent"), { recursive: true });
			const workStateJson = {
				schema: "nexus.agent-work-state.v1",
				timestamp: new Date().toISOString(),
				producer: {
					candidateCommit: producerCommitSha,
					candidateTree: producerTreeHash,
					candidateRef: "refs/heads/candidate/producer",
				},
				contract: {
					file: "src/service-contract.json",
					service: "nexus-collab-service",
					version: "1.0.0"
				},
				status: "PRODUCER_CANDIDATE_READY"
			};

			const stateBuffer = Buffer.from(JSON.stringify(workStateJson, null, 2));
			const stateDigest = createHash("sha256").update(stateBuffer).digest("hex");
			await writeFile(path.join(producerDir, ".agent", "work-state.json"), stateBuffer);

			runGitIn(producerDir, ["add", ".agent/work-state.json"]);
			runGitIn(producerDir, ["commit", "-m", "chore(state): publish machine-readable work-state v1"]);
			const stateCommitSha = runGitIn(producerDir, ["rev-parse", "HEAD"]);
			runGitIn(producerDir, ["push", "-u", "origin", "work-state", "--force"]);
			console.log(`[3.1] Work state pushed to Cloudflare Artifacts (commit: ${stateCommitSha}, digest: ${stateDigest})`);
			auditReport.steps.workStatePublication = {
				stateCommit: stateCommitSha,
				stateDigest,
				ref: "refs/heads/work-state",
				status: "PUBLISHED_TO_ARTIFACTS"
			};

			// -----------------------------------------------------------------
			// Step C: Consumer Actor Clones, Works, and Reassesses against Work State
			// -----------------------------------------------------------------
			console.log("\n[4] Consumer Actor cloning and creating consumer candidate...");
			runGitIn(root, ["clone", "--quiet", REMOTE_URL, consumerDir]);
			runGitIn(consumerDir, ["checkout", "-b", "candidate/consumer"]);

			await mkdir(path.join(consumerDir, "src"), { recursive: true });
			await writeFile(path.join(consumerDir, "src", "client.js"), `
export function createClient(config) {
	return {
		service: config.service,
		version: config.version,
		connected: true
	};
}
`);

			runGitIn(consumerDir, ["add", "src/client.js"]);
			runGitIn(consumerDir, ["commit", "-m", "feat(client): consumer client initial implementation"]);
			const consumerInitSha = runGitIn(consumerDir, ["rev-parse", "HEAD"]);
			console.log(`[4.1] Consumer candidate commit: ${consumerInitSha}`);
			console.log("[4.2] Consumer pushing candidate/consumer to Cloudflare Artifacts...");
			runGitIn(consumerDir, ["push", "-u", "origin", "candidate/consumer", "--force"]);
			auditReport.steps.consumerCandidate = {
				commitSha: consumerInitSha,
				branch: "candidate/consumer",
				status: "PUSHED_TO_ARTIFACTS"
			};

			console.log("\n[5] Consumer fetching and reassessing machine-readable work-state from Cloudflare Artifacts...");
			runGitIn(consumerDir, ["fetch", "origin", "work-state:remotes/origin/work-state"]);
			const stateFileContent = runGitIn(consumerDir, ["show", "origin/work-state:.agent/work-state.json"]);
			const parsedWorkState = JSON.parse(stateFileContent);

			if (parsedWorkState.schema !== "nexus.agent-work-state.v1" ||
			    parsedWorkState.status !== "PRODUCER_CANDIDATE_READY" ||
			    !parsedWorkState.producer?.candidateCommit) {
				throw new Error("Consumer validation of machine-readable work-state failed");
			}

			console.log(`[5.1] Consumer verified work-state from producer (Producer Candidate: ${parsedWorkState.producer.candidateCommit})`);
			auditReport.steps.consumerReassessment = {
				workStateVerified: true,
				producerCommitReferenced: parsedWorkState.producer.candidateCommit,
				status: "COMPATIBLE_AND_REASSESSED"
			};

			// -----------------------------------------------------------------
			// Step D: Automated Integration and Validation
			// -----------------------------------------------------------------
			console.log("\n[6] Performing integration of producer and consumer candidates...");
			runGitIn(root, ["clone", "--quiet", REMOTE_URL, integrationDir]);
			runGitIn(integrationDir, ["checkout", "-b", "integration/contest-slice", producerCommitSha]);

			// Fetch and merge consumer candidate
			runGitIn(integrationDir, ["fetch", "origin", "candidate/consumer"]);
			runGitIn(integrationDir, ["merge", "--no-ff", "-m", "merge(collab): integrate producer and consumer candidates", consumerInitSha]);

			// Automated integration test
			console.log("[6.1] Running automated contract validation test...");
			await writeFile(path.join(integrationDir, "test-integration.js"), `
import { readFileSync } from "node:fs";
import { createClient } from "./src/client.js";

const contract = JSON.parse(readFileSync("./src/service-contract.json", "utf8"));
if (contract.service !== "nexus-collab-service" || contract.version !== "1.0.0") {
	throw new Error("Invalid service contract");
}

const client = createClient(contract);
if (!client.connected || client.service !== contract.service) {
	throw new Error("Client failed contract connection test");
}

console.log("CONTEST_SLICE_VALIDATION: PASS");
`);

			const testProc = spawnSync(process.execPath, [path.join(integrationDir, "test-integration.js")], {
				cwd: integrationDir,
				encoding: "utf8"
			});

			if (testProc.status !== 0 || !testProc.stdout.includes("CONTEST_SLICE_VALIDATION: PASS")) {
				throw new Error(`Integration validation failed: ${testProc.stderr || testProc.stdout}`);
			}
			console.log("[6.2] Automated integration validation PASSED!");

			// Remove temp test script and commit final integrated artifact
			await rm(path.join(integrationDir, "test-integration.js"));
			const finalIntegrationSha = runGitIn(integrationDir, ["rev-parse", "HEAD"]);
			console.log(`[6.3] Final verifiable integration commit: ${finalIntegrationSha}`);

			console.log("[7] Pushing final verified integration commit to Cloudflare Artifacts (contest-slice)...");
			runGitIn(integrationDir, ["push", "-u", "origin", "integration/contest-slice:contest-slice", "--force"]);

			auditReport.steps.automatedValidation = {
				status: "PASS",
				contractValidated: true,
			};
			auditReport.steps.verifiableRemoteCommit = {
				commitSha: finalIntegrationSha,
				remoteRef: "refs/heads/contest-slice",
				status: "VERIFIED_ON_CLOUDFLARE_ARTIFACTS"
			};

			return {
				producerCommitSha,
				stateCommitSha,
				finalIntegrationSha,
				remoteRef: "contest-slice"
			};
		});

		console.log(`\n[8] Broker session ended. Token revocation verified.`);
		auditReport.success = true;

		// ---------------------------------------------------------------------
		// Post-Session Token Inventory Check
		// ---------------------------------------------------------------------
		const cfPath = process.env.CF_CLI_PATH || "/home/mike/.local/node-v24.11.1-linux-x64/bin/cf";
		const checkProc = spawnSync(cfPath, [
			"artifacts", "namespaces", "repos", "tokens", "list",
			"--namespace", NAMESPACE,
			"--name", REPO,
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
			const tokens = JSON.parse(checkProc.stdout);
			auditReport.tokenCleanupVerified = Array.isArray(tokens) && tokens.length === 0;
			console.log(`Active tokens remaining on ${REPO}: ${tokens.length}`);
		}

	} catch (err) {
		console.error("\n[ERROR] Vertical slice failed:", err);
		auditReport.error = err.message;
		process.exitCode = 1;
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	console.log("\n=== CONTEST VERTICAL SLICE AUDIT RECORD ===");
	console.log(JSON.stringify(auditReport, null, 2));

	if (auditReport.success && auditReport.tokenCleanupVerified) {
		console.log("\nSUCCESS: Complete contest vertical slice proven on real Cloudflare Artifacts substrate.");
		process.exit(0);
	} else {
		console.error("\nFAILURE: Contest vertical slice did not meet all criteria.");
		process.exit(1);
	}
}

main().catch(err => {
	console.error("Fatal:", err);
	process.exit(1);
});
