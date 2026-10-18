import { UsageLedger } from "../usage.js";
import type { AutonomousAgent } from "../agent.js";
import { APPLIANCE, buildCatalog } from "../model_catalog.js";
import { selectModel } from "../provider_connect.js";
import { providerDefinition } from "../providers.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { LocalLlmClient } from "../client.js";
import { writeProtectedTextFile } from "../core/persistence_protection.js";
import { receiptText } from "../evidence.js";
import { buildSessionExport } from "../session_export.js";
import { getGitInfo, scaffoldProjectRules } from "../git.js";
import { scanAndOnboardWorkspace } from "../onboard.js";
import { ThemeManager } from "../theme.js";
import { renderTokenGauge } from "../tokens.js";
import { SLASH_COMMANDS, SlashContext, SlashHandler, SlashOutcome, errorText, oneLine, reply } from "./catalog.js";

function help(): SlashOutcome {
  const width = Math.max(...SLASH_COMMANDS.map((spec) => spec.usage.length));
  return reply("help", SLASH_COMMANDS.map((spec) => `${spec.usage.padEnd(width)}  ${spec.summary}`).join("\n"));
}

/**
 * `/doctor [--deep] [--fix [--yes]]`: the same engine as `nexus doctor`, on the running session's configuration (model
 * switches and workspace changes included). Read-only diagnosis may run during a turn; repairs wait for idle (the
 * sidecar refuses them while busy). Repairs need `--yes` in auto mode, or the approval prompt in review mode, and are
 * refused under --read-only.
 */
async function doctor({ host, args, signal }: SlashContext): Promise<SlashOutcome> {
  const { runDoctor, runRepairs, renderDoctorText } = await import("../doctor.js");
  const flags = args.split(/\s+/).filter(Boolean);
  const config = host.app.getConfig();
  const base = { context: "session" as const, config, flags: {}, deep: flags.includes("--deep"), signal };
  let report = await runDoctor(base);
  if (flags.includes("--fix")) {
    const confirm = host.confirm(signal);
    report = await runRepairs(report, {
      ...base,
      readOnly: Boolean(config.readOnly),
      confirm: async (proposals) => {
        if (flags.includes("--yes")) return true;
        if (confirm) return confirm("doctor_repair", { repairs: proposals.map((p) => p.description) });
        return false;
      },
    });
    const declined = report.repairs?.some((r) => r.status === "declined");
    if (declined && !confirm && !flags.includes("--yes")) {
      return reply("doctor", `${renderDoctorText(report)}\nRepairs need confirmation: run /doctor --fix --yes (or switch to /mode review to approve each run).`);
    }
  }
  const failed = report.findings.some((f) => f.status === "fail");
  return reply("doctor", renderDoctorText(report), !failed);
}

/**
 * `/requirements`: the acceptance requirements of the current objective. `accept <id>...` is the operator's authority
 * to let a requirement the agent descoped count as done; the agent cannot do this itself.
 */
async function requirements({ host, args }: SlashContext): Promise<SlashOutcome> {
  const { acceptDescoping, requirementRows } = await import("../core/objective.js");
  const ledger = host.app.getAgent().getObjective();
  if (!ledger) return reply("requirements", "No objective is being tracked yet.");
  const [verb, ...ids] = args.split(/\s+/).filter(Boolean);
  let note = "";
  if (verb === "clear") {
    const dropped = host.app.getAgent().clearObjective();
    host.saveSession();
    const open = dropped ? requirementRows(dropped).filter(([, v]) => !/^(IMPLEMENTED|VERIFIED|DESCOPED \(accepted\))/.test(v)).map(([id]) => id) : [];
    return reply("requirements", `The objective is cleared${open.length ? ` (unresolved when cleared: ${open.join(", ")})` : ""}; your next message starts a new one.`);
  }
  if (verb === "accept") {
    if (!ids.length) return reply("requirements", "Name the requirements to accept, e.g. /requirements accept R2.", false);
    const { accepted, refused } = acceptDescoping(ledger, ids);
    if (accepted.length) host.saveSession();
    note = `${accepted.length ? `Accepted the descoping of ${accepted.join(", ")}.` : ""}${refused.length ? ` Not descoped (nothing to accept): ${refused.join(", ")}.` : ""}\n\n`;
  } else if (verb) {
    return reply("requirements", "Usage: /requirements [accept <id>...|clear]", false);
  }
  const rows = requirementRows(ledger);
  if (!rows.length) return reply("requirements", `${note}The objective is a single request; no separate acceptance requirements were listed.`);
  return reply("requirements", `${note}${rows.map(([id, value]) => `${id.padEnd(4)} ${value}`).join("\n")}`);
}

/** Context sizing and counting: limits with their sources, capability state, the last request's count and source. */
function sizingRows(agent: AutonomousAgent): Array<[string, string]> {
  const caps = agent.getProviderCapabilities();
  const last = agent.getLastRequestCount();
  const tracking = agent.getObjective()?.execution;
  const rows: Array<[string, string]> = [];
  const via = caps?.advertised?.via ? ` via ${caps.advertised.via}` : "";
  rows.push(["context", caps ? `${caps.contextLimit} (${caps.contextSource}${via}) · output ${caps.outputAllowance} (${caps.outputSource})` : "not yet discovered (next request reads the provider's limits, if it advertises them)"]);
  if (caps) rows.push(["provider", `limits discovery ${caps.discovery}${caps.advertised?.serverKind ? ` · server_kind ${caps.advertised.serverKind}` : ""}${caps.advertised?.limitsVersion ? ` · limits_version ${caps.advertised.limitsVersion}` : ""} · request counting ${caps.tokenCounting}`]);
  if (last) rows.push(["last req", `${last.promptTokens} tokens (${last.source}${last.workerId ? ` on ${last.workerId}` : ""}); client estimate ${last.estimate}${last.admitted?.promptTokens !== undefined ? `; admitted ${last.admitted.promptTokens} (${last.admitted.source}${last.admitted.workerId ? ` on ${last.admitted.workerId}` : ""})` : ""}`]);
  if (tracking) rows.push(["progress", `${tracking.cumulativeSteps} steps on this objective · ${tracking.stepsWithoutProgress} since last progress · ${tracking.compactions.filter((c) => c.committed).length} compaction(s)`]);
  return rows;
}

async function status({ host }: SlashContext): Promise<SlashOutcome> {
  const config = host.app.getConfig();
  const git = getGitInfo(config.workspace);
  let servicesStr = "none";
  try {
    const services = await host.app.getAgent().getBridge().listServices();
    if (services && services.length > 0) {
      servicesStr = services.map((s) => `${s.name} (pgid ${s.pgid})`).join(", ");
    }
  } catch {
    servicesStr = "none";
  }

  const rows: Array<[string, string]> = [
    ["workspace", config.workspace],
    ["git", git.isRepo ? git.formattedBadge : "not a repository"],
    ["model", config.model],
    ["mode", host.mode()],
    ["endpoint", config.endpoint],
    ["shell", config.shell],
    ["messages", String(host.app.getAgent().getHistoryCount())],
    ["session", host.sessionId()],
    ["services", servicesStr],
    ...sizingRows(host.app.getAgent()),
  ];
  return reply("status", rows.map(([label, value]) => `${label.padEnd(10)}${value}`).join("\n"));
}

function clear({ host }: SlashContext): SlashOutcome {
  host.app.getAgent().resetConversation();
  return reply("clear", "Conversation context reset.");
}

async function compact({ host, args, signal }: SlashContext): Promise<SlashOutcome> {
  // Run only while no turn is active (a host queues /compact during a turn: AutonomousAgent.requestCompaction).
  const result = await host.app.getAgent().compactNow(args.split(/\s+/).includes("--llm"), signal);
  return reply("compact", result.message, result.ok);
}

function mode({ host, args }: SlashContext): SlashOutcome {
  const wanted = args.trim().toLowerCase();
  if (wanted === "auto" || wanted === "autonomous") {
    host.setMode("auto");
    return reply("mode", "Mode: auto. Edits and commands run without asking.");
  }
  if (wanted === "review" || wanted === "ask") {
    host.setMode("review");
    return reply("mode", "Mode: review. Edits and commands wait for your approval.");
  }
  return reply("mode", `Current mode: ${host.mode()}. Use /mode auto or /mode review.`, !wanted);
}

async function model({ host, args }: SlashContext): Promise<SlashOutcome> {
  const config = host.app.getConfig();
  const name = args.trim();
  // `/model <provider> <model>`: switch provider and model ("appliance" for the local appliance).
  const [first, ...rest] = name.split(/\s+/);
  if (rest.length && (first === APPLIANCE || providerDefinition(first))) {
    const r = selectModel(host.app.getAgent(), config, { provider: first, model: rest.join(" ") });
    return reply("model", r.message, r.ok);
  }
  if (!name) {
    const catalog = await buildCatalog(config);
    const lines: string[] = [];
    for (const p of catalog.providers) {
      const status = p.connected ? `connected${p.source ? ` via ${p.source}` : ""}${p.status === "cached" ? " · offline, cached list" : p.status === "error" ? ` · ${p.error}` : ""}` : `not connected — nexus connect ${p.id}`;
      lines.push(`${p.label} [${p.id}] — ${status}`);
      for (const m of catalog.models.filter((m) => m.provider === p.id)) {
        const active = m.provider === catalog.current.provider && m.id === catalog.current.model;
        lines.push(`  ${active ? "*" : " "} ${m.id}${active ? " (active)" : ""}`);
      }
    }
    lines.push("", "Switch with /model <provider> <model>. In the live view, /model opens the picker and ctrl+p connects a provider.");
    return reply("model", lines.join("\n"));
  }
  config.model = name;
  host.app.getAgent().setModel(name);
  return reply("model", `Model: ${name}`);
}

function shell({ host, args }: SlashContext): SlashOutcome {
  const config = host.app.getConfig();
  const name = args.trim();
  if (!name) return reply("shell", `Active shell: ${config.shell}`);
  config.shell = name;
  host.app.getAgent().setShell(name);
  return reply("shell", `Shell: ${name}`);
}

function cd({ host, args }: SlashContext): SlashOutcome {
  const config = host.app.getConfig();
  if (!args.trim()) return reply("cd", `Workspace: ${config.workspace}`);
  const target = path.resolve(config.workspace, args.trim());
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return reply("cd", `Not a directory: ${target}`, false);
  host.setWorkspace(target);
  return reply("cd", `Workspace: ${target}`);
}

function tokens({ host }: SlashContext): SlashOutcome {
  const agent = host.app.getAgent();
  const lines = [renderTokenGauge(agent.getContextBudget()).trim()];
  const total = agent.getTokenStats();
  if (total.total > 0) {
    lines.push("", `Session usage: ${total.prompt.toLocaleString()} prompt, ${total.completion.toLocaleString()} completion (${total.total.toLocaleString()} total tokens)`);
  }
  const cloud = UsageLedger.global().summary();
  if (cloud) lines.push(cloud);
  return reply("tokens", lines.join("\n"));
}

function sessions({ host }: SlashContext): SlashOutcome {
  const list = host.app.getSessionManager().listSessions();
  if (!list.length) return reply("sessions", "No saved sessions yet.");
  const rows = list.slice(0, 10).map((s) => `${s.id === host.sessionId() ? "*" : " "} ${s.id}  ${s.updatedAt.slice(0, 19)}  ${oneLine(s.title)} · ${s.messageCount} messages`);
  return reply("sessions", [...rows, "", "Load one with /resume <id>."].join("\n"));
}

function save({ host, args }: SlashContext): SlashOutcome {
  if (host.app.getAgent().getMessages().length <= 1) return reply("save", "Nothing to save yet: the conversation is empty.", false);
  const previous = host.sessionId();
  if (args.trim()) host.setSessionId(args.trim());
  try {
    host.saveSession("Snapshot");
  } catch (err) {
    host.setSessionId(previous);
    throw err;
  }
  return reply("save", `Session saved as ${host.sessionId()}.`);
}

function resume({ host, args }: SlashContext): SlashOutcome {
  const result = host.resumeSession(args.trim() || undefined);
  return reply("resume", result.message, result.ok);
}

/** Resolves history item `raw` (1-based) to a turn, or an out-of-range reply. */
export function recall(items: string[], raw: string, command: string): SlashOutcome {
  const index = Number.parseInt(raw, 10) - 1;
  if (!(index >= 0 && index < items.length)) return reply(command, `History index out of range: ${raw}`, false);
  const prompt = items[index];
  return { kind: "turn", command, prompt, label: prompt, checkpoint: `Turn: ${prompt.slice(0, 30)}` };
}

function history({ host, args }: SlashContext): SlashOutcome {
  const items = host.history();
  const query = args.trim();
  const run = query.startsWith("run ") ? query.slice(4).trim() : /^\d+$/.test(query) ? query : undefined;
  if (run !== undefined) return recall(items, run, "history");
  if (query) {
    const lower = query.toLowerCase();
    const hits = items.map((item, index) => ({ item, index })).filter(({ item }) => item.toLowerCase().includes(lower));
    if (!hits.length) return reply("history", `No history items match "${query}".`);
    return reply("history", hits.map(({ item, index }) => `[${index + 1}] ${oneLine(item)}`).join("\n"));
  }
  if (!items.length) return reply("history", "No prompt history yet.");
  const start = Math.max(0, items.length - 20);
  const rows = items.slice(start).map((item, offset) => `[${start + offset + 1}] ${oneLine(item)}`);
  return reply("history", [...rows, "", "Run one again with /history run <n> or !<n>."].join("\n"));
}

function exportSession({ host, args }: SlashContext): SlashOutcome {
  const session = host.app.getSessionManager().loadSession(host.sessionId());
  if (!session || session.messages.length === 0) return reply("export", "Nothing to export yet: this session has not been saved.", false);
  const json = args.trim().toLowerCase() === "json";
  const out = path.join(host.app.getConfig().workspace, `nexus-session-${session.id}.${json ? "json" : "md"}`);
  const exported = buildSessionExport(host.app.getSessionManager(), session);
  writeProtectedTextFile(out, json ? JSON.stringify(exported.json, null, 2) : exported.markdown);
  const history = (exported.json.export as { history: { note: string } }).history;
  return reply("export", `Transcript written to ${out}\n${history.note}`);
}

function init({ host }: SlashContext): SlashOutcome {
  return reply("init", `Project instructions file ready at: ${scaffoldProjectRules(host.app.getConfig().workspace)}`);
}

function onboard({ host }: SlashContext): SlashOutcome {
  const report = scanAndOnboardWorkspace(host.app.getConfig().workspace, true);
  return reply("onboard", [
    `Onboarded ${report.projectName}.`,
    `Stack: ${report.languages.join(", ") || "general"}`,
    `Commands: build ${report.buildCommands[0] || "none"} · test ${report.testCommands[0] || "none"} · lint ${report.lintCommands[0] || "none"}`,
    "Wrote a tailored AGENTS.md.",
  ].join("\n"));
}

function theme({ args }: SlashContext): SlashOutcome {
  const themes = new ThemeManager();
  const name = args.trim();
  if (!name) {
    const rows = themes.listThemes().map((t) => `${t === themes.getThemeName() ? "*" : " "} ${t}`);
    return reply("theme", [...rows, "", "Save one with /theme <name>."].join("\n"));
  }
  return themes.saveConfiguredTheme(name)
    ? reply("theme", `Theme saved: ${name}`)
    : reply("theme", `Unknown theme ${name}. Options: ${themes.listThemes().join(", ")}`, false);
}

export const SESSION_HANDLERS: Record<string, SlashHandler> = {
  help,
  doctor,
  requirements,
  status,
  clear,
  compact,
  mode,
  model,
  shell,
  cd,
  tokens,
  sessions,
  save,
  resume,
  history,
  export: exportSession,
  init,
  onboard,
  theme,
  receipt: ({ host }) => reply("receipt", receiptText(host.receipt())),
  upgrade: upgradeSlash,
  exit: () => reply("exit", "Press q, or ctrl+c with an empty composer, to quit."),
};

/**
 * `/upgrade [--check] [--version <v>] [--yes] [--force]`: compare the installed version with a published
 * release and safely upgrade using the canonical installer and deliberate operator approval.
 */
async function upgradeSlash({ host, args, signal }: SlashContext): Promise<SlashOutcome> {
  const {
    detectInstallation,
    resolveTargetRelease,
    compareInstallationWithRelease,
    performUpgrade,
  } = await import("../upgrade.js");

  const tokens = args.split(/\s+/).filter(Boolean);
  let isCheck = false;
  let isForce = false;
  let isYes = false;
  let allowDowngrade = false;
  let pinnedVersion: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--check") isCheck = true;
    else if (t === "--force" || t === "-f") isForce = true;
    else if (t === "--yes" || t === "-y") isYes = true;
    else if (t === "--allow-downgrade") allowDowngrade = true;
    else if (t === "--version" || t === "-v") {
      pinnedVersion = tokens[++i];
    } else if (!t.startsWith("-") && !pinnedVersion) {
      pinnedVersion = t;
    }
  }

  const installed = detectInstallation();
  let targetRelease;
  try {
    targetRelease = await resolveTargetRelease(pinnedVersion, { signal });
  } catch (err: any) {
    return reply("upgrade", `Failed to resolve release: ${err.message || String(err)}`, false);
  }

  const comparison = compareInstallationWithRelease(installed, targetRelease, { force: isForce });

  if (isCheck) {
    const lines = [
      `Installed version:  ${installed.version} (${installed.provenance})`,
      `Target release:     ${targetRelease.tag_name}${targetRelease.prerelease ? " (prerelease)" : " (stable)"}${targetRelease.published_at ? ` [published ${targetRelease.published_at}]` : ""}`,
    ];
    if (installed.prefix) lines.push(`Install prefix:     ${installed.prefix}`);
    if (comparison.reasons.length > 0) {
      for (const r of comparison.reasons) lines.push(`Note:               ${r}`);
    }
    if (comparison.action === "upgrade") {
      lines.push(`\nUpdate available: ${installed.version} -> ${comparison.targetVersion}. Run /upgrade to install.`);
    } else if (comparison.action === "downgrade") {
      lines.push(`\nTarget ${comparison.targetVersion} is older than current ${installed.version}. Run /upgrade --version ${comparison.targetVersion} --allow-downgrade to downgrade.`);
    } else {
      lines.push(`\nNexus is already up to date (${installed.version}).`);
    }
    return reply("upgrade", lines.join("\n"), true);
  }

  if (!comparison.canUpgrade) {
    return reply("upgrade", `Cannot upgrade: ${comparison.reasons.join("\n")}`, false);
  }

  if (comparison.action === "none" && !isForce) {
    return reply("upgrade", `Nexus is already up to date (${installed.version}). Use /upgrade --force to reinstall.`, true);
  }

  if (comparison.action === "downgrade" && !allowDowngrade && !isYes) {
    return reply("upgrade", `Target version ${comparison.targetVersion} is a downgrade from ${installed.version}. Specify --allow-downgrade to proceed.`, false);
  }

  // Deliberate confirmation
  if (!isYes) {
    const confirmFn = host.requestApproval
      ? (tool: string, a: Record<string, any>) => host.requestApproval!(tool, a, signal)
      : host.confirm(signal);

    if (!confirmFn) {
      return reply(
        "upgrade",
        `Proposed ${comparison.action}: ${installed.version} -> ${comparison.targetVersion}.\nConfirmation required: run /upgrade --yes to apply, or review in interactive mode.`,
        false
      );
    }

    const targetDest = path.join(installed.prefix || "", "lib/nexus", comparison.targetVersion);
    const approved = await confirmFn("nexus_upgrade", {
      action: comparison.action,
      installedVersion: installed.version,
      targetVersion: comparison.targetVersion,
      destination: targetDest,
      notice: "Installs the release package and atomically swaps the launcher symlink. The running session continues safely on the current version until restart."
    });

    if (!approved) {
      return reply("upgrade", `Upgrade to ${comparison.targetVersion} was declined.`, false);
    }
  }

  try {
    const result = await performUpgrade(comparison, {
      force: isForce,
      allowDowngrade,
      signal,
    });
    return reply(
      "upgrade",
      `✔ Nexus successfully upgraded to ${result.newVersion}.\nDestination: ${result.installedPath}\nLauncher:    ${result.binPath}\n\nNotice: ${result.restartNotice}`,
      true
    );
  } catch (err: any) {
    return reply("upgrade", `Upgrade failed: ${err.message || String(err)}`, false);
  }
}
