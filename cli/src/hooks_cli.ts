/**
 * `nexus hooks`: list the command hooks in force, approve or revoke a project's hooks file, and try the configured
 * hooks against a sample tool call (HK-1). Approving records the SHA-256 of the exact bytes shown, and of the workspace
 * files the hooks run. It is the act of a person: there is no `--yes`, and without a terminal nothing is approved.
 */
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { createDefaultRegistry } from "./core/capabilities.js";
import { approveExtension, extensionTrustStorePath, revokeExtension } from "./core/content_trust.js";
import { HOOK_DEFAULT_TIMEOUT_SECS, HOOK_EVENTS, HookRegistry, inspectHookSources, type HookDeclaration, type HookEvent, type HooksFile, type HookSources, type LoadedHooksFile } from "./core/hooks.js";
import { hookLine } from "./core/hook_runner.js";
import { parseStrictJson } from "./core/strict_json.js";

export interface HookCliDeps {
  /** Asks a yes/no question on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
  /** Whether there is a terminal to ask on. */
  interactive?: () => boolean;
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const workspaceOf = (options: { workspace?: string }) => path.resolve(options.workspace ?? process.cwd());
const hooksOf = (file: HooksFile): Array<{ event: HookEvent; hook: HookDeclaration }> => HOOK_EVENTS.flatMap((event) => (file.hooks[event] ?? []).map((hook) => ({ event, hook })));
const commandText = (command: string | string[]) => hookLine(typeof command === "string" ? `sh -c ${JSON.stringify(command)}` : command.map((part) => JSON.stringify(part)).join(" "), 300);

/** Tool names a hook lists that no built-in tool has: most likely a typing error, and such a hook never runs. */
function unknownTools(file: HooksFile): string[] {
  const registry = createDefaultRegistry();
  const names = hooksOf(file).flatMap(({ hook }) => hook.tools).filter((name) => name !== "*" && !name.startsWith("mcp__") && !registry.getByToolName(name));
  return [...new Set(names)];
}

interface ListedSource {
  source: "operator" | "project";
  path: string;
  status: "absent" | "active" | "not_approved" | "changed" | "invalid" | "read_only";
  sha256?: string;
  problem?: string;
  hooks: Array<{ event: HookEvent; name: string; tools: string[]; command: string | string[]; timeout_secs: number }>;
  unknown_tools?: string[];
  /** Project only: the workspace files its commands run, whose bytes an approval covers. */
  covered_files?: Array<{ path: string; sha256: string }>;
  /** Project only, status `changed`: what differs from the approval. */
  changed?: string[];
}

function listed(source: "operator" | "project", file: string, loaded: LoadedHooksFile, status: ListedSource["status"]): ListedSource {
  const unknown = loaded.state === "ok" ? unknownTools(loaded.file) : [];
  return {
    source,
    path: file,
    status,
    ...(loaded.state !== "absent" && loaded.sha256 ? { sha256: loaded.sha256 } : {}),
    ...(loaded.state === "invalid" ? { problem: loaded.problem } : {}),
    hooks: loaded.state === "ok" ? hooksOf(loaded.file).map(({ event, hook }) => ({ event, name: hook.name, tools: hook.tools, command: hook.command, timeout_secs: hook.timeout_secs ?? HOOK_DEFAULT_TIMEOUT_SECS })) : [],
    ...(unknown.length ? { unknown_tools: unknown } : {}),
  };
}

/** Both sources as `nexus hooks list` shows them. */
export function listHookSources(sources: HookSources): ListedSource[] {
  const operator = sources.operator.loaded;
  return [
    listed("operator", sources.operator.path, operator, operator.state === "absent" ? "absent" : operator.state === "ok" ? "active" : "invalid"),
    {
      ...listed("project", sources.project.path, sources.project.loaded, sources.project.status),
      // The project's own reason (a command that cannot be pinned) when the file itself parsed.
      ...(sources.project.problem ? { problem: sources.project.problem } : {}),
      ...(sources.project.files.length ? { covered_files: sources.project.files } : {}),
      ...(sources.project.changed ? { changed: sources.project.changed } : {}),
    },
  ];
}

function printSource(entry: ListedSource): void {
  const colour = entry.status === "active" ? pc.green : entry.status === "absent" ? pc.dim : pc.yellow;
  console.log(`${pc.bold(entry.source)}  ${entry.path}  ${colour(entry.status)}${entry.sha256 ? pc.dim(`  sha256 ${entry.sha256}`) : ""}`);
  if (entry.problem) console.log(`  ${pc.red(hookLine(entry.problem))}`);
  for (const hook of entry.hooks) {
    console.log(`  ${hook.event}  ${pc.bold(hook.name)}  tools: ${hook.tools.join(", ")}  timeout: ${hook.timeout_secs}s`);
    console.log(`    ${commandText(hook.command)}`);
  }
  for (const file of entry.covered_files ?? []) console.log(pc.dim(`  covers ${file.path}  sha256 ${file.sha256}`));
  if (entry.changed) console.log(pc.yellow(`  changed since approval: ${entry.changed.join(", ")}`));
  if (entry.unknown_tools) console.log(pc.yellow(`  no built-in tool is named ${entry.unknown_tools.join(", ")}: a hook that lists only such names never runs`));
}

export function registerHookCommands(program: Command, deps: HookCliDeps = {}): void {
  const confirm = deps.confirm ?? confirmOnTerminal;
  const interactive = deps.interactive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const hooks = program.command("hooks").description("Command hooks that run before and after tool calls (they can deny a call, never approve one)");

  hooks
    .command("list")
    .description("Show the operator's and the project's hooks and whether they are in force")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "Print the listing as JSON")
    .action((options: { workspace?: string; json?: boolean }) => {
      const sources = inspectHookSources({ workspace: workspaceOf(options), readOnly: false });
      const entries = listHookSources(sources);
      if (options.json) {
        console.log(JSON.stringify({ sources: entries, ...(sources.trustProblem ? { trust_store_problem: sources.trustProblem } : {}) }, null, 2));
      } else {
        for (const entry of entries) printSource(entry);
        if (sources.trustProblem) console.log(pc.yellow(`The approval store ${extensionTrustStorePath()} is not used: ${sources.trustProblem}. Nothing it approved runs.`));
        if (entries[0].status === "invalid") console.log(pc.red("The operator's hooks file is invalid: every tool call is denied until it is fixed or moved aside."));
        if (entries[1].status === "not_approved" || entries[1].status === "changed") console.log(`The project's hooks do not run${entries[1].status === "changed" ? ` (${entries[1].changed?.join(", ")} changed since the approval)` : ""}. Review them, then run \`nexus hooks approve\` in a terminal.`);
      }
      // An invalid operator file stops all work, so a script that lists hooks should notice.
      if (entries[0].status === "invalid") process.exitCode = 1;
    });

  hooks
    .command("approve")
    .description("Approve this workspace's .nexus/hooks.json as it is now (a later change needs a new approval)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("--sha256 <hex>", "Approve only if the file has this SHA-256 (you are still asked; approving needs a terminal)")
    .action(async (options: { workspace?: string; sha256?: string }) => {
      const { project } = inspectHookSources({ workspace: workspaceOf(options), readOnly: false });
      const refuse = (message: string, code = 1) => {
        console.error(pc.red(message));
        process.exitCode = code;
      };
      if (project.loaded.state === "absent") return refuse(`There is no ${project.path}.`);
      if (project.loaded.state === "invalid" || project.status === "invalid") return refuse(`${project.path} is not a valid hooks file and cannot be approved: ${hookLine(project.problem ?? "")}`);
      const { sha256, file } = project.loaded;
      const entry = listed("project", project.path, project.loaded, project.status);
      console.log(`${project.path}\nsha256 ${sha256}\nThese programs would run with your authority, outside the sandbox, on the tool calls they name:`);
      for (const hook of entry.hooks) console.log(`  ${hook.event}  ${hook.name}  tools: ${hook.tools.join(", ")}\n    ${commandText(hook.command)}`);
      if (!entry.hooks.length) console.log("  (no hooks)");
      if (project.files.length) console.log("The approval also covers these workspace files they run, as they are now (a change to one needs a new approval):");
      for (const covered of project.files) console.log(`  ${covered.path}  sha256 ${covered.sha256}`);

      // Approving is the act of a person: a tool call of the agent has no terminal, and must not be able to approve
      // hooks for itself by naming a hash.
      if (!interactive()) {
        return refuse("Not approved: approving hooks needs a person at a terminal (standard input and output are not both a terminal). Review the file, then run `nexus hooks approve` yourself in a terminal.", 2);
      }
      const pinned = options.sha256?.trim().toLowerCase();
      if (pinned !== undefined && pinned !== sha256) return refuse(`Not approved: --sha256 does not match the file, whose SHA-256 is ${sha256}.`, 2);
      if (!(await confirm("Approve these hooks for this workspace? [y/N] "))) return refuse("Not approved.");
      // What is recorded is what was read and shown above, not the files as they may be now.
      const count = hooksOf(file).length;
      approveExtension({ kind: "project-hooks", scope: project.id.scope, key: project.id.key, sha256, approvedAt: new Date().toISOString(), summary: `${count} hook${count === 1 ? "" : "s"}`, ...(project.files.length ? { files: project.files } : {}) });
      console.log(`Approved for ${project.id.scope}. Undo with \`nexus hooks revoke\`.`);
    });

  hooks
    .command("revoke")
    .description("Withdraw the approval of this workspace's .nexus/hooks.json")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .action((options: { workspace?: string }) => {
      const { project } = inspectHookSources({ workspace: workspaceOf(options), readOnly: false });
      console.log(revokeExtension(project.id) ? `No longer approved: ${project.path}` : `There was no approval for ${project.path}.`);
    });

  hooks
    .command("test")
    .description("Run the hooks in force against a sample tool call and print what they decide (the tool itself is not run)")
    .argument("<event>", HOOK_EVENTS.join(" or "))
    .requiredOption("--tool <name>", "Tool name of the sample call, for example run_command")
    .option("--input <json>", "The sample call's arguments as a JSON object", "{}")
    .option("--response <json>", "post-tool only: the sample result as a JSON object with success, output and error", '{"success":true,"output":"","error":null}')
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "Print the result as JSON")
    .action(async (event: string, options: { tool: string; input: string; response: string; workspace?: string; json?: boolean }) => {
      const usage = (message: string) => {
        console.error(pc.red(message));
        process.exitCode = 1;
      };
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) return usage(`Unknown event '${hookLine(event, 60)}': use ${HOOK_EVENTS.join(" or ")}.`);
      const object = (text: string, what: string): Record<string, unknown> | undefined => {
        try {
          const value = parseStrictJson(text, { maxDepth: 32 });
          if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
        } catch {
          // reported below
        }
        usage(`${what} must be a JSON object.`);
        return undefined;
      };
      const input = object(options.input, "--input");
      const response = input && object(options.response, "--response");
      if (!input || !response) return;

      const workspace = workspaceOf(options);
      const notices: string[] = [];
      const registry = new HookRegistry({ workspace: () => workspace, readOnly: () => false, permissionMode: () => "review", sessionId: () => "hooks-test", notify: (text) => notices.push(text) });
      const result = await registry.tryEvent(event as HookEvent, options.tool, input, { success: response.success !== false, output: String(response.output ?? ""), error: typeof response.error === "string" ? response.error : null });
      if (options.json) {
        console.log(JSON.stringify({ event, tool: options.tool, decision: result.admitted ? "none" : "deny", ...(result.denialReason ? { denial_reason: result.denialReason } : {}), ...(result.reason ? { reason: result.reason } : {}), runs: result.runs, notices }, null, 2));
      } else {
        for (const notice of notices) console.log(pc.yellow(notice));
        for (const run of result.runs) console.log(`  ${run.source}  ${pc.bold(run.name)}  ${run.decision}${run.exit === null ? "" : `  exit ${run.exit}`}${run.reason ? `  ${run.reason}` : ""}${run.ignored ? pc.dim(`  ignored: ${run.ignored.join(", ")}`) : ""}`);
        if (!result.runs.length && result.admitted) console.log(`  no ${event} hook in force names ${hookLine(options.tool, 80)}`);
        if (!result.admitted) console.log(pc.red(`decision: DENY (${result.denialReason}) ${result.reason ?? ""}`));
        else if (event === "post-tool") console.log("decision: none (post-tool hooks observe; nothing they answer changes a result)");
        else console.log("decision: no objection (not an approval: Nexus's own checks decide as they do without hooks, and an allow from a hook is ignored)");
      }
      // 2: the hooks deny this call. Scripts can branch on it, as on a hook's own exit status.
      if (!result.admitted) process.exitCode = 2;
    });
}
