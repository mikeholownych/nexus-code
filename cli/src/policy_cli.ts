/**
 * GV-1 visibility: `nexus policy show` and `nexus policy check`, and the policy findings of `nexus doctor`.
 *
 * Everything here reads and reports; nothing writes a policy file, records an approval or changes what is enforced.
 * These commands run when a managed file is broken (that is when they are needed), and a broken file is exit code 2.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { describeSource, type EffectivePolicy, type PolicySource } from "./core/managed_policy.js";
import { loadManagedTiers, ManagedPolicyError, MANAGED_POLICY_EXIT_CODE, type LoadedPolicy, type TierInspection } from "./core/managed_policy_load.js";
import { approvalHint, printableRefusal, processPolicyHost, type PolicyHost, type WorkspaceTrustFacts } from "./core/policy_runtime.js";
import { envTrustRequested, isWorkspaceListed, realWorkspace } from "./workspace_trust.js";

export const POLICY_REPORT_SCHEMA_VERSION = 1;

/** One effective value and the tier that decides it. A list also names the tier of each item. */
export interface PolicyRow {
  key: string;
  /** The value as it is shown: `true`, `"block"`, `["a", "b"]`, `not set`, `unrestricted`. */
  value: string;
  source: string;
  items?: { value: string; source: string }[];
}

export interface PolicyTierReport {
  tier: "system" | "user" | "project";
  /** Null where the platform has no such tier. */
  file: string | null;
  state: "absent" | "valid" | "invalid";
  schemaVersion?: number;
  /** The project file's integrity status (`MATCH`, `NEW`, ...). */
  status?: string;
  /** Why the file cannot be used: the whole managed-policy message for a managed tier. */
  error?: string;
}

export interface PolicyReport {
  schemaVersion: typeof POLICY_REPORT_SCHEMA_VERSION;
  /** False when a managed file exists and cannot be used: Nexus does not start then. */
  valid: boolean;
  workspace: string;
  tiers: PolicyTierReport[];
  /** Absent when `valid` is false: no policy is in force, because nothing runs. */
  effective?: PolicyRow[];
  notices: string[];
}

const isSource = (value: unknown): value is PolicySource => Boolean(value) && typeof value === "object" && typeof (value as PolicySource).key === "string" && typeof (value as PolicySource).tier === "string";

/** Every key of the effective policy with its value and source, in the order of the schema. */
export function effectivePolicyRows(policy: EffectivePolicy): PolicyRow[] {
  const rows: PolicyRow[] = [];
  for (const [table, members] of Object.entries(policy)) {
    if (table === "tiers") continue;
    for (const [name, member] of Object.entries(members as Record<string, unknown>)) {
      if (!member || typeof member !== "object") continue;
      const key = `${table}.${name}`;
      const entry = member as { value?: unknown; source?: unknown; values?: readonly string[]; items?: readonly { value: string; source: PolicySource }[]; restricted?: boolean };
      if (Array.isArray(entry.items) && Array.isArray(entry.values)) {
        const items = entry.items.map((item) => ({ value: item.value, source: describeSource(item.source) }));
        // An allowlist names the tier that sets it; a union list has no single tier, so an unset one is the default.
        const source = isSource(entry.source) ? describeSource(entry.source) : items.length && items.every((item) => item.source === items[0].source) ? items[0].source : items.length ? "(per item)" : describeSource({ tier: "default", key });
        rows.push({ key, value: entry.restricted === false ? "unrestricted" : JSON.stringify(entry.values), source, ...(items.length ? { items } : {}) });
      } else if ("value" in entry && isSource(entry.source)) {
        rows.push({ key, value: entry.value === undefined ? "not set" : JSON.stringify(entry.value), source: describeSource(entry.source) });
      }
    }
  }
  const { relaxationStatus, relaxation, relaxationVoidedBy } = policy.verification;
  const relaxationSource = relaxation?.source ?? relaxationVoidedBy;
  rows.push({ key: "verification.project_relaxations", value: relaxationStatus, source: relaxationSource ? describeSource(relaxationSource) : describeSource({ tier: "default", key: "verification" }) });
  return rows;
}

function managedTierReport(inspection: TierInspection): PolicyTierReport {
  const base = { tier: inspection.tier, file: inspection.file };
  if (inspection.error) return { ...base, state: "invalid", error: inspection.error.message };
  if (inspection.loaded) return { ...base, state: "valid", schemaVersion: inspection.loaded.schemaVersion };
  return { ...base, state: "absent" };
}

function projectTierReport(loaded: LoadedPolicy): PolicyTierReport {
  const { project } = loaded;
  const base = { tier: "project" as const, file: project.file, status: project.status };
  if (project.error) return { ...base, state: "invalid", error: project.error };
  return { ...base, state: project.tier || project.sha256 !== undefined ? "valid" : "absent" };
}

/**
 * The policy as Nexus would apply it in `workspace`: each tier's state, and every effective value with its source.
 * Reads the managed files by themselves (both are reported, also when the first is broken) and never throws for a
 * policy problem: a broken managed file is `valid: false`.
 */
export function policyReport(host: PolicyHost, workspace: string, trust: WorkspaceTrustFacts): PolicyReport {
  const tiers = host.inspect().map(managedTierReport);
  const report: PolicyReport = { schemaVersion: POLICY_REPORT_SCHEMA_VERSION, valid: false, workspace, tiers, notices: [] };
  if (tiers.some((tier) => tier.state === "invalid")) return report;
  let loaded: LoadedPolicy;
  try {
    loaded = host.forWorkspace(workspace, trust);
  } catch (error) {
    // The process read its policy before this diagnosis (the files are read once) and found it broken then.
    if (!(error instanceof ManagedPolicyError)) throw error;
    const stale = tiers.find((tier) => tier.tier === error.tier);
    if (stale) Object.assign(stale, { state: "invalid", error: error.message });
    return report;
  }
  const hint = approvalHint(loaded);
  return { ...report, valid: true, tiers: [...tiers, projectTierReport(loaded)], effective: effectivePolicyRows(loaded.effective), notices: [...loaded.notices, ...(hint ? [hint] : [])] };
}

export function renderPolicyReport(report: PolicyReport): string {
  const lines: string[] = [`Policy for ${report.workspace}`, ""];
  for (const tier of report.tiers) {
    const state =
      tier.file === null ? "no such tier on this platform"
      : tier.state === "absent" ? `${tier.file}: absent`
      : tier.state === "valid" ? `${tier.file}: valid${tier.schemaVersion !== undefined ? ` (schema_version ${tier.schemaVersion})` : ""}${tier.status ? ` (${tier.status})` : ""}`
      : `${tier.file}: INVALID`;
    lines.push(`${tier.tier.padEnd(8)}${state}`);
    if (tier.error) lines.push(...tier.error.split("\n").map((line) => `        ${line}`));
  }
  lines.push("");
  if (!report.effective) {
    lines.push("INVALID: Nexus does not start with this policy (exit code 2). No setting or environment variable bypasses it.");
    return printableLines(lines);
  }
  lines.push("Effective policy (value, then the tier that decides it):");
  const width = Math.max(...report.effective.map((row) => row.key.length));
  for (const row of report.effective) {
    lines.push(`  ${row.key.padEnd(width)}  ${row.value}  ${row.source}`);
    if (row.source === "(per item)") for (const item of row.items ?? []) lines.push(`  ${"".padEnd(width)}    ${JSON.stringify(item.value)}  ${item.source}`);
  }
  if (report.notices.length) lines.push("", ...report.notices);
  lines.push("", "VALID: this policy can be used.");
  return printableLines(lines);
}

// A project file or a file name can hold any character; none of it may drive the terminal.
const printableLines = (lines: string[]): string => `${lines.map(printableRefusal).join("\n")}\n`;

/** The verdict on a policy file that is not installed yet: its content, checked as a managed file's content is. */
export interface PolicyFileCheck {
  schemaVersion: typeof POLICY_REPORT_SCHEMA_VERSION;
  file: string;
  valid: boolean;
  /** What is wrong, as `[line N: ]<what>`. */
  error?: string;
  line?: number;
  code?: string;
}

/**
 * A parse error quotes the token it could not accept. `policy check` is pointed at any file the caller names, so a
 * quoted token that does not look like a policy key (lower-case words joined by dots and underscores) is cut to a few
 * characters: enough to find the place, not enough to read the file through its errors.
 */
function withoutFileText(detail: string): string {
  return detail.replace(/(['"`])([^'"`]{9,})\1/g, (all, quote: string, text: string) =>
    /^[a-z][a-z_.]{0,63}$/.test(text) ? all : `${quote}${text.slice(0, 8)}…${quote}`);
}

/**
 * Checks a candidate policy file before it is rolled out: a regular file, not a link, at most 64 KiB, valid UTF-8,
 * the strict grammar, known tables and keys, a supported `schema_version`. Owner and mode are not checked here: they
 * are properties of the installed file, and Nexus checks them where it is installed.
 */
export function checkPolicyFile(file: string): PolicyFileCheck {
  const resolved = path.resolve(file);
  const base = { schemaVersion: POLICY_REPORT_SCHEMA_VERSION, file: resolved } as const;
  try {
    const tiers = loadManagedTiers({ systemPath: null, systemOwnerUid: 0, userPath: resolved, userUid: null, fs });
    return tiers.user ? { ...base, valid: true } : { ...base, valid: false, code: "absent", error: "the file does not exist" };
  } catch (error) {
    if (!(error instanceof ManagedPolicyError)) throw error;
    return { ...base, valid: false, code: error.code, error: `${error.line === undefined ? "" : `line ${error.line}: `}${withoutFileText(error.detail)}`, ...(error.line === undefined ? {} : { line: error.line }) };
  }
}

export function renderPolicyFileCheck(check: PolicyFileCheck): string {
  return printableLines(
    check.valid
      ? [`VALID: ${check.file}`, "The content is a policy this Nexus accepts. Owner and mode are checked where the file is installed: run `nexus policy check` there."]
      : [`INVALID: ${check.file}: ${check.error}.`, "Nexus would refuse to start with this file installed as a managed policy."],
  );
}

/** What `nexus doctor` reports about policy. Shaped as doctor.ts findings, without their timing. */
export interface PolicyFinding {
  id: "policy.system" | "policy.user" | "policy.project" | "policy.effective";
  status: "pass" | "warn" | "fail" | "skip";
  explanation: string;
  evidence: string[];
  action?: string;
}

/** The policy findings: one per tier and one for the result. No finding offers a repair: doctor never changes a policy file. */
export function policyFindings(report: PolicyReport): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const tier of report.tiers) {
    const id = `policy.${tier.tier}` as PolicyFinding["id"];
    const evidence = tier.file === null ? [] : [tier.file];
    if (tier.file === null) findings.push({ id, status: "skip", explanation: `This platform has no ${tier.tier} policy tier.`, evidence });
    else if (tier.tier === "project") {
      if (tier.state === "invalid") findings.push({ id, status: "warn", explanation: "The project policy file cannot be used; none of it is applied (the managed tiers and the built-in defaults still are).", evidence: [...evidence, tier.error ?? ""], action: "Fix the file, or remove it." });
      else if (tier.state === "absent") findings.push({ id, status: "skip", explanation: `The workspace has no project policy file (optional)${tier.status && tier.status !== "ABSENT" ? `; status ${tier.status}` : ""}.`, evidence });
      else if (report.notices.length) findings.push({ id, status: "warn", explanation: `The project policy file is read (status ${tier.status}), and part of it is not applied.`, evidence: [...evidence, ...report.notices], action: "Review the file; `nexus trust <workspace>` approves it as it is now." });
      else findings.push({ id, status: "pass", explanation: `The project policy file is read (status ${tier.status}). It can only add restrictions to the managed tiers.`, evidence });
    } else if (tier.state === "invalid") {
      findings.push({
        id,
        status: "fail",
        explanation: `The ${tier.tier} policy file cannot be used, so Nexus refuses to start (exit code 2).`,
        evidence: [...evidence, ...(tier.error ?? "").split("\n")],
        action: tier.tier === "system" ? "Repair or remove the file as root, then run `nexus policy check`. Nothing bypasses it." : "Fix the file or move it aside (the message gives the command), then run `nexus policy check`.",
      });
    } else if (tier.state === "absent") findings.push({ id, status: "skip", explanation: `No ${tier.tier} policy file is installed (optional).`, evidence });
    else findings.push({ id, status: "pass", explanation: `The ${tier.tier} policy file is valid (schema_version ${tier.schemaVersion}).`, evidence });
  }
  if (!report.effective) {
    findings.push({ id: "policy.effective", status: "skip", explanation: "No effective policy: a managed policy file cannot be used.", evidence: [] });
    return findings;
  }
  const set = report.effective.filter((row) => !row.source.startsWith("[policy: default") && row.value !== "false");
  findings.push(
    set.length
      ? { id: "policy.effective", status: "pass", explanation: `${set.length} policy setting(s) restrict this workspace. \`nexus policy show\` lists every key.`, evidence: set.map((row) => `${row.key} = ${row.value} ${row.source}`) }
      : { id: "policy.effective", status: "skip", explanation: "No policy restricts this workspace: the built-in defaults apply.", evidence: [] },
  );
  return findings;
}

/** The report of this process's policy in `workspace`, with the trust facts security.ts uses. */
export function processPolicyReport(workspace: string): PolicyReport {
  const real = realWorkspace(workspace);
  return policyReport(processPolicyHost(), real, { workspaceTrusted: isWorkspaceListed(real), envTrustRequested: envTrustRequested() });
}

export function registerPolicyCommands(program: Command): void {
  const policy = program.command("policy").description("Show and check the managed policy (system, user and project tiers); never changes it");
  const show = (options: { workspace?: string; json?: boolean }): void => {
    const report = processPolicyReport(options.workspace ?? process.cwd());
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderPolicyReport(report));
    if (!report.valid) process.exitCode = MANAGED_POLICY_EXIT_CODE;
  };
  policy
    .command("show")
    .description("Print the effective policy for a workspace: every key, its value and the tier that decides it")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "Print the report as one JSON document")
    .action((_options: unknown, cmd: Command) => show(cmd.optsWithGlobals()));
  policy
    .command("check [file]")
    .description("Validate the installed policy files, or a policy file before it is rolled out; exit code 2 when Nexus would refuse to start")
    .option("-w, --workspace <path>", "Workspace directory (default: current directory)")
    .option("-j, --json", "Print the result as one JSON document")
    .action((file: string | undefined, _options: unknown, cmd: Command) => {
      const options: { workspace?: string; json?: boolean } = cmd.optsWithGlobals();
      if (file === undefined) return show(options);
      const check = checkPolicyFile(file);
      process.stdout.write(options.json ? `${JSON.stringify(check, null, 2)}\n` : renderPolicyFileCheck(check));
      if (!check.valid) process.exitCode = MANAGED_POLICY_EXIT_CODE;
    });
}
