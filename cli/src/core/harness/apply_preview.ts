import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ensurePrivateDir, writeFileDurably } from "../durable_file.js";
import { HarnessStore } from "./store.js";
import type { HarnessCandidate, PromotionReport } from "./types.js";

export interface ApplyPreviewResult {
  runId: string;
  reportId: string;
  candidateId?: string;
  createdAt: string;
  previewDir: string;
  files: string[];
  noApplyWarning: string;
}

function safeDiff(base: string, cand: string): string {
  const r = spawnSync("git", ["--no-pager", "diff", "--no-index", "--binary", "--", base, cand], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (r.status === 0) return "";
  if (r.status === 1) return (r.stdout ?? "").slice(0, 2 * 1024 * 1024);
  return `# diff unavailable\n# status=${String(r.status)}\n${(r.stderr ?? "").slice(0, 20000)}`;
}

export function buildApplyPreview(store: HarnessStore, runId: string): ApplyPreviewResult {
  const run = store.loadRun(runId);
  const report = store.loadReport(runId);
  if (!report) throw new Error(`No report for ${runId}`);
  const candidateId = report.recommendedCandidateId;
  const createdAt = new Date().toISOString();
  const previewDir = path.join(store.runDir(runId), "apply-preview");
  ensurePrivateDir(previewDir);
  const files: string[] = [];

  const summary = {
    schemaVersion: 1,
    runId,
    reportId: report.id,
    candidateId,
    createdAt,
    liveMutation: false,
    noApplyWarning: "HIR apply preview is review-only. It does not mutate live harness/profile state. Manual reviewed apply required.",
    recommendedAction: report.changes.find((c) => c.recommendation === "review" || c.recommendation === "apply")?.recommendation ?? "review",
    candidateDiffRefs: [] as Array<{ candidateId: string; diffRef: string; gateStatus: string }>,
  };

  for (const cid of run.candidateIds) {
    let cand: HarnessCandidate | undefined;
    try { cand = store.loadCandidate(cid); } catch { continue; }
    summary.candidateDiffRefs.push({ candidateId: cid, diffRef: cand.diffRef, gateStatus: cand.gate.status });
    if (cand.diffRef && fs.existsSync(cand.diffRef)) {
      const target = path.join(previewDir, `${cid}.diff.txt`);
      fs.copyFileSync(cand.diffRef, target);
      files.push(target);
    } else if (cand.treeRef && fs.existsSync(cand.treeRef)) {
      const baseTree = path.join(store.baseDir(run.baseHarnessId), "tree");
      const diff = safeDiff(baseTree, cand.treeRef);
      const target = path.join(previewDir, `${cid}.diff.txt`);
      writeFileDurably(target, diff, 0o600);
      files.push(target);
    }
  }

  const jsonPath = path.join(previewDir, "preview.json");
  writeFileDurably(jsonPath, JSON.stringify(summary, null, 2) + "\n", 0o600);
  files.push(jsonPath);
  const md = [
    `# HIR Apply Preview ${runId}`,
    "",
    "> HIR apply preview is review-only. It does not mutate live harness/profile state. Manual reviewed apply required.",
    "",
    `- Run: ${runId}`,
    `- Report: ${report.id}`,
    `- Recommended candidate: ${candidateId ?? "(none)"}`,
    "",
    "## Candidate diffs",
    ...summary.candidateDiffRefs.map((c) => `- ${c.candidateId}: gate=${c.gateStatus} diff=${c.diffRef || "(generated)"}`),
    "",
    "## Manual apply (reviewed)",
    "- Inspect preview.json and candidate diff files.",
    "- Apply only approved changes in a separate reviewed commit/worktree.",
    "- Re-run deterministic verification and full required checks before merge/release.",
  ].join("\n") + "\n";
  const mdPath = path.join(previewDir, "preview.md");
  writeFileDurably(mdPath, md, 0o600);
  files.push(mdPath);

  return { runId, reportId: report.id, candidateId, createdAt, previewDir, files, noApplyWarning: summary.noApplyWarning };
}
