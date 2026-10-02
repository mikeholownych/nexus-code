import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Process-Local Ephemeral Credential Delivery for Cloudflare Artifacts
 *
 * Enforces strict containment boundaries:
 * 1. Secret interceptor: CLI/API stdout/stderr captured in-memory, parsed, never forwarded.
 * 2. Ephemeral authority delivery: Secret passed only in child process environment (GIT_CONFIG_VALUE_0),
 *    strictly avoiding argv, remote URLs, and persistent disk config.
 * 3. Argv inspection: Both key-value (--token=...) and bare positional token leaks are blocked.
 * 4. Output inspection: Child stdout/stderr inspected; secrets suppressed and flagged.
 * 5. Persistence audit: Local/global git config, remote URLs, and temp directories checked.
 * 6. Cleanup guarantee & failure envelope: Token revocation runs in finally block upon normal completion
 *    or exception unwinding. For unrecoverable process/host termination (e.g., SIGKILL, kernel panic,
 *    sudden power loss) where in-process runtime cleanup cannot execute, residual authority is bounded
 *    strictly by Cloudflare service-side TTL expiration (default 900s).
 */

export class BrokerSecurityError extends Error {
	constructor(code, message) {
		super(`${code}: ${message}`);
		this.name = "BrokerSecurityError";
		this.code = code;
	}
}

export async function containsSecretInDir(directory, secret) {
	if (!secret || secret.length < 8) return false;
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git") {
					const configPath = path.join(fullPath, "config");
					try {
						const content = await readFile(configPath, "utf8");
						if (content.includes(secret)) return true;
					} catch {
						// ignore if missing
					}
					continue;
				}
				if (await containsSecretInDir(fullPath, secret)) return true;
			} else if (entry.isFile()) {
				try {
					const content = await readFile(fullPath, "utf8");
					if (content.includes(secret)) return true;
				} catch {
					// skip unreadable
				}
			}
		}
	} catch {
		// Directory might not exist or be accessible
	}
	return false;
}

export function inspectArgvForSecret(args, secret) {
	if (!secret || secret.length < 8) return;
	for (const arg of args) {
		if (arg === secret) {
			throw new BrokerSecurityError("TOKEN_ONLY_ARGV_LEAK_DETECTED", "Secret was supplied as a bare argument in argv");
		}
		if (arg.includes(secret)) {
			throw new BrokerSecurityError("ARGV_LEAK_DETECTED", "Secret was embedded in an argument in argv");
		}
	}
}

export function auditGitPersistence(repoDir, secret, globalConfigPath = null) {
	if (!secret || secret.length < 8) return;

	if (repoDir) {
		const remoteCheck = spawnSync("git", ["-C", repoDir, "remote", "-v"], {
			encoding: "utf8",
			timeout: 5000,
		});
		if (remoteCheck.stdout && remoteCheck.stdout.includes(secret)) {
			throw new BrokerSecurityError("GIT_REMOTE_PERSISTENCE_DETECTED", "Secret was embedded in git remote URL");
		}

		const localCheck = spawnSync("git", ["-C", repoDir, "config", "--local", "--get-regexp", ".*"], {
			encoding: "utf8",
			timeout: 5000,
		});
		if (localCheck.stdout && localCheck.stdout.includes(secret)) {
			throw new BrokerSecurityError("GIT_CONFIG_PERSISTENCE_DETECTED", "Secret was persisted to local .git/config");
		}
	}

	const globalEnv = globalConfigPath ? { GIT_CONFIG_GLOBAL: globalConfigPath } : process.env;
	const globalCheck = spawnSync("git", ["config", "--global", "--get-regexp", ".*"], {
		encoding: "utf8",
		timeout: 5000,
		env: globalEnv,
	});
	if (globalCheck.stdout && globalCheck.stdout.includes(secret)) {
		throw new BrokerSecurityError("GIT_CONFIG_PERSISTENCE_DETECTED", "Secret was persisted to global git config");
	}
}

/**
 * Execute Cloudflare CLI token creation with in-memory interception
 */
export function defaultTokenIssuer(namespace, repo, scope = "read", ttlSeconds = 900) {
	const cfPath = process.env.CF_CLI_PATH || "/home/mike/.local/node-v24.11.1-linux-x64/bin/cf";
	const args = [
		"artifacts", "namespaces", "tokens", "create",
		namespace,
		"--repo", repo,
		"--scope", scope,
		"--ttl", String(ttlSeconds)
	];

	const proc = spawnSync(cfPath, args, {
		encoding: "utf8",
		timeout: 15000,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PATH: `/home/mike/.local/node-v24.11.1-linux-x64/bin:/home/mike/.local/bin:${process.env.PATH || ""}`
		}
	});

	if (proc.status !== 0) {
		const cleanErr = (proc.stderr || proc.stdout || "").replace(/[0-9a-zA-Z_-]{20,}/g, "[REDACTED]").trim();
		throw new BrokerSecurityError("CF_TOKEN_ISSUE_FAILED", `cf tokens create failed with status ${proc.status}: ${cleanErr}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(proc.stdout);
	} catch {
		throw new BrokerSecurityError("CF_TOKEN_PARSE_FAILED", "Failed to parse structured JSON from cf tokens create");
	}

	const tokenData = parsed.token || parsed;
	const plaintext = tokenData.plaintext || tokenData.token;
	const id = tokenData.id;

	if (!plaintext || typeof plaintext !== "string" || plaintext.length < 8) {
		throw new BrokerSecurityError("CF_TOKEN_INVALID_RESPONSE", "Response did not contain a valid secret plaintext");
	}
	if (!id || typeof id !== "string") {
		throw new BrokerSecurityError("CF_TOKEN_INVALID_RESPONSE", "Response did not contain a valid token id");
	}

	return { id, plaintext, scope: tokenData.scope || scope };
}

/**
 * Execute Cloudflare CLI token revocation
 */
export function defaultTokenRevoker(id, namespace = "nexus-exp1-oct02") {
	if (!id || typeof id !== "string" || id.trim().length === 0) {
		throw new BrokerSecurityError("CLEANUP_FAILURE_MISSING_ID", "Cannot revoke token without valid token ID");
	}

	const cfPath = process.env.CF_CLI_PATH || "/home/mike/.local/node-v24.11.1-linux-x64/bin/cf";
	const args = [
		"artifacts", "namespaces", "tokens", "revoke",
		id,
		"--namespace", namespace,
		"-f"
	];

	let lastStatus = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		const proc = spawnSync(cfPath, args, {
			encoding: "utf8",
			timeout: 15000,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: `/home/mike/.local/node-v24.11.1-linux-x64/bin:/home/mike/.local/bin:${process.env.PATH || ""}`
			}
		});
		lastStatus = proc.status;
		if (proc.status === 0) {
			return { success: true, id };
		}
		spawnSync("sleep", ["1"]);
	}

	throw new BrokerSecurityError("CLEANUP_FAILURE_NONZERO_EXIT", `cf tokens revoke failed with status ${lastStatus}`);
}

/**
 * Run a scoped task with an ephemeral Artifact credential under fail-closed safety guarantees
 */
export async function withBrokerSession({
	namespace,
	repo,
	scope = "read",
	ttlSeconds = 300,
	workDir = null,
	globalConfigPath = null,
	issuer = defaultTokenIssuer,
	revoker = defaultTokenRevoker,
}, taskFn) {
	let secret = null;
	let tokenId = null;
	let cleanupAttempted = false;
	let cleanupSucceeded = false;
	let cleanupError = null;

	try {
		// 1. Issue token via isolated in-memory capture
		const issued = await issuer(namespace, repo, scope, ttlSeconds);
		if (!issued || !issued.plaintext || !issued.id) {
			throw new BrokerSecurityError("ISSUANCE_FAILED", "Issuer returned invalid credential payload");
		}
		secret = issued.plaintext;
		tokenId = issued.id;

		// 2. Prepare isolated environment with HTTP header Bearer token
		const header = `Authorization: Bearer ${secret}`;
		const gitEnv = {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: header,
		};
		if (globalConfigPath) {
			gitEnv.GIT_CONFIG_GLOBAL = globalConfigPath;
		}

		// 3. Define safe execution helper
		const safeRunGit = (args, runOptions = {}) => {
			inspectArgvForSecret(args, secret);

			const mergedEnv = { ...gitEnv, ...(runOptions.env || {}) };
			const proc = spawnSync("git", args, {
				encoding: "utf8",
				timeout: runOptions.timeout || 15000,
				cwd: runOptions.cwd || workDir || process.cwd(),
				env: mergedEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const stdout = proc.stdout || "";
			const stderr = proc.stderr || "";

			if (stdout.includes(secret)) {
				throw new BrokerSecurityError("STDOUT_LEAK_DETECTED", "Child git process emitted secret to stdout");
			}
			if (stderr.includes(secret)) {
				throw new BrokerSecurityError("STDERR_LEAK_DETECTED", "Child git process emitted secret to stderr");
			}

			if (args.includes("config") || args.includes("remote")) {
				auditGitPersistence(runOptions.cwd || workDir, secret, globalConfigPath);
			}

			return {
				status: proc.status,
				signal: proc.signal,
				stdout,
				stderr,
			};
		};

		// 4. Run user task
		const session = {
			tokenId,
			scope: issued.scope,
			runGit: safeRunGit,
			auditPersistence: () => {
				auditGitPersistence(workDir, secret, globalConfigPath);
			},
			auditFilesystem: async (dirToScan) => {
				const leaked = await containsSecretInDir(dirToScan || workDir, secret);
				if (leaked) {
					throw new BrokerSecurityError("FILE_PERSISTENCE_DETECTED", "Secret was persisted to filesystem");
				}
			},
		};

		const result = await taskFn(session);

		if (workDir) {
			auditGitPersistence(workDir, secret, globalConfigPath);
			const fileLeaked = await containsSecretInDir(workDir, secret);
			if (fileLeaked) {
				throw new BrokerSecurityError("FILE_PERSISTENCE_DETECTED", "Secret was persisted to working directory");
			}
		}

		return {
			success: true,
			result,
			tokenId,
		};

	} finally {
		if (tokenId) {
			cleanupAttempted = true;
			try {
				const revResult = await revoker(tokenId, namespace);
				if (revResult && (revResult.success || revResult.status === 0)) {
					cleanupSucceeded = true;
				} else {
					cleanupSucceeded = false;
					cleanupError = new BrokerSecurityError("CLEANUP_FAILED", "Revoker did not confirm successful revocation");
				}
			} catch (err) {
				cleanupSucceeded = false;
				cleanupError = err;
			}

			secret = null;

			if (!cleanupSucceeded) {
				throw (cleanupError || new BrokerSecurityError("CLEANUP_FAILED", "Revocation failed"));
			}
		} else {
			secret = null;
		}
	}
}
