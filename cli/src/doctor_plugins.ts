/**
 * The `plugins.workspace` finding of `nexus doctor` (HK-3): whether the workspace's own plugin files are in force.
 * Since per-plugin trust a trusted workspace no longer loads its plugins by itself, so a plugin an operator counts on
 * may have stopped loading. The files are read and compared with the approvals; none is imported.
 */
import * as path from "node:path";
import { inspectWorkspacePlugins } from "./plugins.js";
import { isWorkspaceTrusted } from "./workspace_trust.js";

export interface WorkspacePluginsDiagnosis {
  status: "pass" | "warn" | "skip";
  explanation: string;
  evidence: string[];
  action?: string;
}

const EVIDENCE_LIMIT = 20;

export function diagnoseWorkspacePlugins(workspace: string): WorkspacePluginsDiagnosis {
  const root = path.resolve(workspace);
  const records = inspectWorkspacePlugins(root);
  const note = "Plugin files were read and compared with your approvals; none was imported.";
  if (!records.length) return { status: "skip", explanation: "The workspace has no plugin files of its own (optional).", evidence: [] };
  const shown = (file: string) => path.relative(root, file);
  const what: Record<string, string> = {
    untrusted: "not approved, so it is not loaded",
    changed: "changed since it was approved, so it is not loaded",
    invalid: "cannot be read as a plugin file, so it is not loaded",
    "load-failed": "approved, but its last load failed, so it is not active",
  };
  const pending = records.filter((record) => record.status in what);
  if (!pending.length) {
    const trusted = isWorkspaceTrusted(root);
    return {
      status: trusted ? "pass" : "warn",
      explanation: trusted
        ? `${records.length} workspace plugin file(s) are approved. ${note}`
        : `${records.length} workspace plugin file(s) are approved, but the workspace is not trusted, so none is loaded. ${note}`,
      evidence: records.slice(0, EVIDENCE_LIMIT).map((record) => `${record.path}: approved`),
      ...(trusted ? {} : { action: `Trust the workspace with \`nexus trust ${root}\`; each plugin file keeps its own approval.` }),
    };
  }
  const evidence = pending.slice(0, EVIDENCE_LIMIT).map((record) => `${record.path}: ${what[record.status]}${record.status === "untrusted" || record.status === "changed" ? "" : ` (${record.reason ?? "no reason recorded"})`}`);
  if (pending.length > EVIDENCE_LIMIT) evidence.push(`... and ${pending.length - EVIDENCE_LIMIT} more: see \`nexus plugins list\``);
  const approvable = pending.filter((record) => record.status === "untrusted" || record.status === "changed");
  const broken = pending.filter((record) => record.status === "load-failed" || record.status === "invalid");
  const steps = [
    ...(approvable.length ? [`Review each file, then approve it by itself in a terminal: ${approvable.slice(0, 5).map((record) => `\`nexus plugins trust ${shown(record.path)}\``).join(", ")}${approvable.length > 5 ? ", ..." : ""}. Each plugin file needs its own approval; trusting the workspace does not load plugins.`] : []),
    ...(broken.length ? [`Fix ${broken.slice(0, 5).map((record) => shown(record.path)).join(", ")}: a workspace plugin must be one self-contained regular file (no sibling or workspace-package imports), then approve it again with \`nexus plugins trust <file>\`.`] : []),
  ];
  return {
    status: "warn",
    explanation: `${pending.length} of ${records.length} workspace plugin file(s) are not active. Since v1.3.0 each workspace plugin file needs its own approval. ${note}`,
    evidence,
    action: steps.join(" "),
  };
}
