const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Return the one admitted work-state branch for a demo run, or null. */
export function workStateBranchForRun(runId: unknown): string | null {
	if (typeof runId !== "string" || !runIdPattern.test(runId)) return null;
	return `contest-demo/${runId}/work-state`;
}

/** Return the canonical Git ref corresponding to an admitted run ID. */
export function workStateRefForRun(runId: unknown): string | null {
	const branch = workStateBranchForRun(runId);
	return branch === null ? null : `refs/heads/${branch}`;
}

/** Return the only producer candidate ref that may be asserted in a run's state. */
export function producerCandidateRefForRun(runId: unknown): string | null {
	if (typeof runId !== "string" || !runIdPattern.test(runId)) return null;
	return `refs/heads/contest-demo/${runId}/candidate/producer`;
}
