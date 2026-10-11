import { classifyRevokeResult } from "./classify-revoke-result.mjs";

const id = "woh2sni4v09aj9hw";
const cases = [
	["exact success acknowledgement", { status: 0, stdout: JSON.stringify({ success: true, result: { id } }), stderr: "" }, "ACKNOWLEDGED_EXACT_ID"],
	["provider not found", { status: 1, stdout: JSON.stringify({ success: false, errors: [{ code: 10404, message: "token not found" }] }), stderr: "" }, "PROVIDER_REPORTED_NOT_FOUND"],
	["HTTP not found", { status: 1, stdout: "", stderr: "HTTP 404 Not Found" }, "PROVIDER_REPORTED_NOT_FOUND"],
	["provider permission denial", { status: 1, stdout: "", stderr: "HTTP 403 Forbidden" }, "PROVIDER_PERMISSION_DENIED"],
	["permission denial outranks not found text", { status: 1, stdout: JSON.stringify({ success: false, errors: [{ code: 1, message: "not found" }] }), stderr: "HTTP 403 Forbidden" }, "PROVIDER_PERMISSION_DENIED"],
	["explicit server error outranks not found text", { status: 1, stdout: JSON.stringify({ success: false, errors: [{ code: 1, message: "resource not found" }] }), stderr: "HTTP 500 Internal Server Error" }, "HTTP_RESPONSE_UNCLASSIFIED"],
	["nonzero exit success envelope is not mislabeled as ID mismatch", { status: 1, stdout: JSON.stringify({ success: true, result: { id } }), stderr: "" }, "SUCCESS_ENVELOPE_NONZERO_EXIT"],
	["transport timeout", { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }, "TRANSPORT_OR_EXECUTION_FAILURE"],
	["unclassified CLI failure", { status: 1, stdout: "", stderr: "command failed" }, "CLI_FAILURE_UNCLASSIFIED"],
	["success wrong ID", { status: 0, stdout: JSON.stringify({ success: true, result: { id: "0000000000000000" } }), stderr: "" }, "SUCCESS_ACK_ID_MISMATCH"],
	["success without ID", { status: 0, stdout: JSON.stringify({ success: true, result: {} }), stderr: "" }, "SUCCESS_ACK_ID_MISSING"],
];

for (const [name, result, expected] of cases) {
	const actual = classifyRevokeResult(result, id);
	if (actual.classification !== expected) throw new Error(`classification test failed: ${name}`);
	if (Object.hasOwn(actual, "rawOutput") || Object.hasOwn(actual, "rawResponse") || Object.hasOwn(actual, "providerMessage")) throw new Error(`raw response field retained: ${name}`);
}
const canary = "synthetic-provider-secret-canary";
const reflected = classifyRevokeResult({ status: 1, stdout: "", stderr: `provider error: ${canary}` }, id);
if (JSON.stringify(reflected).includes(canary)) throw new Error("provider diagnostic leaked into classification");
process.stdout.write(JSON.stringify({ syntheticOnly: true, cases: cases.length, providerDiagnosticCanarySuppressed: true, outputsAreStructuredAndSanitized: true, passed: true }) + "\n");
