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

Two related errors: `normalize` ran while the backslashes were still literal characters, so it did
not collapse the `..` segments; and joining under an absolute fake root let `..` clamp at `/`, so a
target such as `../../../nexus/file` "escaped and returned" lexically and passed while the real link
resolved above the package root.

## Fix

Resolve from the package-relative entry directory after converting separators, so `..` segments are
preserved for the check:

```ts
const entryDir = path.posix.dirname(entryPath.replace(/\\/g, "/"));
const resolved = path.posix.normalize(path.posix.join(entryDir, linkname.replace(/\\/g, "/")));
```

Reject an empty resolution, a first segment other than `expectedRoot`, or any remaining `..` segment.
This rejects both `..\..\outside` and the escape-and-return spelling; in-root targets such as
`../inside`, `..\inside`, `nexus/file` and `../nexus/file` from `nexus/link` still pass.

## Verification

- New `cli/test/tar_safety.test.ts`: 4/4 pass.
- The traversal and escape-and-return tests fail on the pre-fix source; the escape-and-return test
  also fails on the intermediate absolute-root implementation.
- In-root backslash targets and normal relative targets still pass; absolute targets and drive letters
  remain rejected.
- `npx tsc --noEmit -p tsconfig.json`: pass (source tree only; `cli/tsconfig.json` does not include tests).
- `git diff --check`: pass.

## Residual risk

A symlink target that is a genuinely literal filename containing backslashes (`..\..\notes`) is now
treated as a traversal on Linux and rejected; that is deliberate for cross-separator consistency.
Bidi/zero-width and non-path archive metadata are out of scope.
