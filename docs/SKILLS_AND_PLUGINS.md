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

Treat an installed skill as untrusted instructions. Activating a skill only adds its text to the conversation. Its frontmatter is read for `name` and `description` alone: keys such as `allowed-tools` grant nothing, and every tool call the skill suggests still goes through Nexus's normal approval, filesystem and execution policy.

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

  // Lifecycle Hooks
  async onTurnStart(prompt, workspace) {
    console.log(`[Plugin] Turn starting on workspace: ${workspace}`);
  },

  async onToolCall(toolName, args) {
    if (toolName === "run_command" && args.command.includes("cargo build")) {
      console.log("[Plugin] Cargo build detected!");
    }
  },

  async onToolResult(toolName, result) {
    // Inspect tool outputs
  },

  async onTurnEnd(workspace) {
    // Cleanup or post-turn actions
  },

  // Custom Tools
  tools: [
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
        // Execute custom integration logic
        return {
          success: true,
          output: `Alert sent: ${args.message}`
        };
      }
    }
  ]
};
```
