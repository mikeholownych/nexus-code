# Harness² review (WP-1307, issue #69)

Date: 2026-11-05. Status: research write-up. No runtime change, no dependency, nothing executed, `eval/` untouched.

Sources: the paper (arXiv 2610.14224v1, submitted 2026-10-09, cs.AI) and the Apache-2.0 repository `google-research/harness2` (README, `docs/EXPERIMENTS.md`, and the code in `harness2/core/recursion.py`, `library.py`, `prompts.py`, `context.py`, `selection.py`), read over the web and never cloned or run. Every gain quoted below is the paper's own, produced on its benchmarks with its executors, and is **unverified by us**.

## What Harness² is

It leaves model weights fixed and edits the harness through eight mounted files: system prompt, guardrails, memory, tool guidance, subagents, skills, scripts and a plugin. **Task-level recursion** (Propose, Probe, Compose): sample a reference run of the current harness, draft two candidate harnesses (an "invariant" one about how the agent works and a "domain" one about what a practitioner knows), roll each out once on the same task, and have an editor model read the full trajectories and compose one harness. The paper says contrasts "inform subsequent composition rather than verify task correctness". **Harnessing-level recursion** stores the adopted harness plus an `EXPERIENCE.md` lesson in a per-domain library that later tasks read. Its benchmarks (JobBench, LAB, WorkBuddy-Bench) are professional-work tasks, not coding-agent tasks, and its executors are OpenCode and Codex. It needs Python 3.12, Vertex AI credentials and, for one benchmark, Docker.

## 1. Contrastive probing without ground truth on Nexus turns

**Recommendation: borrow, offline only. Skip as an online per-turn mechanism.**

- The method rests on re-running the same task under matched conditions and comparing trajectories. In a live operator turn the rerun has side effects and costs the operator time; Nexus's own context research already rejected a per-turn context planner for the current architecture (`docs/research/context-engineering/DISPOSITION-2026-10-04.md`: "REJECTED for the current architecture / evidence envelope"), and prefix stability is recorded there as an inference-cost property. A per-task harness would also give every task a different prompt prefix, defeating the cache that `buildSystemPrompt()` (`cli/src/agent.ts:4091`) is written to keep byte-stable.
- Ground truth is the wrong constraint for us. Our dev and dogfood tasks have verifiers and hidden tests (DEC-05, `docs/v1.0.0/DECISIONS.md`), so on the tuned set a plain pass-rate A/B is stronger evidence than a behavioural contrast. The method's value to us is diagnosis: where two trajectories diverge, and which prompt or tool-guidance line explains it.
- Signals Nexus already records and could contrast, with no new instrumentation: repetition, stagnation and progress records (`cli/src/core/execution_tracking.ts`, thresholds in `docs/COMPACTION_AND_CONTINUITY.md`); step and request counts; compaction and admission events, including compaction thrash; malformed tool-call recovery; approval refusals; `VerificationEvidence` and receipts (`cli/src/core/turn.ts`, `candidate.ts`); and OTLP spans in `trace.jsonl` (`cli/src/core/trace.ts`). Harness² itself reads whole trajectories, not metrics, and instructs its composer that a defect in 1 of k base runs is noise and an edit must name "a SPECIFIC MOMENT in a trajectory" (`prompts.py`).
- Caveat the paper concedes: one rollout per candidate, shared model bias, and stochastic execution make contrasts weak evidence. DEC-05 requires 5 runs per configuration for exactly this reason.

## 2. Taxonomy mapped onto Nexus

**Recommendation: borrow the vocabulary as a checklist; skip making any component agent-editable.**

| Harness² component | Nexus counterpart | Editable by a model today? | Verdict |
|---|---|---|---|
| System prompt | Operating rules in `buildSystemPrompt()` (`agent.ts:4091`), plus trusted `AGENTS.md`/`CLAUDE.md` rules | Compiled TypeScript; only the project rules file is data | Borrow idea; would need an overlay layer |
| Guardrails | Code, not text: approval policy, `file_guard.ts`, `egress.ts`, `sandbox.ts`, `authority.ts`, workspace trust | No, deliberately | Skip. Must never be model-editable |
| Memory | `KnowledgeGraph` (`.nexus/knowledge.json`, auto-extract off by default, DEC-15); compaction's durable task state | knowledge.json is data | See question 3 |
| Tool guidance | Tool schemas in `cli/src/tools.ts`, canonical few-shots (`cli/src/fewshots.ts`), on-demand groups (`core/tool_groups.ts`, `enable_tools`) | Compiled | Best-fit target for a future contrast study |
| Subagents | `ROLE_PROFILES` in `team.ts`; bounded contracts in `core/specialist_profiles.ts` (read-only, tool whitelists, budgets) | Compiled | Skip. Contracts are safety properties |
| Skills | `SkillManager` (`cli/src/skills.ts`, `docs/SKILLS_AND_PLUGINS.md`): name and description in the prompt, body loaded by `activate_skill`, trust-gated | Yes, files | Closest 1:1 match; the one surface already shaped for this |
| Scripts | No first-class equivalent; the model uses `run_command` | n/a | Skip |
| Plugin | JavaScript plugins (`cli/src/plugins.ts`) that run in-process | Files, but executable | Skip. Model-authored executable code conflicts with the trust model |

Net: Nexus already has analogues for six of the eight. The gap is not a missing component but a missing editable overlay: tool guidance, the operating rules and few-shots are compiled in.

## 3. The durable lessons memory

**Recommendation: borrow the record format and the admission discipline; skip automatic admission.**

What Harness² does (read in `library.py` and `prompts.py`): an entry is the full adopted harness tree plus `EXPERIENCE.md` with `cue`, `lesson`, `evidence`, `confidence`; at most one lesson per task; the reflector may write `NO_ENTRY` and is told adoption "alone never establishes that an edit helped or will transfer"; each edit gets a verdict of `helped`, `hurt`, `no observed effect` or `confounded`, with `confounded` preferred when one rollout is all the support; a lesson resting only on confounded rows must be narrowed or declined; the cue must describe the "shape of situation", neither generic nor task-specific. Scope control: libraries are per domain and per run (each sweep starts empty), retrieval is by browsing an `INDEX.md` rather than injection, executable components are kept "rather than summarised as prose", and a tripwire refuses grader-verdict text in any context or lesson. The paper's own ablation: removing the library costs 3.1 points on WorkBuddy (77.5 to 74.4) and 1.8 on JobBench (36.0 to 34.2); a JobBench library helped WorkBuddy refinement by 0.5 to 2.9 points.

What I did not find: decay, pruning, contradiction handling or re-validation of a stored lesson in `library.py` (`forget` and `retain` exist to keep an evaluation stream causal, not to age entries). Drift and over-generalisation control therefore rests on the reflector's judgement plus Propose re-checking facts per task. That is the same model-judging-itself weakness the paper concedes in its limitations.

Against Nexus: today's memory is operator-saved, trust-gated key/value data, and freshness (CTX-002) was descoped to post-v1 on exactly that basis (`docs/v1.0.0/DECISIONS.md`). Cross-task semantic retrieval is deferred to v1.2 (`docs/v1.1.0/CONTEXT_MANAGEMENT.md`, DEC-V11-13). The layered-memory roadmap is not on `main`: it exists only on the local branch `v1/docs-v11-layered-memory` (`docs/v1.1.0/ROADMAP.md`, kept for that reason), and this review did not read it. Read it before choosing any memory work package. The Nexus memory-safety requirements (`TURN-SPECIFIC-CONTEXT-ENGINEERING-HYPOTHESIS.md` section 8: no stored model text in the instruction channel, applicability against a current fingerprint, provenance on every item) are stricter than anything in Harness², and `CandidateTracker` receipts (`core/candidate.ts`) already model "historical PASS is not current PASS". Model-written lessons that flow into prompts without an operator would violate those requirements, so any Nexus version must be operator-reviewed and carry an applicability fingerprint.

## 4. Parallel versus sequential budgets

**Recommendation: skip budgets above k=1 for us; borrow the cost ledger.**

- Cost shape, from `recursion.py`: each mode schedules **4k rollouts and 3k improvement stages** per task. k=1 is already 4 task runs plus 3 editor sessions over full, untruncated trajectories (`context.py`); k=5 is 20 and 15. Parallel mode runs k reference runs, 2k candidates and k compositions plus an agentic selector; sequential chains k steps. Total work is the same order; only wall-clock differs. The paper states more budget "adds inference cost" and that parallel sessions "do not eliminate this additional computation".
- Paper's returns (unverified): k=1 to 5 adds about 2.9 to 3.9 points on WorkBuddy, 3.0 to 4.2 on JobBench, 2.6 to 6.7 on LAB; parallel on WB-code goes 76.5 to 80.8; sequential led at k=2 on code but parallel finished higher at k=5; the Harness Scaling baseline regressed from k=2 to k=3.
- Our profile: qualification runs are serial on one gateway-backed model and "wall time is the critical-path cost" (`docs/v1.0.0/DECISIONS.md`, DEC-05 inference environment). Parallel width buys no wall-clock on that path; it only helps on a cloud provider, where it multiplies spend. A measured Nexus plain run is about 351 s and 11.8 requests (`DISPOSITION-2026-10-04.md`, one controlled task), so my arithmetic estimate for one k=1 step on the local gateway is roughly 4 rollouts (about 25 minutes serial) plus 3 long-context editor sessions. This is an estimate, not a measurement. Cloud use must pin a model (DEC-06; `openrouter/free` routed 3 requests to 3 models) and cap spend.
- The paper's editor was Claude Opus 4.8 and its executors Gemini 3.5 Flash and GLM-5; it also reports that same-model executor and editor at k=2 still improved all five models. Anthropic is only experimental under DEC-06, so whether a gateway-local editor is good enough is unknown.
- Worth borrowing: `ledger.py` records USD and attempts per stage, so cost is a first-class output of any such experiment.

## 5. Overall

**Recommendation: skip adopting the framework; borrow four ideas.**

Skip the framework: it is Python plus Vertex AI, has OpenCode and Codex executors only (no Nexus adapter, out of scope for v1.1.4), targets professional-work benchmarks rather than coding, and by default gives executors unrestricted network access with Codex's sandbox off. Its own guide reports that a Codex rollout downloaded a JobBench rubric unprompted. That is incompatible with the zero-egress hermetic rule in `docs/v1.1.0/SPEC-EVALUATION.md` (goal 5) and the stimulus/assertion separation (goal 1, `WP-1103-ORACLE-ISOLATION.md`).

Borrow: (a) behavioural trajectory contrast as an offline diagnostic; (b) the `confounded` verdict and `NO_ENTRY` default as the standard for any candidate lesson; (c) the grader-verdict tripwire idea for anything entering context or notes; (d) per-stage cost accounting.

## Constraints for any later trial

- Never on held-out T2 or T3 tasks (`eval/heldout-manifest.json`, `eval/heldout-t3-manifest.json`, DEC-05). Per-task refinement on an evaluation task is tuning. Use only the tuned and dogfood sets, with a train/test split fixed before the run.
- Inside the Nexus sandbox and network policy (`cli/src/sandbox.ts`, `core/egress.ts`), with network blocked at the network level, as the Harness² guide itself advises for Codex.
- Models only through the gateway or DEC-06 providers, pinned, no `openrouter/free`.
- Every adopted edit is a candidate change, re-validated on frozen held-out evaluation by someone other than the tuner, with agent-authored held-out tasks never exposed to the tuning history (DEC-05 task authorship).
- An executor adapter is out of scope for v1.1.4.

## What I could not verify

- The PDF is unreadable through the fetch tool; I read the arXiv HTML through a summarising fetch, so quoted paper text and numbers are a summariser's extraction of 168 KB, not verbatim reading. Figures (images) and the part of appendix D.2 about the reflector were not available. Mechanism claims about the repo come from code I read directly (`recursion.py`, `library.py`, `prompts.py`, `context.py`, `selection.py`); `proposer.py`, `judge.py`, `schedule.py` and the benchmark adapters were not read.
- No reported gain, cost ratio or ablation was reproduced; I did not run Harness² or Nexus. Claims about absent decay or pruning mean "not found in `library.py`", not "proved absent".
- Nexus architecture facts come from `docs/research/context-engineering/CURRENT-NEXUS-CONTEXT-ARCHITECTURE.md` (baseline `731f5d4`, October) and spot checks of current source; I re-confirmed `buildSystemPrompt` and `SkillManager.getPromptSection` only. Line numbers may have drifted. `graphify-out/` does not exist in this worktree.
- The 25-minute figure in section 4 is my estimate.

## Follow-up work packages (proposals only, for a later release, each needs owner approval)

1. **Trajectory-contrast diagnostic.** A read-only script that compares two runs' `trace.jsonl` and execution-tracking records on the tuned set and reports divergence points. No model-written edits.
2. **Candidate-lesson record.** A `cue / lesson / evidence / confidence / verdict` schema for operator-reviewed notes, with an applicability fingerprint, aligned to CTX-002 and the v1.2 retrieval item.
3. **Grader-verdict tripwire audit.** Check whether oracle isolation (WP-1103) already refuses grader output in any context-bound artifact; add the check if not.
4. **Multi-rollout cost ledger.** USD and wall time per session for any experiment that runs more than one rollout.
5. **Trial prerequisites, only if the owner wants a trial:** Nexus executor adapter, tuned/test split tooling, and egress policy for the executor host.
