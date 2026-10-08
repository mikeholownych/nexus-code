export const NOT_A_REPO = "This workspace is not inside a git repository.";
export function reply(command, output, success = true, extra = {}) {
    return { kind: "reply", command, success, output, ...extra };
}
export function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
export function oneLine(text) {
    return text.replace(/\s+/g, " ").trim();
}
/** `!command` and `!<n>`; kept out of the completion catalogue because it is not typed after a slash. */
export const BANG = { name: "!", usage: "!<command>", summary: "Run a shell command directly; !<n> runs prompt n again" };
export const SLASH_COMMANDS = [
    { name: "help", usage: "/help", summary: "List the slash commands", aliases: ["?"] },
    { name: "status", usage: "/status", summary: "Workspace, model, mode, endpoint and session" },
    { name: "clear", usage: "/clear", summary: "Reset the conversation context", aliases: ["reset"] },
    { name: "compact", usage: "/compact [--llm]", summary: "Condense earlier messages to free context" },
    { name: "mode", usage: "/mode [auto|review]", summary: "Run edits and commands freely, or ask first" },
    { name: "model", usage: "/model [name]", summary: "List available models or switch" },
    { name: "shell", usage: "/shell [bash|zsh|sh]", summary: "Show or switch the command shell" },
    { name: "cd", usage: "/cd [path]", summary: "Show or change the workspace directory" },
    { name: "tokens", usage: "/tokens", summary: "Context window use and session token totals", aliases: ["cost"] },
    { name: "diff", usage: "/diff", summary: "Uncommitted changes as a diff" },
    { name: "git", usage: "/git", summary: "Short git status" },
    { name: "stage", usage: "/stage [reset]", summary: "Unstaged hunks, or unstage everything" },
    { name: "commit", usage: "/commit [message]", summary: "Commit; without a message, suggests one" },
    { name: "checkpoint", usage: "/checkpoint [name|diff <id> [base]|prune [n]]", summary: "Save, compare or prune workspace snapshots" },
    { name: "checkpoints", usage: "/checkpoints", summary: "List workspace snapshots" },
    { name: "undo", usage: "/undo", summary: "Roll the workspace back to the last snapshot" },
    { name: "worktree", usage: "/worktree [status|merge|discard]", summary: "Manage the speculative git worktree" },
    { name: "audit", usage: "/audit [count]", summary: "Recent tool executions" },
    { name: "receipt", usage: "/receipt", summary: "Turn outcome, verifier evidence and validation receipt" },
    { name: "test", usage: "/test [pattern]", summary: "Run the project's test suite" },
    { name: "copy", usage: "/copy [diff|code|last]", summary: "Copy the diff, code blocks or the last reply" },
    { name: "paste", usage: "/paste", summary: "Put the clipboard into the composer" },
    { name: "sessions", usage: "/sessions", summary: "Saved sessions" },
    { name: "save", usage: "/save [name]", summary: "Save this session" },
    { name: "resume", usage: "/resume [id]", summary: "Load a saved session (the latest by default)" },
    { name: "history", usage: "/history [query|run <n>]", summary: "Search earlier prompts or run one again", cancellable: true },
    { name: "export", usage: "/export [md|json]", summary: "Write the session transcript into the workspace" },
    { name: "init", usage: "/init", summary: "Create a project rules file" },
    { name: "onboard", usage: "/onboard", summary: "Scan the workspace and write a tailored AGENTS.md" },
    { name: "plan", usage: "/plan [add <phase>|start <n>|done <n>|clear]", summary: "Show or edit the active plan" },
    { name: "knowledge", usage: "/knowledge [set <key> <rule>|delete <key>]", summary: "Persistent project knowledge" },
    { name: "skills", usage: "/skills", summary: "Discovered agent skills" },
    { name: "skill", usage: "/skill <name> | init <name>", summary: "Show a skill or scaffold a new one" },
    { name: "mcp", usage: "/mcp [add|resources|resource <uri>|prompts|prompt <name>]", summary: "MCP servers, tools, resources and prompts" },
    { name: "plugins", usage: "/plugins", summary: "Loaded plugins" },
    { name: "browse", usage: "/browse <url>", summary: "Open a URL in the headless browser" },
    { name: "image", usage: "/image <path> [prompt]", summary: "Send an image to the vision model", cancellable: true },
    { name: "tdd", usage: "/tdd <issue>", summary: "Run a RED → GREEN → REFACTOR cycle", cancellable: true },
    { name: "team", usage: "/team <role|full> [--independent-review] <objective>", summary: "Run a role or the full team as a durable operation (researcher, architect, implementer, tester, reviewer)" },
    { name: "theme", usage: "/theme [name]", summary: "Show or save the colour theme" },
    { name: "recover", usage: "/recover [task-id]", summary: "Recover durable task state" },
    { name: "tui", usage: "/tui", summary: "This is the live view" },
    { name: "exit", usage: "/exit", summary: "Quit Nexus", aliases: ["quit", "q"] },
];
/** The catalogue as announced in `hello`. */
export function slashCatalog() {
    return SLASH_COMMANDS.map(({ name, usage, summary }) => ({ name, usage, summary }));
}
export function findSlash(command) {
    const name = command.trim().replace(/^\//, "").toLowerCase();
    if (name === BANG.name)
        return BANG;
    return SLASH_COMMANDS.find((spec) => spec.name === name || spec.aliases?.includes(name));
}
