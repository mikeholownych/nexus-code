# Shared audit brief (Nexus Code v1.0.0 audit, 2026-10-14)

Repo: /home/mike/nexus-code (origin github.com/mikeholownych/nexus-code), branch main @ db1ca55 (v0.1.0-alpha.2-2-gdb1ca55).
Untracked `nexus-continuity-validation/` and git stashes belong to the user: do NOT touch.
Clean snapshot of HEAD (for running things): /tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad/snap  (a baseline `npm ci; cargo test; build; npm test; security_gates` is running there now — do not start another full suite; targeted single test files are fine).
Product: Nexus Code = local coding client/harness. TypeScript agent + sidecar (cli/), Rust harness-core tools + Ratatui nexus-tui (core/). Local inference (OpenAI-compatible: vLLM/LM Studio/llama.cpp, homelab "gateway" at 10.0.8.5) is first class; cloud providers optional. Must work standalone without homelab-ai.
Contest (Cloudflare Workers + Artifacts collaboration service, experiments/cloudflare-artifacts-vertical-slice, demo/) is a SEPARATE product; Nexus is its demo harness.

RULES
- Read-only on the repo. Never edit, commit, stash, checkout, or build inside /home/mike/nexus-code. Write only under /tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad.
- No publishing, deploys, pushes, paid API calls, live-infrastructure mutation. Do not print credentials; redact any secret values (config.env, .env, tokens).
- Never `pkill -f`. Kill only by PID you started.
- Historical docs/reviews and "VERIFIED" claims are evidence to check, not proof.
- Every finding must cite file:line and an evidence label: SOURCE | TEST | RUNTIME | MEASUREMENT | DOC-CLAIM | HISTORICAL | INFERENCE | UNVERIFIED.
- Distinguish proven defects (reproduced or unambiguous in source) from qualification gaps (missing evidence).
- Be concrete and terse. No filler.

OUTPUT: write ONE markdown file at the path given in your task, with these sections:
1. Coverage ledger: table of every file in your scope -> review method (full read / targeted read / skim / excluded+why).
2. Architecture/data-flow notes for your scope (interfaces, trust boundaries, state).
3. Findings: table rows `ID | Severity (S1 blocker/S2 major/S3 minor/S4 note) | Workflow | Location file:line | Evidence label + what | User impact | Recommended disposition`. Use your assigned ID prefix.
4. Reproductions: exact commands run + outputs (trimmed) for any defect you reproduced.
5. Strengths with evidence.
6. Qualification gaps (things not proven either way) + exact procedure to qualify.
7. Proposed v1.0.0 requirements for your scope: `ID | requirement | rationale (workflow/safety/compat/failure) | blocker? (BLOCKER / RELEASE-REQUIRED / POST-V1) | acceptance test`.
8. Commands you ran.
Final reply to the orchestrator: <= 15 lines summary + the output path.
