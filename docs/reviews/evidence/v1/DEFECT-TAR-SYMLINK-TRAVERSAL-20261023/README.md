# DEFECT: backslash-separated `..` symlink targets bypass archive confinement

| | |
|---|---|
| Base revision | `4bf6e2b041dc2efb54af551a73796aacc54494a3` (`origin/main`) |
| Branch | `v1/defect-tar-symlink-traversal` |
| Affected behavior | `isSymlinkSafe` converted `\` to `/` **after** `path.normalize`, so `..\..\outside` survived normalization as literal characters and passed the `expectedRoot` check. The equivalent `../../outside` was rejected. |
| Severity | Low on the supported Linux target: a Linux extractor stores the backslashes literally, and the post-extraction `realpath` containment walk then fails or stays inside. The validator's own cross-separator contract is wrong, and an extractor that treats `\` as a separator (Windows) would escape. |

## Reproduction (pre-fix)

```ts
isSymlinkSafe("../../outside", "nexus/dir/link")          // { safe: false }
isSymlinkSafe("..\\..\\outside", "nexus/dir/link")        // { safe: true }  <-- bug
isSymlinkSafe("sub\\..\\..\\..\\outside", "nexus/dir/link") // { safe: true }
```

## Root cause

```ts
const resolved = path.normalize(path.join("/", entryDir, linkname)).replace(/\\/g, "/");
```

`normalize` ran while the backslashes were still literal characters, so it did not collapse the
`..` segments. The later replacement produced `..` segments that the first-segment check ignored.

## Fix

Normalize separators before joining/normalizing, using the platform-independent POSIX path
implementation, and reject any remaining `..` segment:

```ts
const entryDir = path.posix.dirname(entryPath.replace(/\\/g, "/"));
const resolved = path.posix.normalize(path.posix.join("/", entryDir, linkname.replace(/\\/g, "/")));
```

## Verification

- New `cli/test/tar_safety.test.ts`: 3/3 pass.
- The traversal test fails on the pre-fix source at `..\..\outside` (returned safe) and passes now.
- In-root backslash targets (`..\inside`) and normal relative targets still pass; absolute targets and
  drive letters remain rejected.
- `npx tsc --noEmit -p tsconfig.json`: pass; `git diff --check`: pass.
