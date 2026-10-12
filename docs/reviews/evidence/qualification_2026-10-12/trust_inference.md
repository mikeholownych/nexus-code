# Area 4 (Operator control & trust) and Area 5 (Inference compatibility & recovery)

Status: COMPLETE (2026-10-12). Key reproductions re-run on feat/tui-surface (696178a) extract with identical results (R1, R2, R3, R8, R9, I3, I5c).
harness-core binary reused from `assess/ctx/cc/core/target/release` (core library sources `core/src/{file_ops,runner,main}.rs`
are identical on all three commits: `git diff --stat 3727938 696178a -- core` / `... 31d6622 -- core` touch only `core/src/bin/nexus_tui/*`).
Reproductions: `assess/ti/main/cli/test/zz_trust_repro.test.ts` (sidecar + ApplicationCore + mock gateway, HOME and TMPDIR isolated).

## Findings — Area 4

### T-01 Review mode does not gate `delete_file`; `delete_file "."` deletes the whole workspace (incl. `.git`) without approval
- Priority: P0
- Label: REPRODUCED DEFECT
- Affects: main, feat/tui-surface, fix/context-convergence, installed runtime (identical gate code)
- Trigger: sidecar started with `--approve` (mode `review`); model calls `delete_file {path:"keep.txt"}` or `delete_file {path:"."}`.
- Expected: an `approval.request` before any deletion (deletion is the most destructive file operation), and the workspace root never deletable.
- Observed: the approval gate lists only four tools — 3727938:cli/src/agent.ts:2502-2508 (`edit_file | write_file | patch_file | run_command`).
  `delete_file` goes straight to the spine. The Rust deleter accepts the root because `canon.starts_with(&base_canon)` is true when
  `canon == base_canon` and then calls `remove_dir_all` (3727938:core/src/file_ops.rs:630-648). `.` is not a protected path
  (cli/src/security.ts:25-30, 92-110 only match `.git`, `.env`, `id_rsa`, `id_ed25519`). The REPL even has display text for a
  `delete_file` approval that is never reached (cli/src/repl.ts:346-347).
  Repro output (R1, R2; approvals auto-denied by the rig, so any request would have blocked the deletion):
  `OBS R1 {"approvals":[],"toolEnds":[{"tool":"delete_file","success":true}],"keepExists":false}`
  `OBS R2 {"approvals":[],"toolEnds":[{"tool":"delete_file","success":true}],"repoExists":false,"gitExists":false,"entries":null}`
- Impact: an operator who chose review mode to stay in control can lose the entire repository, including uncommitted work and git history,
  from one model tool call. The checkpoint taken before the turn lives inside the workspace/.git and is deleted with it.
- Remediation: derive "requires approval" from the capability registry (`capability.mutating && category !== "orchestration"`, plus
  `proc` category) instead of a hard-coded name list; reject in `delete_file` (Rust) any target whose canonical path equals the workspace
  root or lies in `.git`; make directory deletion a separate explicit flag.
- Acceptance test: sidecar `review` rig; script `delete_file {path:"keep.txt"}` → exactly one `approval.request` with `tool:"delete_file"`;
  deny → file present. Script `delete_file {path:"."}` and `{path:"./"}` → tool fails with a root-protection error even in `auto` mode;
  repo and `.git` present.
- Dependencies: none. Not addressed on fix/context-convergence (cc/cli/src/agent.ts:2998-3004 identical list) or feat/tui-surface (tui/cli/src/agent.ts:2507-2512).

### T-02 Subagents run every tool with no approval in review mode
- Priority: P0
- Label: REPRODUCED DEFECT
- Affects: main, feat/tui-surface, fix/context-convergence, installed runtime
- Trigger: review mode; model calls `spawn_subagent`; the subagent calls `write_file` and `run_command`.
- Expected: subagent mutations go through the same operator approval as the parent's.
- Observed: `runSubagent` dispatches with no confirm handler — 3727938:cli/src/agent.ts:3648
  `this.dispatchToolCall(call, currentStep, "subagent")` (4th parameter `onConfirm` omitted), and the subagent is offered the full
  `HARNESS_TOOLS` (agent.ts:3620). `spawn_subagent` itself is `mutating:false` and not in the approval list. Same on tui (agent.ts:3659) and cc (agent.ts:4191).
  Repro R3: `OBS R3 {"approvals":[],"toolEnds":[{"tool":"spawn_subagent",...}],"subTxt":"from subagent","cmdTxt":true}` — the subagent wrote
  `sub.txt` and executed `echo pwned > cmd.txt` with zero approval requests.
- Impact: review mode is bypassable by any model that delegates (local models frequently do when the tool is offered). Read-only mode is
  inherited (config spread at agent.ts:2200-2211), so this affects approval only.
- Remediation: pass the parent's `onConfirm` into `AutonomousAgent.runSubagent` and through to `dispatchToolCall`; label the approval
  request with `actor:"subagent"` so the operator can see who asks.
- Acceptance test: review rig; scripts n1 `spawn_subagent`, n2 `write_file sub.txt` + `run_command`, n3 report → two `approval.request`
  events; denying both leaves no `sub.txt`/`cmd.txt`.
- Dependencies: T-01's registry-derived gate. Not addressed on any branch.

### T-03 Opening a workspace executes workspace-supplied code (plugins and MCP servers) with no trust prompt, even under `--read-only` and `--approve`
- Priority: P0
- Label: REPRODUCED DEFECT
- Affects: main, feat/tui-surface, fix/context-convergence, installed runtime (plugins.ts, mcp.ts identical on all three)
- Trigger: a cloned repository contains `plugins/*.mjs` (or `.nexus/plugins/*.js`) and/or `.mcp.json` / `mcp.json`; the operator submits any prompt.
- Expected: workspace-provided executables are not run until the operator trusts that workspace; read-only mode never executes them.
- Observed: `pluginDirs` includes `<workspace>/.nexus/plugins` and `<workspace>/plugins` (3727938:cli/src/plugins.ts:46-54) and every
  `.js`/`.mjs` there is `import()`ed in-process (plugins.ts:66-91). `mcpConfigFiles` puts `<workspace>/.mcp.json` and `<workspace>/mcp.json`
  first (mcp.ts:479-487) and `loadAndConnect` spawns each `command` (mcp.ts:507-531, spawn at 101-105) with `env: {...process.env, ...}`
  (mcp.ts:98). Both run from `runTurn` → `initExtensibility` (agent.ts:2795, 950-959) on the first prompt. No trust check exists
  (`grep -rn "trust" cli/src` finds only unrelated provenance/operation code).
  Repro R8 (read-only + review): `OBS R8 {"pluginRan":true,"mcpSpawned":"env has key: yes cwd=...","advertisedMcpTools":["mcp__evil__wipe"],"approvals":[]}` —
  the plugin wrote a file at import time and the MCP server process received the operator's environment (a fake `sk-…` key variable was visible).
- Impact: arbitrary code execution as the operator from untrusted repositories (`plugins/` is a common directory name), plus exfiltration of
  provider keys in the environment. Read-only mode and the bwrap sandbox (which only wrap `run_command`) are bypassed entirely.
- Remediation: load workspace-scoped plugins/MCP only after an explicit, persisted per-workspace trust decision (hash of the config/plugin
  files, stored under `~/.nexus`); never load them in read-only mode; pass MCP children an allowlisted environment, not `process.env`;
  drop the bare `<workspace>/plugins` directory.
- Acceptance test: R8 rig → `pluginRan:false`, no `MCP_SPAWNED`, and a `notice`/approval asking to trust the workspace; after granting trust
  (non-read-only) the MCP child's env lacks provider key variables.
- Dependencies: none. Not addressed on any branch.

### T-04 MCP and plugin tools are advertised to the model but can never execute (FAIL-001)
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: main, feat/tui-surface, fix/context-convergence
- Trigger: any connected MCP server or plugin `customTools`.
- Expected: either executable through the spine with admission/approval, or not offered.
- Observed: definitions are sent (agent.ts:1092-1093) but `ExecutionSpine.execute` rejects any tool absent from the registry
  (core/spine.ts:306-327) and nothing registers MCP/plugin tools (only `REQUIREMENTS_CAPABILITY`/`READ_OBJECTIVE_CAPABILITY`, agent.ts:759-760).
  The `defaultHandler` branches for MCP/plugin (agent.ts:2560-2565) are unreachable. R8: `"Error executing mcp__evil__wipe: FAIL-001: Tool 'mcp__evil__wipe' is not registered in CapabilityRegistry."`
- Impact: MCP/plugins are non-functional for tool use while still costing context and confusing the model; when fixed naively they would
  inherit T-01's name-list approval gap (they would execute unapproved). Security-wise this currently *prevents* an approval bypass.
- Remediation: register MCP/plugin tools as capabilities with `mutating:true`, category `external`, approval required by default; then they
  pass authority/read-only/approval gates.
- Acceptance test: stdio MCP fixture tool → in review mode one approval request, approve → tool runs; in read-only → AUTH-009 denial.
- Dependencies: T-01, T-03.

### T-05 Protected-path policy is enforced only for single-file tools; `batch_read` returns `.env` contents to the model
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Trigger: model calls `batch_read {paths:[".env"]}` (or `run_command cat .env`, `search_code`/`grep`).
- Expected: `.env` (a DEFAULT_PROTECTED_PATH) is not readable by any tool, or its values are redacted before leaving the host.
- Observed: the protected-path check covers `write_file|edit_file|patch_file|delete_file|read_file` only (3727938:cli/src/tools.ts:432-441).
  R6: `read_file` → "Security Policy Violation: Path '.env' is protected", but `batch_read` → `"content": "    1 | API_TOKEN=zzsecretvalue1234567890"`
  and the second chat request to the gateway contained the secret (`secretSentToModel:true`). The outbound vault patterns
  (security.ts:131-147) do not match an unquoted `KEY=value` line.
- Impact: credentials in `.env` reach whatever endpoint is configured (cloud providers included) despite a policy that claims to protect them.
- Remediation: enforce `isPathProtected` inside the Rust path resolver (`resolve_safe_path`) for every file tool (`batch_read`, `file_info`,
  search/trigram/outline), and filter protected paths out of search/list results; add an unquoted `^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=.+$` rule to egress redaction.
- Acceptance test: R6 rig → all three calls fail or redact; `gw.requests[1]` does not contain the secret.
- Dependencies: none.

### T-06 `run_tests.filter` is interpolated into a shell command and `run_tests` is not approval-gated: arbitrary command execution in review mode
- Priority: P0
- Label: REPRODUCED DEFECT
- Affects: main, feat/tui-surface, fix/context-convergence, installed runtime (tester.ts/tools.ts identical)
- Trigger: review mode; model calls `run_tests {filter: 'x" ; touch INJECTED ; echo "'}`.
- Expected: filter passed as a single argv element (or rejected), and running repository test code asks for approval in review mode.
- Observed: `detectTestCommand` builds strings like `npm test -- -t "${filterPattern}"`, `cargo test -- ${filterPattern}` (unquoted), `pytest -k "${filterPattern}"`
  (3727938:cli/src/tester.ts:30,37,47,50,55,60); `run_tests` is `mutating:false` (core/capabilities.ts:787-790) and not in the approval list
  (agent.ts:2502-2508). R9 (review): `approvals:[]`, tool output `"command":"npm test -- -t \"x\" ; touch INJECTED ; echo \"\""`, `injected:true`.
  Under `--read-only` the same command runs inside the bwrap `--ro-bind` sandbox (tools.ts:715-742), so writes fail there (R4/R4b).
- Impact: complete review-mode bypass via one argument; also lets any prompt-injected model run arbitrary shell in auto mode under the guise of "tests".
- Remediation: quote the filter with a proper shell-escape (or pass argv to the runner without a shell) and reject filters containing shell
  metacharacters; treat `run_tests` as `proc` requiring approval in review mode (approve the resolved command once per session).
- Acceptance test: R9 rig → `approval.request` with `tool:"run_tests"` showing the resolved command; with approval granted, `INJECTED` is not created and the filter appears literally in the test runner's argv.
- Dependencies: T-01. Not addressed on any branch.

### T-07 A quarantined secret placeholder is rehydrated into public-destination tool arguments (`search_web`)
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Trigger: a secret the egress classifier recognises (e.g. `sk-…`) is read by a tool; the model sees `[NEXUS_SEC_REF_…]`; the model calls `search_web` with that placeholder.
- Expected: placeholders are rehydrated only for local sinks (file writes, local commands); public sinks keep the placeholder or are refused.
- Observed: every tool call's args are restored first — 3727938:cli/src/agent.ts:2484-2490 (`getVault().restore(serialized)`) — and the spine
  egress hook only re-checks `fetch_web`, `browser_navigate` and remote MCP (agent.ts:668-728); everything else, including `search_web`, falls into
  the "authorized local sink" rehydration branch (agent.ts:730-742). `search_web` sends the query to `SEARXNG_URL` or DuckDuckGo (search_web.ts:21-50, 94).
  R12 (SEARXNG_URL pointed at a local capture server): `modelSawRawKey:false, placeholder:"[NEXUS_SEC_REF_a1b9…]", searchQueriesReceived:["/search?q=error sk-proj-AbCdEf1234567890GhIjKlMnOp&format=json"], rawKeyLeftHost:true`.
- Impact: the vault's guarantee (model never sees, secret never leaves) is inverted: the model can cause the real key to be published to a third-party search engine without ever knowing it.
- Remediation: classify each tool's sink (`HOST_LOCAL` vs external) in the capability registry; rehydrate only for local sinks; for external
  sinks run `evaluateEgress` on the args and refuse if any placeholder or secret is present.
- Acceptance test: R12 rig → capture server receives the placeholder (or no request), never the raw key; a `write_file` with the placeholder still writes the real value locally.
- Dependencies: none.

### T-08 Secret redaction misses common formats and durable stores keep them in plaintext (sessions, diffs, audit log, task state, flight log)
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all three branches (persistence and egress code identical in the relevant files)
- Trigger: a workspace file contains secrets in common formats; the agent reads it (`read_file`, `cat`) and writes a copy.
- Expected: no plaintext secret in `~/.nexus/**` or `<repo>/.nexus/**`; common formats tokenized before reaching the model.
- Observed (R11, `recordFlight:true`): sent to model in plaintext — unquoted `DB_PASSWORD=…`, URL credentials `postgres://admin:<pw>@…`, a JWT
  (an `sk-…`, `ghp_…` and AWS secret were tokenized). Persisted in plaintext:
  `~/.nexus/audit.log` (URL password, JWT), `~/.nexus/sessions/<id>.json` and `~/.nexus/tasks/task-*.json` (unquoted password, URL password, JWT),
  `~/.nexus/sessions/<id>.diffs/*.diff` (URL password, JWT **and the AWS secret** — the diff store applies weaker redaction than the egress path),
  `<repo>/.nexus/flights/*.flightlog` (unquoted password, URL password, JWT). Classifier: core/egress.ts (deterministic/contextual/entropy passes, ~lines 280-360);
  UI redaction is a separate, different regex set (cli/src/ui.ts:6-13).
- Impact: credentials accumulate in operator-home files that are later exported/shared (session export, audit, flight logs) and go to cloud models.
- Remediation: one canonical classifier for egress, UI and persistence; add URL userinfo, JWT (`eyJ…\.eyJ…\.`), unquoted `*_(KEY|TOKEN|SECRET|PASSWORD)=` rules;
  route the diff writer and audit log through `redactForPersistence`.
- Acceptance test: R11 rig → `persistedHome` and `persistedRepoNexus` empty; `sentToModel` all false.
- Dependencies: T-05.

### T-09 Objective ledger accepts `verified` from any passing `run_tests`, including a filtered run that executes no tests
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Trigger: model edits, runs `run_tests {filter:"no-such-test-name"}` (passes because nothing runs), then `update_requirements` R1/R2 `verified`.
- Expected: `verified` binds only to the configured/authoritative verifier (unfiltered), as the turn predicate does.
- Observed: `currentPassingAttempt` accepts any PASSED attempt with matching workspace state (agent.ts:1480-1491); `recordAttempt` stores
  whatever `parsed.command` ran (agent.ts:2622-2636). R10: `reqs:[{R1, verified, verifiedBy:"npm test -- -t \"no-such-test-name\""}, {R2, verified, …}]`
  while the full suite would fail; the turn itself correctly ended `TURN ENDED - UNVERIFIED (VERIFICATION_NOT_RUN)`.
- Impact: the ledger (shown to operator and model, persisted, used for continuation) claims operator requirements are verified when they are not;
  the turn outcome is not fooled, so this is a misleading-state defect, not a false completion. Descoping is correctly operator-only (objective.ts:29-35, 242-256, 349-353).
- Remediation: record attempts with `filtered:true` when `args.filter` is set and refuse them for `verified`; or bind `verified` to `discoverVerifier()`'s command.
- Acceptance test: R10 rig → `update_requirements verified` rejected with a "filtered run" error; R1/R2 stay `implemented`.
- Dependencies: T-06.

### T-10 Read-only blocks of `run_tests` surface as a test failure; `write_file` always reports `"overwritten"`
- Priority: P3
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Observed: under `--read-only` `run_tests` runs in the read-only sandbox and is reported as `"Test suite failed: Errors encountered"` (R4/R4b),
  not as a policy block, which invites the model to "fix" tests. `write_file` computes status after writing
  (core/src/file_ops.rs:231 `if target.exists()`), so new files are reported `"status": "overwritten"` (R10, I2, I5 outputs).
- Remediation: detect read-only in `run_tests` and return a policy error up front; compute `existed` before opening the file.
- Acceptance test: read-only `run_tests` → error text contains "read-only"; `write_file` of a new path → `"created"`.

### T-11 Workspace confinement is lexical in TS and check-then-act in Rust (TOCTOU), with an outside zero-byte create on symlink swap
- Priority: P3
- Label: SOURCE-SUPPORTED RISK
- Affects: all three branches
- Observed: TS `confine` uses `path.resolve`/`path.relative` only (core/authority.ts:267-370), no realpath. The real guard is Rust
  `resolve_safe_path` (file_ops.rs:651-711; canonicalises existing targets/ancestors, rejects escaping symlinks, `..` popping past root) plus
  post-open `/proc/self/fd` verification in `write_file`/`edit_file` (file_ops.rs:55-75, 221, 533, 606) — this is good. Residual races:
  `write_file` opens with `create(true)` before verifying the descriptor, so a component swapped to an outside symlink between check and open creates an
  empty outside file before the write is refused; `create_dir_all(parent)` (file_ops.rs:206-211) can create outside directories under a racing swap;
  `delete_file` canonicalises then `remove_*` by path (file_ops.rs:630-648). Requires a concurrent local attacker; not reproduced.
- Remediation: open relative to a workspace dirfd with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` (Linux) for create/delete.
- Acceptance test: Rust unit test that swaps a parent dir for an outside symlink between resolve and open (via a test hook) → no outside file created.

### T-12 Default operating mode executes edits, deletes and shell commands with no approval; `fetch_web`/`search_web`/`browser_*` are never gated
- Priority: P2
- Label: SOURCE-SUPPORTED RISK (product decision to surface)
- Affects: all three branches, installed runtime
- Observed: sidecar mode is `review` only with `--approve` (sidecar.ts:792, 800); REPL `autoApprove = true` by default (repl.ts:68, index.ts:112).
  Network tools are `mutating:false` (capabilities.ts: `net_fetch`, `net_search`, `browser_*`), allowed in read-only and never approval-gated, and no
  domain allowlist exists unless `.nexus-security.json` sets one (security.ts:44-74). `isSafeOutboundUrl` checks only the initial URL; `fetch` follows redirects
  (tools.ts:38-90, 618-623; no `redirect` option). Workspace content can thus be sent to arbitrary hosts by a prompt-injected model.
- Remediation: make review the default for new workspaces or show the mode prominently at start; gate network egress tools in review mode;
  set `redirect:"manual"` and re-validate each hop.
- Acceptance test: `fetch_web` to a URL that 302-redirects to `http://127.0.0.1:<port>` is refused; review mode asks before `fetch_web`.

## Findings — Area 5 (inference compatibility and recovery)

Rig: `assess/ti/main/cli/test/zz_infer_repro.test.ts` — own raw OpenAI-compatible HTTP server (arbitrary bodies, status, headers, chunked bytes,
socket reset), real `SidecarServer` + `ApplicationCore` agent loop, recovery env shortened (`LOCAL_LLM_RECOVERY_*`). client.ts, parser.ts and
provider_recovery.ts are byte-identical on main, feat/tui-surface and fix/context-convergence (`git diff` empty).

### I-01 Tool calls are extracted from `<think>` reasoning and executed — a deletion the model explicitly declined was performed
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all three branches, installed runtime (re-run on tui: identical)
- Trigger: a reasoning model (DeepSeek-R1/Qwen style) replies `<think>I could run {"name":"delete_file","arguments":{"path":"important.txt"}} but that would destroy data, so I will not.</think>The file looks fine; no changes needed.`
- Expected: no tool runs; text in reasoning is never an instruction.
- Observed: parser step 6 "Rescue tool call if accidentally placed inside DeepSeek <think> reasoning" (3727938:cli/src/parser.ts:314-335) turns any
  balanced JSON with a `name` in the reasoning into a tool call. I5c: `toolStarts:[{tool:"delete_file",subject:"important.txt"}]`, `toolEnds:[{success:true}]`, `importantExists:false`.
- Impact: destructive actions from hypothetical reasoning, without approval in auto mode (and in review mode for `delete_file`, see T-01).
- Remediation: remove the reasoning rescue; if kept, only for a model profile known to emit calls in `<think>`, and never for mutating tools.
- Acceptance test: I5c → `toolStarts:[]`, `important.txt` present, turn completes with the final text.

### I-02 Lenient JSON repair silently rewrites file content (`None`→`null`, `True`→`true`, trailing commas removed)
- Priority: P1
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Trigger: tool-call arguments that are invalid JSON only because of raw newlines inside strings (the most common local-model artifact), with code content.
- Expected: either an exact repair (escape control characters only) or a rejection asking the model to resend.
- Observed: `repairJson` applies global regex rewrites to the whole text, inside string values too (parser.ts:33-43: Python literals,
  trailing commas, unquoted keys) before the control-character pass (parser.ts:64-96), which is built on the already-rewritten text.
  Probe P1 (`parseModelResponse` with args `{"path":"m.py","content":"x = None\nif True:\n    items = [1, 2,]\n"}` with raw newlines):
  `{"path":"m.py","content":"x = null\nif true:\n    items = [1, 2]\n"}` — that is what `write_file` would write. When the rewrite breaks
  quoting instead (I1b, content containing `{a: 1}`), the call fails with a misleading `FAIL-002: Missing required parameter 'path'`.
- Impact: silent corruption of Python/JS/YAML content written by local models; hard to notice because the write "succeeds".
- Remediation: run the string-aware control-character escape first on the original text; apply structural repairs only outside string literals (tokenizer-based); on any repair, record it in the tool receipt.
- Acceptance test: P1 → content identical to the intended text with `None`/`True`/`[1, 2,]` preserved.

### I-03 An empty assistant reply is reported as a completed turn
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all three branches, installed runtime (re-run on tui: identical)
- Trigger: stream completes (`finish_reason:"stop"`, `[DONE]`) with no content and no tool calls; the non-streaming re-request (client.ts:1307-1311) also returns `content:""`.
- Expected: a failed/incomplete turn ("model returned no output"), optionally with one bounded retry.
- Observed: I3: 2 requests (`stream:[true,false]`), `TURN ENDED - NO CHANGES TO VERIFY`, `execution=COMPLETED outcome=NOT_REQUIRED modelStop=FINAL_TEXT`, empty final text.
- Impact: operators see success for a turn that did nothing; common with overloaded local servers and template mismatches.
- Remediation: in the turn loop, treat `toolCalls.length === 0 && !text.trim()` as `modelStop: EMPTY_OUTPUT` → execution FAILED (agent.ts near 3158, subagent already does this at 3640-3644).
- Acceptance test: I3 → `execution=FAILED`, reason names empty output.

### I-04 Text that merely contains JSON with a `name` field is executed as a tool call
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Trigger: final answer quoting a `package.json` (`{"name":"my-app","version":"1.0.0",…}`).
- Observed: parser step 5 (parser.ts:291-312) accepts any balanced object with `name|tool|action`. I5b: tool `my-app` dispatched → `FAIL-001 … not registered`,
  an extra inference request, the answer is re-generated. Combined with I-01, a quoted example like `{"name":"delete_file",…}` in prose would run.
- Remediation: only accept embedded calls whose name is an offered tool and whose shape is `{name, arguments}`; skip steps 4-6 when the model/provider supports native tool calls.
- Acceptance test: I5b → no tool dispatched, one request, final text kept.

### I-05 Provider context-length errors end the turn; llama.cpp's error shape is not recognised as capacity; no reactive compaction
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Observed: I6 (OpenAI shape, `code:"context_length_exceeded"`) → classified `CAPACITY_REJECTED`, `NOT_EXECUTED`, then `TURN FAILED … HTTP 400` after 1 request.
  I6b (llama.cpp server shape: `type:"exceed_context_size_error"`, message "exceeds the available context size", `n_ctx`) → `REQUEST_REJECTED`
  (the body regex at core/provider_recovery.ts:106 lacks "context size"). No code in agent.ts handles `CAPACITY_REJECTED` (grep: no match), so neither
  compaction-and-retry nor `n_ctx` learning happens; pre-flight admission (`ContextBudgetError`) exists but depends on a configured/learned limit.
- Impact: long sessions against local servers with a smaller real `n_ctx` than configured fail hard instead of compacting.
- Remediation: add `exceed_context_size_error`/"context size"/`n_ctx` to capacity classification; on CAPACITY_REJECTED compact once and resubmit, and lower the learned context limit from `n_ctx`.
- Acceptance test: I6b → classified CAPACITY_REJECTED; with a script that accepts the second (compacted, shorter) request, the turn completes.

### I-06 SSE lines `data:` without the optional space are ignored, failing the turn
- Priority: P2
- Label: REPRODUCED DEFECT
- Affects: all three branches
- Observed: the parser accepts only `data: ` (client.ts:1177, 1181); the SSE spec makes the space optional. I7 → 3 submissions, `stream_incomplete`,
  `Provider recovery exhausted … replay budget (2) is spent`, `TURN FAILED`.
- Remediation: accept `/^data:\s?/` and `data:[DONE]`.
- Acceptance test: I7 → turn completes with text "nospace".

### I-07 Provider-reported usage is ignored for plain endpoints; inference receipts exist only for connected providers
- Priority: P2
- Label: SOURCE-SUPPORTED RISK (partly observed)
- Affects: all three branches
- Observed: `withReceipt` returns early when `!this.conn.providerId` (client.ts:520-521) and stream usage is captured only into `this.pending`, which is
  set only for providers (client.ts:1166, 1201-1205); the agent uses reported usage only when `getProviderId()` is set, else an estimate (agent.ts:3107-3123).
  I10 sent a `usage` chunk (1234/56) from a plain endpoint; the turn projection has no usage fields and nothing records it.
- Impact: for local-first users (LM Studio/vLLM/llama.cpp via `--endpoint`) token accounting is estimated and there is no receipt trail.
- Remediation: always capture `usage`, `id`, `model` from responses and write receipts with `providerId:"endpoint:<origin>"`.
- Acceptance test: I10 → a receipt in the usage ledger with `usage.inputTokens:1234` and session totals including 1234.

### I-08 Malformed tool-call JSON yields a misleading error to the model
- Priority: P3
- Label: REPRODUCED DEFECT
- Observed: I1 (`{"path":"a.txt","content":"hello"` unterminated) → args become `{raw:…}` (agent.ts:2472-2480) → `FAIL-002: Malformed arguments: Missing required parameter 'path'`.
  The model is not told its JSON was invalid; it recovered here (next reply was text), but local models often loop on this.
- Remediation: return "arguments were not valid JSON: <parse error>; resend the call" when `raw` is set.
- Acceptance test: I1 → tool message contains "not valid JSON".

## What is solid (with evidence)
- Read-only command execution is defence-in-depth: authority admission rejects shell metacharacters and allowlists inspection commands
  (core/authority.ts:43-130, 213-230), the bridge applies a second allowlist (tools.ts:31-32, 445-463), and every read-only command runs in bwrap/docker with
  `--ro-bind` and no network or is refused if no sandbox exists (tools.ts:715-742, sandbox.ts:126-180). R4/R4b: `npm test` mutates normally but not under read-only;
  R5: `rg --pre ./pre.sh` refused; R7: `delete_file`, `manage_knowledge` denied with AUTH-009.
- Rust path confinement canonicalises targets/ancestors, rejects escaping and broken symlinks and verifies opened descriptors (file_ops.rs:55-75, 651-711; unit tests 1096-1131).
- Streaming: UTF-8 decoding with `stream:true` (I8: "héllo 🙂 wörld" split mid-emoji intact), incomplete streams detected (no `finish_reason`/`[DONE]`),
  `finish_reason=length` refuses partial tool args (client.ts:1281-1290), mid-stream error frames classified.
- No duplicate execution: tools run only after a complete response; a stream reset after a complete tool-call delta but before finish was replayed and the command ran once (I9: `countLines:1`); I2 cut mid-tool-call → recovered, file written once.
- Recovery: 503 and 429 (`Retry-After: 1` honoured, ~1.2 s) are waited out with operator notices and work preserved (I4, I4b); unknown-execution replays are bounded (I7: budget 2).
- Failover never widens disclosure (client.ts:796-804); no TLS verification is disabled anywhere (grep `rejectUnauthorized|NODE_TLS_REJECT|insecure` over cli/src and core/src: no hits).
- Objective ledger: descoping operator requirements needs `/requirements accept`; agent status changes withdraw acceptance; `verified` requires a recorded passing attempt on the current workspace state and is demoted after any mutation (objective.ts:29-35, 286-360, 380-395). Turn outcome was not fooled by T-09 (R10 heading UNVERIFIED).
- Steering: per-id dedupe across process and resumed ledger, explicit acks for queued/deferred/rejected/cancelled with text returned (sidecar.ts:227-275); reviewed in source only.

## Checks actually run
- `git archive` of 3727938, 696178a, 31d6622 into `assess/ti/{main,tui,cc}`; `git diff --stat` between them for core/ and cli/src (core library identical; client/parser/provider_recovery/plugins/mcp/authority/tools/security/spine identical).
- `HOME=<tmp> TMPDIR=/tmp/claude-1000/tiZW1L npx tsx --test test/zz_trust_repro.test.ts` on main: R1, R2, R3, R4, R4b, R5, R6, R7, R8, R9, R10, R11, R12 — outputs quoted above.
- Same with `test/zz_infer_repro.test.ts` (recovery env shortened): I1, I1b, I2, I3, I4, I4b, I5, I5b, I5c, I6, I6b, I7, I8, I9, I10 — all ran (log `assess/ti/infer_run1.log`).
- `npx tsx --test test/zz_parser_probe.test.ts` (P1 repairJson corruption).
- On the feat/tui-surface extract: R1, R2, R3, R8, R9, I3, I5c — identical results.
- Source greps for approval list, registry flags, MCP/plugin loading, trust checks, TLS flags, CAPACITY_REJECTED handling (cited inline).

## Limitations
- Mock/own HTTP servers only; no real local inference server (llama.cpp/vLLM/LM Studio) was exercised; I6b uses llama.cpp's documented error shape from memory, not a live capture.
- fix/context-convergence was compared by source diff, not re-run (the relevant files are identical except agent.ts, whose approval list and subagent dispatch were checked by grep).
- The bwrap sandbox was available on this host; behaviour without bwrap/docker (refusal path) is from source only.
- TOCTOU (T-11), redirect SSRF (T-12) and anthropic/openai-responses protocol adapters (cli/src/protocols/) were reviewed in source only / not reviewed in depth.
- The harness-core binary used is the 31d6622 build; its library sources are identical to main/tui, but the binary itself was not rebuilt from main.
