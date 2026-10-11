import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { closeBoundExecutable, executeBoundExecutable, openTrustedExecutable } from "./linux-bound-exec.mjs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const benignSource = '#include <stdio.h>\nint main(void){puts("APPROVED_OBJECT_EXECUTED");return 0;}\n';
const replacementSource = '#include <stdio.h>\nint main(void){puts("UNVALIDATED_REPLACEMENT_EXECUTED");return 0;}\n';

async function main() {
	const root = await mkdtemp(path.join(os.tmpdir(), "nexus-bound-exec-test-"));
	let bound = null;
	try {
		const benignC = path.join(root, "approved.c");
		const replacementC = path.join(root, "replacement.c");
		const executable = path.join(root, "git-fixture");
		const replacement = path.join(root, "replacement");
		await writeFile(benignC, benignSource, { mode: 0o600 });
		await writeFile(replacementC, replacementSource, { mode: 0o600 });
		const buildA = spawnSync("/usr/bin/gcc", ["-O2", "-o", executable, benignC], { encoding: "utf8", timeout: 15000 });
		const buildB = spawnSync("/usr/bin/gcc", ["-O2", "-o", replacement, replacementC], { encoding: "utf8", timeout: 15000 });
		if (buildA.status !== 0 || buildB.status !== 0) throw new Error("fixture compile failed");
		await chmod(executable, 0o755);
		await chmod(replacement, 0o755);
		const fixtureBytes = await readFile(executable);
		const expectedSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
		bound = openTrustedExecutable(executable, { expectedUid: process.getuid(), expectedSha256 });
		await rename(replacement, executable);
		const oldDesign = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
		const descriptorDesign = executeBoundExecutable(bound, [], { timeout: 5000 });
		const oldRanReplacement = oldDesign.status === 0 && oldDesign.stdout.includes("UNVALIDATED_REPLACEMENT_EXECUTED");
		const boundRanApproved = descriptorDesign.status === 0 && descriptorDesign.stdout.includes("APPROVED_OBJECT_EXECUTED");
		const boundRejectedReplacement = !descriptorDesign.stdout.includes("UNVALIDATED_REPLACEMENT_EXECUTED");
		let digestMismatchRejected = false;
		try { const wrong = openTrustedExecutable(executable, { expectedUid: process.getuid(), expectedSha256: "0".repeat(64) }); closeBoundExecutable(wrong); } catch { digestMismatchRejected = true; }
		const linkPath = path.join(root, "approved-link");
		await symlink(executable, linkPath);
		let symlinkRejected = false;
		try { const link = openTrustedExecutable(linkPath, { expectedUid: process.getuid() }); closeBoundExecutable(link); } catch { symlinkRejected = true; }
		const passed = oldRanReplacement && boundRanApproved && boundRejectedReplacement && digestMismatchRejected && symlinkRejected;
		process.stdout.write(JSON.stringify({ syntheticOnly: true, realGitModified: false, cloudflareOperations: 0, oldDesignRanReplacement: oldRanReplacement, descriptorDesignRanApprovedObject: boundRanApproved, descriptorDesignRejectedReplacement: boundRejectedReplacement, digestMismatchRejected, symlinkRejected, boundIdentity: bound.identity, passed }) + "\n");
		if (!passed) process.exitCode = 1;
	} catch {
		process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: false, failureDetailsSuppressed: true }) + "\n");
		process.exitCode = 1;
	} finally {
		closeBoundExecutable(bound);
		await rm(root, { recursive: true, force: true });
	}
}

main().catch(() => {
	process.stdout.write(JSON.stringify({ syntheticOnly: true, passed: false, failureDetailsSuppressed: true }) + "\n");
	process.exitCode = 1;
});
