# Held-out T2 corpus: custody verification (read-only)

| | |
|---|---|
| Date | 2026-10-17T17:24Z |
| Verifier role | Independent custodian (read-only; did not author the corpus) |
| Store | `~/nexus-heldout/` (owner `mike`, mode `0700`) |
| Target | `~/nexus-heldout/tasks/` — T2 held-out tasks (SPEC-10 §2.1, REQ-QUAL-101) |
| Scope | Manifest↔disk reconciliation, sha256 recomputation, provenance, language/class coverage, reference-patch coverage. No payloads reproduced here. |

**Verdict: NOT FROZEN and NOT YET INDEPENDENTLY VERIFIABLE. The corpus is 28/40 tasks; only 20 are manifested; the `hidden_sha256` derivation is undocumented, so hidden tests cannot be independently verified. The corpus must not be used for published held-out evidence until the gaps below are closed and the manifest is committed to the repository before the RC freeze.**

## 1. Method

1. Enumerated `tasks/` and the two manifests (`MANIFEST-batch1.json`, `MANIFEST-batch2.json`).
2. Recomputed `task_sha256` as `sha256(task.json raw bytes)` and compared to every manifest entry.
3. Attempted to recompute `hidden_sha256` under every plausible canonical scheme (raw file bytes; single-file sha; sorted `name+content` concatenation; `name sha256` lines; git-blob; JSON encodings of the hidden object; reference-patch bytes).
4. Counted language/class coverage and reference-patch/validation-log coverage.

Manifest digests at verification time (tamper anchor):

```
5a61bdc40e58e88cc740ee40e3fae86cfabddb77349db67b85b2df00944e9ea1  MANIFEST-batch1.json
70f0b05913cefdcdcd404d6ac83bfeafc4baf21d524055402ff7ae2ec064dac1  MANIFEST-batch2.json
```

## 2. Findings

### 2.1 Completeness (target: 40 tasks, ≥ 20 external repos, ≥ 6 per class)

| Measure | Result |
|---|---|
| Task directories on disk | **28** |
| Directories with a complete `task.json` | **25** |
| Directories with `hidden/` only (no `task.json`) | **3** — `ho-go-feature-03`, `ho-go-refactor-01`, `ho-rs-bugfix-03` |
| Manifested tasks (batch1 + batch2) | **20** (10 + 10) |
| Complete but **unmanifested** | **5** — `ho-go-bugfix-01`, `ho-js-bugfix-03`, `ho-js-debug-03`, `ho-py-feature-03`, `ho-py-refactor-03` |
| External-repo tasks | 25 / 25 complete (0 fixture tasks) ✅ ≥ 20 |
| Classes (complete tasks) | bugfix 7, debug 6, feature 6, refactor 6 ✅ ≥ 6 each |
| Languages (manifested) | go 4, java/type-script 6, python 6, rust 4 ✅ all four covered |

The corpus is **short of the 40-task target** and is being authored in batches (the `HELDOUT_AUTHORING` claim reads "batch 1 of 4: 10 T2 tasks", i.e. authoring is still in progress).

### 2.2 Hash integrity

| Hash | Scheme | Result |
|---|---|---|
| `task_sha256` | sha256 of `task.json` raw bytes | **20 / 20 verified ✅** |
| `hidden_sha256` | **undocumented** | **0 / 20 reproducible ✗** |

`task_sha256` is well-defined and every manifested task matches. `hidden_sha256` could not be reproduced under any of the schemes in §1.3, and no generator script for the manifests exists in the store, the repo, or `bin/` (`bin/` holds only `check_schema.mjs`, `validate.mjs`, `validate.py`, `claimwait.py`). **A third party cannot verify that the hidden tests on disk are the ones the manifest attests to.** The hidden files for the manifested tasks predate their manifests, so this is a documentation gap, not (currently) evidence of tampering — but it is a custody defect that blocks independent acceptance.

### 2.3 Reference coverage

Reference patch **and** validation log present for **25 / 25** complete tasks (`reference/<id>.patch`, `reference/<id>.validation.log`). Notes on injection/squash are in `reference/NOTES.md`. ✅

### 2.4 Provenance / independence

- The on-disk corpus is **authored under the `HELDOUT_AUTHORING` claim**, whose `owner.json` names `claude-lead (delegated to an isolated author subagent)`. It is **not** the implementing agent (codex). Whether `claude-lead` is independent of the implementation session (no access to Nexus source, the development set, or tuning history) is **not evidenced** in the store and must be confirmed (see `heldout-authorship-handoff-2026-10-17.md`).
- The manifest of sha256 hashes is **not committed to the repository** (`eval/heldout-manifest.json` is referenced by CONCURRENCY §8 and PLAN-10 but does not exist). REQ-QUAL-101 requires the manifest to be committed before the RC freeze.

## 3. Defects and gaps (blockers to held-out use)

| # | Gap | Requirement |
|---|---|---|
| C1 | Corpus incomplete: 28/40 dirs; 20 manifested; 3 dirs lack `task.json` | REQ-QUAL-101 (≥ 40 tasks) |
| C2 | `hidden_sha256` scheme undocumented and non-reproducible | REQ-QUAL-105/106, CONCURRENCY §8 (sealed manifest) |
| C3 | Corpus manifest not committed to the repo before freeze | REQ-QUAL-101, CONCURRENCY §8 |
| C4 | Author-independence from the implementation session not evidenced | CONCURRENCY §8, REQ-QUAL-101 |
| C5 | Reference validation logs not independently re-run by the custodian (trusted as recorded) | REQ-QUAL-106 |

## 4. Required before freeze (custodian disposition)

1. Finish authoring to ≥ 40 tasks (≥ 20 external, ≥ 6/class) under a **separate, independent** author session (see handoff).
2. **Document the `hidden_sha256` derivation** in the store (e.g. `bin/` or a `MANIFEST.md`), then re-verify all 20 — and verify the remaining tasks as they are manifested.
3. Commit the sealed manifest to `eval/heldout-manifest.json` (or the path PLAN-10 names) **before RC1**, and hash the manifest itself.
4. A custodian other than the author re-runs `bin/validate.py` for every task (setup, hidden fails pre-patch, patch passes, regression passes) and records the results.
5. Freeze: after the manifest is committed and verified, no case swap, threshold change, or payload disclosure to the implementation/tuning agent. Any later disclosure for debugging is recorded and the exposed tasks are retired from fresh held-out use.

No payloads, hidden test bodies, or validators are reproduced in this report.
