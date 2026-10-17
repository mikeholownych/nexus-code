/**
 * Slash commands the live TUI runs through the sidecar. The list mirrors the readline REPL (`cli/src/repl.ts`);
 * the TUI builds completion and help from `usage` and `summary`, so both are operator-facing text.
 */
import type { ConfirmHandler } from "../agent.js";
import type { CheckpointManager } from "../checkpoint.js";
import type { ApplicationCore } from "../core/app.js";
import type { ReceiptSection } from "../evidence.js";
import type { ApprovalMode } from "../types.js";

export interface SlashSpec {
  name: string;
  usage: string;
  summary: string;
  aliases?: string[];
  /** Cancel stops it. Commands that resolve to a turn become cancellable when the turn starts. */
  cancellable?: boolean;
}

/** What the sidecar lets a command read and change. */
export interface SlashHost {
  readonly app: ApplicationCore;
  mode(): ApprovalMode;
  setMode(mode: ApprovalMode): void;
  sessionId(): string;
  setSessionId(id: string): void;
  checkpoints(): CheckpointManager;
  setWorkspace(dir: string): void;
  saveSession(title?: string): void;
  resumeSession(id?: string): { ok: boolean; message: string };
  /** Earlier prompts, oldest first: the REPL history file, then this session's prompts. */
  history(): string[];
  /** Approval callback for agent runs a command starts; undefined in auto mode. */
  confirm(signal: AbortSignal): ConfirmHandler | undefined;
  /** Receipt sections for the last turn and the active validation receipt. */
  receipt(): ReceiptSection[];
}

export interface SlashContext {
  host: SlashHost;
  args: string;
  signal: AbortSignal;
}

export interface SlashReply {
  kind: "reply";
  command: string;
  success: boolean;
  output: string;
  /** "diff" asks the client to colour unified-diff lines. */
  format?: "diff";
  /** Text for the client to put into the composer. */
  composer?: string;
}

/** The command resolved to a prompt: the sidecar checkpoints, then runs it as a turn under the command's id. */
export interface SlashTurn {
  kind: "turn";
  command: string;
  prompt: string | any[];
  label: string;
  checkpoint: string;
}

export type SlashOutcome = SlashReply | SlashTurn;
export type SlashHandler = (ctx: SlashContext) => SlashOutcome | Promise<SlashOutcome>;

export const NOT_A_REPO = "This workspace is not inside a git repository.";

export function reply(command: string, output: string, success = true, extra: Pick<SlashReply, "format" | "composer"> = {}): SlashReply {
  return { kind: "reply", command, success, output, ...extra };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `!command` and `!<n>`; kept out of the completion catalogue because it is not typed after a slash. */
export const BANG: SlashSpec = { name: "!", usage: "!<command>", summary: "Run a shell command directly; !<n> runs prompt n again" };

export const SLASH_COMMANDS: SlashSpec[] = [
  { name: "help", usage: "/help", summary: "List the slash commands", aliases: ["?"] },
  { name: "status", usage: "/status", summary: "Workspace, model, mode, endpoint and session" },
  { name: "doctor", usage: "/doctor [--deep] [--fix [--yes]]", summary: "Diagnose this session's configuration, endpoint, engine, shell and state; --fix repairs (runs while busy without --fix)" },
  { name: "clear", usage: "/clear", summary: "Reset the conversation context", aliases: ["reset"] },
  { name: "compact", usage: "/compact [--llm]", summary: "Condense earlier messages to free context" },
  { name: "mode", usage: "/mode [auto|review]", summary: "Run edits and commands freely, or ask first" },
  { name: "model", usage: "/model [provider] [model]", summary: "Choose a model from any connected provider (ctrl+p connects one)" },
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
  { name: "requirements", usage: "/requirements [accept <id>...|clear]", summary: "The objective's acceptance requirements; accept a scope reduction, or clear the objective to start a new one" },
  { name: "knowledge", usage: "/knowledge [set <key> <rule>|delete <key>]", summary: "Persistent project knowledge" },
  { name: "skills", usage: "/skills", summary: "Discovered agent skills" },
  { name: "skill", usage: "/skill <name> | init <name>", summary: "Show a skill or scaffold a new one" },
  { name: "mcp", usage: "/mcp [add|resources|resource <uri>|prompts|prompt <name>]", summary: "MCP servers, tools, resources and prompts" },
  { name: "plugins", usage: "/plugins", summary: "Loaded plugins" },
  { name: "browse", usage: "/browse <url>", summary: "Open a URL in the headless browser" },
  { name: "image", usage: "/image <path> [prompt]", summary: "Send an image to the vision model", cancellable: true },
  { name: "tdd", usage: "/tdd <issue>", summary: "[experimental] Run a RED → GREEN → REFACTOR cycle", cancellable: true },
  { name: "team", usage: "/team <role|full> [--independent-review] <objective>", summary: "[experimental] Run a role or the full team as a durable operation (researcher, architect, implementer, tester, reviewer)" },
  { name: "theme", usage: "/theme [name]", summary: "Show or save the colour theme" },
  { name: "recover", usage: "/recover [task-id]", summary: "Recover durable task state" },
  { name: "exit", usage: "/exit", summary: "Quit Nexus", aliases: ["quit", "q"] },
];

/** The catalogue as announced in `hello`. */
export function slashCatalog(): Array<Pick<SlashSpec, "name" | "usage" | "summary">> {
  return SLASH_COMMANDS.map(({ name, usage, summary }) => ({ name, usage, summary }));
}

export function findSlash(command: string): SlashSpec | undefined {
  const name = command.trim().replace(/^\//, "").toLowerCase();
  if (name === BANG.name) return BANG;
  return SLASH_COMMANDS.find((spec) => spec.name === name || spec.aliases?.includes(name));
}
