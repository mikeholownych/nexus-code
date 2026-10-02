# Experiment 2 Independent Qualification

**Date:** 2026-10-02
**Disposition:** `EXPERIMENT_2_INDEPENDENTLY_QUALIFIED`
**Reviewer identity/profile/model:** Separate reviewer execution `/root/independent_e2_final_review`; exact model/profile unavailable (**UNKNOWN**).

## Scope and evidence inspected

The reviewer independently examined the live Cloudflare baseline, two recovery forks, temporary Worker source/deployment, structured runner evidence, fresh ordinary Git clones, credential inventory, repository state, and the Experiment 2 acceptance criteria. The reviewed recovery evidence before cleanup was SHA-256 `47c1cf8d132b33acba19c5b1e051e2581aacb7e820a2ac7d66d04a9d63aa6c76`; cleanup metadata was subsequently appended to the retained JSON. Recovery runner SHA-256 was `1388345b4078587a767ebbf7ffdb760c2152058af2bab9b6975ce02434c8c69d`; Worker source SHA-256 was `0829e2306b5235f8b0dc87527df881d7ac7ef1fdc877ff8cc86b36eae078bb9f`.

## Falsification checks

- **OBSERVED:** Baseline repository `nexus-exp1-oct02/external-git-proof` remained at commit `ec3affd0e916b895e3528de6747b632f428359c0`, tree `8a10e93afd210e09f6166ad39d144710011f16ed`.
- **OBSERVED:** Both forks were distinct real repositories, initially preserving that exact commit/tree. Fresh Git clone identity, direct-parent relationships, and Worker readback were checked independently.
- **OBSERVED:** Separate reviewer-created credentials attempted mutation across both forks and the baseline using ordinary Git; allowed own-repository writes succeeded and all four unauthorized writes were denied. The executor evidence independently recorded the same six-cell matrix.
- **OBSERVED:** Fork initial credentials were revoked before actor credentials were issued. Reviewer and executor credentials were tracked by non-secret identifiers and revoked; no plaintext credential was found in reviewed source/evidence/config/remotes.
- **OBSERVED:** The Worker returned 401 for unauthenticated readback and fork requests. Reviewer temporary routes were removed after review. The executor Worker was retained until independent checks finished, then deleted.
- **OBSERVED:** Git merge-base/diff checks established baseline ancestry and separate changes. Fork latency numbers were treated as single-run observations only.
- **OBSERVED:** No event behavior, agent collaboration outcome, or optimal architecture claim was promoted. No core operation was mocked.

## Correction history

- **OBSERVED:** Recovery attempt 1 was rejected for qualification because Git subprocesses inherited secret-like parent environment variables and fork-issued initial credentials were not captured/revoked. The runner was corrected to use an allowlisted child environment and to inventory/revoke initial credentials. Attempt 1 remains preserved separately as unqualified evidence.
- **OBSERVED:** The corrected recovery passed independent review. Reviewer-created probe refs were removed and reviewer credentials revoked before the disposition was issued.

## Limits

This qualifies one bounded two-fork isolation experiment. It does not establish scale, cost guarantees, event guarantees, collaboration improvement, or fork-per-candidate architectural fitness. Reviewer model/profile metadata was not available; no claim about it is made.
