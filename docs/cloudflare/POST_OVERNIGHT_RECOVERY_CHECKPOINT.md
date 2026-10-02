# Post-overnight recovery checkpoint

Date: 2026-10-02 UTC

## Executive state

- Starting and current committed HEAD: `b63ba494cd3164adfbef0051c0f62f5362bea5df`.
- No commits, push, tag, or remote creation occurred in this recovery.
- Issue #12 remains open.
- Contest state: substrate experiments are prior evidence; the current collaboration observation is not qualified and no contest implementation gate is met.
- Elapsed time: not reliably measured.

## Historical artifact verification

At recovery start, the reported SHA-256 hashes matched:

- `OVERNIGHT_CHECKPOINT.md`: `ffd61c5c5e8843afed1610b71f9ccd0be957190727f8b14cd953fd15e7541ebf`
- `AGENT_COLLABORATION_EXPERIMENT_3_EVIDENCE.md`: `4d57757c863dad87c5ea94ae4db060645da7aa207e3d4ca6bba2b9936f63468e`
- `AGENT_NATIVE_COLLABORATION_RESEARCH.md`: `615f21e28ac6145315f67b3a832801fd392498b232cd472b225447618030283d`
- E3 preregistration: `3051ae216d054259aabc4f81b556348796f131f003323a55769c2d57e430fe36`

The original overnight checkpoint is preserved unchanged. This continuation records corrections without rewriting its historical account.

## Security incident: CF-COLLAB-TOKEN-OUTPUT-001

- **Independent disposition:** `TOKEN_OUTPUT_INCIDENT_CONTAINED_WITH_RESIDUAL_EXPOSURE`.
- The initial read token was emitted by `cf` stdout, passed into the tool result/assistant context, and persists in the local Codex rollout JSONL. It was not used for Git. The matching revoke command correlated by token ID and exited 0 about seven seconds after creation.
- The recorded session file is mode `0664`, owner/group `mike`; parent directories permit group traversal. Other local reads, external service retention, backups, telemetry, and any observation during the pre-revocation interval are unknown. The transcript copy remains; no permission change, deletion, or redaction was attempted.
- Independent review of the rollout chronology found subsequent token creation and Git pushes after the initial disclosure, before the actual stop. This corrects the earlier checkpoint's implication that Cloudflare activity stopped immediately. Those later credentials were distinct and were captured inside scripts; the evidence does not show use of the initially exposed token.
- The historical four-repository inventory reported zero active tokens. A separate current read-only account inventory found one namespace, five repositories, and zero active repository tokens in each (`--state all --per-page 100`; all listed records fit on one page). This supports current token containment for those repositories, but does not prove no prior misuse, old-token rejection, or absence of other credential classes.
- **Root cause:** Cloudflare's token-create API returns the plaintext credential in its response. Installed `cf` 1.0.0-beta.10 documents structured results on stdout and passes the full token-create API result through its JSON formatter. The direct command invocation forwarded that stdout into the tool record. This was not shell tracing. See [independent incident review](CF-COLLAB-TOKEN-OUTPUT-001_INDEPENDENT_REVIEW.md) and [Cloudflare REST documentation](https://developers.cloudflare.com/artifacts/api/rest-api/).
- **Operator decision required:** decide how to handle the retained local rollout copy (restrict, redact, or retain under an approved handling policy). No real Artifact credential issuance resumes before this residual exposure has a safe disposition.

## Experiment 3 independent review

- **Disposition:** `EXPERIMENT_3_CORRECTION_REQUIRED`.
- Independent reviewers verified the baseline, producer/control/treatment Git objects, parent/tree/path identity, one candidate commit per consumer, and successful local integrations and validation.
- A separate transcript review corroborated that preregistration preceded actor spawns; treatment read initial state, committed, then read updated state and reported no additional commit. Control has no state-reader/HTTP/producer-path calls. Actor prompt contents remain unknown because encrypted messages were not decrypted.
- The prescribed sequence was not followed: producer commit creation preceded the treatment commit; producer push overlapped treatment commit; state update preceded control commit. This weakens paired comparability. Both candidates passed, and the one reported zero-additional-treatment-commit count does not measure uncommitted work or prove causation. No collaboration benefit or qualified null result is established.
- The README-only producer change did not touch the consumer contract, so both correct consumers were expected to pass. This is a plausible design explanation, not proof that the signal has no value.

## Credential brokerage canary

- A synthetic-only harness ran with exit 0 and zero self-reported failures. Independent mutation review falsified assertions: it incorrectly passed when final stdout was contaminated, malformed issuer stderr was forwarded, the token alone appeared in child argv, or the response ID was missing.
- **Result:** brokerage gate failed; the harness is not accepted as a credential-safety control. No real credential was resumed. Synthetic test only; no live Git mutation occurred.
- The identified synthetic secret was generated for this test and not persisted in repository files or its output. Temporary scratch directories were removed by the test.

## Cloudflare resources and current access

- Existing Worker: `nexus-agent-collab-exp1-20261002`, version `e071efb5-d1ec-464e-9c7f-86784b6c6a38`; experiment routes were previously checked for unauthenticated rejection. `/health` is public; `/work-state` requires bearer authorization. No mutation route was identified.
- Namespace: `nexus-exp1-oct02`; five retained experimental repositories. Current read-only inventory found zero active repository tokens in each.
- These resources remain live. Recovery made no Cloudflare mutations, deployments, credential issuance, or Git network operations. No billing settings were changed.
- The separate temporary Worker authorization file at `/tmp/agent-collab-auth-mskBF1/auth` was not printed or modified during this recovery.

## Registered findings and limitations

- `CF-COLLAB-TOKEN-OUTPUT-001`: contained with residual transcript exposure; operator handling decision pending.
- `CF-COLLAB-TOOLCHAIN-001`: fixture setup does not install/pin TypeScript cleanly; remains registered.
- E3 protocol-order deviation: preregistration sequence not followed; treatment/control comparability weakened.
- Synthetic brokerage harness: independent mutation review found false negatives; correction/re-review required before use.
- Cloudflare token inventory is current for the five listed repositories only; no old-token denial test was run.
- E3 causal benefit, effect size, repeatability, time/context cost, and false-positive rate remain unknown.

## Repository and security state

- Modified/new recovery artifacts are uncommitted: incident review, E3 review/evidence addenda, research correction, synthetic brokerage notes/harness, and this checkpoint.
- Pre-existing untracked `.cloudflare/`, `.wrangler/`, and six Issue #12 assessment artifacts were not staged or altered.
- No tests beyond the synthetic canary run and reviewer reproduction were run. No dependency/source behavior was added to the Nexus product.
- The synthetic canary baseline returned exit 0; independent fault injection failed it as a security gate. No secret scanner was run against the sensitive rollout transcript. Repository changes still require final secret review before any future commit.
- No new credential is active according to the current five-repository inventory. Public endpoint inventory is limited to the existing `/health`; sensitive state reads are bearer-protected. No temporary endpoint was deployed in this recovery.

## Critical path and next loop

1. Operator resolves safe handling of the retained token-bearing rollout transcript.
2. Replace the synthetic-only harness with a broker test whose output, argument, response-validation, and cleanup assertions survive independent fault injection; independently review before real credentials.
3. Correct and preregister a comparable stale-interface control/treatment trial. Declare one primary metric before execution and preserve all actor-run chronology and state responses as secret-free evidence.
4. Only after the security gate passes, execute and independently review that bounded replication. Do not start contest application integration until a collaboration mechanism shows a bounded outcome improvement.

No Experiment 3 rerun occurred in this recovery. No real Artifact credentials were issued. No contest vertical-slice implementation began.

## Operator-authorized incident remediation update — 2026-10-02

The operator dispositioned `CF-COLLAB-TOKEN-OUTPUT-001` as contained with historical residual exposure and authorized exact local plaintext remediation. The pathname copy was sanitized after preserving non-secret metadata in [CF-COLLAB-TOKEN-OUTPUT-001_REMEDIATION.md](CF-COLLAB-TOKEN-OUTPUT-001_REMEDIATION.md). This paragraph's earlier pathname-only account and zero-match claim were incomplete; a stale descriptor copy was later found and remediated as recorded below. The current full-descriptor exact-match count is unverified. External, provider-side, backup, and out-of-scope retention remain unknown.

The independent incident review remains unchanged as historical review evidence. No new credential was issued. The old brokerage harness remains rejected; its replacement must pass independent fault injection before any real credential probe.

## Follow-up correction — 2026-10-02

The pathname-only remediation statement above was incomplete. Independent
review found a stale open descriptor for the original unlinked rollout inode.
That descriptor copy was subsequently inspected and its four known credential
occurrences were replaced in place with the incident marker. Positioned
structural reads verified the four affected JSONL fields contain the marker;
the descriptor snapshot remained open/growing. Eight known occurrences were
replaced across the pathname and descriptor copies, but the current full-
descriptor exact-match count remains unverified. The removed plaintext was not
retained to enable a new literal scan. Process memory, unreadable
`/proc` entries, external transcript service, backups, and other out-of-scope
copies remain unknown. Independent post-remediation review of the stale
descriptor was not completed.

The earlier brokerage qualification draft at this path was also withdrawn:
its claimed real credential probe is unverified, and the synthetic safety gate
had not qualified. A read-only active-token inventory for
`nexus-exp1-oct02/external-git-proof` observed zero active tokens. The current
gate remains unqualified pending independent fault injection against its latest
source. No real credential issuance or E3 rerun is authorized before that
qualification.
