# DEFECT: backslash-separated `..` symlink targets bypass archive confinement

| | |
|---|---|
| Original reproduction baseline (before PR #175) | `4bf6e2b041dc2efb54af551a73796aacc54494a3` |
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

The validator normalized while the backslashes were still literal characters, so it did not collapse
the `..` segments. The initial implementation also joined under an absolute fake root, which clamped
leading `..` segments. This evidence records the original reproduction baseline; PR #176 was based on
`d92f38b17cc145ab22748379cbfa572b711b59b4` and merged at
`d484b9863bd7a83c170958ff9bda62a96c0bc683`.

## Fix

Resolve from the package-relative entry directory after converting separators, so `..` segments are
preserved for the check:

```ts
const entryDir = path.posix.dirname(entryPath.replace(/\\/g, "/"));
const resolved = path.posix.normalize(path.posix.join(entryDir, linkname.replace(/\\/g, "/")));
```

Reject an empty resolution, a first segment other than `expectedRoot`, or any remaining `..` segment.
This rejects targets whose final normalized destination is outside the package root, including
`..\..\outside`. It does not reject a spelling solely for temporarily climbing above the
`nexus/` prefix if the normalized final destination returns inside it. For example,
`../../nexus/file` from `nexus/dir/link` resolves to `nexus/file` and is accepted. In-root targets such
as `../inside`, `..\inside`, and `nexus/file` also pass.

## Verification

- New `cli/test/tar_safety.test.ts`: 4/4 pass.
- The forward-slash and backslash traversal cases whose final normalized target is outside the
  package root fail on the pre-fix source.
- The test distinguishes a final outside target (rejected) from an above-prefix spelling that
  normalizes back inside the root (accepted).
- In-root backslash targets and normal relative targets still pass; absolute targets and drive letters
  remain rejected.
- `npx tsc --noEmit -p tsconfig.json`: pass (source tree only; `cli/tsconfig.json` does not include tests).
- `git diff --check`: pass.

## Residual risk

A symlink target that is a genuinely literal filename containing backslashes (`..\..\notes`) is now
treated as a traversal on Linux and rejected; that is deliberate for cross-separator consistency.
Bidi/zero-width and non-path archive metadata are out of scope.
