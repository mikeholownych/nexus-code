# Workspace plugins

This page is about plugins that a repository carries: JavaScript modules in `<workspace>/.nexus/plugins/` and
`<workspace>/plugins/`. Plugins you keep in `~/.nexus/plugins/` and `~/.config/nexus/plugins/` are your own; nothing
here changes them. Installed plugin packages (`nexus plugins install`) and the plugin API are described in
[`SKILLS_AND_PLUGINS.md`](SKILLS_AND_PLUGINS.md).

A workspace plugin runs inside the Nexus process with all of its authority. From v1.3.0 a workspace plugin file is
loaded only when **that file's exact bytes** are approved by you. In-process workspace plugins are kept for now and are
deprecated.

```bash
nexus plugins list                          # what is loaded, and what is not and why
nexus plugins trust .nexus/plugins/audit.js # review first; asks in a terminal; records the file's SHA-256
nexus plugins revoke .nexus/plugins/audit.js
nexus doctor                                # finding plugins.workspace
```

## What decides whether a workspace plugin loads

All of these, in this order:

1. The session is not read-only and the workspace is trusted (`nexus trust`). Trust is still required; it is no longer
   enough.
2. Managed policy does not refuse the file (`plugins.disable_workspace`, `plugins.allow`). A policy refusal stands
   whatever you approved.
3. The file can be read as a plugin file: a regular file, not a symbolic link, without a second hard link, at most
   1 MiB, valid UTF-8.
4. Its bytes are the ones you approved for this workspace path. One changed byte, and it waits for a new approval.
5. No plugin of yours (in `~/.nexus/plugins/` or `~/.config/nexus/plugins/`) has the same name: yours is the one used,
   and the workspace's is reported as `shadowed`.

The statuses `nexus plugins list` shows: `trusted` (approved and loaded), `untrusted`, `changed`, `invalid`,
`policy-refused`, `shadowed`, and `load-failed` (approved, but the import failed, with the reason).

Approving needs a person at a terminal: without one, `nexus plugins trust` shows the file's hash and approves nothing,
whatever `--sha256` says. The file is read again after you answer, and nothing is recorded if it changed while you were
asked. A command that runs outside the sandbox with your rights can still fake a terminal or write
`~/.config/nexus/extension_trust.json` itself; run the agent sandboxed, or keep approvals on, when the repository is
not trusted. An approvals file that a repository ships is never read: only the one in your configuration directory is.

## How an approved plugin is run

Nexus reads the file once, and imports those same bytes from a private copy in a temporary directory (mode 700, one
file, removed after the import), not from the workspace. So what runs is what was hashed, even if the file is replaced
at that moment. It also means the plugin is **one file**:

- `import "./lib.js"`, `require("./lib")` and dynamic `import("./x.js")` of a sibling do not resolve;
- a bare package import (`import x from "some-package"`, `require("some-package")`) does not resolve either: the
  workspace's `node_modules` is not on the path of the copy;
- reading a file beside the plugin through `import.meta.url` or `__dirname` finds nothing.

A plugin that fails for one of these reasons is reported, not dropped: one notice names it, `nexus plugins list` and
`nexus doctor` show `load-failed` with the error, and the approval is kept (fix the file and approve the new bytes).

What an approved plugin does at run time is its own business, and yours for having approved it: an absolute
`import("/path/to/other.mjs")`, a `child_process` call or a file read by absolute path are not checked. Review the file
before you approve it.

## Migrating workspace plugins

**What changed.** Before v1.3.0, trusting a workspace (`nexus trust`) loaded every `*.js` and `*.mjs` file in its
plugin directories, with their sibling files and the workspace's packages in reach. From v1.3.0:

| Before | Now |
|---|---|
| `nexus trust` loads all workspace plugins | each plugin file also needs `nexus plugins trust <file>` |
| a changed plugin file is loaded as it is | a changed file is not loaded until approved again |
| a plugin may import sibling files and workspace packages | a plugin is one self-contained file |
| a plugin that fails to import is silently skipped | it is reported as `load-failed` with the reason |
| a workspace plugin can replace a plugin of yours with the same name | yours is used; the workspace's is `shadowed` |

**What stops loading after the upgrade.** Every workspace plugin, until you approve it. Nothing is approved for you.
The first session in such a workspace prints one notice that lists the files with the command for each:

```text
nexus: 2 workspace plugins are not loaded. Since v1.3.0 each workspace plugin file needs its own approval; trusting the workspace no longer loads them. Review each file, then run in a terminal:
  nexus plugins trust .nexus/plugins/audit.js
  nexus plugins trust plugins/format.mjs
```

`nexus doctor` reports the same as the warning `plugins.workspace`, and `nexus plugins list` shows each file's status.
A hook the plugin provided (a `preToolExecution` that refuses calls, say) is **not running** until then.

**What to do.**

1. Read each plugin file. Approve it with `nexus plugins trust <file>` in a terminal.
2. If the plugin imports sibling files or packages, it will show as `load-failed`. Make it one file (bundle it, or
   inline the helpers), then approve the new file.
3. Consider moving it out of the repository: a plugin in `~/.nexus/plugins/` is yours, needs no approval, and cannot be
   changed by the repository.
4. A plugin whose job is to refuse or log tool calls is better written as a command hook, which runs as a separate
   process and can only deny: see [`HOOKS.md`](HOOKS.md). `preToolExecution` that refuses maps to a `pre-tool` hook,
   `onToolResult` logging to a `post-tool` hook. A middleware that rewrites tool arguments has no hook equivalent.
