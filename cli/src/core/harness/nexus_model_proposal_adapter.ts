import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../durable_file.js";
import { AutonomousAgent } from "../../agent.js";
import type { HarnessConfig } from "../../types.js";
import type { TurnResult } from "../turn.js";
import type { ProposalAdapter, ProposalContext, ProposalResult } from "./proposal_adapter.js";

export interface NexusModelProposalOptions {
  model: string;
  endpoint: string;
  apiKey?: string;
  maxSteps?: number;
  temperature?: number;
  sandbox?: "auto" | "bwrap" | "docker" | "none";
  network?: boolean;
}

export interface NexusModelProposalAdapterOptions {
  createAgent?: (config: HarnessConfig, workspace: string) => { run: (prompt: string) => Promise<TurnResult>; shutdown?: () => void };
  resolveConfig?: (ctx: ProposalContext) => NexusModelProposalOptions | undefined;
}

function copyDir(src: string, dst: string): void {
  ensurePrivateDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const lst = fs.lstatSync(s);
    if (lst.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      const rel = path.relative(path.resolve(src), real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`symlink escapes source: ${s}`);
      if (fs.statSync(real).isDirectory()) copyDir(real, d);
      else { ensurePrivateDir(path.dirname(d)); fs.copyFileSync(real, d); }
      continue;
    }
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) { ensurePrivateDir(path.dirname(d)); fs.copyFileSync(s, d); }
  }
}

function extractJson(text: string): any | undefined {
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/(\{[\s\S]*\})/);
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return undefined; }
}

export class NexusModelProposalAdapter implements ProposalAdapter {
  constructor(private readonly opts: NexusModelProposalAdapterOptions = {}) {}

  async propose(ctx: ProposalContext): Promise<ProposalResult[]> {
    const cfg = this.opts.resolveConfig?.(ctx);
    if (!cfg && !this.opts.createAgent) return [];
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hir-propose-"));
    const work = path.join(tempRoot, "work");
    const home = path.join(tempRoot, "home");
    try {
      copyDir(ctx.baseTree, work);
      ensurePrivateDir(home);
      const stateDir = path.join(home, ".nexus", "state");
      const agentCfg: HarnessConfig = {
        model: cfg?.model ?? "test-model",
        endpoint: cfg?.endpoint ?? "http://127.0.0.1:1/v1",
        apiKey: cfg?.apiKey,
        maxSteps: cfg?.maxSteps ?? 6,
        temperature: cfg?.temperature ?? 0,
        workspace: work,
        shell: "bash",
        approvalMode: "auto",
        fullAccess: true,
        sandbox: cfg?.sandbox ?? "auto",
        sandboxNetwork: cfg?.network ?? false,
      } as any;
      const prevHome = process.env.HOME;
      const prevState = process.env.NEXUS_STATE_DIR;
      process.env.HOME = home;
      process.env.NEXUS_STATE_DIR = stateDir;
      let turn: TurnResult | undefined;
      try {
        const agent = this.opts.createAgent ? this.opts.createAgent(agentCfg, work) : (() => { const a = new AutonomousAgent(agentCfg); return { run: (p: string) => a.run(p), shutdown: () => a.shutdown() }; })();
        try {
          const prompt = [
            "You are proposing an improved harness candidate for a Harness Improvement Run.",
            "Do NOT mutate live harness/profile state outside this isolated workspace.",
            "Return JSON in a code block with shape: {\"rationale\":string,\"targetWeaknesses\":string[],\"edits\":[{\"path\":string,\"content\":string}]}",
            "Only edit files inside the workspace; use relative paths; no secrets. Prefer small, targeted edits addressing observed weaknesses.",
            `Round: ${ctx.round}`,
            `Task suite: ${ctx.suite.id}`,
            `Cases: ${JSON.stringify(ctx.suite.cases.map((c) => ({ id: c.id, description: c.description, expected: c.expected })))}`,
            `Prior reflections: ${JSON.stringify((ctx.priorReflections ?? []).slice(-10))}`,
            `Prior scorecards: ${JSON.stringify(ctx.priorScorecards.slice(-20))}`,
            `Prior probe observations: ${JSON.stringify(ctx.priorProbes.slice(-10).map((p) => ({ caseId: p.caseId, status: p.status, verifierPass: p.metrics.verifierPass, observations: p.observations.slice(-3) })))}`,
            `Relevant library lessons (advisory, do not auto-apply): ${JSON.stringify((ctx.libraryEntries ?? []).slice(-5).map((e) => ({ id: e.id, status: e.status, confidence: e.confidence, statement: e.statement })))}`,
          ].join("\n");
          turn = await agent.run(prompt);
        } finally {
          try { agent.shutdown?.(); } catch {}
        }
      } finally {
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
        if (prevState === undefined) delete process.env.NEXUS_STATE_DIR; else process.env.NEXUS_STATE_DIR = prevState;
      }

      const text = String((turn as any)?.detail ?? (turn as any)?.assistantText ?? "");
      const parsed = extractJson(text);
      if (parsed && Array.isArray(parsed.edits)) {
        for (const e of parsed.edits) {
          if (!e || typeof e.path !== "string" || typeof e.content !== "string") continue;
          const rel = e.path.replace(/^\/+/, "");
          if (rel.includes("..") || path.isAbsolute(rel)) continue;
          const abs = path.resolve(work, rel);
          const inside = path.relative(work, abs);
          if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
          ensurePrivateDir(path.dirname(abs));
          fs.writeFileSync(abs, e.content, "utf8");
        }
      }
      const outDir = path.join(tempRoot, "candidate");
      copyDir(work, outDir);
      return [{
        candidatePath: outDir,
        rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "model proposal",
        targetWeaknesses: Array.isArray(parsed?.targetWeaknesses) ? parsed.targetWeaknesses.filter((x: any) => typeof x === "string") : [],
        source: "agent",
      }];
    } finally {
      // Candidate path is inside tempRoot; orchestrator copies gated candidates into durable store.
      // Do not remove tempRoot here; process temp cleanup handles it and caller may copy immediately.
    }
  }
}
