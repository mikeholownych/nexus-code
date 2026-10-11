import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const secret = process.env.SYNTHETIC_CREDENTIAL;
const root = process.env.BROKER_SCRATCH;
const mode = process.env.BROKER_FAULT ?? "none";
if (!secret || !root) process.exit(90);
delete process.env.SYNTHETIC_CREDENTIAL;
const repo = path.join(root, "repo");
const envFile = path.join(root, "persisted-env");
const evidence = path.join(root, "evidence.json");
const normalRemote = "https://example.invalid/repo.git";
const run = (command, args, env) => spawnSync(command, args, { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, cwd: root, env });
const gitEnv = {
	PATH: process.env.PATH,
	HOME: root,
	LANG: "C",
	GIT_CONFIG_GLOBAL: path.join(root, "global.gitconfig"),
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
};

let cleanupOk = true;
let gitOk = false;
try {
	await mkdir(repo, { recursive: true });
	const init = run("git", ["init", "--quiet", repo], gitEnv);
	if (init.status !== 0) throw Object.assign(new Error("git-init-failed"), { diagnostic: `git-init-${init.status}` });
	const remoteAdd = run("git", ["-C", repo, "remote", "add", "origin", normalRemote], gitEnv);
	if (remoteAdd.status !== 0) throw Object.assign(new Error("remote-add-failed"), { diagnostic: `remote-add-${remoteAdd.status}-stderr-${remoteAdd.stderr?.length ?? 0}` });
	if (mode === "environmentPersistence") process.env.LEAKED_CREDENTIAL = secret;
	if (["stdout", "stderr", "argv", "tokenOnlyArgv"].includes(mode)) {
		const args = ["-e", "const c=require('node:crypto');const t=process.env.SYNTHETIC_CREDENTIAL??'';const a=process.argv.join(' ');process.stdout.write(JSON.stringify({used:c.createHash('sha256').update(t).digest('hex')===process.env.EXPECTED_SHA,argvLeaked:a.includes(t)}));", ...(mode === "argv" ? ["--", `--header=${secret}`] : mode === "tokenOnlyArgv" ? [secret] : [])];
		const child = run(process.execPath, args, { ...gitEnv, SYNTHETIC_CREDENTIAL: secret, EXPECTED_SHA: process.env.EXPECTED_SHA });
		if (child.status !== 0 || !JSON.parse(child.stdout).used) process.exitCode = 91;
		gitOk = child.status === 0;
		if (mode === "stdout") process.stdout.write(secret);
		if (mode === "stderr") process.stderr.write(secret);
		if (mode === "argv" || mode === "tokenOnlyArgv") process.stdout.write(JSON.stringify({ argvLeakObserved: JSON.parse(child.stdout).argvLeaked }));
	} else {
		const child = run(process.execPath, ["-e", "const c=require('node:crypto');const t=process.env.SYNTHETIC_CREDENTIAL??'';process.stdout.write(JSON.stringify({used:c.createHash('sha256').update(t).digest('hex')===process.env.EXPECTED_SHA,argvLeaked:process.argv.includes(t)}));"], { ...gitEnv, SYNTHETIC_CREDENTIAL: secret, EXPECTED_SHA: process.env.EXPECTED_SHA });
		gitOk = child.status === 0 && JSON.parse(child.stdout).used;
		if (!gitOk) process.exitCode = 92;
	}
	if (mode === "environmentFile") await writeFile(envFile, secret);
	if (mode === "temporaryFile") await writeFile(path.join(root, "secret.tmp"), secret);
	if (mode === "evidenceFile") await writeFile(evidence, JSON.stringify({ credential: secret }));
	if (mode === "filename") await writeFile(path.join(root, secret), "synthetic fixture");
	if (mode === "symlinkTarget") await symlink(secret, path.join(root, "secret-link"));
	if (mode === "remoteUrl" && run("git", ["-C", repo, "remote", "set-url", "origin", `https://${secret}@example.invalid/repo.git`], gitEnv).status !== 0) throw new Error("remote-fault-injection-failed");
	if (mode === "localGitConfig" && run("git", ["-C", repo, "config", "--local", "http.extraHeader", secret], gitEnv).status !== 0) throw new Error("local-config-fault-injection-failed");
	if (mode === "globalGitConfig" && run("git", ["config", "--global", "http.extraHeader", secret], gitEnv).status !== 0) throw new Error("global-config-fault-injection-failed");
	if (mode === "cleanupFailure") {
		const blocked = path.join(root, "blocked-cleanup");
		await mkdir(blocked);
		await writeFile(path.join(blocked, "secret"), secret);
		try { await rm(blocked); } catch { cleanupOk = false; }
	}
	if (mode === "abnormalTermination") {
		await writeFile(path.join(root, "crash-residue"), secret);
		process.kill(process.pid, "SIGKILL");
	}
	if (!cleanupOk) {
		process.exitCode = 93;
	} else {
		const environmentContainsCredential = Object.values(process.env).some((value) => value === secret);
		if (mode !== "environmentPersistence") delete process.env.LEAKED_CREDENTIAL;
		if (mode !== "temporaryFile") await rm(path.join(root, "secret.tmp"), { force: true });
		if (mode !== "evidenceFile") await rm(evidence, { force: true });
		if (mode !== "environmentFile") await rm(envFile, { force: true });
		process.stdout.write(JSON.stringify({ gitOk, cleanupOk, environmentContainsCredential }));
	}
	} catch (error) {
	cleanupOk = false;
	process.stderr.write(JSON.stringify({ helperFailure: error?.name ?? "Error", diagnostic: /^[a-z0-9_-]+$/.test(error?.diagnostic ?? "") ? error.diagnostic : "UNCLASSIFIED" }));
	process.exitCode = 94;
} finally {
	if (mode !== "abnormalTermination" && mode !== "cleanupFailure") {
		delete process.env.SYNTHETIC_CREDENTIAL;
		delete process.env.LEAKED_CREDENTIAL;
	}
}
