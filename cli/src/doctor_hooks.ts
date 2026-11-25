/**
 * The `hooks.config` finding of `nexus doctor` (HK-1): whether the command hooks that are declared are the ones in
 * force. The files are read, never run.
 */
import * as path from "node:path";
import { inspectHookSources } from "./core/hooks.js";
import { listHookSources } from "./hooks_cli.js";
import { printable } from "./core/printable.js";

export interface HooksDiagnosis {
  status: "pass" | "warn" | "fail" | "skip";
  explanation: string;
  evidence: string[];
  action?: string;
}

/** `home` is the operator's home directory, where the hooks file and the approval store live. */
export function diagnoseHooks(workspace: string, home: string): HooksDiagnosis {
  // Paths, hook names and file problems come from files anyone may have written: nothing of them is reported raw.
  const found = diagnose(workspace, home);
  return { ...found, explanation: printable(found.explanation, 1000), evidence: found.evidence.map((line) => printable(line, 800)), ...(found.action ? { action: printable(found.action, 1000) } : {}) };
}

function diagnose(workspace: string, home: string): HooksDiagnosis {
  const config = path.join(home, ".config", "nexus");
  const sources = inspectHookSources({ workspace, readOnly: false, operatorFile: path.join(config, "hooks.json"), trustStorePath: path.join(config, "extension_trust.json") });
  const [operator, project] = listHookSources(sources);
  const note = "Hooks were read from their files, not run.";
  if (operator.status === "invalid") {
    return {
      status: "fail",
      explanation: `The operator's hooks file is invalid, so every tool call is denied until it is fixed. ${note}`,
      evidence: [`${operator.path}: ${operator.problem}`],
      action: `Fix ${operator.path} or move it aside; \`nexus hooks list\` shows the problem.`,
    };
  }
  const problems: string[] = [];
  if (project.status === "not_approved") problems.push(`${project.path}: not approved, so its hooks do not run`);
  if (project.status === "changed") problems.push(`${project.path}: ${project.changed?.join(", ")} changed since the approval, so its hooks do not run`);
  if (project.status === "invalid") problems.push(`${project.path}: not a valid hooks file, so its hooks do not run (${project.problem})`);
  if (sources.trustProblem) problems.push(`${path.join(config, "extension_trust.json")}: the approval store is not used (${sources.trustProblem}); nothing it approved runs`);
  for (const entry of [operator, project]) {
    if (entry.status === "active" && entry.unknown_tools) problems.push(`${entry.path}: no built-in tool is named ${entry.unknown_tools.join(", ")}; a hook that lists only such names never runs`);
  }
  const active = [operator, project].filter((entry) => entry.status === "active");
  const count = active.reduce((sum, entry) => sum + entry.hooks.length, 0);
  const evidence = [...problems, ...active.map((entry) => `${entry.path}: ${entry.hooks.length} hook(s) in force (${entry.hooks.map((hook) => `${hook.event} ${hook.name}`).join(", ") || "none"})`)];
  if (problems.length) {
    return {
      status: "warn",
      explanation: `${problems.length} command hook problem(s): hooks you may be counting on are not running. ${note}`,
      evidence,
      action: project.status === "not_approved" || project.status === "changed" ? `Review ${project.path}, then run \`nexus hooks approve -w ${workspace}\` in a terminal.` : "Run `nexus hooks list` and correct what it reports.",
    };
  }
  if (!count) return { status: "skip", explanation: "No command hooks are configured (optional).", evidence };
  return { status: "pass", explanation: `${count} command hook(s) are in force. ${note}`, evidence };
}
