/**
 * BG-1/BG-2: whether an operator verifier command may be used on an unattended job. Shared by schedule add, fire-time
 * submission, and inbox `submissionProblem`, so a hand-written request cannot skip the checks the CLI applies.
 */
import * as os from "node:os";
import * as path from "node:path";
import { SecurityManager } from "../security.js";
import { decideCommand, NO_COMMAND_RULES, readCommandRulesFile } from "./command_rules.js";

/**
 * Why the operator's verifier command may not be used, or undefined. An unattended run starts this one command without
 * asking (the operator chose it), so it is held to what an interactive command is: bounded, one line, not on the
 * security tripwire list, and not forbidden by the operator's own command rules. Checked when a job or schedule is made
 * and again each time a schedule fires, because a schedule record is a file on disk.
 */
export function verifierProblem(workspace: string, verifier: string | null): string | undefined {
  if (verifier === null) return undefined;
  if (!verifier.trim() || verifier.length > 2000 || /[\0\r\n]/.test(verifier)) return "the verifier must be one command line of at most 2000 characters";
  const blocked = new SecurityManager(workspace).isCommandBlocked(verifier);
  if (blocked.blocked) return `the verifier command is refused by the security policy: ${blocked.reason ?? "blocked"}`;
  let rules = NO_COMMAND_RULES;
  try {
    rules = readCommandRulesFile(path.join(os.homedir(), ".config", "nexus", "command_rules.json"));
  } catch {
    // A rules file that does not load is ignored by every command, as the agent ignores it.
  }
  const verdict = decideCommand(rules, verifier);
  if (verdict?.decision === "forbidden") return "the verifier command is forbidden by your command rules";
  return undefined;
}
