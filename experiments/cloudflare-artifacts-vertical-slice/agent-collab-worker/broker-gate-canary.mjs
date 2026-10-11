import { lstat, mkdtemp, readFile, readlink, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

// Synthetic-only process-boundary test. It never invokes cf or contacts Cloudflare.
const secret = `synthetic-${randomBytes(32).toString("hex")}`;
const helper = new URL("./broker-gate-helper.mjs", import.meta.url);
const expectedSha = createHash("sha256").update(secret).digest("hex");
const modes = ["stdout", "stderr", "argv", "tokenOnlyArgv", "helperArgv", "helperTokenOnlyArgv", "environmentPersistence", "environmentFile", "remoteUrl", "localGitConfig", "globalGitConfig", "temporaryFile", "evidenceFile", "filename", "symlinkTarget", "cleanupFailure", "abnormalTermination"];
const baseEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_SYSTEM: "/dev/null" };
const run = (args, env) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, env });
async function fileContents(dir, into = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		into.push(file);
		if (entry.isDirectory()) await fileContents(file, into);
		else if (entry.isFile()) into.push(await readFile(file, "utf8"));
		else if (entry.isSymbolicLink()) into.push(await readlink(file));
	}
	return into;
}
function hasSecret(value) { return typeof value === "string" && value.includes(secret); }
const results = {};
let baselineOk = false;
let parentCleanupVerified = true;
try {
	for (const mode of ["none", ...modes]) {
		const scratch = await mkdtemp(path.join(os.tmpdir(), "cf-broker-case-"));
		const helperArgs = [helper.pathname];
		if (mode === "helperArgv") helperArgs.push("--credential", secret);
		if (mode === "helperTokenOnlyArgv") helperArgs.push(secret);
		const proc = run(helperArgs, { ...baseEnv, BROKER_SCRATCH: scratch, BROKER_FAULT: mode, SYNTHETIC_CREDENTIAL: secret, EXPECTED_SHA: expectedSha });
		const disk = await fileContents(scratch);
		const argvSeen = proc.error?.message ?? "";
		const outputLeaked = hasSecret(proc.stdout) || hasSecret(proc.stderr);
		let childReportsArgvLeak = /\"(?:argvLeakObserved|argvLeaked)\":true/.test(proc.stdout ?? "");
		for (const line of (proc.stdout ?? "").split("\n")) try { const parsed = JSON.parse(line); childReportsArgvLeak ||= parsed.argvLeakObserved === true || parsed.argvLeaked === true; } catch { /* output may intentionally leak */ }
		const argvLeaked = hasSecret(argvSeen) || helperArgs.some(hasSecret) || childReportsArgvLeak;
		const fileLeaked = disk.some(hasSecret);
		const envLeaked = Object.values(process.env).some(hasSecret);
		const abnormal = proc.signal === "SIGKILL" || proc.status === 137;
		const cleanupObserved = proc.status === 0 && !fileLeaked;
		let childUsedCredential = /\"(?:gitOk|used)\":true/.test(proc.stdout ?? "");
		let helperEnvironmentLeak = /\"environmentContainsCredential\":true/.test(proc.stdout ?? "");
		const injectedLeakObserved = mode === "stdout" || mode === "stderr" ? outputLeaked
			: ["argv", "tokenOnlyArgv", "helperArgv", "helperTokenOnlyArgv"].includes(mode) ? argvLeaked
			: mode === "environmentPersistence" ? helperEnvironmentLeak
			: ["cleanupFailure", "abnormalTermination"].includes(mode) ? fileLeaked
			: ["environmentFile", "remoteUrl", "localGitConfig", "globalGitConfig", "temporaryFile", "evidenceFile", "filename", "symlinkTarget"].includes(mode) ? fileLeaked
			: false;
		const detected = mode === "cleanupFailure" ? fileLeaked && proc.status !== 0
			: mode === "abnormalTermination" ? fileLeaked && abnormal
			: injectedLeakObserved;
		if (mode === "none") baselineOk = proc.status === 0 && childUsedCredential && !outputLeaked && !argvLeaked && !fileLeaked && !envLeaked && !helperEnvironmentLeak;
		else results[mode] = detected;
		// Parent owns crash cleanup and verifies scratch is absent after removal.
		await rm(scratch, { recursive: true, force: true });
		try { await readdir(scratch); parentCleanupVerified = false; } catch (error) { if (error?.code !== "ENOENT") parentCleanupVerified = false; }
		if (!cleanupObserved && mode === "none") baselineOk = false;
	}
	const allDetected = modes.every((mode) => results[mode] === true);
	const output = { syntheticOnly: true, baselineClean: baselineOk, childHandoffVerified: baselineOk, negativeControlsDetected: results, allNegativeControlsDetected: allDetected, parentCleanupVerified };
	process.stdout.write(`${JSON.stringify(output)}\n`);
	if (!baselineOk || !allDetected || !parentCleanupVerified) process.exitCode = 1;
} catch (error) {
	process.stdout.write(JSON.stringify({ syntheticOnly: true, failed: true, errorClass: error?.name ?? "Error" }) + "\n");
	process.exitCode = 1;
}
