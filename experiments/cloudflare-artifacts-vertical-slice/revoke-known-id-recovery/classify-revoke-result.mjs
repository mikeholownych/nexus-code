const httpStatusPattern = /(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?\s*[:=]?\s*)([1-5]\d\d)\b/i;
const permissionPattern = /permission denied|not authorized|unauthorized|forbidden|authentication error/i;
const notFoundPattern = /not found|not_found/i;

function envelopeFrom(result) {
	for (const candidate of [result?.stdout, result?.stderr]) {
		if (typeof candidate !== "string") continue;
		try {
			const value = JSON.parse(candidate);
			if (value && typeof value === "object" && typeof value.success === "boolean") return value;
		} catch {}
	}
	return null;
}

export function classifyRevokeResult(result, expectedId) {
	const stdout = typeof result?.stdout === "string" ? result.stdout : "";
	const stderr = typeof result?.stderr === "string" ? result.stderr : "";
	const combined = `${stdout}\n${stderr}`;
	const envelope = envelopeFrom(result);
	const statusMatch = combined.match(httpStatusPattern);
	const explicitHttpStatus = statusMatch ? Number(statusMatch[1]) : null;
	const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
	const providerErrorCodes = errors.map((item) => item?.code).filter(Number.isInteger).slice(0, 4);
	const providerMessages = errors.map((item) => typeof item?.message === "string" ? item.message : "").join("\n");
	const classifiedText = `${combined}\n${providerMessages}`;
	const permissionDenied = explicitHttpStatus === null ? permissionPattern.test(classifiedText) : explicitHttpStatus === 401 || explicitHttpStatus === 403;
	const notFound = explicitHttpStatus === 404 || (explicitHttpStatus === null && (/\b404\b/.test(classifiedText) || notFoundPattern.test(classifiedText)));
	const successEnvelope = envelope?.success === true;
	const responseId = typeof envelope?.result?.id === "string" ? envelope.result.id : null;
	let classification;
	if (result?.error) classification = "TRANSPORT_OR_EXECUTION_FAILURE";
	else if (result?.status === 0 && successEnvelope && responseId === expectedId) classification = "ACKNOWLEDGED_EXACT_ID";
	else if (permissionDenied) classification = "PROVIDER_PERMISSION_DENIED";
	else if (notFound) classification = "PROVIDER_REPORTED_NOT_FOUND";
	else if (explicitHttpStatus !== null && explicitHttpStatus >= 400) classification = "HTTP_RESPONSE_UNCLASSIFIED";
	else if (successEnvelope && result?.status !== 0) classification = "SUCCESS_ENVELOPE_NONZERO_EXIT";
	else if (successEnvelope) classification = responseId ? "SUCCESS_ACK_ID_MISMATCH" : "SUCCESS_ACK_ID_MISSING";
	else if (envelope?.success === false) classification = "PROVIDER_REJECTED";
	else if (result?.status !== 0) classification = "CLI_FAILURE_UNCLASSIFIED";
	else classification = "RESPONSE_SHAPE_UNEXPECTED";
	return Object.freeze({
		classification,
		processExitStatus: Number.isInteger(result?.status) ? result.status : null,
		processSignal: typeof result?.signal === "string" ? result.signal : null,
		childErrorCode: typeof result?.error?.code === "string" ? result.error.code : null,
		httpStatus: explicitHttpStatus,
		providerSuccess: typeof envelope?.success === "boolean" ? envelope.success : null,
		returnedIdMatches: responseId === expectedId,
		providerObjectReportedAbsent: classification === "PROVIDER_REPORTED_NOT_FOUND",
		permissionDenied: classification === "PROVIDER_PERMISSION_DENIED",
		providerErrorCodes,
		stdoutCaptured: stdout.length > 0,
		stderrCaptured: stderr.length > 0,
		stdoutBytes: Buffer.byteLength(stdout),
		stderrBytes: Buffer.byteLength(stderr),
	});
}
