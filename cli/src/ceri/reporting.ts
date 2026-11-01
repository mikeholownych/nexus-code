import type { CeriOperationalReport, BaselineComparisonResult, RunManifest } from "./contracts.js";

export class CeriReportGenerator {
  /**
   * Generates a structured operational report from executed evaluation runs and baseline comparisons.
   */
  static generateOperationalReport(
    runs: Array<{ manifest: RunManifest; comparison?: BaselineComparisonResult }>,
    totalAvailableEvaluations: number,
    options?: {
      baselineId?: string;
      limitations?: string[];
    }
  ): CeriOperationalReport {
    let passedRuns = 0;
    let failedRuns = 0;
    let inconclusiveCount = 0;
    let flakyCount = 0;
    let infrastructureFailures = 0;
    let incomparableCount = 0;
    const confirmedRegressions: string[] = [];
    const regressionCandidates: string[] = [];
    const blockers: string[] = [];

    for (const { manifest, comparison } of runs) {
      if (manifest.status === "FAILED") failedRuns++;
      else if (manifest.status === "COMPLETED") passedRuns++;
      else if (manifest.status === "INTERRUPTED" || manifest.status === "INCONCLUSIVE" || manifest.status === "NOT_EXECUTED") inconclusiveCount++;

      if (comparison) {
        if (comparison.outcome === "CONFIRMED_REGRESSION") {
          confirmedRegressions.push(comparison.currentRunId);
          blockers.push(`Confirmed regression in evaluation '${manifest.evaluationId}' (Run ${manifest.runId})`);
        } else if (comparison.outcome === "REGRESSION_CANDIDATE") {
          regressionCandidates.push(comparison.currentRunId);
        } else if (comparison.outcome === "FLAKY") {
          flakyCount++;
        } else if (comparison.outcome === "INFRASTRUCTURE_FAILURE") {
          infrastructureFailures++;
        } else if (comparison.outcome === "INCONCLUSIVE") {
          inconclusiveCount++;
        } else if (comparison.outcome === "INCOMPARABLE") {
          incomparableCount++;
        }
      }
    }

    const executedRuns = runs.length;
    const rawCoverage =
      executedRuns > 0 ? (executedRuns / Math.max(1, totalAvailableEvaluations)) * 100 : 0;
    const completenessScore = Number(Math.min(100, Math.max(0, rawCoverage)).toFixed(1));

    return {
      reportId: `CERI-REP-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      evaluationCoverage: {
        totalEvaluations: totalAvailableEvaluations,
        executedRuns,
        passedRuns,
        failedRuns,
      },
      baselineId: options?.baselineId,
      regressions: {
        confirmed: confirmedRegressions,
        candidates: regressionCandidates,
      },
      inconclusiveCount,
      flakyCount,
      infrastructureFailures,
      incomparableCount,
      blockers,
      evidenceCompletenessScore: completenessScore,
      limitations: options?.limitations ?? [
        "Internal evaluation results serve as release veto gates; independent verification receipts required for certification.",
      ],
    };
  }

  /**
   * Formats the operational report as a clean GitHub-style Markdown report.
   */
  static formatMarkdownReport(report: CeriOperationalReport): string {
    const lines: string[] = [];
    lines.push(`# Continuous Evaluation and Regression Intelligence (CERI) Report`);
    lines.push(`**Report ID:** \`${report.reportId}\`  `);
    lines.push(`**Generated At:** ${report.generatedAt}  `);
    if (report.baselineId) {
      lines.push(`**Designated Baseline:** \`${report.baselineId}\`  `);
    }
    lines.push(`**Coverage Score:** ${report.evidenceCompletenessScore}% (${report.evaluationCoverage.executedRuns}/${report.evaluationCoverage.totalEvaluations} evaluations executed)  `);
    lines.push("");

    lines.push(`## 1. Executive Status & Release Gates`);
    if (report.evaluationCoverage.executedRuns === 0) {
      lines.push(`> [!WARNING]`);
      lines.push(`> **NO EVALUATIONS EXECUTED:** Coverage is 0%. No capability or regression claims can be substantiated.`);
    } else if (report.blockers.length > 0) {
      lines.push(`> [!CAUTION]`);
      lines.push(`> **RELEASE BLOCKED:** ${report.blockers.length} confirmed regression blocker(s) detected.`);
      for (const b of report.blockers) {
        lines.push(`> - ${b}`);
      }
    } else if (report.regressions.candidates.length > 0) {
      lines.push(`> [!WARNING]`);
      lines.push(`> **QUALIFICATION IN PROGRESS:** ${report.regressions.candidates.length} regression candidate(s) awaiting reproduction runs.`);
    } else if (
      report.evaluationCoverage.failedRuns > 0 ||
      report.inconclusiveCount > 0 ||
      report.infrastructureFailures > 0 ||
      report.incomparableCount > 0
    ) {
      lines.push(`> [!WARNING]`);
      lines.push(
        `> **EVALUATION ANOMALIES DETECTED:** Non-zero failures (${report.evaluationCoverage.failedRuns}), inconclusive (${report.inconclusiveCount}), infrastructure failures (${report.infrastructureFailures}), or incomparable runs (${report.incomparableCount}). Further qualification required.`
      );
    } else {
      lines.push(`> [!NOTE]`);
      lines.push(
        `> **NO REGRESSIONS OBSERVED:** All executed evaluations (${report.evaluationCoverage.passedRuns}) completed cleanly and match or exceed baseline criteria.`
      );
    }
    lines.push("");

    lines.push(`## 2. Evaluation Metrics Ledger`);
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Executed Runs | ${report.evaluationCoverage.executedRuns} |`);
    lines.push(`| Passed Runs | ${report.evaluationCoverage.passedRuns} |`);
    lines.push(`| Failed Runs | ${report.evaluationCoverage.failedRuns} |`);
    lines.push(`| Confirmed Regressions | ${report.regressions.confirmed.length} |`);
    lines.push(`| Regression Candidates | ${report.regressions.candidates.length} |`);
    lines.push(`| Inconclusive / Interrupted | ${report.inconclusiveCount} |`);
    lines.push(`| Flaky Evaluations | ${report.flakyCount} |`);
    lines.push(`| Infrastructure Failures | ${report.infrastructureFailures} |`);
    lines.push(`| Incomparable Configurations | ${report.incomparableCount} |`);
    lines.push("");

    lines.push(`## 3. Explicit Measurement Limitations`);
    for (const lim of report.limitations) {
      lines.push(`- ${lim}`);
    }
    lines.push("");

    return lines.join("\n");
  }
}
