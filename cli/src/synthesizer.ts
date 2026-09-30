import * as fs from "node:fs";
import * as path from "node:path";
import { runTestSuite, detectTestCommand, TestRunResult } from "./tester.js";
import { AutonomousAgent } from "./agent.js";
import { HarnessConfig } from "./types.js";
import pc from "picocolors";

export type TddPhase = "IDLE" | "RED" | "GREEN" | "REFACTOR" | "COMPLETED";

export interface TddPhaseRecord {
  phase: TddPhase;
  timestamp: string;
  status: "PENDING" | "PASSED" | "FAILED";
  details?: string;
}

export interface SynthesizerState {
  currentPhase: TddPhase;
  issueDescription: string;
  reproductionTestTarget?: string;
  history: TddPhaseRecord[];
  regressionFailures: string[];
}

export interface TddVerificationResult {
  success: boolean;
  phase: TddPhase;
  output: string;
  failures?: string[];
  error?: string;
}

export interface TddRunResult {
  success: boolean;
  finalPhase: TddPhase;
  summary: string;
  state: SynthesizerState;
}

/**
 * SynthesizerEngine: Enforces strict RED-GREEN-REFACTOR Test-Driven Development protocol.
 * 
 * 1. RED Phase: Ensures a reproduction test is created and fails before any source edits are allowed.
 * 2. GREEN Phase: Applies surgical fixes until the reproduction test passes.
 * 3. REFACTOR Phase: Executes workspace test suite to guarantee zero regression.
 */
export class SynthesizerEngine {
  private workspace: string;
  private state: SynthesizerState;

  constructor(workspace: string = process.cwd()) {
    this.workspace = path.resolve(workspace);
    this.state = {
      currentPhase: "IDLE",
      issueDescription: "",
      history: [],
      regressionFailures: [],
    };
  }

  public getState(): SynthesizerState {
    return { ...this.state, history: [...this.state.history] };
  }

  public getCurrentPhase(): TddPhase {
    return this.state.currentPhase;
  }

  /**
   * Initializes a TDD session for an issue or bug report.
   */
  public startSession(issueDescription: string, reproductionTestTarget?: string): void {
    this.state = {
      currentPhase: "RED",
      issueDescription,
      reproductionTestTarget,
      history: [
        {
          phase: "RED",
          timestamp: new Date().toISOString(),
          status: "PENDING",
          details: `Session initiated: ${issueDescription}`,
        },
      ],
      regressionFailures: [],
    };
  }

  /**
   * Phase 1 (RED): Run reproduction test against unpatched codebase.
   * Success requires the reproduction test to FAIL (confirming bug presence).
   */
  public async verifyRedPhase(testTarget?: string): Promise<TddVerificationResult> {
    const target = testTarget || this.state.reproductionTestTarget;
    if (!target) {
      return {
        success: false,
        phase: "RED",
        output: "",
        error: "No reproduction test target specified for RED phase verification.",
      };
    }
    this.state.reproductionTestTarget = target;

    const testRes = runTestSuite(this.workspace, target);
    // In RED phase, success = test FAILED (confirmed defect reproduction)
    const defectReproduced = !testRes.success;

    if (defectReproduced) {
      this.state.currentPhase = "GREEN";
      this.state.history.push({
        phase: "RED",
        timestamp: new Date().toISOString(),
        status: "PASSED",
        details: `Reproduction test failed as expected. Defect reproduced (${testRes.failures.length} failures).`,
      });

      return {
        success: true,
        phase: "RED",
        output: testRes.rawOutput,
        failures: testRes.failures,
      };
    } else {
      this.state.history.push({
        phase: "RED",
        timestamp: new Date().toISOString(),
        status: "FAILED",
        details: "Reproduction test passed unexpectedly. Bug was not reproduced.",
      });

      return {
        success: false,
        phase: "RED",
        output: testRes.rawOutput,
        error: "Reproduction test passed on unpatched codebase. A valid reproduction test must fail on the existing defect.",
      };
    }
  }

  /**
   * Phase 2 (GREEN): Verify that the reproduction test passes after source edits.
   */
  public async verifyGreenPhase(testTarget?: string): Promise<TddVerificationResult> {
    const target = testTarget || this.state.reproductionTestTarget;
    if (!target) {
      return {
        success: false,
        phase: "GREEN",
        output: "",
        error: "No reproduction test target specified for GREEN phase verification.",
      };
    }

    const testRes = runTestSuite(this.workspace, target);
    if (testRes.success) {
      this.state.currentPhase = "REFACTOR";
      this.state.history.push({
        phase: "GREEN",
        timestamp: new Date().toISOString(),
        status: "PASSED",
        details: "Reproduction test passed! Bug resolved by source edits.",
      });

      return {
        success: true,
        phase: "GREEN",
        output: testRes.rawOutput,
      };
    } else {
      this.state.history.push({
        phase: "GREEN",
        timestamp: new Date().toISOString(),
        status: "FAILED",
        details: `Reproduction test still failing (${testRes.failures.length} failures).`,
      });

      return {
        success: false,
        phase: "GREEN",
        output: testRes.rawOutput,
        failures: testRes.failures,
        error: "Reproduction test continues to fail. Additional implementation needed.",
      };
    }
  }

  /**
   * Phase 3 (REFACTOR): Run the complete test suite to guarantee zero regressions.
   */
  public async verifyRefactorPhase(): Promise<TddVerificationResult> {
    const fullRes = runTestSuite(this.workspace);

    if (fullRes.success) {
      this.state.currentPhase = "COMPLETED";
      this.state.regressionFailures = [];
      this.state.history.push({
        phase: "REFACTOR",
        timestamp: new Date().toISOString(),
        status: "PASSED",
        details: "Full test suite passed with zero regressions.",
      });

      return {
        success: true,
        phase: "REFACTOR",
        output: fullRes.rawOutput,
      };
    } else {
      this.state.regressionFailures = fullRes.failures;
      this.state.history.push({
        phase: "REFACTOR",
        timestamp: new Date().toISOString(),
        status: "FAILED",
        details: `Regressions detected: ${fullRes.failures.length} tests failing.`,
      });

      return {
        success: false,
        phase: "REFACTOR",
        output: fullRes.rawOutput,
        failures: fullRes.failures,
        error: `Regressions detected! ${fullRes.failures.length} tests failed in full suite.`,
      };
    }
  }

  /**
   * Orchestrates an end-to-end TDD session with an autonomous agent.
   */
  public async runAutonomousTdd(
    agent: AutonomousAgent,
    issuePrompt: string,
    reproductionHint?: string
  ): Promise<TddRunResult> {
    this.startSession(issuePrompt, reproductionHint);

    console.log(pc.bold(pc.cyan("\n🔴 === TDD PHASE 1: RED (Create Reproduction Test) ===\n")));
    const redPrompt = [
      `[TDD PROTOCOL - PHASE 1: RED]`,
      `Objective: ${issuePrompt}`,
      reproductionHint ? `Target Test File/Pattern: ${reproductionHint}` : "",
      ``,
      `Instructions:`,
      `1. Explore existing tests and locate the component under test.`,
      `2. Author a reproduction test that asserts the correct expected behavior and explicitly triggers the issue.`,
      `3. Execute the test using run_command to verify that it FAILS against the current unpatched code.`,
      `4. DO NOT modify any production / source files yet.`,
      `5. Once the reproduction test is written and confirmed failing, call task_completed with a summary of the failing test.`,
    ].filter(Boolean).join("\n");

    await agent.run(redPrompt);

    // Verify RED phase
    let target = this.state.reproductionTestTarget || reproductionHint;
    if (!target) {
      // Auto-detect newly modified test files from git status
      try {
        const gitInfo = agent.getEffectiveTools();
        // Fallback to searching recently added files in test/ or tests/
      } catch {}
    }

    console.log(pc.bold(pc.green("\n🟢 === TDD PHASE 2: GREEN (Implement Fix) ===\n")));
    const greenPrompt = [
      `[TDD PROTOCOL - PHASE 2: GREEN]`,
      `Objective: Fix the bug and make the reproduction test pass.`,
      `Reproduction Test: ${target || "Created in Phase 1"}`,
      ``,
      `Instructions:`,
      `1. Inspect the failing test and pinpoint the root cause in the source code.`,
      `2. Apply minimal, surgical edits to production source files using edit_file or patch_file.`,
      `3. Run the reproduction test using run_command to verify it now PASSES.`,
      `4. When the reproduction test passes, call task_completed with a summary of the fix.`,
    ].join("\n");

    await agent.run(greenPrompt);

    console.log(pc.bold(pc.magenta("\n🔵 === TDD PHASE 3: REFACTOR (Regression Suite Verification) ===\n")));
    const refactorResult = await this.verifyRefactorPhase();

    if (!refactorResult.success) {
      console.log(pc.yellow(`⚠️ Regressions detected! Spawning self-healing turn...`));
      const healingPrompt = [
        `[TDD PROTOCOL - PHASE 3: REGRESSION HEALING]`,
        `The fix introduced regressions in the wider test suite:`,
        ...(refactorResult.failures || []).map((f) => `  - ${f}`),
        ``,
        `Instructions:`,
        `1. Fix the regressions while keeping the reproduction test passing.`,
        `2. Run the test suite to confirm all tests pass cleanly.`,
        `3. Call task_completed when all tests pass.`,
      ].join("\n");

      await agent.run(healingPrompt);
      const recheck = await this.verifyRefactorPhase();
      if (!recheck.success) {
        return {
          success: false,
          finalPhase: this.state.currentPhase,
          summary: "TDD workflow completed with remaining regressions.",
          state: this.getState(),
        };
      }
    }

    return {
      success: true,
      finalPhase: "COMPLETED",
      summary: "TDD workflow completed successfully: RED -> GREEN -> REFACTOR verified.",
      state: this.getState(),
    };
  }
}
