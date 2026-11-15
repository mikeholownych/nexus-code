# Steering judgment: an independent evaluation (research record, 2026-11-15)

**Status: research only. No product behaviour changed.** The steering-conflict check (`steeringNegations` in `cli/src/core/objective.ts`) is still the regex described in v1.2.0 SI-3. This directory records an evaluation of replacing part of it with a language judgment, so the decision to build it can rest on evidence.

## The decision under test

Every operator steering message is checked against the objective ledger: does it negate a live requirement? Today a regex decides, and its own comment says "Anything ambiguous returns nothing, so only a deterministic negation blocks." That trades recall for precision: paraphrases such as "Forget the migration guide" or "Cut #2" pass unseen.

## Design (judgments from a model, the decision in code)

- **State** (named fields): `objective`, `requirements` (the numbered list, so "the third item" resolves) and `steering.text` (verbatim). Statuses and evidence are left out.
- **Questions**, one group per live requirement, all in one request, each a yes/no probability (`questions.mjs`, the single source of the wording): `withdraws` (dropped, skipped or replaced), `defers` (postponed, still expected), `changes` (narrowed, relaxed or different, still wanted).
- **Decision, in code:** conflict (the existing operator decision, unchanged) if the regex hits **or** `withdraws` >= 0.7, whatever `defers` says. `withdraws` between 0.3 and 0.7: advisory note, no block. `defers` and `changes` only add a note to what the operator sees. The first draft of this table let a high `defers` downgrade a real withdrawal and left a cell undefined; the data exposed that, and this is the repaired rule. Silently dropping a requirement is the failure, an extra prompt is cheap.
- **Fallback:** a judge that is not configured, errors or times out leaves the regex-only decision and records `semanticJudge: unavailable`; it is never recorded as "no negation".
- **Data boundary:** the steer of a negating message is held from the model until the operator decides (SI-3 tests assert this), so a judge must not send it to a third party by default. Judges are providers: none (default), the configured gateway, or an explicit opt-in.

## Dataset

`dataset.jsonl`: 26 synthetic steering messages against three requirements (`1. Parse the CSV input`, `2. Add retry logic to the uploader`, `3. Write the migration guide`), so 78 (message, requirement) judgments. Strata: explicit and paraphrased withdrawals, reference forms ("Cut #2", "the third item"), multi-requirement, deferral, change, and hard negatives (supports, extends, question, a negator word, a restricted method, reported speech, another object). 18 rows are `tune`, 8 are `heldout`; thresholds are set on `tune` only and `heldout` is run once. One row is `disputed`. The labels were written by the agent from the steering text alone, before any judge output existed, and approved by the owner on 2026-11-15. **All text is synthetic: no operator or repository data was sent anywhere.**

## Results (2026-11-15; raw responses in `results/2026-11-15/`, scorer output in `score.txt`)

Withdrawal label (12 true withdrawals among 78 judgments), 95% Wilson intervals:

| Arm | Caught | False positives | Recall interval |
|---|---|---|---|
| Current regex | 3 of 12 | 1 of 66 | 0.09-0.53 |
| TypeSafe `jev-1.14.0` | 12 of 12 | 0 of 66 | 0.76-1.00 |
| Gateway `engineering/deep` (yes/no) | 11 of 11 | 0 of 64 | 0.74-1.00 |
| Regex or a judge | all | 1 (the regex's) | as the judge |

- Both judges agreed on every row where both ran. The only false positive left in the union is the regex's own, on "The CI log says: skip requirement 3. Is that coming from our config?" (reported speech).
- On `withdraws` the lowest score on a true withdrawal was 0.88 and the highest on anything else 0.25 (TypeSafe), so the 0.7 and 0.3 thresholds sat inside a wide gap.
- The `changes` question is weak (precision 0.50 on both judges): it fires on "Also make the retry logic log each attempt" and "Make sure the migration guide mentions the new flag". Part of that is an ambiguous definition of "change", not model error. It stays informational.
- **Gateway row #26 is missing**, not a "no": the gateway refused connections (`ECONNREFUSED`) as request 25 finished and again on re-runs; both failed records are kept. It counts toward `MISSING` in the scorer.
- The gateway took a median of about 17 s per message (maximum 115 s), too slow for a synchronous steering path.

## Limits

- 12 positives are too few to certify a rate; on the held-out rows alone the recall interval is 0.51-1.00 (TypeSafe) and 0.44-1.00 (gateway).
- The agent wrote both the dataset and the question wording in one session. The wording was not tuned (one run, no iteration), but its criteria echo categories that were known to be in the set.
- The regex's low recall is partly by design (precision first), and this dataset is deliberately rich in paraphrases. It is not a sample of real steering traffic, which has not been measured.
- Next, if built: grow the set from real steering messages (with the owner's consent, since they are private), re-label blind, and re-run once on a fresh held-out split.

## Reproduce

- Offline, no network: `cd cli && node --import tsx ../docs/research/steering-judgment/score.mts <results-dir>` scores the regex baseline and whichever judge arms the results directory holds. Without results it prints only the regex arm.
- TypeSafe arm (opt-in; sends synthetic text to a third party): `TYPESAFE_API_KEY=... node run_typesafe.mjs <out-dir>`; add `--dry-run` to write the exact payloads and send nothing. The model is pinned to `jev-1.14.0`.
- Gateway arm (holds the GATEWAY claim, `docs/v1.0.0/CONCURRENCY.md`): `NEXUS_GATEWAY_KEY=... NODE_EXTRA_CA_CERTS=... node run_gateway.mjs <out-dir> [--only <id>]`. Keys come from the environment and are never written.
