# Operation with `git.isolate`

`isolate.json` is a spec for `nexus operation run examples/operation/isolate.json` (experimental). With
`"git": { "isolate": true }` every unit runs on its own worktree and branch and completions merge into an operation
branch, which is what makes `policy.maxConcurrentUnits` above 1 legal: without isolation two units would write the
same checkout, and the spec is refused.
