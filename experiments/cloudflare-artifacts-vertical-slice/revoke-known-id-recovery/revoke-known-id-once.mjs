import { closeBoundExecutable, executeBoundExecutable, openTrustedExecutable } from "/opt/nexus-cloudflare-broker/broker/linux-bound-exec.mjs";
import { classifyRevokeResult } from "./classify-revoke-result.mjs";

const expectedId = "woh2sni4v09aj9hw";
const namespace = "nexus-exp1-oct02";
const node = "/opt/nexus-cloudflare-broker/runtime/node";
const cfEntry = "/opt/nexus-cloudflare-broker/cf-runtime/node_modules/cf/bin/cf";
const env = Object.freeze({
	PATH: "/usr/bin:/bin",
	HOME: "/home/mike",
	XDG_CONFIG_HOME: "/home/mike/.config",
	LANG: "C.UTF-8",
	NO_COLOR: "1",
	CF_NO_OSC_PROGRESS: "1",
});

function emit(fields, exitCode = 1) {
	process.stdout.write(JSON.stringify({
		operation: "revoke-known-artifact-token-id",
		tokenId: expectedId,
		createCommandInvocations: 0,
		listCommandInvocations: 0,
		revokeCommandInvocations: fields.revokeCommandInvocations ?? 0,
		...fields,
	}) + "\n");
	process.exitCode = exitCode;
}

if (process.getuid?.() !== 0 || process.cwd() !== "/" || process.argv.length !== 2 ||
	JSON.stringify(Object.keys(process.env).sort()) !== JSON.stringify(Object.keys(env).sort()) ||
	Object.entries(env).some(([key, value]) => process.env[key] !== value)) {
	emit({ classification: "LOCAL_BOUNDARY_PRECONDITION_FAILED", revokeCalls: 0 });
} else {
	const attemptedAt = new Date().toISOString();
	let bound = null;
	let result;
	let revokeCommandInvocations = 0;
	try {
		bound = openTrustedExecutable(node, { expectedUid: 0 });
		revokeCommandInvocations = 1;
		result = executeBoundExecutable(bound, [cfEntry, "artifacts", "namespaces", "tokens", "revoke", expectedId, "--namespace", namespace, "-f"], {
			cwd: "/",
			env,
			timeout: 15000,
			maxBuffer: 256 * 1024,
		});
	} catch (error) {
		result = { status: null, error: { code: typeof error?.code === "string" ? error.code : "EXECUTION_ERROR" }, stdout: "", stderr: "" };
	} finally {
		if (bound) closeBoundExecutable(bound);
	}
	const classified = classifyRevokeResult(result, expectedId);
	const acknowledged = classified.classification === "ACKNOWLEDGED_EXACT_ID";
	result.stdout = "";
	result.stderr = "";
	emit({
		revokeCommandInvocations,
		attemptedAt,
		providerRequestSubmission: "UNKNOWN_UNLESS_RESPONSE_RECEIVED",
		...classified,
		historicalRevocationProven: false,
		providerReportedAbsentNow: classified.providerObjectReportedAbsent,
		rawProviderOutputEmitted: false,
	}, acknowledged ? 0 : 1);
}
