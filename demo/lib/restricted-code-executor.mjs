import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTOR_UID = 65534;
const EXECUTOR_GID = 65534;
const SKIP_NAMES = new Set([".git", "node_modules", "dist", ".agent"]);
const FIXED_ENV_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"];
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = `const fs=require('node:fs');const groups=process.getgroups().sort((a,b)=>a-b);const status=fs.readFileSync('/proc/self/status','utf8');const caps=status.match(/^CapEff:\\s+([0-9a-f]+)$/m)?.[1]??null;const socket=(p)=>{try{fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK);return true}catch{return false}};process.stdout.write(JSON.stringify({uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),egid:process.getegid(),groups,caps,dockerSocket:socket('/var/run/docker.sock'),lxdSockets:['/var/lib/lxd/unix.socket','/var/snap/lxd/common/lxd/unix.socket'].filter(socket),envKeys:Object.keys(process.env).sort()}));`;

function assertTrustedExecutable(filePath) {
	const resolved = realpathSync(filePath);
	const info = lstatSync(resolved);
	if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("GENERATED_EXECUTOR_TOOLCHAIN_INVALID");
	return resolved;
}

function copyTreeWithoutLinks(source, destination) {
	const sourceInfo = lstatSync(source);
	if (sourceInfo.isSymbolicLink()) throw new Error("GENERATED_EXECUTOR_INPUT_SYMLINK_REJECTED");
	if (sourceInfo.isDirectory()) {
		mkdirSync(destination, { mode: 0o755 });
		for (const entry of readdirSync(source, { withFileTypes: true })) {
			if (SKIP_NAMES.has(entry.name)) continue;
			copyTreeWithoutLinks(path.join(source, entry.name), path.join(destination, entry.name));
		}
		chmodSync(destination, 0o555);
		return;
	}
	if (!sourceInfo.isFile()) throw new Error("GENERATED_EXECUTOR_INPUT_TYPE_REJECTED");
	cpSync(source, destination, {});
	chmodSync(destination, 0o444);
}

function packageRootFromTsc(tscPath) {
	const resolved = realpathSync(tscPath);
	if (!path.isAbsolute(resolved) || path.basename(resolved) !== "tsc") throw new Error("GENERATED_EXECUTOR_TOOLCHAIN_INVALID");
	const packageRoot = path.dirname(path.dirname(resolved));
	if (path.basename(packageRoot) !== "typescript") throw new Error("GENERATED_EXECUTOR_TOOLCHAIN_INVALID");
	return packageRoot;
}

function defaultTscPath() {
	const candidate = path.resolve(MODULE_DIR, "..", "node_modules", "typescript", "bin", "tsc");
	if (existsSync(candidate)) return candidate;
	throw new Error("GENERATED_EXECUTOR_TOOLCHAIN_REQUIRED");
}

function spawnRestricted({ setprivPath, nodePath, tempPath, cwd, args, timeoutMs, maxBuffer }) {
	const childEnv = {
		PATH: "/usr/bin:/bin",
		HOME: "/nonexistent",
		LANG: "C.UTF-8",
		LC_ALL: "C",
		TMPDIR: tempPath,
	};
	const result = spawnSync("/usr/bin/sudo", [
		"-n", setprivPath,
		"--reuid=65534", "--regid=65534", "--clear-groups",
		"--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
		"--no-new-privs", "--", "/usr/bin/env", "-i",
		...FIXED_ENV_KEYS.map((key) => `${key}=${childEnv[key]}`),
		nodePath, ...args,
	], {
		cwd,
		env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" },
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer,
	});
	return result;
}

function verifyExecutor(result) {
	if (result.error || result.status !== 0) throw new Error("GENERATED_EXECUTOR_IDENTITY_PROBE_FAILED");
	let identity;
	try { identity = JSON.parse(result.stdout); } catch { throw new Error("GENERATED_EXECUTOR_IDENTITY_PROBE_FAILED"); }
	const expectedGroups = [EXECUTOR_GID];
	if (identity.uid !== EXECUTOR_UID || identity.euid !== EXECUTOR_UID || identity.gid !== EXECUTOR_GID || identity.egid !== EXECUTOR_GID) {
		throw new Error("GENERATED_EXECUTOR_IDENTITY_MISMATCH");
	}
	if (JSON.stringify(identity.groups) !== JSON.stringify(expectedGroups)) throw new Error("GENERATED_EXECUTOR_GROUPS_UNSAFE");
	if (!identity.caps || !/^0+$/.test(identity.caps)) throw new Error("GENERATED_EXECUTOR_CAPABILITIES_UNSAFE");
	if (identity.dockerSocket || identity.lxdSockets.length > 0) throw new Error("GENERATED_EXECUTOR_PRIVILEGED_SOCKET_ACCESS");
	if (JSON.stringify(identity.envKeys) !== JSON.stringify([...FIXED_ENV_KEYS].sort())) throw new Error("GENERATED_EXECUTOR_ENVIRONMENT_UNSAFE");
	return identity;
}

export class RestrictedCodeExecutor {
	constructor({ tscPath = defaultTscPath(), nodePath = "/usr/bin/node", tempDirectory = os.tmpdir() } = {}) {
		if (!tscPath || !path.isAbsolute(tscPath)) throw new Error("GENERATED_EXECUTOR_TOOLCHAIN_REQUIRED");
		this.tscPath = realpathSync(tscPath);
		this.nodePath = assertTrustedExecutable(nodePath);
		this.setprivPath = assertTrustedExecutable("/usr/bin/setpriv");
		this.sudoPath = assertTrustedExecutable("/usr/bin/sudo");
		this.typescriptRoot = packageRootFromTsc(this.tscPath);
		this.tempDirectory = tempDirectory;
	}

	validateProject(sourceDirectory, testRelativePath, { requiredOutput = "", overlayFiles = [] } = {}) {
		if (typeof testRelativePath !== "string" || !/^dist\/test\/[A-Za-z0-9._-]+\.js$/.test(testRelativePath)) {
			throw new Error("GENERATED_EXECUTOR_TEST_PATH_REJECTED");
		}
		const overlayPaths = new Set(["src/customer-store.ts", "test/store.test.ts"]);
		if (!Array.isArray(overlayFiles) || overlayFiles.some((entry) => !overlayPaths.has(entry?.path) || typeof entry.contents !== "string" || Buffer.byteLength(entry.contents) > 128 * 1024)) {
			throw new Error("GENERATED_EXECUTOR_OVERLAY_REJECTED");
		}
		const input = realpathSync(sourceDirectory);
		if (!lstatSync(input).isDirectory()) throw new Error("GENERATED_EXECUTOR_INPUT_INVALID");
		const stage = mkdtempSync(path.join(this.tempDirectory, "nexus-generated-validation-"));
		const project = path.join(stage, "project");
		const toolchain = path.join(stage, "toolchain", "typescript");
		const output = path.join(project, "dist");
		const temp = path.join(stage, "tmp");
		try {
			copyTreeWithoutLinks(input, project);
			chmodSync(project, 0o755);
			for (const entry of overlayFiles) {
				const sourcePath = path.join(project, entry.path);
				const sourceInfo = lstatSync(sourcePath);
				if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("GENERATED_EXECUTOR_OVERLAY_REJECTED");
				const sourceDirectory = path.dirname(sourcePath);
				chmodSync(sourceDirectory, 0o755);
				chmodSync(sourcePath, 0o644);
				writeFileSync(sourcePath, entry.contents, { mode: 0o444 });
				chmodSync(sourcePath, 0o444);
				chmodSync(sourceDirectory, 0o555);
			}
			mkdirSync(output, { mode: 0o700 });
			chmodSync(project, 0o555);
			mkdirSync(path.dirname(toolchain), { recursive: true, mode: 0o755 });
			copyTreeWithoutLinks(this.typescriptRoot, toolchain);
			mkdirSync(temp, { mode: 0o700 });
			chmodSync(stage, 0o755);
			const ownership = spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/chown", `${EXECUTOR_UID}:${EXECUTOR_GID}`, "--", output, temp], {
				env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" },
				encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
			});
			if (ownership.error || ownership.status !== 0) throw new Error("GENERATED_EXECUTOR_WORKSPACE_SETUP_FAILED");
			const identityResult = spawnRestricted({
				setprivPath: this.setprivPath, nodePath: this.nodePath, tempPath: temp, cwd: project,
				args: ["-e", PROBE], timeoutMs: 5000, maxBuffer: 64 * 1024,
			});
			const identity = verifyExecutor(identityResult);
			const compiler = path.join(toolchain, "bin", "tsc");
			const compile = spawnRestricted({
				setprivPath: this.setprivPath, nodePath: this.nodePath, tempPath: temp, cwd: project,
				args: [compiler, "-p", path.join(project, "tsconfig.json"), "--pretty", "false"],
				timeoutMs: 30000, maxBuffer: 1024 * 1024,
			});
			if (compile.error || compile.status !== 0) {
				const diagnosticText = `${compile.stdout ?? ""}\n${compile.stderr ?? ""}`;
				const diagnosticCodes = [...new Set(diagnosticText.match(/\bTS\d{4,5}\b/g) ?? [])].slice(0, 16);
				return { ok: false, phase: "typescript", exitCode: compile.status ?? null, diagnosticCodes, identity };
			}
			const testPath = path.resolve(project, testRelativePath);
			if (!testPath.startsWith(`${output}${path.sep}`)) {
				return { ok: false, phase: "test-artifact", exitCode: null, identity };
			}
			const test = spawnRestricted({
				setprivPath: this.setprivPath, nodePath: this.nodePath, tempPath: temp, cwd: project,
				args: [testPath], timeoutMs: 30000, maxBuffer: 1024 * 1024,
			});
			const outputText = `${test.stdout ?? ""}\n${test.stderr ?? ""}`;
			return {
				ok: !test.error && test.status === 0 && (!requiredOutput || String(test.stdout).includes(requiredOutput)),
				phase: "complete",
				exitCode: test.status ?? null,
				outputMatched: !requiredOutput || String(test.stdout).includes(requiredOutput),
				outputBytes: Buffer.byteLength(outputText),
				identity,
			};
		} catch (error) {
			const candidate = error?.message ?? error?.code ?? "";
			return { ok: false, phase: "executor", errorCode: /^[A-Z0-9_]+$/.test(candidate) ? candidate : "GENERATED_EXECUTOR_FAILED" };
		} finally {
			const cleanup = spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/rm", "-rf", "--", stage], {
				env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" },
				encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024,
			});
			if (cleanup.error || cleanup.status !== 0) throw new Error("GENERATED_EXECUTOR_CLEANUP_FAILED");
		}
	}
}
