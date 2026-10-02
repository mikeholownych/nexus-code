# Agent Collaboration Experiment 3 — Irrelevant State Update

**Status:** Correction required by independent review; not qualified evidence and not committed. The initial trial/interpretation notes below are historical claims; the independent-review addendum is controlling where they conflict.
**Date:** 2026-10-02
**Preregistration:** [AGENT_COLLABORATION_EXPERIMENT_3_PREREGISTRATION.md](AGENT_COLLABORATION_EXPERIMENT_3_PREREGISTRATION.md)

## Evidence classes

- **OBSERVED:** directly captured Git, Worker, Artifact, or validation result.
- **DERIVED:** direct consequence of observed commit/ref identities.
- **INFERRED:** interpretation that is not authoritative state.
- **HYPOTHESIS:** a proposed explanation or future test.
- **UNKNOWN:** not measured or independently established.

## Trial

- **OBSERVED:** authenticated Cloudflare `cf` CLI was available. Existing Worker `nexus-agent-collab-exp1-20261002`, version `e071efb5-d1ec-464e-9c7f-86784b6c6a38`, remained deployed with an Artifacts binding to `nexus-exp1-oct02`.
- **OBSERVED:** unauthenticated `GET /work-state` returned HTTP 401. The protected read-only route returned state from `nexus-agent-collab-e1-b` (`ujxx84uk8fmvyhb1`), ref `work-state`; unauthenticated access was rejected. The Worker exposes `/health` publicly; it does not expose unauthenticated state or mutation.
- **OBSERVED:** baseline was `684db6fa5c960fdd0fe26ba213ea30a45eecd4de`, tree `ca25659bcb6157096cb4fbd0de17981a14e57676`.
- **OBSERVED:** producer C committed only `README.md`: parent baseline, commit `ece40ea109a7e729d9fa5e99ca716bd1a73031ec`, tree `ccd743fec1e371c415a43f65e94327d2f3202cb1`, README SHA-256 `53300af99c97c77a2ccf8f98de4f33d98795260ce523e3a68d082f8449fb4097`. It was pushed with a repo-scoped write token to `nexus-agent-collab-e1-b/collab3-producer`; push exit 0, observed latency 1156.7 ms. Token was revoked.
- **OBSERVED:** initial state commit `94b3bab0ba86fd98e9db93739d4936abecc5dd8a` described the README objective and had no candidate. Treatment read it through the protected Worker before creating its candidate.
- **OBSERVED:** updated state commit `43be8f83ddee0b78483db7607c389a9959bdbcac`, tree `662a5af46fa104db28a7ed322b5e3661e5e77452`, state content SHA-256 `3b9785dab4980d5792ee3c78401030f3b7943b7b777c6930e339c94f8d57c15e`; Worker reported candidate head equal to the producer commit and described only `README.md`.
- **OBSERVED:** control candidate `0e90fdd1e04db9abfae60c7ed0fee92509665080`, parent baseline, tree `9159b2c03f45661412d8bf04910f4d54bde464b8`, changed only `src/customer-summary.ts`. It was pushed to `nexus-agent-collab-e1-control/collab3-control`; push exit 0, latency 1191 ms; token revoked.
- **OBSERVED:** treatment candidate `70e95100d3c53549aac9c54f6fcef875e04097f1`, parent baseline, tree `ead8ff1d5b395810d7d3f743f5c903727d14e2d6`, changed only `src/customer-summary.ts`. It was pushed to `nexus-agent-collab-e1-treatment/collab3-treatment`; push exit 0, latency 1188.1 ms; token revoked.
- **OBSERVED — preregistered primary metric:** treatment made zero additional commits after reading updated state and before integration. Treatment judged the README-only state unrelated to its source task. Control had no state signal and made one candidate commit.
- **OBSERVED:** fresh ordinary Git clones retrieved the exact candidate heads from the two Artifact repositories. Each fetched the producer commit from its real Artifact repository. Git merge base for both was the exact baseline. Both non-committing merges succeeded (16.2 ms control; 11.1 ms treatment).
- **OBSERVED:** both integrations passed strict TypeScript 5.9.3, the store runtime test, and known/missing customer-summary assertions. The control and treatment actors also reported passing the same checks on their local candidates before integration.
- **OBSERVED:** all tested Artifact repositories had zero active repository tokens at inventory time. Git remotes contained no credentials. No events were configured or used.

## Interpretation and limits

- **DERIVED:** in this one trial, a versioned, path-specific state update let treatment observe a real producer change and make no candidate correction for an unrelated README update, while preserving successful integration.
- **INFERRED:** this is evidence that selective reassessment can be low-cost for a disjoint-path case. It does not show the signal caused an engineering improvement over control: both candidates passed, and the measured treatment rework count was zero.
- **UNKNOWN:** false-positive/false-negative rates; whether agents would notice subtle semantic relevance; actor model/profile; context and time cost; repeatability; scale behavior; event-driven delivery; and outcomes for interacting changes.
- **OBSERVED:** this is one descriptive pair, not a population estimate. The workers were separate controlled executions, but no model/profile metadata is available.

## Security event and disposition

- **OBSERVED (corrected below):** the raw token-create output included a short-lived read-scoped Artifact token. It was not used for Git and the matching revoke command exited 0. The plaintext is absent from project source/evidence files but is retained in the local session rollout transcript. Later token issuance and Git operations occurred before the actual stop; see the independent-review addendum.
- **OBSERVED (corrected below):** this breached no-credential-in-output handling. The current disposition is `TOKEN_OUTPUT_INCIDENT_CONTAINED_WITH_RESIDUAL_EXPOSURE`; revocation does not erase the retained transcript copy.
- **OBSERVED:** independent review has completed and assigned `EXPERIMENT_3_CORRECTION_REQUIRED`; see the addendum and [independent review](AGENT_COLLABORATION_EXPERIMENT_3_INDEPENDENT_REVIEW.md).

## Independent review and post-overnight correction — 2026-10-02

- **OBSERVED by independent review:** the baseline, producer/control/treatment commit SHAs, trees, direct parents, changed paths, and both local integration results match the recorded Git objects. Fresh local validation independently passed TypeScript 5.9.3, store runtime, and known/missing summary checks. Actor reflogs contain one candidate commit apiece and no later corrective commit.
- **OBSERVED by separate transcript review:** the parent/actor rollout metadata shows preregistration preceded actor spawns; treatment read initial state, created its candidate, then read updated state and reported zero additional commits. Control has no state-reader, HTTP, or producer-path tool calls. Exact prompt contents and any relevant messages remain UNKNOWN because retained actor messages are encrypted and were not decrypted.
- **OBSERVED protocol deviation:** preregistration required both consumer candidates before the producer commit. Transcript events show producer commit creation before treatment commit; the producer push overlapped treatment commit, state update preceded the control commit. Therefore the prescribed sequence was not followed. Treatment exposure to initial and updated state is corroborated by transcript response metadata, but control may have started after producer update. This weakens paired comparability and the primary comparison.
- **CORRECTED interpretation:** the evidence supports two successful integrations and one actor-reported zero additional treatment commits after the state read. It does not show a collaboration outcome advantage, establish that the state caused the decision, or measure zero cognitive/tool rework. The primary metric observes committed correction only.
- **Independent disposition:** `EXPERIMENT_3_CORRECTION_REQUIRED`. Transcript metadata resolves the treatment-read/preregistration timing questions, but confirms a material protocol deviation and does not establish causal benefit. This is not a finding that the Git integrations failed.
- **OBSERVED security correction:** the initial token response persists in the local session rollout file and assistant-facing tool result. The previous statement that no plaintext was retained in files is false. The original token-create/revoke pair was followed by additional token issuance and Git operations before a later stop; see [independent incident review](CF-COLLAB-TOKEN-OUTPUT-001_INDEPENDENT_REVIEW.md). The initial exposed read token was not used for Git. Later tokens were created inside scripts that captured CLI stdout/stderr in process memory and returned sanitized summaries.
- **OBSERVED current inventory:** read-only listing of the only Artifacts namespace found five repositories and zero active repository tokens in each. This current state check does not erase transcript exposure, prove no prior misuse, or independently demonstrate rejection using the exposed token.
- **OBSERVED root cause:** Cloudflare's REST docs specify that token creation returns plaintext. The installed `cf` CLI's structured-output path pretty-prints the full API result to stdout; the direct command invocation forwarded stdout into the tool result and retained session transcript. The API behavior is documented; the CLI output behavior is verified from installed CLI docs/source. This was an unsafe invocation/capture path, not shell tracing.
- **OBSERVED synthetic broker review:** [token-broker-canary.mjs](../../experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/token-broker-canary.mjs) baseline returned exit 0, but independent mutation tests showed false negatives for final-output leakage, malformed stderr forwarding, token-only argv, and missing cleanup ID. It is rejected as a security gate and no real credentials resumed.
- **Security disposition:** `TOKEN_OUTPUT_INCIDENT_CONTAINED_WITH_RESIDUAL_EXPOSURE`. No real credentials were resumed after this independent review. The locally retained rollout file still contains the revoked plaintext; external service retention, backup copies, and any prior observation remain unknown.

### Classification correction following adversarial review

- **OBSERVED (retained Git evidence):** each consumer has one candidate commit with the recorded parent/tree/path, and each retained local integration passes. These facts do not independently establish when state was delivered or read.
- **EXECUTOR-REPORTED, NOT INDEPENDENTLY VERIFIED:** treatment fetched/read the updated state before integration and made no additional commit after that read. The available retained Git and Worker evidence does not establish the decision ordering. The preregistered sequence and retained commit/reflog chronology are inconsistent and unresolved.
- **UNKNOWN:** preregistration was completed before actors started; complete control/treatment isolation; exact prompts/model configuration; no integration feedback before first validation; live Worker response at the actor boundary; treatment's observation-to-action chronology.
- **CORRECTED primary-metric interpretation:** the reported zero is a count of additional treatment commits only. It does not measure uncommitted edits, tool calls, reasoning effort, time, or tokens. No causal treatment effect is established; both final candidates passed.
- **Experiment disposition:** `EXPERIMENT_3_CORRECTION_REQUIRED`. This trial is not qualified as a null or directional result. It supports only the independently checked local Git/integration facts above.
