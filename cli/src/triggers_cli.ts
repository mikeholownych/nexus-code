/**
 * `nexus triggers`: list trigger trust status, approve or revoke a workspace's trigger specs (BG-3 trust model).
 *
 * Approving a trigger is the act of a person at a terminal: there is no `--yes`, and without a terminal nothing is
 * approved. A trigger spec's bytes are pinned by SHA-256; changed bytes are a different spec and need a new approval.
 *
 * BG-3 itself (the trigger firer that watches files and HTTP) is deferred to v1.4. This CLI is the trust surface it
 * builds on: `nexus triggers list` shows what is approved and what is not, `approve` pins a spec by hash, `revoke`
 * withdraws approval. A firer reads `triggerMayRun` from trigger_trust.ts before starting any run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { createHash } from "node:crypto";
import { parseStrictJson, readHardenedFile, decodeStrictUtf8 } from "./core/strict_json.js";
import {
  triggerTrustStorePath,
  readTriggerTrustStore,
  approveTrigger,
  revokeTrigger,
  triggerTrustEntry,
  entryForSpec,
  triggerMayRun,
  workspaceMayHaveTriggers,
  decideTriggerTrust,
} from "./core/trigger_trust.js";
import {
  parseTriggerSpec,
  canonicalizeTriggerSpec,
  triggerSpecSha256,
  type TriggerSpec,
  type TriggerTrustEntry,
} from "./core/trigger_spec.js";
import { realWorkspace } from "./workspace_trust.js";
import { hookLine } from "./core/hook_runner.js";

export interface TriggersCliDeps {
  /** Asks a yes/no question on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
  /** Whether there is a terminal to ask on. */
  interactive?: () => boolean;
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^yes$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const workspaceOf = (options: { workspace?: string }) => path.resolve(options.workspace ?? process.cwd());

/** One trigger as `nexus triggers list` shows it. */
interface ListedTrigger {
  id: string;
  kind: string;
  policy: string;
  status: "approved" | "not_approved" | "changed" | "absent";
  sha256?: string;
  problem?: string;
  bounds: string;
}

/** The most of one field `approve` prints; a longer one is not shown in full and so is not approved. */
export const APPROVE_FIELD_CAP = 4000;

/**
 * Reads `.nexus/triggers.json`. All or nothing: a file that does not parse in full (one bad spec, a duplicate id)
 * yields no specs and says why, so nothing in it can be approved. The file must be a regular file owned by you and not
 * writable by group or others (0644 from a git checkout is accepted; 0664 is not).
 */
function parseTriggerFile(file: string): { specs: TriggerSpec[]; problem?: string; rawSha256?: string } {
  try {
    if (!fs.existsSync(file)) return { specs: [] };
    const fileData = readHardenedFile(file, { maxBytes: 256 * 1024, forbiddenMode: 0o022 });
    if (!fileData) return { specs: [] };
    const parsed = parseStrictJson(decodeStrictUtf8(fileData.bytes));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.triggers))
      return { specs: [], problem: "it is not a version 1 trigger spec file" };
    const specs: TriggerSpec[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of parsed.triggers.entries()) {
      let spec: TriggerSpec;
      try {
        spec = parseTriggerSpec(JSON.stringify(raw));
      } catch (error) {
        return { specs: [], problem: `trigger #${index + 1} is invalid, so nothing in the file can be approved: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (seen.has(spec.id)) return { specs: [], problem: `trigger id ${JSON.stringify(spec.id)} appears twice, so nothing in the file can be approved` };
      seen.add(spec.id);
      specs.push(spec);
    }
    return { specs, rawSha256: createHash("sha256").update(fileData.bytes).digest("hex") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fix = /permissions are too open/.test(message) ? `; fix: chmod go-w ${file}` : "";
    return { specs: [], problem: `the trigger spec file cannot be used: ${message}${fix}` };
  }
}

const specSha256 = (spec: TriggerSpec): string => triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(spec), "utf8"));

/** A value as JSON with every control and non-ASCII character escaped, so what is printed is what is hashed. */
const shown = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * Everything approving `spec` authorises, as lines to print: each field of the canonical spec, in full. Any field
 * longer than `APPROVE_FIELD_CAP` is cut with a count and sets `complete: false` (approval is refused).
 */
export function describeTriggerSpec(spec: TriggerSpec): { lines: string[]; sha256: string; complete: boolean } {
  const sha256 = specSha256(spec);
  let complete = true;
  const field = (label: string, value: string): string => {
    const text = shown(value);
    if (text.length <= APPROVE_FIELD_CAP) return `  ${label}: ${text}`;
    complete = false;
    return `  ${label}: ${text.slice(0, APPROVE_FIELD_CAP)}\n    [${text.length - APPROVE_FIELD_CAP} more characters, not shown: refuse to approve a spec you cannot read in full]`;
  };
  const lines = [`${spec.event.kind} trigger ${shown(spec.id)}  canonical sha256 ${sha256}`];
  lines.push(`  kind: ${spec.event.kind}`);
  for (const p of [...(spec.event.paths ?? [])].sort()) lines.push(field("event.path", p));
  for (const o of [...(spec.event.allowedOrigins ?? [])].sort()) lines.push(field("event.allowedOrigin", o));
  if (spec.event.kind === "webhook" && spec.event.allowedOrigins === undefined) lines.push("  event.allowedOrigins: none (any origin)");
  if (spec.event.secret !== undefined) lines.push("  secret: an inline secret is configured (not shown; it sits in the repository file)");
  else if (spec.event.secretEnv !== undefined) lines.push(field("secret: read from environment variable", spec.event.secretEnv));
  else lines.push("  secret: none");
  lines.push(field("action.prompt", spec.action.prompt));
  lines.push(`  action.policy: ${spec.action.policy}`);
  lines.push(spec.action.verifier != null ? field("action.verifier", spec.action.verifier) : "  action.verifier: none");
  lines.push(`  rate: ${spec.rate.maxPerMinute}/minute, ${spec.rate.maxPerHour}/hour, ${spec.rate.maxPerDay}/day`);
  lines.push(`  bounds: ${boundsText(spec)}`);
  return { lines, sha256, complete };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundsText(spec: TriggerSpec): string {
  return `${spec.bounds.maxToolInvocations} tools / ${spec.bounds.maxRounds} rounds / ${spec.bounds.maxTurnMinutes} min`;
}

function listTriggers(workspace: string, entries: TriggerTrustEntry[]): ListedTrigger[] {
  const triggerFile = path.join(workspace, ".nexus", "triggers.json");
  const parsed = parseTriggerFile(triggerFile);
  if (parsed.problem) return [{ id: triggerFile, kind: "—", policy: "—", status: "absent", problem: parsed.problem, bounds: "—" }];
  const listed: ListedTrigger[] = [];
  for (const spec of parsed.specs) {
    const id: { scope: string; key: string } = { scope: realWorkspace(workspace), key: spec.id };
    const entry = triggerTrustEntry(entries, id);
    // status is per spec: compare each spec's own canonical hash
    const status: ListedTrigger["status"] = !entry ? "not_approved" : entry.sha256 === specSha256(spec) ? "approved" : "changed";
    listed.push({
      id: spec.id,
      kind: spec.event.kind,
      policy: spec.action.policy,
      status,
      sha256: entry?.sha256,
      bounds: boundsText(spec),
    });
  }
  return listed;
}

function printTrigger(entry: ListedTrigger): void {
  const colour = entry.status === "approved" ? pc.green : entry.status === "changed" ? pc.yellow : pc.dim;
  console.log(`${pc.bold(entry.id)}  ${entry.kind}  ${entry.policy}  ${colour(entry.status)}${entry.sha256 ? pc.dim(`  sha256 ${entry.sha256}`) : ""}  ${entry.bounds}`);
  if (entry.problem) console.log(`  ${pc.red(hookLine(entry.problem))}`);
}

export function registerTriggerCommands(program: Command, deps: TriggersCliDeps = {}): void {
  const confirm = deps.confirm ?? confirmOnTerminal;
  const interactive = deps.interactive ?? (() => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
  });

  const triggers = program.command("triggers").description("Event trigger trust status and approvals (BG-3; firing deferred to v1.4)");

  triggers
    .command("list")
    .description("Show this workspace's trigger specs and whether each is approved")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "Print the listing as JSON")
    .action((options: { workspace?: string; json?: boolean }) => {
      const workspace = workspaceOf(options);
      const entries = readTriggerTrustStore().entries;
      const trusted = workspaceMayHaveTriggers(workspace);
      const listed = listTriggers(workspace, entries);
      if (options.json) {
        console.log(JSON.stringify({ workspace, trusted, triggers: listed }, null, 2));
      } else {
        console.log(`Workspace: ${workspace}`);
        console.log(`Trusted for triggers: ${trusted ? "yes" : "no"}`);
        if (!trusted) console.log(pc.yellow("  Trust it with `nexus trust <workspace>` before any trigger can run here."));
        if (!listed.length) {
          console.log("  (no trigger specs in .nexus/triggers.json)");
        }
        for (const entry of listed) printTrigger(entry);
      }
    });

  triggers
    .command("approve")
    .description("Approve this workspace's .nexus/triggers.json as it is now (a later change needs a new approval)")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("--sha256 <hex>", "Approve only if the file has this SHA-256 (you are still asked; approving needs a terminal)")
    .action(async (options: { workspace?: string; sha256?: string }) => {
      const workspace = workspaceOf(options);
      const refuse = (message: string, code = 1) => {
        console.error(pc.red(message));
        process.exitCode = code;
      };
      const triggerFile = path.join(workspace, ".nexus", "triggers.json");
      const parsed = parseTriggerFile(triggerFile);
      if (!parsed.specs.length) return refuse(`There is no usable trigger spec in ${triggerFile}${parsed.problem ? ": " + parsed.problem : ""}.`);
      if (!workspaceMayHaveTriggers(workspace))
        return refuse(`Not approved: ${workspace} is not trusted for triggers. Run \`nexus trust ${workspace}\` first.`, 2);

      const rawSha256 = parsed.rawSha256 ?? "";
      console.log(`${triggerFile}\nfile sha256 ${rawSha256}\nApproving authorises each of these to run unattended when its event fires, exactly as printed:`);
      const described = parsed.specs.map((spec) => ({ spec, ...describeTriggerSpec(spec) }));
      for (const d of described) for (const line of d.lines) console.log(line);

      // Approving is the act of a person: a tool call of the agent has no terminal.
      if (!interactive()) {
        return refuse("Not approved: approving triggers needs a person at a terminal (standard input and output are not both a terminal). Review the file, then run `nexus triggers approve` yourself in a terminal.", 2);
      }
      const unreadable = described.filter((d) => !d.complete).map((d) => d.spec.id);
      if (unreadable.length) return refuse(`Not approved: ${unreadable.join(", ")} cannot be shown in full (a field is over ${APPROVE_FIELD_CAP} characters). Refuse to approve a spec you cannot read in full; shorten it.`, 2);
      const pinned = options.sha256?.trim().toLowerCase();
      if (pinned !== undefined && pinned !== rawSha256)
        return refuse(`Not approved: --sha256 does not match the file, whose SHA-256 is ${rawSha256}.`, 2);

      const now = new Date().toISOString();
      const scope = realWorkspace(workspace);
      let approved = 0;
      for (const d of described) {
        // The answer is about THIS hash: the first 12 hex digits of what was just printed in full.
        if (!(await confirm(`Type "yes" to approve trigger ${d.spec.id} with canonical sha256 ${d.sha256.slice(0, 12)}…: `))) {
          console.log(`Not approved: ${d.spec.id}.`);
          continue;
        }
        approveTrigger(entryForSpec(scope, d.spec, now), { workspaceTrusted: true });
        approved++;
      }
      if (approved === 0) return refuse("Not approved.", 0);
      console.log(`Approved ${approved} trigger${approved === 1 ? "" : "s"} for ${scope}. Undo with \`nexus triggers revoke\`.`);
    });

  triggers
    .command("revoke")
    .description("Withdraw the approval of a trigger in this workspace")
    .argument("<id>", "Trigger id to revoke")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .action((id: string, options: { workspace?: string }) => {
      const workspace = workspaceOf(options);
      const removed = revokeTrigger({ scope: realWorkspace(workspace), key: id });
      console.log(removed ? `No longer approved: trigger ${id}` : `There was no approval for trigger ${id}.`);
    });

  triggers
    .command("status")
    .description("Show the trust decision for one trigger (whether it may run now)")
    .argument("<id>", "Trigger id")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .action((id: string, options: { workspace?: string }) => {
      const workspace = workspaceOf(options);
      const triggerFile = path.join(workspace, ".nexus", "triggers.json");
      const parsed = parseTriggerFile(triggerFile);
      const spec = parsed.specs.find((s) => s.id === id);
      const currentSha256 = spec ? specSha256(spec) : undefined;
      const entries = readTriggerTrustStore().entries;
      const decision = decideTriggerTrust(entries, realWorkspace(workspace), spec, currentSha256);
      console.log(`trigger ${id} in ${workspace}`);
      console.log(`  trusted: ${decision.workspaceTrusted ? "yes" : "no"} (the trusted-workspaces store; NEXUS_TRUST_WORKSPACE=1 does not count for triggers)`);
      if (parsed.problem) console.log(`  spec file: ${hookLine(parsed.problem, 400)}`);
      console.log(`  status: ${decision.status}`);
      console.log(`  may run: ${triggerMayRun(decision) ? "yes" : "no"}`);
      console.log(`  ${decision.reason}`);
      process.exitCode = triggerMayRun(decision) ? 0 : 1;
    });
}
