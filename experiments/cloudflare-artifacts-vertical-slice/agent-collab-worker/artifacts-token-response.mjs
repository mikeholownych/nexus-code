const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(code) {
	const error = new Error(code);
	error.code = code;
	return error;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
	if (typeof value !== "string") return false;
	const match = value.match(isoTimestampPattern);
	if (!match || Number.isNaN(Date.parse(value))) return false;
	const [year, month, day, hour, minute, second] = [
		Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10)),
		Number(value.slice(11, 13)), Number(value.slice(14, 16)), Number(value.slice(17, 19)),
	];
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (day < 1 || day > days[month - 1]) return false;
	const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
	return !zone || (Number(zone[2]) <= 23 && Number(zone[3]) <= 59);
}

/** Parse the documented Cloudflare Artifacts token-create success envelope.
 * `plaintext` is returned only for immediate internal custody; callers should
 * retain only `metadata` from the result.
 */
export function parseCreateTokenResponse(response) {
	let envelope;
	try {
		envelope = typeof response === "string" || Buffer.isBuffer(response)
			? JSON.parse(response.toString())
			: response;
	} catch {
		throw fail("TOKEN_CREATE_RESPONSE_MALFORMED");
	}
	if (!isRecord(envelope)) throw fail("TOKEN_CREATE_RESPONSE_MALFORMED");
	if (!Array.isArray(envelope.errors) || !Array.isArray(envelope.messages)) throw fail("TOKEN_CREATE_RESPONSE_MALFORMED");
	if (envelope.success !== true) throw fail("TOKEN_CREATE_PROVIDER_FAILURE");
	if (!isRecord(envelope.result)) throw fail("TOKEN_CREATE_RESULT_MALFORMED");

	const { id, plaintext, scope, expires_at: expiresAt } = envelope.result;
	// Cloudflare documents id as string without a lexical restriction. Keep this
	// deliberately lexical-agnostic and encode it if later placed in a URL path.
	if (typeof id !== "string" || id.length === 0) throw fail("TOKEN_CREATE_ID_INVALID");
	// Cloudflare defines ArtifactToken as a string. Examples do not constrain its
	// lexical form, so enforce only the structural requirement that it is nonempty.
	if (typeof plaintext !== "string" || plaintext.length === 0) throw fail("TOKEN_CREATE_PLAINTEXT_INVALID");
	if (scope !== "read" && scope !== "write") throw fail("TOKEN_CREATE_SCOPE_INVALID");
	if (!isIsoTimestamp(expiresAt)) {
		throw fail("TOKEN_CREATE_EXPIRY_INVALID");
	}

	const metadata = Object.freeze({ id, scope, expiresAt });
	return Object.freeze({ plaintext, metadata });
}

/** Send the provider secret directly to a caller-owned protected custody sink. */
export async function captureCreateTokenResponse(response, writeProtectedSecret) {
	if (typeof writeProtectedSecret !== "function") throw fail("TOKEN_CREATE_CUSTODY_SINK_REQUIRED");
	const parsed = parseCreateTokenResponse(response);
	await writeProtectedSecret(parsed.plaintext);
	return parsed.metadata;
}

/** Capture a provider response with safe HTTP status and bounded outcome only. */
export async function captureCreateTokenHttpResponse(httpStatus, response, writeProtectedSecret) {
	if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
		throw fail("TOKEN_CREATE_HTTP_STATUS_INVALID");
	}
	if (httpStatus < 200 || httpStatus >= 300) {
		return Object.freeze({ httpStatus, outcome: "HTTP_FAILURE" });
	}
	try {
		const metadata = await captureCreateTokenResponse(response, writeProtectedSecret);
		return Object.freeze({ httpStatus, outcome: "CAPTURED", metadata });
	} catch (error) {
		const allowedCodes = new Set([
			"TOKEN_CREATE_RESPONSE_MALFORMED", "TOKEN_CREATE_PROVIDER_FAILURE",
			"TOKEN_CREATE_RESULT_MALFORMED", "TOKEN_CREATE_ID_INVALID",
			"TOKEN_CREATE_PLAINTEXT_INVALID", "TOKEN_CREATE_SCOPE_INVALID",
			"TOKEN_CREATE_EXPIRY_INVALID", "TOKEN_CREATE_CUSTODY_SINK_REQUIRED",
		]);
		const errorCode = allowedCodes.has(error?.code) ? error.code : "TOKEN_CREATE_CAPTURE_FAILED";
		return Object.freeze({ httpStatus, outcome: "RESPONSE_REJECTED", errorCode });
	}
}
