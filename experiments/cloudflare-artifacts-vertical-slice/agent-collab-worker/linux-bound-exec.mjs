import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";

export function openTrustedExecutable(executablePath, policy) {
	if (process.platform !== "linux" || !pathIsAbsolute(executablePath)) throw new Error("unsupported executable path");
	const pathStat = lstatSync(executablePath);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("executable must be a regular non-symlink file");
	const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
	const fd = openSync(executablePath, flags);
	try {
		const opened = fstatSync(fd);
		const parent = statSync(pathDirectory(executablePath));
		if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) throw new Error("executable changed while opening");
		if (opened.dev !== parent.dev) throw new Error("executable filesystem differs from parent directory");
		if (opened.uid !== policy.expectedUid) throw new Error("executable owner is not trusted");
		if ((opened.mode & 0o022) !== 0) throw new Error("executable is group or world writable");
		if ((opened.mode & 0o111) === 0) throw new Error("file is not executable");
		if (policy.expectedSha256 && hashFd(fd) !== policy.expectedSha256) throw new Error("executable digest is not approved");
		return { fd, identity: { dev: opened.dev, ino: opened.ino, uid: opened.uid, mode: opened.mode & 0o777, size: opened.size, sha256: hashFd(fd) } };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

export function executeBoundExecutable(bound, args, options = {}) {
	if (!Number.isInteger(bound?.fd) || bound.fd < 0) throw new Error("bound executable descriptor is required");
	const result = spawnSync("/proc/self/fd/3", args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		timeout: options.timeout ?? 15000,
		maxBuffer: options.maxBuffer ?? 256 * 1024,
		stdio: ["ignore", "pipe", "pipe", bound.fd],
	});
	return result;
}

export function closeBoundExecutable(bound) {
	if (Number.isInteger(bound?.fd) && bound.fd >= 0) {
		closeSync(bound.fd);
		bound.fd = -1;
	}
}

function hashFd(fd) {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	for (let offset = 0; offset < fstatSync(fd).size;) {
		const bytes = readSync(fd, buffer, 0, buffer.length, offset);
		if (bytes === 0) throw new Error("short read while hashing executable");
		hash.update(buffer.subarray(0, bytes));
		offset += bytes;
	}
	return hash.digest("hex");
}

function pathIsAbsolute(value) {
	return typeof value === "string" && value.startsWith("/");
}

function pathDirectory(value) {
	const index = value.lastIndexOf("/");
	return index === 0 ? "/" : value.slice(0, index);
}
