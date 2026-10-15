# Nexus Supervised-Dogfooding Reassessment — 2026-10-03

> **Historical record.** This document is kept for provenance. Current requirements and status: [docs/v1.0.0/REQUIREMENTS.md](../v1.0.0/REQUIREMENTS.md). Statuses here may have been superseded or contradicted since it was written.

Question: *Can an operator now sit down at Nexus and do sustained, supervised real engineering without losing trust in what it
reports or losing control of the session?*

Baseline: `d4cd199` (truthful, interruptible turns) on `main`. Assessment only — no product code changed. This is a behavioral
reassessment: I did not walk the earlier B/C list; I used Nexus, then asked what the new semantics did to each journey.
Evidence scripts: `docs/reviews/evidence/supervised-dogfooding-2026-10-03/`. Tags: OBSERVED / REPRODUCED / INFERRED / UNRESOLVED.

## 1. Verdict

**SUPERVISED DOGFOODING (direct REPL mode): READY_WITH_FRICTION — start using Nexus on Nexus, with the guardrails in §8.**
**Worktree mode: NOT yet** — a verified result can be silently stranded (§3, F-A1).
**Unattended / `harness run` in automation: not assessed as ready** (exit code 2 is noisy for read-only turns, F-B1).

What I did: a real engineering session against the live gateway (`engineering/b0`) on a scratch Node project with two seeded
bugs — fix failing tests, add a feature, ask a read-only question, interrupt a long task mid-flight, continue it, resume the
session in a new process, then a six-task sustained session; plus deterministic fault scenarios (gateway down/recovery,
review-mode approval, Ctrl-C at an approval prompt, denial) and the worktree flow with the real model.

The semantics did what they were built to do. The remaining problems are no longer "Nexus lies about failure"; they are
(a) the *scope* of what `VERIFIED` is allowed to imply, (b) a conservative mutation model that cries wolf, and (c) things Nexus does to the
repository without being asked.

## 2. What now works (REPRODUCED against the real gateway unless noted)

| Journey | Result |
|---|---|
| Fix failing tests | 71 s, `COMPLETED / VERIFIED (npm test)`. The first `task_completed` was **refused by the oracle** because the verifier was failing; the model had to repair and re-verify. This is the slice working in anger. |
| Add feature in the same session | 42 s, `VERIFIED`; context carried over correctly |
| Interrupt (Ctrl-C ~25 s into a long multi-step task) | prompt back in <0.1 s, `TURN INTERRUPTED`, working tree unchanged for the next 3 s, no further model calls; follow-up "Continue…" finished (113 s, `VERIFIED`) with the history intact |
| Resume in a new process (`--resume`) | model answered "what did we change / anything unfinished" correctly from restored context (23 s) |
| Sustained: 6 consecutive tasks, one session | 5 × `VERIFIED` (56/52/63/123/292 s); final tree passes 40/40 tests; no REPL fault |
| Gateway down | `TURN FAILED — network_error (origin: transport)`; prompt stays usable; next prompt succeeds when the gateway returns (deterministic) |
| Review mode: Ctrl-C at the approval prompt | prompt in <0.1 s, `TURN INTERRUPTED`, file not written (deterministic) |
| Review mode: deny | file not written; session continues (but see F-B5) |

Operator-visible truthfulness is materially better: banners are tied to evidence, a model's own summary is labelled "not independently
verified", and failures/interrupts can no longer read as completion.

## 3. The question you asked: candidate VERIFIED vs integration REFUSED

**Result: the product does not make the distinction. It projects candidate verification as overall success.** (REPRODUCED three ways)

| Run | Candidate | Integration | What Nexus reported |
|---|---|---|---|
| deterministic, root dirty (untracked operator file) | verifier passed | merge refused | banner `TASK COMPLETED - VERIFIED`, `success:true`, `status:"completed"`, exit 0 |
| deterministic, root dirty only by Nexus's own `.nexus/knowledge.json` | passed | refused | same |
| **real model, ordinary task** (`run --worktree --authoritative-verifier "npm test"`, add `sign(x)`) | passed | refused (same cause) | same: VERIFIED / success / exit 0; change exists only in `.nexus/worktrees/task-…` |

The refusal is visible only as one yellow log line ("…unverified or the root workspace is dirty; retaining worktree"), which in `--json`
mode is buried inside `logs[]`. It also conflates two causes ("unverified" vs "dirty"), names no files, and says nothing about the objective.

Worse, there is **no operator path to finish the job** (REPRODUCED): after the `run` process exits, a new REPL's `/worktree` lists the worktree but
`/worktree merge` answers "No active speculative worktree to merge" (the binding lives in process memory); `harness worktrees` is list-only. The verified
work is stranded until the operator does a manual `git merge`.

This is the same class of defect the last slice eliminated, one level up: `execution` and `outcome` describe the *candidate*; nothing describes
*integration*. What the reassessment recommends (not done here): a fourth, orthogonal dimension — e.g. `integration: NOT_APPLICABLE | INTEGRATED | REFUSED(reason) | PENDING` —
so the product can say `candidate VERIFIED · integration REFUSED(TARGET_WORKTREE_DIRTY) · objective NOT COMPLETED`. The existing `BLOCKED` execution state and `REPOSITORY_STATE_CHANGED`
reason were placed in the vocabulary for exactly this and are still unused.

## 4. Findings from living with it

Classification is for *supervised* dogfooding. A = blocks it, B = materially degrades trust or efficiency, C = polish, D = speculative.

### A (scoped: blocks worktree mode only)
- **F-A1 Integration truth.** §3. Worktree mode reports success for work that never reached the operator's tree and offers no way to integrate it. REPRODUCED.

### B
- **F-B1 Read-only turns end `UNVERIFIED` (cry-wolf).** Every turn in which the model reads via the shell (`git diff`, `grep -n`) flags the workspace as unverified, because every successful `run_command` is classed *mutating*. Observed on **2 of 2** real read-only turns (T3, L6): `COMPLETED / UNVERIFIED / VERIFICATION_NOT_RUN` right after a verified turn with an untouched tree; `harness run` would exit 2. A signal that fires on innocent turns trains operators to ignore it. Mutation should be detected by **effect** (workspace diff before/after), not by tool class. REPRODUCED.
- **F-B2 Verifier integrity is not part of the evidence.** In T1 the model edited `package.json`'s `scripts.test` to make a failing invocation pass, then the oracle ran the edited `npm test` → `VERIFIED`. Here the change was benign (it was a real invocation incompatibility, and the model said so) but Nexus recorded nothing about it: `VERIFIED` currently means "the command named X passed", not "the verifier as the operator knew it passed". Verifier-defining files (package.json scripts, Makefile, test files, CI config) changed during the turn should be named in the evidence. OBSERVED.
- **F-B3 No per-turn change ledger.** T1/T2 left `debug_test.js` and `verify_clamp.js` in the repo under a green `VERIFIED` banner; the interrupted turn left a partial edit to `src/math.js`. Nexus never lists what the turn created/modified/deleted; the operator must run `/git` or `git status`. For supervised use this is the single most useful missing piece, and it is the same data F-B1 and F-B2 need. REPRODUCED.
- **F-B4 Silent persistent rule-learning and repo dirt.** `autoExtract` scans the operator's prompt for "always / never / do not / must…" and stores the phrase as a permanent project rule in `.nexus/knowledge.json` (injected into every future system prompt). My prompt "…and do not leave stray files." became `rule-do-not-leave-stray-files-`. The file is **untracked, not ignored**, so it dirties the repo and (via F-A1's `git status --porcelain` check) makes Nexus block its own later worktree merges. Operator-surprising, repo-modifying, no consent. REPRODUCED.
- **F-B5 Operator-denied actions are invisible in the result.** After denying a write in review mode the model called `task_completed`; the turn read `COMPLETED / NOT_REQUIRED / "no changes to verify"` — technically true, but the stated objective was not achieved because the operator said no. The turn result should carry denied/failed-dispatch counts. REPRODUCED (deterministic).
- **F-B6 Context economics over a sustained session.** Six small tasks drove live context 12k → 53k of a fixed 65,536 window (≈10k/turn, mostly retained tool output JSON); cumulative prompt tokens **1.84M** for ~6 minutes of work. At L5 compaction fired once, collapsing 92 messages to 7 in a 292 s turn (the next turns remained coherent, but the operator was told nothing beyond a log line). The 65,536 limit is configuration, not discovered from the gateway (UNRESOLVED whether the model supports more). It works, but a longer session will spend its time compacting. REPRODUCED.
- **F-B7 Output legibility.** The useful parts (STEP header, tool name, final banner) are surrounded by full tool-argument echoes (the whole `task_completed` summary printed twice), raw `[context_admission]` lines each step, and truncated JSON result blobs. The final banner is good; nothing in between tells an operator what the agent concluded from a tool result. OBSERVED.
- **F-B8 Known friction re-confirmed, tolerable when supervised:** dangling user message after a failed turn (history 3 msgs, last=user, REPRODUCED again), typed-ahead input dropped, `/tui` key leak, unguarded slash commands. None was triggered by normal use in ~15 real-gateway turns.

### C
- `--json` puts operationally important warnings (merge refused, retained worktree) only in `logs[]`.
- Banner width/alignment glitches at narrower terminals; spinner frames flood non-TTY logs.
- `harness worktrees` shows no merge state or reason.

### D
- Live status line / TUI; effect-based `integration` UI; multi-agent. Still premature — now because the signals they would project are not yet complete (F-A1, F-B3), not because they are broken.

## 5. Effect of the previous slice on earlier findings (behavioral, not a checklist)

- Cancellation, outcome truth, stream truth, verifier gating: held under real use, no regressions seen. Interrupt latency against the real gateway was effectively instant because the abort lands in inference; a long-running tool remains a settle-wait (not exercised with the real model).
- *New* because of the new semantics: F-B1 (UNVERIFIED noise), F-B5 (denial invisible), F-A1 (dimension missing). The first two are tuning/extension of the contract; the third is a missing dimension.
- Appears reduced in importance: "lost completion truth", "need TUI to understand state" — the banner plus structured result now answers most of "did it work".

## 6. Whole-system observations

Latency was model-dominated and acceptable (40–120 s for typical small edits; one 292 s compaction-affected turn). Failure recovery cost fell: a bad turn is now one line plus a prompt. The expensive remaining human cost is *auditing the working tree after each turn* (F-B3) and *not trusting `UNVERIFIED`* (F-B1). The inference service was never the limiting factor in any scenario.

## 7. Unknowns and limits

One model (`engineering/b0`) and one small project; no other gateway capabilities (`deep`/`lead`) exercised. No large-repository, slow-test-suite, or long-running-tool cancellation run against the real model. Review-mode and denial were tested deterministically only. Worktree runs used the sandbox (bwrap) available on this host. Context-window size of the actual model unknown to Nexus (F-B6). Compaction quality was judged only by subsequent coherence.

## 8. Recommendation

**Begin supervised dogfooding of Nexus on Nexus in direct (non-worktree) REPL mode now**, with these operating rules until the next slice lands:
1. Run `/git` (or `git status`) after every turn; treat the banner as "what the model and verifier established", not "what changed".
2. Treat `UNVERIFIED / VERIFICATION_NOT_RUN` after a read-only turn as noise; treat `UNVERIFIED / NO_APPLICABLE_VERIFIER` and `NOT_ESTABLISHED` as real.
3. Commit (or checkpoint) before each turn; `/undo` and the per-turn automatic checkpoint exist.
4. Add `.nexus/` to the target repo's ignore file, and check `.nexus/knowledge.json` for rules you did not intend.
5. Do not use `--worktree` for real work yet.
6. Keep a short friction log; the next slice should come from it plus the items below.

**Recommended next bounded slice — "Change ledger and integration truth":**
- A per-turn change ledger from actual repository/workspace state (created/modified/deleted, including untracked, before vs after) shown in the turn summary and stored in `TurnResult`.
- Derive the verification obligation from that ledger (effect-based; fixes F-B1) and record verifier-defining files touched (F-B2).
- Add the `integration` dimension for worktree runs with a named refusal reason, make success require integration, and give the operator a way to adopt/merge a stranded worktree from a new process (F-A1).
- Record denied actions in the result (F-B5).
- *Not included:* TUI, context-compaction redesign (F-B6), knowledge-graph policy (F-B4 — decide separately; at minimum stop it from dirtying the repo), typed-ahead, slash-command guards.

Success would be shown by deterministic scenarios (shell-read-only turn → `NOT_REQUIRED`; created stray file → listed in ledger; dirty-root worktree run → `VERIFIED · REFUSED(TARGET_WORKTREE_DIRTY) · objective not completed`, exit ≠ 0; denial → recorded) and a repeat of the real-gateway journeys above.

## 9. Repository state

Product code untouched (HEAD `d4cd199` at the start). Scratch HOME credentials copied for the live runs were deleted afterwards. The 36 pre-existing unrelated working-tree entries are untouched. This report and its evidence scripts are the only additions, committed locally; nothing pushed.
