# Embedding

`embed.mjs` is a Node program that uses Nexus as a library. It imports the library entry point, starts the Nexus
sidecar as a child process, and asks it to fix the wrong `add()` in `project/` (copied into a scratch repository), with
`node --test` as the authoritative verifier. It prints the outcome and exits 0 only when the outcome is `VERIFIED`:

```bash
# an installed release: the Nexus home is two levels above the real bin/nexus
NEXUS_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v nexus)")")")"
NEXUS_LIB="$NEXUS_HOME/lib/cli/dist/lib.js" node examples/embed/embed.mjs
# a checkout, after `npm --prefix cli run build`
NEXUS_LIB="$PWD/cli/dist/lib.js" node examples/embed/embed.mjs
```

`NEXUS_LIB` is the absolute path of `lib/cli/dist/lib.js` under the Nexus home (the directory that holds `bin/nexus`).
The endpoint and model come from the usual settings (`LOCAL_LLM_ENDPOINT`), or from sidecar options in `NEXUS_ARGS`.

The sidecar runs in review mode, so it asks before each command or edit. The example's `onApproval` allows
`run_command`, `write_file` and `edit_file`, one call at a time, and denies everything else. Without a handler every
request is denied, and the library has no way to approve "always".

See [`docs/EMBEDDING.md`](../../docs/EMBEDDING.md) for the API and what the library guarantees.
