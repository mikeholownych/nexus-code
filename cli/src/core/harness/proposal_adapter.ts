import type { HarnessImprovementRun, HirTaskSuite, ProbeResult, ScorecardEntry } from "./types.js";

export interface ProposalContext {
  run: HarnessImprovementRun;
  suite: HirTaskSuite;
  baseTree: string;
  round: number;
  priorCandidates: Array<{ id: string; treeRef: string; diffRef: string }>;
  priorProbes: ProbeResult[];
  priorScorecards: ScorecardEntry[];
}

export interface ProposalResult {
  candidatePath: string;
  rationale: string;
  targetWeaknesses: string[];
  source: "agent" | "human" | "imported";
}

export interface ProposalAdapter {
  propose(ctx: ProposalContext): Promise<ProposalResult[]>;
}

export class NoopProposalAdapter implements ProposalAdapter {
  async propose(): Promise<ProposalResult[]> {
    return [];
  }
}
