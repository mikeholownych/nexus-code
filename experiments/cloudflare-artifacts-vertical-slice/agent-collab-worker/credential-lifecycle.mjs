export const CredentialState = Object.freeze({
	NO_CREDENTIAL: "NO_CREDENTIAL",
	ISSUANCE_ATTEMPTED: "ISSUANCE_ATTEMPTED",
	ISSUED_CONFIRMED: "ISSUED_CONFIRMED",
	IN_USE: "IN_USE",
	REVOCATION_ATTEMPTED: "REVOCATION_ATTEMPTED",
	REVOKED_CONFIRMED: "REVOKED_CONFIRMED",
	ISSUANCE_AMBIGUOUS: "ISSUANCE_AMBIGUOUS",
	REVOCATION_AMBIGUOUS: "REVOCATION_AMBIGUOUS",
});

const secretField = /^(authorization|credential|password|plaintext|secret|token)$/i;

export function initialCredentialLifecycle() {
	return Object.freeze({
		state: CredentialState.NO_CREDENTIAL,
		credentialId: null,
		inventoryConfirmed: false,
		authenticationRejected: false,
		revokeCommandSucceeded: false,
	});
}

export function transitionCredentialLifecycle(current, event) {
	if (!current || !Object.values(CredentialState).includes(current.state)) throw new Error("invalid lifecycle state");
	if (!event || typeof event.type !== "string" || containsSecretField(event)) throw new Error("invalid or secret-bearing lifecycle event");
	const next = { ...current };
	switch (event.type) {
		case "issue-requested":
			requireState(current, CredentialState.NO_CREDENTIAL);
			next.state = CredentialState.ISSUANCE_ATTEMPTED;
			break;
		case "issue-response-valid":
			requireState(current, CredentialState.ISSUANCE_ATTEMPTED);
			if (!validId(event.id) || !["read", "write"].includes(event.scope) || !validExpiry(event.expiresAt)) throw new Error("issuance response lacks validated metadata");
			next.state = CredentialState.ISSUED_CONFIRMED;
			next.credentialId = event.id;
			next.inventoryConfirmed = false;
			break;
		case "issue-authoritatively-rejected":
			requireState(current, CredentialState.ISSUANCE_ATTEMPTED);
			if (event.serviceRejected !== true || event.credentialCreated !== false) throw new Error("issuance rejection is not authoritative");
			next.state = CredentialState.NO_CREDENTIAL;
			break;
		case "issue-response-ambiguous":
			requireState(current, CredentialState.ISSUANCE_ATTEMPTED);
			next.state = CredentialState.ISSUANCE_AMBIGUOUS;
			break;
		case "issued-inventory-confirmed":
			requireState(current, CredentialState.ISSUED_CONFIRMED);
			if (!validId(event.id) || event.id !== current.credentialId || event.state !== "active") throw new Error("inventory does not confirm this issued credential");
			next.inventoryConfirmed = true;
			break;
		case "issued-inventory-ambiguous":
			requireState(current, CredentialState.ISSUED_CONFIRMED);
			next.state = CredentialState.ISSUANCE_AMBIGUOUS;
			next.inventoryConfirmed = false;
			break;
		case "inventory-correlated":
			requireState(current, CredentialState.ISSUANCE_AMBIGUOUS);
			if (!validId(event.id) || event.exactRequestCorrelation !== true || event.state !== "active") throw new Error("inventory does not correlate an active issuance");
			next.state = CredentialState.ISSUED_CONFIRMED;
			next.credentialId = event.id;
			next.inventoryConfirmed = true;
			break;
		case "inventory-inconclusive":
			requireState(current, CredentialState.ISSUANCE_AMBIGUOUS);
			next.state = CredentialState.ISSUANCE_AMBIGUOUS;
			break;
		case "use-started":
			requireState(current, CredentialState.ISSUED_CONFIRMED);
			if (!current.inventoryConfirmed) throw new Error("credential is not confirmed active in inventory");
			next.state = CredentialState.IN_USE;
			break;
		case "revoke-requested":
			const ambiguousIdCorrelated = current.state === CredentialState.ISSUANCE_AMBIGUOUS && event.exactRequestCorrelation === true;
			if (![CredentialState.ISSUED_CONFIRMED, CredentialState.IN_USE].includes(current.state) && !ambiguousIdCorrelated) throw new Error("revocation requires a correlated credential ID");
			if (!validId(event.id)) throw new Error("revocation requires a valid credential ID");
			if (current.credentialId && current.credentialId !== event.id) throw new Error("revocation ID mismatch");
			next.state = CredentialState.REVOCATION_ATTEMPTED;
			next.credentialId = event.id;
			break;
		case "revoke-command-succeeded":
			requireState(current, CredentialState.REVOCATION_ATTEMPTED);
			next.revokeCommandSucceeded = event.commandSucceeded === true;
			if (!next.revokeCommandSucceeded) next.state = CredentialState.REVOCATION_AMBIGUOUS;
			break;
		case "revoke-command-ambiguous":
			requireState(current, CredentialState.REVOCATION_ATTEMPTED);
			next.state = CredentialState.REVOCATION_AMBIGUOUS;
			break;
		case "revocation-observed-active":
			requireState(current, CredentialState.REVOCATION_ATTEMPTED, CredentialState.REVOCATION_AMBIGUOUS);
			next.state = CredentialState.REVOCATION_AMBIGUOUS;
			next.inventoryConfirmed = true;
			next.authenticationRejected = false;
			break;
		case "revocation-observation-inconclusive":
			requireState(current, CredentialState.REVOCATION_ATTEMPTED, CredentialState.REVOCATION_AMBIGUOUS);
			next.state = CredentialState.REVOCATION_AMBIGUOUS;
			next.inventoryConfirmed = event.inventoryAbsent === true;
			next.authenticationRejected = false;
			break;
		case "revocation-verified":
			requireState(current, CredentialState.REVOCATION_ATTEMPTED, CredentialState.REVOCATION_AMBIGUOUS);
			if (event.inventoryAbsent !== true || event.authenticationRejected !== true) throw new Error("revocation not independently verified");
			next.state = CredentialState.REVOKED_CONFIRMED;
			next.inventoryConfirmed = true;
			next.authenticationRejected = true;
			break;
		default:
			throw new Error("unknown lifecycle event");
	}
	return Object.freeze(next);
}

function requireState(current, ...states) {
	if (!states.includes(current.state)) throw new Error("invalid lifecycle transition");
}

function validId(id) {
	return typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function validExpiry(value) {
	const time = Date.parse(value);
	return Number.isFinite(time) && time > Date.now();
}

function containsSecretField(value) {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, item]) => secretField.test(key) || containsSecretField(item));
}
