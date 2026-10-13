import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RestrictedCodeExecutor } from "../lib/restricted-code-executor.mjs";

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "nexus-executor-regression-"));
const canaryDirectory = mkdtempSync(path.join(os.tmpdir(), "nexus-root-canary-"));
const canaryPath = path.join(canaryDirectory, "synthetic-capability.canary");
const canary = `NEXUS_SYNTHETIC_PRIVILEGE_BOUNDARY_CANARY_${randomUUID()}`;
const project = path.join(tempRoot, "project");

function command(file, args, input) {
	const result = spawnSync(file, args, {
		input,
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 64 * 1024,
		env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C" },
	});
	assert.ifError(result.error);
	return result;
}

try {
	const owner = command("/usr/bin/sudo", ["-n", "/usr/bin/chown", "0:0", canaryDirectory]);
	assert.equal(owner.status, 0, "canary directory becomes root-owned");
	const traversable = command("/usr/bin/sudo", ["-n", "/usr/bin/chmod", "0711", canaryDirectory]);
	assert.equal(traversable.status, 0, "canary directory permits traversal only");
	const created = command("/usr/bin/sudo", ["-n", "/usr/bin/tee", canaryPath], canary);
	assert.equal(created.status, 0, "root-only synthetic canary creation succeeds");
	assert.equal(created.stdout, canary, "synthetic content was written only inside the test harness");
	const secured = command("/usr/bin/sudo", ["-n", "/usr/bin/chmod", "0400", canaryPath]);
	assert.equal(secured.status, 0, "canary file has mode 0400");
	const metadata = command("/usr/bin/sudo", ["-n", "/usr/bin/stat", "-c", "%u:%g:%a", canaryPath]);
	assert.equal(metadata.stdout.trim(), "0:0:400", "canary matches root-owned mode-0400 capability model");

	mkdirSync(path.join(project, "src"), { recursive: true });
	mkdirSync(path.join(project, "test"), { recursive: true });
	writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({
		compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "./dist" },
		include: ["src/**/*", "test/**/*"],
	}));
	writeFileSync(path.join(project, "src", "safe.ts"), "export const value: number = 42;\n");
	const attackTest = `
declare const require: (name: string) => any;
import { value } from "../src/safe.js";
const fs = require("node:fs");
const child = require("node:child_process");
let directRead = false;
try { fs.readFileSync(${JSON.stringify(canaryPath)}); directRead = true; } catch {}
const sudoRead = child.spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/cat", ${JSON.stringify(canaryPath)}], { encoding: "utf8", timeout: 2000 });
const dockerRead = child.spawnSync("/usr/bin/docker", ["run", "--rm", "--pull=never", "--network=none", "--mount", "type=bind,src=${canaryPath},dst=/canary,readonly", "alpine:3.20", "/bin/cat", "/canary"], { encoding: "utf8", timeout: 3000 });
const lxdRead = child.spawnSync("/usr/bin/lxc", ["list", "--format=json"], { encoding: "utf8", timeout: 1500 });
const validRequest = JSON.stringify({ operation: "repo-default" }) + "\\n";
const sudoDenied = !sudoRead || sudoRead.status !== 0;
const dockerDenied = !dockerRead || dockerRead.status !== 0;
const lxdUnavailable = !lxdRead || lxdRead.status !== 0;
if (value !== 42 || directRead || !sudoDenied || !dockerDenied || !lxdUnavailable) throw new Error("restricted executor regression failed");
console.log("RESTRICTED_EXECUTOR_SECURITY_REGRESSION_PASS");
`;
	writeFileSync(path.join(project, "test", "boundary.test.ts"), attackTest);

	const directControllerRead = command("/usr/bin/cat", [canaryPath]);
	assert.notEqual(directControllerRead.status, 0, "controller filesystem permissions deny direct access");

	const executor = new RestrictedCodeExecutor({ tscPath: path.join(demoRoot, "node_modules", "typescript", "bin", "tsc") });
	const result = executor.validateProject(project, "dist/test/boundary.test.js", {
		requiredOutput: "RESTRICTED_EXECUTOR_SECURITY_REGRESSION_PASS",
	});
	assert.equal(result.ok, true, "generated validation code runs while privilege paths are blocked");
	assert.deepEqual(result.identity.groups, [65534]);
	assert.equal(result.identity.uid, 65534);
	assert.equal(result.identity.euid, 65534);
	assert.equal(result.identity.gid, 65534);
	assert.equal(result.identity.egid, 65534);
	assert.equal(result.identity.caps, "0000000000000000");
	assert.equal(result.identity.dockerSocket, false);
	assert.deepEqual(result.identity.lxdSockets, []);
	assert.deepEqual(result.identity.envKeys, ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
	assert.equal(JSON.stringify(result).includes(canary), false, "synthetic canary is absent from controller-visible result");

	const overlayProject = path.join(tempRoot, "overlay-project");
	mkdirSync(path.join(overlayProject, "src"), { recursive: true });
	mkdirSync(path.join(overlayProject, "test"), { recursive: true });
	writeFileSync(path.join(overlayProject, "tsconfig.json"), JSON.stringify({
		compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "./dist" },
		include: ["src/**/*", "test/**/*"],
	}));
	writeFileSync(path.join(overlayProject, "src", "customer-store.ts"), "export interface Customer { status: string }\nexport function readCustomer(): Customer { return { status: 'active' }; }\n");
	writeFileSync(path.join(overlayProject, "src", "consumer.ts"), "import { readCustomer } from './customer-store.js'; export const active = readCustomer().accountState.code === 'ACT';\n");
	writeFileSync(path.join(overlayProject, "test", "overlay.test.ts"), "import { active } from '../src/consumer.js'; if (!active) throw new Error('overlay contract failed'); console.log('OVERLAY_VALIDATION_PASS');\n");
	const staleContract = executor.validateProject(overlayProject, "dist/test/overlay.test.js");
	assert.equal(staleContract.ok, false, "consumer code fails against the stale baseline contract");
	const currentContract = executor.validateProject(overlayProject, "dist/test/overlay.test.js", {
		requiredOutput: "OVERLAY_VALIDATION_PASS",
		overlayFiles: [{ path: "src/customer-store.ts", contents: "export interface Customer { accountState: { code: 'ACT' | 'SUS' } }\nexport function readCustomer(): Customer { return { accountState: { code: 'ACT' } }; }\n" }],
	});
	assert.equal(currentContract.ok, true, "restricted validation copy accepts the exact producer contract overlay");
	assert.throws(() => executor.validateProject(overlayProject, "dist/test/overlay.test.js", { overlayFiles: [{ path: "package.json", contents: "{}" }] }), /GENERATED_EXECUTOR_OVERLAY_REJECTED/);

	assert.equal(createHash("sha256").update(canary).digest("hex").length, 64);

	console.log(JSON.stringify({
		result: "PASS",
		canarySha256: createHash("sha256").update(canary).digest("hex"),
		identity: result.identity,
		typecheckAndGeneratedTest: true,
		staleBaselineRejectedAndProducerOverlayAccepted: true,
		controllerBrokerDiagnostic: true,
		canaryReflected: false,
	}));
} finally {
	const cleanup = command("/usr/bin/sudo", ["-n", "/usr/bin/rm", "-rf", "--", canaryDirectory]);
	assert.equal(cleanup.status, 0, "root-only canary cleanup succeeds");
	assert.equal(existsSync(canaryDirectory), false, "root-only canary directory is removed");
	rmSync(tempRoot, { recursive: true, force: true });
}
