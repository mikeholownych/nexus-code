# Repository protections for the v1 release

This is a proposal. As of 2026-10-18 the repository has no rulesets, no branch protection and no tag protection.
Applying these rules is an administrative settings change, and the repository owner makes it.

## Current state (read-only inspection, 2026-10-18)

| Setting | Value |
|---|---|
| Rulesets / branch protection / tag protection | none |
| Collaborators | `mikeholownych` (admin) only; every agent pushes as this account |
| Default workflow token | `read`; workflows request extra permissions themselves (`release.yml`: `contents`, `id-token`, `attestations` write) |
| Actions | all actions allowed; SHA pinning not required |
| Environments | none |

All agents share one GitHub identity, so GitHub cannot separate authors from reviewers. A rule requiring an approving
review would deadlock every PR, because an author cannot approve their own PR. Independent review therefore stays
where it is recorded today: separate reviewer agents, the claim log and the evidence directories. The rules below
enforce what GitHub *can* check: required CI, no history rewriting, and immutable release tags.

## Rules

`rulesets/protected-branches.json` covers `main` and `v1/integration`:
- no deletion and no force-push;
- changes only through a pull request (0 required approvals, for the reason above);
- required checks: `test-matrix (20)`, `test-matrix (22)`, `test-matrix (24)`, `linux-x86_64` and
  `cloudflare-contest-contract`, all from GitHub Actions;
- the strict "branch must be up to date" policy is **off**. See the deadlock analysis below. CONCURRENCY §5.4
  (rebase onto the base, then rerun) remains the process rule.

`rulesets/release-tags.json` covers `refs/tags/v*`:
- tags can be created, but never moved or deleted.

No bypass actors are defined. To repair a mistaken tag, the owner disables the ruleset, records why, and enables it again.

## Lifecycle check (ACCEPTANCE §1.1)

1. **RC source to `main`.** PR #8 (`v1/integration` to `main`) needs the required checks. It is merged with a merge
   commit `M`. The RC tag `v1.0.0-rc.N` goes on `M`, which is on `main`, so `release.yml`'s ancestry check passes.
   Creating a tag is allowed.
2. **RC rebuild.** A fix is merged through PRs, and a new tag `rc.N+1` is created. Old RC tags stay as evidence.
3. **Stable promotion.** Commit `S` changes only the version and sits directly on the accepted RC commit `M`. A PR
   from a branch whose head is `S` targets `main`. While `main` is still `M`, `S` is already current, and the merge
   keeps `S` in `main`'s history. Tag `v1.0.0` goes on `S`. `release.yml` verifies it is version-only on `rc.N`.
   - With strict "up to date" checks, any merge to `main` between the RC and the stable commit would force an update
     merge into the PR branch. `S` would then no longer be directly on the RC, which is the deadlock that keeping
     strict mode off avoids.
   - Process rule: **nothing else merges to `main` between the accepted RC and the stable tag.**
4. **Publication.** `release.yml` creates the stable release as a draft. `gh release edit v1.0.0 --draft=false` is not
   affected by these rules.

## Apply, verify, roll back (owner)

```sh
R=repos/mikeholownych/nexus-code
gh api -X POST "$R/rulesets" --input docs/releases/rulesets/protected-branches.json
gh api -X POST "$R/rulesets" --input docs/releases/rulesets/release-tags.json
# verify
gh api "$R/rules/branches/main" -q '[.[].type]'           # deletion, non_fast_forward, pull_request, required_status_checks
gh api "$R/rules/branches/v1/integration" -q '[.[].type]'
gh api "$R/rulesets" -q '.[] | "\(.id) \(.name) \(.enforcement)"'
# roll back one ruleset
gh api -X DELETE "$R/rulesets/<id>"
```

After applying, `git push origin <sha>:main` should be rejected, and so should moving or deleting an existing `v*`
tag. A PR with green required checks should still merge.
