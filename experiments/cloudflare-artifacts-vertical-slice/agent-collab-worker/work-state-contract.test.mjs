import assert from "node:assert/strict";
import test from "node:test";
import { producerCandidateRefForRun, workStateBranchForRun, workStateRefForRun } from "./src/work-state-contract.ts";

test("maps one canonical UUID to only its contest work-state ref", () => {
	const runId = "e1f81d95-7644-46f9-a07b-bfc6e6050501";
	assert.equal(workStateBranchForRun(runId), `contest-demo/${runId}/work-state`);
	assert.equal(workStateRefForRun(runId), `refs/heads/contest-demo/${runId}/work-state`);
	assert.equal(producerCandidateRefForRun(runId), `refs/heads/contest-demo/${runId}/candidate/producer`);
});

test("rejects arbitrary, malformed, and non-canonical run selectors", () => {
	for (const runId of [undefined, null, "main", "../../main", "E1F81D95-7644-46F9-A07B-BFC6E6050501", "e1f81d95-7644-46f9-a07b-bfc6e6050501/extra"]) {
		assert.equal(workStateBranchForRun(runId), null);
		assert.equal(workStateRefForRun(runId), null);
		assert.equal(producerCandidateRefForRun(runId), null);
	}
});
