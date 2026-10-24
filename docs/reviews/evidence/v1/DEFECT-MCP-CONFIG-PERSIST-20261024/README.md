# DEFECT: MCP server config saved world-readable and silently clobbered

| | |
|---|---|
| Base revision | `b0240273dc6824c068e6f65719fbbdacf2efb889` (`origin/main`) |
| Branch | `v1/defect-mcp-config-persist` |
| Affected behavior | `McpClientManager.addServer(..., saveToConfig=true)` wrote `~/.config/nexus/mcp.json` with default permissions (`0644` under the usual `022` umask) and created `~/.config/nexus` as `0755`, although an MCP server definition may carry its own token in `env`. It also parsed the existing config inside a `catch {}`; an unparseable file was treated as empty and replaced, silently deleting every other server definition. The caller was told "Saved to ~/.config/nexus/mcp.json" in both cases. |
| Severity | Medium: local credential disclosure to other users on a multi-user host, and user-visible configuration loss on a syntax error. |

## Reproduction (pre-fix)

With `HOME` isolated and umask `022`, an existing `~/.config/nexus/mcp.json` containing another server plus a
trailing comma (invalid JSON) was passed through `addServer` with a test stdio server whose `env` carried
`FAKE_TOKEN=s3cr3t-value`:

```
result  {"success":true,"toolCount":0,"resourceCount":0,"promptCount":0}
mode    644  dir 755
content {"mcpServers":{"fake":{...,"env":{"FAKE_TOKEN":"s3cr3t-value"}}}}
```

`keep` was gone, the token was group/world-readable, and no failure was reported.

## Fix

- Create `~/.config/nexus` as `0700` and tighten an existing directory to `0700`.
- Write the JSON to a `0600` temporary file, `chmod 0600`, then `rename` it over the target atomically (following an
  existing symlink's target so dotfile symlinks keep working); remove the temporary file on failure.
- Parse and validate the existing config before writing. A non-object or unparseable file is left byte-for-byte
  untouched; the connection still succeeds but `addServer` returns `persisted: false` and `persistError`.
- Report that state in the REPL wizard and `/mcp add` instead of claiming the configuration was saved.

## Verification

- New `cli/test/mcp.test.ts`: 2/2. On the pre-fix `mcp.ts`, the first test fails with
  `config mode 644 leaks a server token to other users` and the second with the overwritten-config assertion
  (the broken bytes were replaced). Both pass after the change.
- `test/workspace_trust.test.ts` (environment allowlist, MCP config selection): 7/7 together with the new file.
- `npx tsc --noEmit -p tsconfig.json`; `git diff --check`: pass.

## Residual risk

- Tightening an existing `~/.config/nexus` to `0700` relies on the directory being owned by the current user; if it
  is not chmod-able, persistence now fails closed (connection succeeds, `persisted: false`) rather than writing to a
  directory whose mode cannot be secured.
- A dangling symlink at the config path is replaced rather than followed; a valid symlink continues to have its
  target file replaced.
- Refusing an unparseable config requires the operator to fix the JSON before the new server can be persisted; the
  in-memory connection still works for the current session.
- MCP config files loaded from an untrusted workspace remain governed by the existing workspace-trust gate; this
  change covers only the manager's own persistence path.
