# Experiment 2B Independent Review Record

**Date:** 2026-10-02
**Disposition:** Shared-ref authority result independently confirmed
**Reviewer model/profile:** **UNKNOWN** for both separate reviewer executions.

## Reviewer 1 — `/root/independent_e2_final_review`

- **OBSERVED:** Inspected the live repository `nexus-exp1-oct02/nexus-exp2b-shared-refs`, ID `s9jethbwn3ebkqoh`, executor Worker `nexus-exp2b-shared-ref-20261002`, and the E2B JSON/source. At review start the JSON hash was `473122770886433033dfdf4357cb7121760fe9f84fb68c16d7fe704b1c099478`; the executor later added a truthful completion record and cleanup details.
- **OBSERVED:** With fresh repository-scoped credentials and ordinary Git, independently exercised all six writes: A→candidate A/B/main and B→candidate B/A/main all succeeded. Reviewer readback observed the resulting pushed SHAs.
- **OBSERVED:** Restored the executor's final state: `main` at `ec3affd0e916b895e3528de6747b632f428359c0`, candidate A at `60e149fd4e79edbc2376a891346f89ec6147d39b`, candidate B at `bab7fe248718bfefcda10f6c87b00af4d6e5706b`. Fresh `git ls-remote` and a separately deployed authenticated Artifact binding Worker agreed on SHA/tree/parents/file digests.
- **OBSERVED:** Unauthenticated Worker read and fork calls returned 401. Reviewer credentials were revoked and its temporary Worker deleted. Executor resources were left live.
- **Disposition:** Repository-scoped write authority confirmed; ref-scoped authority was not observed.

## Reviewer 2 — `/root/independent_e2_review`

- **OBSERVED:** Independently inspected the current live repository and Worker, minted fresh credentials, repeated all six ordinary Git pushes, and observed all accepted. Fresh Git readback confirmed the restored executor state, trees, direct parents, merge base, and file SHA-256 values.
- **OBSERVED:** Unauthenticated `/read` and `/fork` calls returned 401. Gitleaks scans of E2B evidence, Markdown, runner, and Worker source found no leaks. Remotes had no userinfo; local/system Git config had no authorization headers. Reviewer tokens were revoked and verified revoked.
- **UNKNOWN limitation:** This reviewer did not have the executor's Worker secret file and therefore did not reissue an authenticated request to the executor Worker. Reviewer 1 independently deployed a separate protected Worker and confirmed binding readback. The second reviewer also checked that first review record against current Git state and source.
- **Disposition:** Independently confirmed repository-wide authority for the tested refs; no ref-scoped authority observed.

## Evidence/source boundary

The first reviewer encountered the executor harness stopping during its final `ls-remote` step after the six authority pushes and Worker reads had completed. The executor added direct fresh-clone Git comparison and documented the exact harness defect. The second reviewer independently confirmed the refs/comparison facts with a fresh clone. Neither review treats the original script exit as a Cloudflare failure or as proof by itself.

The review confirms a substrate authority fact. It does not establish agent collaboration, candidate quality, performance at scale, or the best permanent architecture.
