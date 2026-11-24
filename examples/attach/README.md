# Attaching a second client

`attach.mjs` starts a Nexus sidecar with `--listen`, attaches two clients to its private unix socket (a controller and an
observer), shows that a wrong token is refused and that an observer cannot command the session, runs one prompt through the
controller, and exits 0 only when the observer saw the same turn finish. The protocol is in
[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md), "Socket transport".

```bash
# an installed release: the Nexus home is two levels above the real bin/nexus
NEXUS_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v nexus)")")")"
NEXUS_SIDECAR="$NEXUS_HOME/lib/cli/dist/sidecar.js" node examples/attach/attach.mjs
# a checkout, after `npm --prefix cli run build`
NEXUS_SIDECAR="$PWD/cli/dist/sidecar.js" node examples/attach/attach.mjs
```

The endpoint and model come from the usual settings (`LOCAL_LLM_ENDPOINT`), or from sidecar options in `NEXUS_ARGS`.

The token never appears on stdout: the sidecar prints the socket and descriptor paths, and the descriptor (mode 0600, in a
directory only you can use) holds the token. Anything that runs as you and can read that file can attach, so run model-driven
commands in a sandbox. The program that starts the sidecar stays its owner: closing the sidecar's stdin shuts it down.
