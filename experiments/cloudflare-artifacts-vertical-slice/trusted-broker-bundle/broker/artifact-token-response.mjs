const httpStatusPattern = /(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?\s*[:=]?\s*)([1-5]\d\d)\b/i;
const notFoundPattern = /\bnot found\b|\bnot_found\b/i;
const permissionPattern = /permission denied|not authorized|unauthorized|forbidden|authentication error/i;
const networkFailurePattern = /could not resolve host|failed to connect|connection timed out|operation timed out|network is unreachable|connection reset|could not read from remote repository|repository not found/i;
const authFailurePattern = /authentication failed|http basic: access denied|invalid credentials|access denied/i;

function parseEnvelope(...outputs) {
	for (const output of outputs) {
		if (typeof output !== "string" || output.length === 0) continue;
		try {
			const value = JSON.parse(output);
			if (value && typeof value === "object" && typeof value.success === "boolean") return value;
		} catch {}
	}
	return null;
}

function httpStatusFrom(...outputs) {
	for (const output of outputs) {
		if (typeof output !== "string") continue;
		const match = output.match(httpStatusPattern);
		if (match) return Number(match[1]);
	}
	return null;
}

export function classifyRevokeResponse(result, expectedId) {
	const stdout = typeof result?.stdout === "string" ? result.stdout : "";
	const stderr = typeof result?.stderr === "string" ? result.stderr : "";
	const envelope = parseEnvelope(stdout, stderr);
	const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
	const status = httpStatusFrom(stderr, stdout);
	const providerErrorCodes = errors.map((error) => error?.code).filter(Number.isInteger).slice(0, 4);
	const providerMessages = errors.map((error) => typeof error?.message === "string" ? error.message : "").join("\n");
	const responseIdMatches = typeof envelope?.result?.id === "string" && envelope.result.id === expectedId;
	const hasStructuredFailure = envelope?.success === false;
	const structuredFailureText = `${providerMessages} ${providerErrorCodes.join(" ")}`;
	const notFoundEnvelopeOnly = hasStructuredFailure && errors.length > 0 &&
		errors.every((error) => error?.code === 10200);
	const transientNotFoundEnvelope = status === 404 && notFoundEnvelopeOnly;
	const permissionEvidence = status === 401 || status === 403 ||
		(status === null && hasStructuredFailure && permissionPattern.test(structuredFailureText));
	const output = `${stdout}\n${stderr}`;
	const permissionTextConflict = status === 404 && permissionPattern.test(output);
	let classification = "REVOKE_AMBIGUOUS";
	let reason = "response_did_not_match_a_qualified_provider_outcome";

	if (result?.error || result?.signal) {
		classification = "REVOKE_TRANSPORT_FAILURE";
		reason = result?.error?.code ? "child_execution_error" : "child_terminated_by_signal";
	} else if (permissionTextConflict) {
		classification = "REVOKE_AMBIGUOUS";
		reason = "http_404_conflicts_with_permission_diagnostic";
	} else if (status === 401 || status === 403 || permissionEvidence) {
		classification = "REVOKE_PERMISSION_DENIED";
		reason = status === 401 || status === 403 ? "http_auth_or_permission_status" : "structured_permission_error";
	} else if (result?.status === 0 && envelope?.success === true && responseIdMatches) {
		classification = "REVOKE_ACKNOWLEDGED";
		reason = "zero_exit_and_exact_success_envelope_id";
	} else if (transientNotFoundEnvelope) {
		classification = "REVOKE_TRANSIENT_RETRY_ELIGIBLE";
		reason = "explicit_http_404_with_only_provider_not_found_errors";
	} else if (hasStructuredFailure) {
		classification = "REVOKE_PROVIDER_FAILURE";
		reason = "structured_provider_failure_envelope";
	} else if (status === 404) {
		classification = "REVOKE_TRANSIENT_RETRY_ELIGIBLE";
		reason = "explicit_http_404_without_structured_failure_envelope";
	} else if (status !== null && status >= 400) {
		classification = "REVOKE_PROVIDER_FAILURE";
		reason = "explicit_non_retryable_http_error_status";
	} else if (notFoundPattern.test(output)) {
		classification = "REVOKE_NOT_FOUND_NONQUALIFYING";
		reason = "unstructured_not_found_diagnostic_without_http_404";
	} else if (result?.status !== 0) {
		classification = "REVOKE_AMBIGUOUS";
		reason = "nonzero_cli_exit_without_qualified_response";
	} else if (envelope?.success === true && !responseIdMatches) {
		classification = "REVOKE_AMBIGUOUS";
		reason = typeof envelope?.result?.id === "string" ? "success_envelope_id_mismatch" : "success_envelope_id_missing";
	}

	return Object.freeze({
		classification,
		reason,
		processExitStatus: Number.isInteger(result?.status) ? result.status : null,
		processSignal: typeof result?.signal === "string" ? result.signal : null,
		childErrorCode: typeof result?.error?.code === "string" ? result.error.code : null,
		httpStatus: status,
		providerEnvelopePresent: envelope !== null,
		providerSuccess: typeof envelope?.success === "boolean" ? envelope.success : null,
		providerResponseIdMatches: responseIdMatches,
		providerErrorCodes,
		stdoutBytes: Buffer.byteLength(stdout),
		stderrBytes: Buffer.byteLength(stderr),
	});
}

export function classifyPostRevokeGit(result, expectedHead) {
	const stdout = typeof result?.stdout === "string" ? result.stdout : "";
	const stderr = typeof result?.stderr === "string" ? result.stderr : "";
	const status = httpStatusFrom(stderr, stdout);
	const output = `${stdout}\n${stderr}`;
	const returnedHead = stdout.split(/\r?\n/).map((line) => line.match(/^([0-9a-f]{40,64})\s+HEAD\s*$/i)?.[1] ?? null).find(Boolean) ?? null;
	const returnedHeadMatches = typeof expectedHead === "string" && returnedHead === expectedHead;
	const authText = authFailurePattern.test(output);
	const networkText = networkFailurePattern.test(output) || status === 404;
	let classification = "POST_REVOKE_GIT_FAILURE_UNCLASSIFIED";
	let reason = "failure_did_not_establish_authentication_rejection";

	if (result?.error || result?.signal) {
		classification = "POST_REVOKE_GIT_UNRELATED_FAILURE";
		reason = result?.error?.code ? "git_child_execution_error" : "git_child_terminated_by_signal";
	} else if (result?.status === 0) {
		classification = returnedHeadMatches ? "POST_REVOKE_CREDENTIAL_STILL_ACCEPTED" : "POST_REVOKE_GIT_SUCCESS_UNVERIFIED";
		reason = returnedHeadMatches ? "expected_private_head_read_succeeded_after_revoke_acknowledgement" : "git_succeeded_without_expected_head_identity";
	} else if (networkText && (authText || status === 401 || status === 403)) {
		classification = "POST_REVOKE_GIT_FAILURE_UNCLASSIFIED";
		reason = "conflicting_authentication_and_transport_or_repository_evidence";
	} else if (status === 401 || status === 403) {
		classification = "POST_REVOKE_AUTHENTICATION_REJECTED";
		reason = "explicit_http_auth_or_authorization_status";
	} else if (networkText) {
		classification = "POST_REVOKE_GIT_UNRELATED_FAILURE";
		reason = status === 404 ? "repository_or_path_not_found" : "network_or_dns_failure";
	} else if (authText) {
		classification = "POST_REVOKE_AUTHENTICATION_REJECTED";
		reason = "git_authentication_rejection_diagnostic";
	} else if (result?.status === null || result?.status === undefined) {
		classification = "POST_REVOKE_GIT_UNRELATED_FAILURE";
		reason = "git_process_did_not_return_an_exit_status";
	}

	return Object.freeze({
		classification,
		reason,
		processExitStatus: Number.isInteger(result?.status) ? result.status : null,
		processSignal: typeof result?.signal === "string" ? result.signal : null,
		childErrorCode: typeof result?.error?.code === "string" ? result.error.code : null,
		httpStatus: status,
		returnedHeadMatches,
		stdoutBytes: Buffer.byteLength(stdout),
		stderrBytes: Buffer.byteLength(stderr),
	});
}
