import { classifyPostRevokeGit, classifyRevokeResponse } from "./artifact-token-response.mjs";

const tokenId = "synthetictokenid";
const expectedHead = "ec3affd0e916b895e3528de6747b632f428359c0";
const canary = "synthetic-provider-credential-canary";
const revokeCases = [
	["exact acknowledgement", { status: 0, stdout: JSON.stringify({ success: true, result: { id: tokenId } }), stderr: "" }, "REVOKE_ACKNOWLEDGED"],
	["explicit transient 404", { status: 1, stdout: "", stderr: "HTTP 404 token not found" }, "REVOKE_TRANSIENT_RETRY_ELIGIBLE"],
	["documented API not-found envelope with HTTP 404", { status: 1, stdout: JSON.stringify({ success: false, result: null, errors: [{ code: 10200, message: "not found" }], messages: [] }), stderr: "HTTP 404" }, "REVOKE_TRANSIENT_RETRY_ELIGIBLE"],
	["not-found envelope without HTTP status is not retryable", { status: 1, stdout: JSON.stringify({ success: false, result: null, errors: [{ code: 10200, message: "not found" }], messages: [] }), stderr: "" }, "REVOKE_PROVIDER_FAILURE"],
	["textual not-found without status", { status: 1, stdout: "", stderr: "token not found" }, "REVOKE_NOT_FOUND_NONQUALIFYING"],
	["permission status beats not-found text", { status: 1, stdout: "", stderr: "HTTP 403 Forbidden: token not found" }, "REVOKE_PERMISSION_DENIED"],
	["conflicting HTTP 404 and permission text is ambiguous", { status: 1, stdout: "", stderr: "HTTP 404 Forbidden: token not found" }, "REVOKE_AMBIGUOUS"],
	["provider failure beats 404 text", { status: 1, stdout: JSON.stringify({ success: false, errors: [{ code: 10400, message: "internal error" }] }), stderr: "HTTP 404 token not found" }, "REVOKE_PROVIDER_FAILURE"],
	["HTTP 500 beats not-found text", { status: 1, stdout: "", stderr: "HTTP 500 token not found" }, "REVOKE_PROVIDER_FAILURE"],
	["transport failure", { status: null, signal: "SIGTERM", stdout: "", stderr: "" }, "REVOKE_TRANSPORT_FAILURE"],
	["unclassified process failure", { status: 1, stdout: "", stderr: "command failed" }, "REVOKE_AMBIGUOUS"],
	["nonzero success envelope remains ambiguous", { status: 1, stdout: JSON.stringify({ success: true, result: { id: tokenId } }), stderr: "" }, "REVOKE_AMBIGUOUS"],
	["wrong acknowledgement ID remains ambiguous", { status: 0, stdout: JSON.stringify({ success: true, result: { id: "other-token-id-123" } }), stderr: "" }, "REVOKE_AMBIGUOUS"],
	["provider text canary is suppressed", { status: 1, stdout: "", stderr: canary }, "REVOKE_AMBIGUOUS"],
];
for (const [name, result, expected] of revokeCases) {
	const actual = classifyRevokeResponse(result, tokenId);
	if (actual.classification !== expected) throw new Error(`revoke classification mismatch: ${name}`);
	if (JSON.stringify(actual).includes(canary)) throw new Error(`revoke canary leaked: ${name}`);
	if (Object.keys(actual).some((key) => /message|raw|body|diagnosticText/i.test(key))) throw new Error(`raw provider detail retained: ${name}`);
}

const gitCases = [
	["HTTP authorization rejection", { status: 128, stdout: "", stderr: "HTTP 403 Forbidden" }, "POST_REVOKE_AUTHENTICATION_REJECTED"],
	["Git authentication rejection", { status: 128, stdout: "", stderr: "fatal: Authentication failed for https://artifacts.cloudflare.net/" }, "POST_REVOKE_AUTHENTICATION_REJECTED"],
	["credential still works for expected HEAD", { status: 0, stdout: `${expectedHead} HEAD\n`, stderr: "" }, "POST_REVOKE_CREDENTIAL_STILL_ACCEPTED"],
	["Git success without expected HEAD is inconclusive", { status: 0, stdout: "", stderr: "" }, "POST_REVOKE_GIT_SUCCESS_UNVERIFIED"],
	["DNS failure is unrelated", { status: 128, stdout: "", stderr: "fatal: Could not resolve host: artifacts.cloudflare.net" }, "POST_REVOKE_GIT_UNRELATED_FAILURE"],
	["repository 404 is unrelated", { status: 128, stdout: "", stderr: "fatal: repository not found; HTTP 404" }, "POST_REVOKE_GIT_UNRELATED_FAILURE"],
	["network and auth conflict is ambiguous", { status: 128, stdout: "", stderr: "fatal: Could not resolve host; Authentication failed" }, "POST_REVOKE_GIT_FAILURE_UNCLASSIFIED"],
	["child transport error is unrelated", { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }, "POST_REVOKE_GIT_UNRELATED_FAILURE"],
];
for (const [name, result, expected] of gitCases) {
	const actual = classifyPostRevokeGit(result, expectedHead);
	if (actual.classification !== expected) throw new Error(`post-revoke Git classification mismatch: ${name}`);
	if (JSON.stringify(actual).includes(canary)) throw new Error(`post-revoke canary leaked: ${name}`);
}

process.stdout.write(JSON.stringify({ syntheticOnly: true, revokeCases: revokeCases.length, postRevokeGitCases: gitCases.length, canarySuppressed: true, passed: true }) + "\n");
