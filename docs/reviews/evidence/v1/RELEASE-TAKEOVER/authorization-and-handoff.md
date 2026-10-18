# Release authorization and rate-limit handoff

## Authority

The owner accepted the v1 plan and explicitly authorized necessary commits, pushes, PRs, merges, release candidates, release tags and stable v1.0.0 publication after the accepted gates pass. The owner subsequently reaffirmed approvals while resolving the six external-action items. These authorizations are recorded from the direct owner conversation; this document does not turn agent reports into authority.

On 2026-10-18 the owner instructed: “The claude agent has hit a rate-limit. Review where it left off and take over it's duties.” The `RELEASE_PUBLISHER` claim was transferred from `claude-code` to `codex-api-root` under that instruction. The old record is preserved in the shared Git metadata and the append-only claims log. If Claude resumes, it must coordinate a new handoff before publishing; there is one active publisher.

## Preserved gates and ownership

Authorization is distinct from acceptance. No RC or stable acceptance is granted by this record. Required CI, exact-RC installation/qualification, independent review, human terminal evidence, stable draft verification, protected-branch rules and immutable tags still apply. Failed or absent evidence remains failed or absent. No threshold, supported-platform claim, corpus policy or artifact identity is changed.

Evaluator implementation had already transferred to `eval-impl` under a separately logged owner-authorized rate-limit handoff at 12:59 UTC. That implementation retains its lane; this handoff does not authorize competing edits. Other active owners, including upgrade follow-on and requirements/readiness owners, retain their claims. Private corpus payloads remain restricted to author/custodian roles.

The source checkout on `main` is dirty and is not the integration/runtime authority. Takeover discovery used remote `v1/integration` at `6f69f1a02e882d5a52a686319b11064f895afbc3`; later evidence must identify its own revision. Existing process metadata, calibration, and source CI do not substitute for installed-RC qualification.

## Remaining administrative matters

The user need not approve publication again. Actual missing permissions or explicitly required human acceptance must be identified precisely. Contest material stays frozen; security alerts in that material are not dismissed or silently waived. Broad host-service changes are outside the qualification provisioning lane.
