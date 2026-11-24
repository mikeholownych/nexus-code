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

`nexus plugins` with no subcommand still lists **loaded** JS modules from the plugin search path (unchanged).
