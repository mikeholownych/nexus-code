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

## Your own plugin directories

`~/.nexus/plugins/` and `~/.config/nexus/plugins/` hold plugins that are loaded without any approval, because you put
them there. Two things keep that true:

- The agent's file tools refuse both directories (to read, write, edit or delete, including deleting a directory that
  contains them), whatever the workspace is.
- If you start Nexus **in your home directory** (or any directory that contains it), those directories lie inside the
  workspace, where they cannot be told from repository content. They are then **not loaded** as yours, and a notice
  says so: "start Nexus in a project directory". `~/.nexus/plugins/` is then treated as the workspace's own plugin
  directory, where each file needs an approval.

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

## Workspace manifest plugins (command hooks, no in-process code)

A repository can also carry a plugin that runs **nothing inside Nexus**: a directory
`<workspace>/.nexus/plugins/<name>/` with a `nexus-plugin.json`. It contributes command hooks, which run as separate
processes and can only deny a tool call (see [`HOOKS.md`](HOOKS.md)). This is where a workspace plugin whose job is to
refuse or log tool calls should move.

```text
.nexus/plugins/guard/
  nexus-plugin.json
  hooks.json
  check.sh
```

```json
{ "version": 1, "name": "guard", "pluginVersion": "1.0.0", "permissions": ["hooks"], "contributions": { "hooks": ["hooks.json"] } }
```

`hooks.json` is a hooks file in the format of `docs/HOOKS.md`; a script path in it is relative to the plugin's
directory:

```json
{ "version": 1, "hooks": { "pre-tool": [ { "name": "check", "tools": ["write_file"], "command": ["./check.sh"] } ] } }
```

```bash
nexus plugins list                         # each manifest plugin with its status
nexus plugins trust .nexus/plugins/guard   # in a terminal: shows hooks, files and the tree digest, then asks
nexus plugins revoke .nexus/plugins/guard
```

Rules:

- **Hooks and skills only.** The manifest's `name` is the directory's name; `permissions` may hold `hooks` and
  `skills`; a contribution of `mcp` or `verifiers`, the `tools` permission, or any other key is refused (workspace MCP
  servers belong in `.mcp.json`).
- **The whole tree is approved, by its digest.** Every file in the directory must be accounted for by the manifest:
  the manifest, a hooks file it names, a script or file a hook's command names, or a file of a skill directory it
  names. A file that is not, a symbolic link, or more than 64 files makes the plugin invalid. The approval records the
  tree digest and every file's SHA-256; one changed byte anywhere, or a file added or removed, and the plugin is out of
  force until you approve it again. The notice names what changed.
- **Its hooks are project hooks.** The same command rule as for `.nexus/hooks.json` applies (a script of the plugin
  run directly, or a listed interpreter followed by one; nothing else), the script must lie inside the plugin's own
  directory, its `#!` line is held to the same rule, and it runs from a verified private copy of the approved bytes. A
  hook is shown and recorded as `<plugin>/<hook>` with the source `workspace-plugin`.
- **What stands above your approval:** the workspace must be trusted (`nexus trust`); the session must not be
  read-only; managed policy must not refuse it (`plugins.disable_workspace` refuses every workspace plugin,
  `plugins.allow` admits one by `sha256:<tree digest>`). A policy refusal is not overridden by an approval, and
  `nexus plugins trust` does not record one for a refused plugin.
- **Order.** For one tool call the operator's hooks run first, then the workspace's manifest plugins (by name), then
  the project's own `.nexus/hooks.json`. The first denial ends the chain. No plugin and no file can remove or disable
  another's hooks, and a hook's "allow" has no effect.
- **Skills.** A skill directory a manifest names (`contributions.skills`, a directory with a `SKILL.md`) is recorded
  and covered by the approval, and that is all in this version: it is **not** added to the skill catalog or to any
  request. Loading plugin skills on a trigger is not built yet.
- **Bounds.** A plugin's directory holds at most 64 files, 256 directories, 8 levels and 8 MiB (1 MiB per file);
  past any of these it is invalid. At most 32 plugins are used, from the first 256 entries of `.nexus/plugins/`. An
  unchanged tree is not read or hashed again: Nexus looks at each file's size and times on every tool call and reads
  the tree only when something differs.
- Approving needs a person at a terminal, with the same limit as above for commands that run outside the sandbox.
- **A workspace plugin is not a control over the agent.** Its files are in the workspace, and the agent can edit
  them like any other file. An edit takes the plugin out of force: its hooks stop running, and one notice says so
  (`WARNING: workspace plugin guard is NO LONGER IN FORCE: <file> changed since it was approved`), once per session.
  Nothing unapproved runs, but the guard is gone until you approve again. A guard that must hold against the agent
  belongs in your own `~/.config/nexus/hooks.json`.
- Names of files, plugins and hooks are shown with control and formatting characters written out (`\u001b`), so a
  file name cannot rewrite what you are shown.

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
3. Consider moving it out of the repository: a plugin in `~/.nexus/plugins/` is yours and needs no approval. What
   protects it: it lies outside the workspace, the agent's file tools refuse to read or write that directory in any
   workspace, and under the sandbox the agent's commands cannot reach it. What does not: a shell command that runs
   outside the sandbox with your rights can write there, as it can write any file of yours.
4. A plugin whose job is to refuse or log tool calls is better written as a command hook, which runs as a separate
   process and can only deny: see [`HOOKS.md`](HOOKS.md). `preToolExecution` that refuses maps to a `pre-tool` hook,
   `onToolResult` logging to a `post-tool` hook. A middleware that rewrites tool arguments has no hook equivalent.
