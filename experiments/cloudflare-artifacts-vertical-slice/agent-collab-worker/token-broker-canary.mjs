import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const canary = `synthetic-${randomBytes(32).toString("hex")}`;
const root = await mkdtemp(path.join(os.tmpdir(), "cf-token-broker-canary-"));
const repo = path.join(root, "repo");
const baseEnv = {
	PATH: process.env.PATH,
	HOME: root,
	LANG: "C",
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_GLOBAL: path.join(root, "global-config"),
	GIT_CONFIG_SYSTEM: "/dev/null",
};
const run = (command, args, env = baseEnv) => spawnSync(command, args, {
	encoding: "utf8",
	timeout: 10000,
	maxBuffer: 1024 * 1024,
	cwd: root,
	env,
});
async function containsCanary(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (await containsCanary(file)) return true;
		} else if (entry.isFile()) {
			if ((await readFile(file)).includes(canary)) return true;
		}
	}
	return false;
}

let result;
try {
	const init = run("git", ["init", "--quiet", repo]);
	if (init.status !== 0) throw new Error("temporary Git repository init failed");
	const addRemote = run("git", ["-C", repo, "remote", "add", "origin", "https://example.invalid/repo.git"]);
	if (addRemote.status !== 0) throw new Error("temporary credential-free remote setup failed");

	// Model cf's documented one-time plaintext response. Keep both output streams in memory.
	const issuer = `process.stdout.write(JSON.stringify({id:"synthetic-id",scope:"read",plaintext:process.env.CANARY}));process.stderr.write(process.env.CANARY);`;
	const issued = run(process.execPath, ["-e", issuer], { ...baseEnv, CANARY: canary });
	if (issued.status !== 0) throw new Error("synthetic issuer failed");
	const response = JSON.parse(issued.stdout);
	if (response.scope !== "read" || response.plaintext !== canary) throw new Error("synthetic response validation failed");
	const expectedHeader = `Authorization: Bearer ${response.plaintext}`;

	// Pass authority only in the Git child environment, never argv, a remote URL, or persistent config.
	const gitEnv = {
		...baseEnv,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: expectedHeader,
	};
	const gitArgs = ["config", "--get", "http.extraHeader"];
	const gitConfig = run("git", gitArgs, gitEnv);
	const gitReceivedHeader = gitConfig.status === 0 && gitConfig.stdout.trim() === expectedHeader;
	const expectedDigest = createHash("sha256").update(expectedHeader).digest("hex");
	const childCode = `const c=require("node:crypto");const v=process.env.GIT_CONFIG_VALUE_0??"";const secret=process.env.CANARY??"";const ok=c.createHash("sha256").update(v).digest("hex")===process.env.EXPECTED_SHA;process.stdout.write(JSON.stringify({receivedAndUsed:ok,argvHasSecret:process.argv.some(x=>x.includes(secret))}));if(!ok)process.exit(7);`;
	const child = run(process.execPath, ["-e", childCode], { ...gitEnv, CANARY: response.plaintext, EXPECTED_SHA: expectedDigest });
	const childResult = JSON.parse(child.stdout);

	// Failure output is captured and discarded; cleanup runs in finally.
	let cleanupAttempted = false;
	let cleanedTokenId = null;
	let failedOperationExit = null;
	let failedOutput = "";
	try {
		const failed = run(process.execPath, ["-e", `process.stderr.write(process.env.GIT_CONFIG_VALUE_0);process.exit(23);`], gitEnv);
		failedOperationExit = failed.status;
		failedOutput = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
	} finally {
		const revokeSynthetic = async (id) => { cleanedTokenId = id; };
		await revokeSynthetic(response.id); // Synthetic cleanup hook; no Cloudflare token is created or revoked.
		cleanupAttempted = cleanedTokenId === response.id;
	}

	// Malformed issuer output containing the canary must fail closed without forwarding it.
	const malformed = run(process.execPath, ["-e", `process.stdout.write("not-json "+process.env.CANARY);process.stderr.write(process.env.CANARY);process.exit(2);`], { ...baseEnv, CANARY: canary });
	let malformedRejected = false;
	try { JSON.parse(malformed.stdout); } catch { malformedRejected = true; }

	const localConfig = run("git", ["-C", repo, "config", "--local", "--get-regexp", "^http\\..*extraheader$"]);
	const globalConfig = run("git", ["config", "--global", "--get-regexp", "^http\\..*extraheader$"]);
	const remote = run("git", ["-C", repo, "remote", "get-url", "origin"]);
	const fileLeak = await containsCanary(root);
	const visible = JSON.stringify({ childResult, failedOperationExit, cleanupAttempted, malformedRejected });
	result = {
		syntheticOnly: true,
		issuerStdoutCapturedNotForwarded: issued.stdout.includes(canary) && !visible.includes(canary),
		issuerStderrCapturedNotForwarded: issued.stderr.includes(canary) && !visible.includes(canary),
		gitReceivedAndUsedHeader: gitReceivedHeader && childResult.receivedAndUsed,
		secretAbsentFromChildArgv: !childResult.argvHasSecret,
		secretAbsentFromGitArgv: !gitArgs.some((arg) => arg.includes(response.plaintext)),
		localAndGlobalGitConfigClean: localConfig.status === 1 && globalConfig.status === 1,
		remoteUrlCredentialFree: remote.status === 0 && remote.stdout.trim() === "https://example.invalid/repo.git",
		generatedFilesContainCanary: fileLeak,
		successOutputContainsCanary: visible.includes(canary),
		failureOutputForwarded: false,
		failureExitObserved: failedOperationExit === 23,
		syntheticCleanupHookRan: cleanupAttempted,
		malformedIssuerRejected: malformedRejected && malformed.status === 2 && malformed.stdout.includes(canary),
		malformedOutputForwarded: false,
	};
	const emitted = JSON.stringify({ ...result, scratchRemoved: true });
	result.successOutputContainsCanary = emitted.includes(response.plaintext);
	result.failureOutputForwarded = emitted.includes(failedOutput);
	result.malformedOutputForwarded = emitted.includes(malformed.stdout) || emitted.includes(malformed.stderr);
} finally {
	await rm(root, { recursive: true, force: true });
}
const failedChecks = [
	!result.issuerStdoutCapturedNotForwarded,
	!result.issuerStderrCapturedNotForwarded,
	!result.gitReceivedAndUsedHeader,
	!result.secretAbsentFromChildArgv,
	!result.secretAbsentFromGitArgv,
	!result.localAndGlobalGitConfigClean,
	!result.remoteUrlCredentialFree,
	result.generatedFilesContainCanary,
	result.successOutputContainsCanary,
	result.failureOutputForwarded,
	!result.failureExitObserved,
	!result.syntheticCleanupHookRan,
	!result.malformedIssuerRejected,
	result.malformedOutputForwarded,
];
const provisionalOutput = `${JSON.stringify({ ...result, scratchRemoved: true, failedCheckCount: failedChecks.filter(Boolean).length })}\n`;
const finalOutputContainsCanary = provisionalOutput.includes(canary);
if (failedChecks.some(Boolean) || finalOutputContainsCanary) process.exitCode = 1;
const finalOutput = `${JSON.stringify({ ...result, finalOutputContainsCanary, scratchRemoved: true, failedCheckCount: failedChecks.filter(Boolean).length + Number(finalOutputContainsCanary) })}\n`;
process.stdout.write(finalOutput);
