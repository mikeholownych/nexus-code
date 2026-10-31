# RC14 scripted PTY qualification

This packet records the installed-RC scenarios required by `docs/v1.0.0/ACCEPTANCE.md` §5.2. It is separate from the five-terminal manual matrix, which DEC-20 waives for v1.0.0. Runs use the immutable published `v1.0.0-rc.14` package and the repository's local synthetic `mockgw.py`; they do not access the live gateway, credentials, user workspaces, or held-out tasks.

## Bound artifact and runtime

- RC tag: `v1.0.0-rc.14`
- Source commit: `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99`
- Linux archive SHA-256: `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`
- Installed command output: `1.0.0-rc.14 (16eeb6eeffe7)`
- Runner source: `docs/v1.0.0/evidence/D_pty/` at the source commit recorded in `run-manifest.json`.
- The PTY helper is copied to a temporary directory and patched only to bind the installed RC's `NEXUS_HOME`, `nexus-tui`, `sidecar.js`, and `index.js` paths, and to seed the isolated fixture workspace as trusted. Setting `NEXUS_HOME` matches the exact installed launcher's environment. The project files in `docs/v1.0.0/evidence/D_pty/` remain unchanged.
- Each scenario uses a fresh synthetic workspace and HOME. The mock server binds to `127.0.0.1` on an ephemeral port.

## Scenarios and acceptance checks

The runner executes s1 (unreachable endpoint), s2 (continuous typing and paste during approval at 40×14), s3 (completion disposition), s4–s6 (cancel/steer), s7 (resume), s8–s9 (tool cancellation and exit cleanup), and r1a/r1d REPL approval checks. Individual stdout, stderr, exit codes, PTY byte streams, screen dumps, mock-gateway request logs, and isolated fixture state are retained by attempt. A zero exit code alone is not a pass: the reviewer must compare each captured behavior with §5.2's stated predicates.

## Reproduction

Install the published asset with the official installer into a disposable prefix and isolated HOME. Verify the archive digest above and installed `nexus --version`, then run:

```sh
NEXUS_PREFIX=/path/to/disposable/prefix \
NEXUS_NODE_PATH=/path/to/node-22-or-newer/bin \
PTY_PYTHON_PATH=/path/to/pinned-python-packages \
  docs/reviews/evidence/v1-qualification/rc.14/scripted-pty/run-installed-rc.sh \
  docs/reviews/evidence/v1-qualification/rc.14/scripted-pty/attempt-<unique-id>
```

The runner refuses to overwrite an existing attempt directory. Retain failed and interrupted attempts; use a new unique output directory for a retry. The Python driver dependencies are pinned with hashes in `requirements-pty.txt`.

## Status

The exact-asset run and per-scenario predicate review are recorded in `run-manifest.json`. The recorded evidence meets each §5.2 predicate, using supplemental attempts where a legacy helper was interrupted or used an obsolete prompt matcher. Independent review is still pending, so the scripted-PTY gate is not yet marked accepted. This packet does not establish full RC acceptance or stable-release acceptance.

The synthetic workspaces' 84 nested Git metadata directories are preserved as per-workspace `.git-metadata.tar.gz` archives; `fixture-git-archives.json` records each archive's size, member count, and digest. This keeps the public packet self-contained without Git submodule pointers.

Per-attempt `SHA256SUMS` cover the files retained in Git. Regenerable
`__pycache__` bytecode and the raw workspace `.git` internals are not committed;
the latter are retained inside the `.git-metadata.tar.gz` archives described
above.
