import { CredentialState, initialCredentialLifecycle, transitionCredentialLifecycle } from "./credential-lifecycle.mjs";

const id = "synthetictokenid";
const expiresAt = new Date(Date.now() + 300_000).toISOString();
let assertions = 0;

function check(condition) {
	assertions += 1;
	if (!condition) throw new Error("lifecycle assertion failed");
}

function rejects(fn) {
	let didReject = false;
	try { fn(); } catch { didReject = true; }
	check(didReject);
}

function advance(state, event) {
	return transitionCredentialLifecycle(state, event);
}

try {
	let state = initialCredentialLifecycle();
	check(state.state === CredentialState.NO_CREDENTIAL);
	rejects(() => advance(state, { type: "inventory-skipped-contest-mode" }));
	state = advance(state, { type: "issue-requested" });
	check(state.state === CredentialState.ISSUANCE_ATTEMPTED);
	state = advance(state, { type: "issue-response-ambiguous" });
	check(state.state === CredentialState.ISSUANCE_AMBIGUOUS);
	state = advance(state, { type: "inventory-inconclusive" });
	check(state.state === CredentialState.ISSUANCE_AMBIGUOUS);
	rejects(() => advance(state, { type: "inventory-correlated", id, state: "active", exactRequestCorrelation: false }));
	rejects(() => advance(state, { type: "revoke-requested", id }));
	state = advance(state, { type: "inventory-correlated", id, state: "active", exactRequestCorrelation: true });
	check(state.state === CredentialState.ISSUED_CONFIRMED && state.inventoryConfirmed);
	state = advance(state, { type: "use-started" });
	check(state.state === CredentialState.IN_USE);
	state = advance(state, { type: "revoke-requested", id });
	state = advance(state, { type: "revoke-command-succeeded", commandSucceeded: true });
	check(state.state === CredentialState.REVOCATION_ATTEMPTED && state.revokeCommandSucceeded);
	rejects(() => advance(state, { type: "revocation-verified", inventoryAbsent: true, authenticationRejected: false }));
	state = advance(state, { type: "revocation-verified", inventoryAbsent: true, authenticationRejected: true });
	check(state.state === CredentialState.REVOKED_CONFIRMED);

	let ambiguousRevoke = advance(advance(advance(initialCredentialLifecycle(), { type: "issue-requested" }), { type: "issue-response-valid", id, scope: "read", expiresAt }), { type: "revoke-requested", id });
	check(ambiguousRevoke.state === CredentialState.REVOCATION_ATTEMPTED && !ambiguousRevoke.inventoryConfirmed);
	ambiguousRevoke = advance(ambiguousRevoke, { type: "revoke-command-ambiguous" });
	check(ambiguousRevoke.state === CredentialState.REVOCATION_AMBIGUOUS);
	ambiguousRevoke = advance(ambiguousRevoke, { type: "revocation-observed-active" });
	check(ambiguousRevoke.state === CredentialState.REVOCATION_AMBIGUOUS && !ambiguousRevoke.authenticationRejected);
	ambiguousRevoke = advance(ambiguousRevoke, { type: "revocation-verified", inventoryAbsent: true, authenticationRejected: true });
	check(ambiguousRevoke.state === CredentialState.REVOKED_CONFIRMED);
	let inconclusive = advance(advance(advance(advance(initialCredentialLifecycle(), { type: "issue-requested" }), { type: "issue-response-valid", id, scope: "read", expiresAt }), { type: "issued-inventory-confirmed", id, state: "active" }), { type: "use-started" });
	inconclusive = advance(inconclusive, { type: "revoke-requested", id });
	inconclusive = advance(inconclusive, { type: "revoke-command-succeeded", commandSucceeded: true });
	inconclusive = advance(inconclusive, { type: "revocation-observation-inconclusive", inventoryAbsent: true });
	check(inconclusive.state === CredentialState.REVOCATION_AMBIGUOUS && !inconclusive.authenticationRejected);

	let rejectedIssue = advance(initialCredentialLifecycle(), { type: "issue-requested" });
	rejectedIssue = advance(rejectedIssue, { type: "issue-authoritatively-rejected", serviceRejected: true, credentialCreated: false });
	check(rejectedIssue.state === CredentialState.NO_CREDENTIAL);
	rejects(() => advance(initialCredentialLifecycle(), { type: "issue-authoritatively-rejected", serviceRejected: true, credentialCreated: false }));
	rejects(() => advance(initialCredentialLifecycle(), { type: "issue-requested", token: "synthetic" }));
	rejects(() => advance(advance(initialCredentialLifecycle(), { type: "issue-requested" }), { type: "issue-response-valid", id, scope: "read", expiresAt: "invalid" }));

	let noInventory = advance(advance(advance(initialCredentialLifecycle(), { type: "issue-requested" }), { type: "issue-response-valid", id, scope: "read", expiresAt }), { type: "inventory-skipped-contest-mode" });
	check(noInventory.inventorySkipped && !noInventory.inventoryConfirmed);
	noInventory = advance(noInventory, { type: "use-started" });
	noInventory = advance(noInventory, { type: "revoke-requested", id });
	noInventory = advance(noInventory, { type: "revoke-command-succeeded", commandSucceeded: true });
	rejects(() => advance(noInventory, { type: "revocation-verified-no-inventory", authenticationRejected: false }));
	noInventory = advance(noInventory, { type: "revocation-verified-no-inventory", authenticationRejected: true });
	check(noInventory.state === CredentialState.REVOKED_CONFIRMED && !noInventory.inventoryConfirmed);
	let noInventoryUnacked = advance(advance(advance(initialCredentialLifecycle(), { type: "issue-requested" }), { type: "issue-response-valid", id, scope: "read", expiresAt }), { type: "inventory-skipped-contest-mode" });
	noInventoryUnacked = advance(noInventoryUnacked, { type: "revoke-requested", id });
	noInventoryUnacked = advance(noInventoryUnacked, { type: "revoke-command-succeeded", commandSucceeded: false });
	rejects(() => advance(noInventoryUnacked, { type: "revocation-verified-no-inventory", authenticationRejected: true }));

	process.stdout.write(JSON.stringify({ syntheticOnly: true, assertions, issuanceAmbiguityFailsClosed: true, revokeCommandSuccessNotFinal: true, revokeRequiresAuthenticationEvidence: true, noInventoryContestPath: true, secretFieldsRejected: true, passed: true }) + "\n");
} catch {
	process.stdout.write(JSON.stringify({ syntheticOnly: true, assertions, passed: false, detailsSuppressed: true }) + "\n");
	process.exitCode = 1;
}
