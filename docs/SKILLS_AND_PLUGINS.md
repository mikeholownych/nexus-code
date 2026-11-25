# Skills and Plugins Guide

Nexus Code provides two distinct extensibility mechanisms:
1. **Agent Skills (`SKILL.md`)**: Reusable domain knowledge, procedural guidelines, and prompt instructions that the agent discovers and loads dynamically.
2. **JavaScript Plugins (`.js`)**: Dynamic runtime extensions that hook into agent lifecycle events and register custom executable tools.

---

## 1. Agent Skills

Skills allow Nexus Code to adopt specialized expert personas and workflows on demand without permanently bloating the system prompt.

### Discovery Locations
Skills are discovered from these directories, each holding `<skill-name>/SKILL.md`. When two skills share a name, the first location in this order wins:

1. User global skills, always loaded: `~/.nexus/skills`, `~/.config/nexus/skills`, `~/.agents/skills`, `~/.config/opencode/skills`, `~/.claude/skills`
2. Current workspace, loaded only when the workspace is trusted (`nexus trust .`): `./.nexus/skills`, `./.agents/skills`, `./.claude/skills`, `./skills`

A workspace skill can never replace a user global skill of the same name. In an untrusted workspace, workspace skills are listed as untrusted and `activate_skill` refuses them.

Symlinked skill directories are followed, so a skill linked from another location loads normally.

### Installing skills with the Agent Skills CLI
`.agents/skills` (project) and `~/.agents/skills` (global) are the shared Agent Skills directories. Any installer that writes there works with Nexus. With the open-source [Skills CLI](https://github.com/vercel-labs/skills), installing into those directories for another agent that shares them also makes the skills available to Nexus. For example, `--agent codex` writes to the same directories.

A `nexus` agent entry ("Nexus Code") for that CLI has been prepared but is **not yet part of a released Skills CLI**. Until it is, `npx skills add <owner/repo> --agent nexus` is rejected as an unknown agent.

Treat an installed skill as untrusted instructions. Activating a skill only adds its text to the conversation and records a governed activation id + content digest on subsequent tool receipts (disable with `NEXUS_SKILL_ACTIVATION_IDS=0`).

Frontmatter:

| Key | Effect |
|---|---|
| `name`, `description` | Discovery, ranking, catalog (always) |
| `allowed-capabilities`, `denied-capabilities` | Optional tool-name lists; **enforced only when** `NEXUS_SKILL_CONSTRAINTS=1`, and only as an **intersection** with session authority (never expands it) |
| `allowed-tools` and other keys | Ignored (no grant) |

Every tool call still goes through Nexus's normal approval, filesystem and execution policy. Optional: `NEXUS_SKILL_INTEGRITY=live` blocks tools if the skill file changes after activation; `NEXUS_SKILL_CONFIRM_WORKSPACE=1` asks before activating a workspace skill in review/auto; `NEXUS_SKILL_SYMLINK_POLICY=warn|deny` for realpath-outside-root.

### Local qualification (WP-GS-06)

`nexus skills qualify [name]` evaluates skills against JSON fixtures (`.nexus/skill-fixtures/` or a path passed with `--fixtures`). A passing run records `qualifiedAt` + `qualificationDigest` under `NEXUS_STATE_DIR/skills/index.json`. Content digest drift clears that qualification. Set `NEXUS_SKILL_REQUIRE_QUALIFICATION=1` to refuse `activate_skill` until the current digest is qualified. Air-gapped; no remote registry.

### Creating a Skill
Create a directory with a `SKILL.md` containing YAML frontmatter:

```markdown
---
name: react-refactor
description: Guidelines for refactoring React components to functional hooks with TypeScript
---

# React Refactoring Guidelines

When refactoring React class components or legacy JSX:
1. Convert class components into functional components using React.FC.
2. Replace lifecycle methods with `useEffect` and `useCallback`.
3. Extract inline state into custom hooks when state logic exceeds 20 lines.
4. Verify tests pass with `npm test`.
```

### Inspecting and Activating Skills
In the REPL:
- `/skills`: List all discovered skills.
- `/skill react-refactor`: Display full skill instructions.
The autonomous agent can also load skills dynamically during execution via the `activate_skill` tool.

---

## 2. Dynamic JavaScript Plugins

Plugins are standard JavaScript ES modules placed in:
- `~/.nexus/plugins/*.js`
- `~/.config/opencode/plugins/*.js`
- `./.nexus/plugins/*.js`

### Plugin Structure
A plugin exports a default object:

```javascript
export default {
  name: "metric-logger",
  description: "Logs timing metrics and custom alerts for builds",

  // Lifecycle hooks take a single context object (not positional arguments).
  async onTurnStart({ prompt, workspace }) {
    console.log(`[Plugin] Turn starting on workspace: ${workspace}`);
  },

  async onToolCall({ toolName, args }) {
    if (toolName === "run_command" && String(args.command ?? "").includes("cargo build")) {
      console.log("[Plugin] Cargo build detected!");
    }
  },

  async onToolResult({ toolName, result }) {
    // Inspect tool outputs
  },

  async onTurnEnd({ summary, isFinished }) {
    // Cleanup or post-turn actions
  },

  // Custom tools
  customTools: [
    {
      definition: {
        type: "function",
        function: {
          name: "send_slack_alert",
          description: "Send an alert to the dev team channel",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "Message text" }
            },
            required: ["message"]
          }
        }
      },
      async handler(args) {
        return {
          success: true,
          output: `Alert sent: ${args.message}`
        };
      }
    }
  ]
};
```

### Installed packages (HK-2)

A distributable plugin package is a directory with `nexus-plugin.json` at its root. Install records a tree digest so
`verify` detects modification. There is no marketplace and no auto-update.

```text
nexus plugins install <local-dir>
nexus plugins list-installed
nexus plugins verify [name]
nexus plugins remove <name>
```

`nexus plugins` / `nexus plugins list` lists **loaded** JS modules from the plugin search path.

## 2.3 Workspace plugin trust (HK-3 / D18)

The full rules, how an approved plugin is run, and the migration from earlier versions are in [`PLUGINS.md`](PLUGINS.md).

Global plugins (`~/.nexus/plugins/`, `~/.config/nexus/plugins/`) are operator-managed and load when present.

Workspace plugins (`.nexus/plugins/`, `plugins/`) are repository content. They require **per-plugin trust** keyed by the SHA-256 of the exact plugin bytes. Trusting a workspace (`nexus trust .`) is necessary but no longer sufficient to execute workspace plugin code.

```bash
nexus plugins list                        # loaded plugins + unapproved workspace plugins
nexus plugins trust .nexus/plugins/p.js   # approve exact bytes for this workspace
nexus plugins revoke .nexus/plugins/p.js  # withdraw approval
```

A changed workspace plugin file needs a new approval. Managed policy may refuse plugins.

**Single-file load:** Nexus hashes the entry file's bytes once and imports those same bytes from a private temp copy (not the path on disk). Relative `import` / `require` of siblings under the plugins directory therefore cannot run: only the approved entry file executes. Keep a workspace plugin as one self-contained file. Absolute/`file:`/`createRequire` loads of other workspace paths inside an approved entry still run with process authority — approving that entry approves those loads; do not approve code that reaches outside itself.

**Approving needs a real terminal** (same limit as `nexus hooks approve`): `nexus plugins trust` refuses when stdin/stdout are not a TTY. An unsandboxed command that can drive a PTY still has the operator's rights and can approve; under `--sandbox` the trust store is unreachable. Prefer reviewing the file yourself in a terminal.

**Migration note (HK-3/D18):** in-process workspace JS plugins remain supported for now but are deprecated as a trust boundary. They run with full process authority. Prefer operator-managed/global plugins or future subprocess/manifest plugin packaging. Subprocess isolation of workspace plugin hooks is Phase D / v1.4.
