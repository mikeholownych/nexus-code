# WP-131-08 / #800 containment `startsWith("..")` fix

Measured on branch `v1/security-containment-800` against `release/v1.3.1` (`e578571b` base).

## Helper

`cli/src/path_within.ts` exports `isPathWithin` / `pathEscapesRoot` / `isPathStrictlyWithin` with the correct segment check:

`relative === ""` (inside) or not (`relative === ".." || relative.startsWith("../")` after `\`→`/` normalize, or absolute relative).

`sandbox.isPathWithin` already had the correct form (PF-3); this module is a zero-dep twin so light call sites do not import sandbox. `FILE_cli_src_sandbox.ts` was held by another claim; sandbox was left unchanged.

## Site disposition (before → after)

| Site | Before bug effect | After |
|---|---|---|
| `browser.ts` (navigate/symlink/screenshot) | Jail refuse: **fail-closed** (over-refuse `..hid`) | Correct jail |
| `core/authority.ts` (cwd/path/subtree) | Jail refuse: **fail-closed** | Correct |
| `core/candidate.ts` (touches candidate) | Classification: wrong outside | Correct inside |
| `core/observation_identity.ts` | Classification: wrong outside | Correct inside |
| `lsp.ts` `outsideRoot` | Document open: **fail-closed** | Correct; local `isInside` already correct |
| `safe_fs.ts` `relativeParts` | Doctor/fs mutations: **fail-closed** | Correct |
| `security.ts` (verification rels/restore) | Rel listing miss / restore refuse: mixed; restore of `..hid` path was refused (**fail-closed**) | Correct |
| `skills.ts` (symlink outside trust) | Untrusted treat: **fail-closed** for in-workspace `..hid` links | Correct |
| `tester.ts` `typecheckSignatures` | Display: showed absolute for `..hid` | Workspace-relative |
| `workspace_trust.ts` `isWorkspaceFile` | Trust/MCP: **fail-open** if used to *exclude* workspace-owned paths from policy (file under `..hid` not treated as workspace file) | Correct |
| `worktrunk/copy.ts` `insideOrEqual` | Copy safety: **fail-closed** for `..hid` under source | Correct |
| `worktrunk/paths.ts` `resolveWorktreePath` | Path admit: **fail-closed** | Correct |

PF-3 already fixed the high-impact fail-open socket-hide case in `sandbox.ts` / `sidecar.ts`. This sweep closes the remaining `git grep` sites from #800.

## Verification

```text
HOME=$(mktemp -d) node --import tsx --test test/path_containment.test.ts
# 10/10 pass
```

## Reference coding / XERJ

- Queried XERJ `opencode` corpus for path containment; hits were unrelated (Figma plugin API / UI folder helpers). Rejected.
- Took: in-repo `sandbox.isPathWithin` (PF-3) and #800’s stated formula.
- Fallback: `git grep 'startsWith("..")'` on `cli/src`.
