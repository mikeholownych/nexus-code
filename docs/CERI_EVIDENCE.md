# CERI evidence: what the integrity record means

Applies to `cli/src/ceri/` (an unwired library used by tests; no shipped command reads it).

## What it is

A finalized CERI run directory holds `manifest.json`, `assertions.json`, `events.jsonl`, optionally `receipts.json`, and `integrity.json`. The record lists a SHA-256 of every other file and a composite hash of those. On load, `CeriEvidenceStore` checks that the record exists, names this run, covers exactly the regular files present, and that every hash matches.

## What it is not

The record is **local and same-user**. It is not signed, not authenticated and not tamper-proof. Anyone who can write the evidence directory as the same user can edit a file and rewrite `integrity.json` (and a baseline spec's `manifestSha256` and identity) to match. Nothing here defends against that, and no CERI result is external qualification evidence.

What it does detect: accidental corruption, truncation, a partial write, a file added or removed, a record copied from another run, and an evidence file edited without re-recording.

## Checks on load and on write

- `passed` must be a JSON boolean; `"false"` is rejected, not read as true.
- A run id is never reused or overwritten; ids are validated names (letter or digit first, at most 128 characters of `A-Za-z0-9_.-`, no `..`, no `.abandoned-`), and an id that differs only by case from an existing one is refused.
- Containment uses resolved paths: the evaluation and run directories must be real directories (not symlinks) inside the real store root.
- A crashed run is quarantined with `abandonRun`; pre-integrity evidence is re-recorded by an operator with `migrateLegacyRun`, which marks the record `migrated`.

## Baselines and comparisons

`CeriBaselineComparator.loadVerifiedBaseline(store, spec)` accepts a baseline only if its evidence passes the integrity check, `spec.manifestSha256` is the hash of the stored manifest, and the recorded identity equals that manifest's identity. `compareToVerifiedBaseline` marks a result `certifying` only when the candidate's model name, digest and quantization, sampling, fixture identity, evaluator and evaluation versions, configuration and toolchain all match the baseline. Otherwise the result is non-certifying and `identityBinding.mismatchedFields` names every field that differs or is not recorded.

`CONFIRMED_REGRESSION` requires a certifying comparison plus a different, verified earlier run that regressed the same assertion against the same baseline. A caller flag cannot produce it. Comparisons made with caller-supplied assertions or manifests stay non-certifying.

"Certifying" here means bound to local evidence under the limits above; it does not mean externally attested.
