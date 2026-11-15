# Release process

Building, packaging and tagging are described in [Development and release](DEVELOPMENT.md#release-package). This page covers the documentation steps that follow a stable tag.

## After the stable tag

The release workflow does not touch the README, the CHANGELOG or `docs/releases/LATEST`. Once the stable tag is published, make a manual follow-up commit (a normal PR) that:

1. Sets `docs/releases/LATEST` to the new stable tag (one line, `vX.Y.Z`).
2. Updates the README status line ("the latest stable release is ...") and the README and `quickstart.md` install pins to that tag, and removes any "in development" wording for it.
3. Replaces `Unreleased` in the CHANGELOG heading of the new version with the tag date.

`node scripts/check_doc_versions.mjs` (run in CI) fails when any of these disagree with `LATEST`, so the follow-up PR is the one that turns it green again. The stable-promotion commit itself passes because `LATEST` still names the previous stable tag and the new version may stay `Unreleased` until `LATEST` moves.

v1.2.0 needs this follow-up: `LATEST` is `v1.1.4` and the CHANGELOG heading `[v1.2.0]` says `Unreleased` until it is done.
