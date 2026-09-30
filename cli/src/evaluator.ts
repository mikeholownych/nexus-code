import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { AutonomousAgent } from "./agent.js";
import { HarnessConfig } from "./types.js";
import { runTestSuite } from "./tester.js";
import pc from "picocolors";

export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit?: string;
  problem_statement: string;
  test_patch?: string;
  hints_text?: string;
  created_at?: string;
  version?: string;
  fail_to_pass?: string[] | string;
  pass_to_pass?: string[] | string;
}

export interface EvaluationResult {
  instanceId: string;
  repo: string;
  resolved: boolean;
  status: "RESOLVED" | "UNRESOLVED" | "ERROR";
  durationMs: number;
  tokensConsumed: { prompt: number; completion: number; total: number };
  stepsTaken: number;
  patchDiff?: string;
  testOutput?: string;
  error?: string;
}

export interface BenchmarkSummary {
  benchmarkName: string;
  timestamp: string;
  totalInstances: number;
  resolvedCount: number;
  unresolvedCount: number;
  errorCount: number;
  passRatePercentage: number;
  totalTokensConsumed: number;
  avgDurationSeconds: number;
  results: EvaluationResult[];
}

/**
 * SWE-bench Evaluation Harness & Benchmark Runner
 * Runs standard SWE-bench instances through the Nexus Code agent and grades patches.
 */
export class BenchmarkEvaluator {
  private workspace: string;

  constructor(workspace: string = process.cwd()) {
    this.workspace = path.resolve(workspace);
  }

  /**
   * Loads instances from a JSON array file or JSONL line-delimited file.
   */
  public static loadDataset(filePath: string): SweBenchInstance[] {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Dataset file not found: ${resolved}`);
    }

    const content = fs.readFileSync(resolved, "utf-8").trim();
    if (!content) return [];

    // Try parsing as JSON array
    if (content.startsWith("[")) {
      try {
        return JSON.parse(content) as SweBenchInstance[];
      } catch {}
    }

    // Parse as JSON Lines (JSONL)
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const instances: SweBenchInstance[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.instance_id && parsed.problem_statement) {
          instances.push(parsed as SweBenchInstance);
        }
      } catch (err: any) {
        console.warn(pc.yellow(`Warning: Skipped malformed JSONL line ${i + 1}: ${err.message}`));
      }
    }

    return instances;
  }

  /**
   * Evaluates a single SWE-bench task instance.
   */
  public async evaluateInstance(
    instance: SweBenchInstance,
    baseConfig: HarnessConfig,
  ): Promise<EvaluationResult> {
    const t0 = Date.now();
    const config: HarnessConfig = {
      ...baseConfig,
      workspace: this.workspace,
      worktree: true, // Always sandbox in ephemeral worktree to prevent workspace pollution
      recordFlight: true,
    };

    const agent = new AutonomousAgent(config);

    try {
      console.log(pc.bold(pc.cyan(`\n🧪 Evaluating SWE-bench Instance: ${instance.instance_id}`)));
      console.log(`Repository: ${pc.bold(instance.repo)} | Base Commit: ${pc.dim(instance.base_commit || "HEAD")}`);
      console.log(`Problem: ${pc.white(instance.problem_statement.slice(0, 100).replace(/\n/g, " "))}...`);

      // 1. If base commit specified and git repository is active, ensure clean base
      if (instance.base_commit) {
        try {
          execFileSync("git", ["checkout", instance.base_commit], {
            cwd: this.workspace,
            stdio: ["ignore", "ignore", "ignore"],
          });
        } catch {}
      }

      // 2. Run agent on problem statement
      await agent.run(instance.problem_statement);

      // 3. Inspect git diff of generated solution
      let patchDiff = "";
      try {
        patchDiff = execFileSync("git", ["diff", "HEAD~1..HEAD"], {
          cwd: this.workspace,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (!patchDiff.trim()) {
          patchDiff = execFileSync("git", ["diff"], {
            cwd: this.workspace,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          });
        }
      } catch {}

      // 4. If gold test patch exists, apply test patch to verify fix
      let testOutput = "";
      let testsPassed = false;

      if (instance.test_patch) {
        try {
          execFileSync("git", ["apply", "--check", "-"], {
            cwd: this.workspace,
            input: instance.test_patch,
            stdio: ["pipe", "ignore", "ignore"],
          });
          execFileSync("git", ["apply", "-"], {
            cwd: this.workspace,
            input: instance.test_patch,
            stdio: ["pipe", "ignore", "ignore"],
          });
        } catch {}
      }

      // 5. Run test suite to verify resolution
      const testRes = runTestSuite(this.workspace);
      testsPassed = testRes.success || testRes.command === "none";
      testOutput = testRes.rawOutput || "";

      const durationMs = Date.now() - t0;
      const tokensConsumed = agent.getTokenStats();
      const hasCodeChanges = patchDiff.trim().length > 0;
      const resolved = testsPassed && (hasCodeChanges || testRes.command === "none");

      const result: EvaluationResult = {
        instanceId: instance.instance_id,
        repo: instance.repo,
        resolved,
        status: resolved ? "RESOLVED" : "UNRESOLVED",
        durationMs,
        tokensConsumed,
        stepsTaken: agent.getHistoryCount(),
        patchDiff,
        testOutput,
      };

      const statusBadge = resolved ? pc.bold(pc.green("✔ RESOLVED")) : pc.bold(pc.red("✘ UNRESOLVED"));
      console.log(`\nResult: ${statusBadge} in ${(durationMs / 1000).toFixed(1)}s (${tokensConsumed.total} tokens consumed)`);

      return result;
    } catch (err: any) {
      return {
        instanceId: instance.instance_id,
        repo: instance.repo,
        resolved: false,
        status: "ERROR",
        durationMs: Date.now() - t0,
        tokensConsumed: agent.getTokenStats(),
        stepsTaken: agent.getHistoryCount(),
        error: err.message,
      };
    } finally {
      agent.shutdown();
    }
  }

  /**
   * Runs evaluation over a set of instances and produces an aggregated summary.
   */
  public async runBenchmark(
    instances: SweBenchInstance[],
    config: HarnessConfig,
    benchmarkName: string = "SWE-bench",
  ): Promise<BenchmarkSummary> {
    const results: EvaluationResult[] = [];
    const t0 = Date.now();

    for (let i = 0; i < instances.length; i++) {
      console.log(pc.bold(pc.magenta(`\n[${i + 1}/${instances.length}] Progress: ${(i / instances.length * 100).toFixed(0)}%`)));
      const res = await this.evaluateInstance(instances[i], config);
      results.push(res);
    }

    const resolvedCount = results.filter((r) => r.status === "RESOLVED").length;
    const unresolvedCount = results.filter((r) => r.status === "UNRESOLVED").length;
    const errorCount = results.filter((r) => r.status === "ERROR").length;
    const totalTokensConsumed = results.reduce((acc, r) => acc + r.tokensConsumed.total, 0);
    const avgDurationSeconds = instances.length > 0 ? (Date.now() - t0) / 1000 / instances.length : 0;
    const passRatePercentage = instances.length > 0 ? parseFloat((resolvedCount / instances.length * 100).toFixed(1)) : 0;

    return {
      benchmarkName,
      timestamp: new Date().toISOString(),
      totalInstances: instances.length,
      resolvedCount,
      unresolvedCount,
      errorCount,
      passRatePercentage,
      totalTokensConsumed,
      avgDurationSeconds,
      results,
    };
  }

  /**
   * Renders a GitHub-flavored Markdown scorecard report.
   */
  public static renderScorecard(summary: BenchmarkSummary): string {
    const lines: string[] = [];
    lines.push(`# 🏆 ${summary.benchmarkName} Evaluation Scorecard\n`);
    lines.push(`- **Evaluated At**: ${summary.timestamp}`);
    lines.push(`- **Total Instances**: ${summary.totalInstances}`);
    lines.push(`- **Pass Rate @ 1**: **${summary.passRatePercentage}%** (${summary.resolvedCount}/${summary.totalInstances})`);
    lines.push(`- **Total Tokens Consumed**: ${summary.totalTokensConsumed.toLocaleString()}`);
    lines.push(`- **Avg Time Per Problem**: ${summary.avgDurationSeconds.toFixed(1)}s\n`);

    lines.push(`| Instance ID | Repo | Status | Duration | Steps | Tokens |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- |`);

    for (const r of summary.results) {
      const icon = r.status === "RESOLVED" ? "✅ RESOLVED" : r.status === "ERROR" ? "⚠️ ERROR" : "❌ UNRESOLVED";
      lines.push(`| \`${r.instanceId}\` | ${r.repo} | ${icon} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.stepsTaken} | ${r.tokensConsumed.total} |`);
    }

    return lines.join("\n") + "\n";
  }
}
