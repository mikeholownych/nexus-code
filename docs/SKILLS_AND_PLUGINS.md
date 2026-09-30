# Skills and Plugins Guide

Nexus Code provides two distinct extensibility mechanisms:
1. **Agent Skills (`SKILL.md`)**: Reusable domain knowledge, procedural guidelines, and prompt instructions that the agent discovers and loads dynamically.
2. **JavaScript Plugins (`.js`)**: Dynamic runtime extensions that hook into agent lifecycle events and register custom executable tools.

---

## 1. Agent Skills

Skills allow Nexus Code to adopt specialized expert personas and workflows on demand without permanently bloating the system prompt.

### Discovery Locations
Skills are automatically discovered from:
- Current workspace: `./skills/<skill-name>/SKILL.md` or `./.nexus/skills/<skill-name>/SKILL.md`
- User global skills: `~/.nexus/skills/<skill-name>/SKILL.md`, `~/.claude/skills/<skill-name>/SKILL.md`, or `~/.config/opencode/skills/<skill-name>/SKILL.md`

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
