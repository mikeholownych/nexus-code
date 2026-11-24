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
import { writePrivateFile } from "./core/durable_file.js";
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
    return /^y(es)?$/i.test((await rl.question(question)).trim());
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

function parseTriggerFile(file: string): { specs: TriggerSpec[]; problem?: string; rawSha256?: string } {
  try {
    if (!fs.existsSync(file)) return { specs: [], problem: undefined };
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      return { specs: [], problem: "the trigger spec file is not a private regular file" };
    const fileData = readHardenedFile(file, { maxBytes: 256 * 1024, forbiddenMode: 0o077 });
    if (!fileData) return { specs: [], problem: undefined };
    const parsed = parseStrictJson(decodeStrictUtf8(fileData.bytes));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.triggers))
      return { specs: [], problem: "it is not a version 1 trigger spec file" };
    const specs: TriggerSpec[] = [];
    for (const raw of parsed.triggers) {
      try {
        specs.push(parseTriggerSpec(JSON.stringify(raw)));
      } catch (error) {
        return { specs, problem: error instanceof Error ? error.message : String(error) };
      }
    }
    return { specs, rawSha256: createHash("sha256").update(fileData.bytes).digest("hex") };
  } catch (error) {
    return { specs: [], problem: error instanceof Error ? error.message : String(error) };
  }
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
    const currentSha256 = parsed.rawSha256;
    // status is per spec: compare each spec's own hash
    const specSha = triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(spec), "utf8"));
    let status: ListedTrigger["status"] = "not_approved";
    if (!entry) status = "not_approved";
    else if (entry.sha256 === specSha) status = "approved";
    else status = "changed";
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
      console.log(`${triggerFile}\nsha256 ${rawSha256}\nThese triggers would run when their events fire:`);
      for (const spec of parsed.specs) {
        console.log(`  ${spec.event.kind}  ${pc.bold(spec.id)}  policy: ${spec.action.policy}  ${boundsText(spec)}`);
        console.log(`    ${hookLine(spec.action.prompt, 100)}`);
      }

      // Approving is the act of a person: a tool call of the agent has no terminal.
      if (!interactive()) {
        return refuse("Not approved: approving triggers needs a person at a terminal (standard input and output are not both a terminal). Review the file, then run `nexus triggers approve` yourself in a terminal.", 2);
      }
      const pinned = options.sha256?.trim().toLowerCase();
      if (pinned !== undefined && pinned !== rawSha256)
        return refuse(`Not approved: --sha256 does not match the file, whose SHA-256 is ${rawSha256}.`, 2);
      if (!(await confirm("Approve these triggers for this workspace? [y/N] "))) return refuse("Not approved.", 0);

      const now = new Date().toISOString();
      const storePath = triggerTrustStorePath();
      const kept = readTriggerTrustStore(storePath).entries;
      for (const spec of parsed.specs) {
        const entry = entryForSpec(realWorkspace(workspace), spec, now);
        const index = kept.findIndex((e) => e.scope === entry.scope && e.key === entry.key);
        if (index !== -1) kept[index] = entry; else kept.push(entry);
      }
      writePrivateFile(storePath, `${JSON.stringify({ version: 1, entries: kept }, null, 2)}\n`, { durable: true });
      console.log(`Approved ${parsed.specs.length} trigger${parsed.specs.length === 1 ? "" : "s"} for ${realWorkspace(workspace)}. Undo with \`nexus triggers revoke\`.`);
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
      const currentSha256 = spec ? triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(spec), "utf8")) : undefined;
      const entries = readTriggerTrustStore().entries;
      const decision = decideTriggerTrust(entries, realWorkspace(workspace), spec, currentSha256);
      console.log(`trigger ${id} in ${workspace}`);
      console.log(`  trusted: ${decision.workspaceTrusted ? "yes" : "no"}`);
      console.log(`  status: ${decision.status}`);
      console.log(`  may run: ${triggerMayRun(decision) ? "yes" : "no"}`);
      console.log(`  ${decision.reason}`);
      process.exitCode = triggerMayRun(decision) ? 0 : 1;
    });
}
