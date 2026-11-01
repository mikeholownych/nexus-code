export type BenchmarkCategory =
  | "deterministic_query"
  | "code_review"
  | "debugging"
  | "feature_implementation";

export interface BenchmarkScenario {
  id: string;
  title: string;
  category: BenchmarkCategory;
  syntheticBaselineTurns: number;
  syntheticBaselineTokens: number;
  hasConfirmationBiasRisk: boolean;
}

export interface ExecutionTrace {
  scenarioId: string;
  configId: "configA" | "configB" | "configC";
  turns: number;
  tokensConsumed: number;
  confirmationBiasDefectAccepted: boolean;
  cycleDetected: boolean;
}

export interface OrchestrationConfigProfile {
  id: "configA" | "configB" | "configC";
  name: string;
  totalTurns: number;
  totalTokens: number;
  confirmationBiasDefectsAccepted: number;
  efficiencyScore: number;
  cyclesDetected: number;
}

export interface ComparativeBenchmarkResult {
  scenariosCount: number;
  profiles: {
    configA: OrchestrationConfigProfile;
    configB: OrchestrationConfigProfile;
    configC: OrchestrationConfigProfile;
  };
}

/**
 * Comparative evaluation framework contrasting three orchestration architectures:
 * - Config A: Baseline Generalist (Single agent, naive retry, unstripped review narratives)
 * - Config B: Specialist Profiles & Objective Review (Specialists + Review boundary, no micro-router)
 * - Config C: Adaptive Orchestration (Specialists, Micro-Router, Review Boundary, Escalation Machine, Adaptive Throttle)
 *
 * Supports both:
 * 1. Empirical evaluation of recorded execution traces (`evaluateTraces`)
 * 2. Analytical projection based on theoretical architecture savings (`runBenchmark` / `projectScenarios`)
 */
export class ComparativeEvaluationHarness {
  private readonly scenarios: readonly BenchmarkScenario[];

  constructor(scenarios: readonly BenchmarkScenario[]) {
    this.scenarios = scenarios;
  }

  /**
   * Evaluates empirical execution traces recorded from live or simulated harness runs.
   */
  static evaluateTraces(traces: readonly ExecutionTrace[]): ComparativeBenchmarkResult {
    const configA: OrchestrationConfigProfile = {
      id: "configA",
      name: "Config A (Baseline Generalist)",
      totalTurns: 0,
      totalTokens: 0,
      confirmationBiasDefectsAccepted: 0,
      efficiencyScore: 0.0,
      cyclesDetected: 0,
    };

    const configB: OrchestrationConfigProfile = {
      id: "configB",
      name: "Config B (Specialists + Independent Review)",
      totalTurns: 0,
      totalTokens: 0,
      confirmationBiasDefectsAccepted: 0,
      efficiencyScore: 0.0,
      cyclesDetected: 0,
    };

    const configC: OrchestrationConfigProfile = {
      id: "configC",
      name: "Config C (Adaptive Orchestration)",
      totalTurns: 0,
      totalTokens: 0,
      confirmationBiasDefectsAccepted: 0,
      efficiencyScore: 0.0,
      cyclesDetected: 0,
    };

    const scenarioIds = new Set<string>();
    const profiles = { configA, configB, configC };

    for (const trace of traces) {
      if (!Object.hasOwn(profiles, trace.configId)) {
        throw new Error(`Unknown configId '${trace.configId}' in trace for scenario '${trace.scenarioId}'`);
      }
      const target = profiles[trace.configId];
      scenarioIds.add(trace.scenarioId);
      target.totalTurns += trace.turns;
      target.totalTokens += trace.tokensConsumed;
      if (trace.confirmationBiasDefectAccepted) target.confirmationBiasDefectsAccepted += 1;
      if (trace.cycleDetected) target.cyclesDetected += 1;
    }

    const baselineTokens = configA.totalTokens;
    configA.efficiencyScore = 0.0;
    configB.efficiencyScore =
      baselineTokens > 0
        ? Number(((1 - configB.totalTokens / baselineTokens) * 100).toFixed(1))
        : 0.0;
    configC.efficiencyScore =
      baselineTokens > 0
        ? Number(((1 - configC.totalTokens / baselineTokens) * 100).toFixed(1))
        : 0.0;

    return {
      scenariosCount: scenarioIds.size,
      profiles: { configA, configB, configC },
    };
  }

  /**
   * Computes an assumption-driven projection across the defined scenarios. Nothing is executed: Config B and C
   * totals are fixed multiples of each scenario's synthetic baseline, so this is not evidence that any
   * configuration is better. Use `evaluateTraces` with recorded runs for empirical comparison.
   */
  async runBenchmark(): Promise<ComparativeBenchmarkResult> {
    const configA: OrchestrationConfigProfile = {
      id: "configA",
      name: "Config A (Baseline Generalist)",
      totalTurns: 0,
      totalTokens: 0,
      confirmationBiasDefectsAccepted: 0,
      efficiencyScore: 0.0,
      cyclesDetected: 0,
    };

    const configB: OrchestrationConfigProfile = {
      id: "configB",
      name: "Config B (Specialists + Independent Review)",
      totalTurns: 0,
      totalTokens: 0,
      confirmationBiasDefectsAccepted: 0,
      efficiencyScore: 0.0,
      cyclesDetected: 0,
    };

    const configC: OrchestrationConfigProfile = {
      id: "configC",
      name: "Config C (Adaptive Orchestration)",
      totalTurns: 0,
      totalTokens: 0,
      confirmationBiasDefectsAccepted: 0,
      efficiencyScore: 0.0,
      cyclesDetected: 0,
    };

    for (const scenario of this.scenarios) {
      // Config A: Baseline
      configA.totalTurns += scenario.syntheticBaselineTurns;
      configA.totalTokens += scenario.syntheticBaselineTokens;
      if (scenario.hasConfirmationBiasRisk) {
        configA.confirmationBiasDefectsAccepted += 1;
      }

      // Config B: Specialists + Independent review
      const bTokens =
        scenario.category === "code_review" || scenario.category === "debugging"
          ? Math.floor(scenario.syntheticBaselineTokens * 0.75)
          : scenario.syntheticBaselineTokens;
      configB.totalTurns += scenario.syntheticBaselineTurns;
      configB.totalTokens += bTokens;
      configB.confirmationBiasDefectsAccepted += 0;

      // Config C: Adaptive Orchestration with micro-router deterministic short-circuit
      if (scenario.category === "deterministic_query") {
        configC.totalTurns += 1;
        configC.totalTokens += 50; // nominal deterministic invocation overhead
      } else if (scenario.category === "debugging") {
        configC.totalTurns += Math.max(2, Math.floor(scenario.syntheticBaselineTurns * 0.5));
        configC.totalTokens += Math.floor(scenario.syntheticBaselineTokens * 0.45);
        configC.cyclesDetected += 1;
      } else {
        configC.totalTurns += scenario.syntheticBaselineTurns;
        configC.totalTokens += Math.floor(scenario.syntheticBaselineTokens * 0.7);
      }
      configC.confirmationBiasDefectsAccepted += 0;
    }

    // Efficiency is computed from the projected token totals above. Those totals come from fixed per-category
    // multipliers, not from executed runs, so the result restates the model's assumptions and proves nothing.
    const baselineTokens = configA.totalTokens;
    configA.efficiencyScore = 0.0;
    configB.efficiencyScore =
      baselineTokens > 0
        ? Number(((1 - configB.totalTokens / baselineTokens) * 100).toFixed(1))
        : 0.0;
    configC.efficiencyScore =
      baselineTokens > 0
        ? Number(((1 - configC.totalTokens / baselineTokens) * 100).toFixed(1))
        : 0.0;

    return {
      scenariosCount: this.scenarios.length,
      profiles: {
        configA,
        configB,
        configC,
      },
    };
  }
}
