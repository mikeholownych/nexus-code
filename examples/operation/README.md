# Operation with `git.isolate`

`isolate.json` is a spec for `nexus operation run examples/operation/isolate.json` (experimental). With
`"git": { "isolate": true }` every unit runs on its own worktree and branch and completions merge into an operation
branch, which is what makes `policy.maxConcurrentUnits` above 1 legal: without isolation two units would write the
same checkout, and the spec is refused.

`semantic-conflict.json` has two independent units that touch different files: one changes a unit of measure, the
other adds a helper and a test that rely on the old one. Each passes alone and Git merges them without a conflict.
The merged tree is checked with every integrated unit's verifier, so the first unit integrates and the second blocks
with a decision that names both (see [PA-2](../../docs/v1.3.0/PA2_VERIFIED_MERGES.md)).
