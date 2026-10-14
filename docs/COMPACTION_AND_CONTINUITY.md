# Compaction and task continuity

How Nexus keeps a long task going: no step ceiling on progressing work, progress judged against workspace state,
tracking that survives compaction, follow-ups and restart, a durable compaction boundary, and context sizing taken from
the provider when it advertises it. Operator reference first, then the developer reference.

Nexus works the same way with or without the homelab-ai gateway. When the gateway is the connection, Nexus reads the
capacity it advertises and counts requests through it. Without it, Nexus uses the operator's configuration or its
labelled defaults. Neither product requires the other.

## Operator reference

### Long tasks have no step ceiling

`--max-steps` (default 30) is the length of a **segment**. At each segment boundary the turn writes a durable
checkpoint and continues by itself. A turn ends for one of these reasons only:

| Ends when | Reason on the result |
| --- | --- |
| the model calls `task_completed` or gives a final answer | `COMPLETED` (with the verifier's outcome) |
| you cancel (Esc / Ctrl-C) | `INTERRUPTED` |
| no progress for `--stagnation-steps` consecutive steps (default 12) | `STAGNATION_DETECTED` |
| the same action gives the same result on an unchanged workspace after two recovery notes | `STAGNATION_DETECTED` |
| inference fails and provider recovery cannot wait it out | `INFERENCE_FAILED` |
| a compaction (or another record the next action depends on) cannot be written | `PERSISTENCE_FAILED` |
| **you** set `--max-total-steps N` or `--max-turn-minutes M` | `STEP_BUDGET_EXHAUSTED` / `TIME_BUDGET_EXHAUSTED` |

There is no default total-step or time limit. Earlier versions stopped at 300 steps and 120 minutes; those defaults
are gone. Explicit limits (`--max-total-steps`, `NEXUS_MAX_TOTAL_STEPS`, `--max-turn-minutes`,
`NEXUS_MAX_TURN_MINUTES`) still apply. `--no-continuation` is your explicit choice of a turn that ends at `--max-steps`.

The model is never told that "steps are running out" unless you set a step limit. The live status line shows
`step N` (and `step N of M` only under a limit you set).

Delegated helpers (`spawn_subagent`) have no step allowance either. A helper stops when it delivers its report, when
it shows no progress, or when its parent turn is cancelled.

### What counts as progress

A step makes progress when any of these is true:

- the workspace reaches a state not seen before on this objective (by content, not file timestamps);
- an observing action (reading files, running a command) returns something not seen before on the current state;
- the acceptance requirements change to a state not seen before (`update_requirements` with evidence);
- your steering or a follow-up message is applied.

These do **not** count as progress:

- editing the plan;
- re-formatting the same tool arguments, or a new tool-call id;
- writing a file with the content it already has;
- returning the workspace to an earlier state;
- a command whose output differs only in timestamps, durations, request ids or temporary paths.

### Repetition and polling

Nexus compares three things before calling an action repeated: the action (tool and canonical arguments), its outcome
(normalized; for `run_command` the exit code decides success), and the workspace state it ran on. That state covers:

- file content (HEAD plus every changed and untracked file);
- the git index;
- the content of ignored dependency and environment inputs (`node_modules/.package-lock.json`, `.venv/pyvenv.cfg`,
  `target/.rustc_info.json`, `.env`, …);
- `PATH`.

How Nexus responds:

- **The same action and result on an unchanged state** is a demonstrated loop on its third occurrence. The model gets
  a recovery note; after two notes the turn stops with the loop cited.
- **The same command after a real change** (an edit, a staged change, reinstalled dependencies with different
  content) is a legitimate retry. It starts a new count.
- **Polling**: an external command (`run_command`, network tools) returning the same result on an unchanged workspace
  is a poll, not a loop. Nexus waits before re-running it (1 s, 2 s, 4 s … capped at 30 s). The wait gives external
  state time to change, and stops a tight loop from burning inference. Polls make no progress, so a poll that never
  changes ends the turn through the stagnation threshold.
- **Transient failures** (connection refused, timeouts, HTTP 429/502/503/504, …) get the same backoff. They are not
  treated as deterministic loops.
- **Re-reading something compaction removed** is re-acquisition, not repetition. If the same output has to be
  re-read twice after compaction removed it, Nexus records *context thrash*: the window does not hold the working set.
  It asks the model to keep the facts it needs in its own messages.
- **Unknown state**: if the workspace state cannot be established (for example, too costly on a huge non-git tree),
  Nexus says so on the result (`continuation.stateUncertainty`) and never claims an action was repeated on an
  unchanged workspace.

The stagnation threshold (12) counts consecutive steps without progress. Any progressing step resets it, so it does
not limit how long a task can run. The repetition threshold (3) means "seen twice is a re-check, three times is a
loop".

### Tracking that survives compaction, follow-ups and restart

Each objective carries its execution tracking inside the objective ledger:

- cumulative steps;
- progress events;
- repeated actions with their evidence;
- failed approaches;
- recovery notes and backoff waits;
- compactions.

Compaction rewrites the conversation, never the ledger. `/resume` and task recovery restore the ledger with the
session. The model sees demonstrated loops and recent failed approaches in the pinned ledger, so they are not
repeated after a compaction or a restart.

When a follow-up is the same objective:

- **Listed requirements** (two or more numbered items, unfinished): every follow-up continues the objective.
- **Single request, unfinished**: "continue", "keep going", "resume", "try again" and similar continue it.
- **Any other new request**: starts a new objective, with new tracking.
- **`/requirements clear` and `/clear`**: start over explicitly.

Your original wording and constraints stay pinned verbatim whatever compaction does.

### Compaction

Automatic compaction runs when a request would not fit, or proactively at 80% pressure. If two pressure compactions
in a row each free less than 5% of the window (or find nothing to remove), Nexus stops compacting on pressure alone
and waits until a request would not fit. This *compaction thrash* is recorded separately from task repetition.

`/compact` and `/compact --llm`:

- **No turn running**: runs at once.
- **During work (TUI)**: queued and acknowledged at once. It runs only when nothing is in flight: after the current
  inference and its whole tool batch, approvals included, have settled, and before the next inference or tool
  dispatch. If the turn ends first, it runs at the end of the turn.
- **Duplicates**: a second identical request shares the first one's outcome. At most one request of each kind waits.
- **Cancellation and shutdown**: end waiting requests with that outcome.
- **Every request** gets a final result for its id.

Every compaction, automatic or manual, is committed in a fixed order before anything else happens:

1. the original messages are appended to the archive (`<session>.history.jsonl`, fsync), tagged with the compaction id;
2. the conversation switches to the compacted form;
3. the task state is written, then the session record. Each names the compactions it commits, and each is synced to
   disk.

If the archive cannot be written, nothing is compacted and the outcome says so. If a record cannot be written, the
compaction is applied but reported **not durable**, naming which write failed:

- an automatic compaction stops the turn with `PERSISTENCE_FAILED`, before any further inference or tool call;
- a manual one reports failure.

Mid-turn progress saves that fail are shown once and listed on the turn's result (`persistence.failures`).

After a crash at any point of a compaction, `/resume` is consistent:

- **Died before the records were written**: the resumed conversation still holds the originals, and the archive lines
  of the interrupted compaction are set aside and reported.
- **Died mid-append**: a torn archive line is counted as unreadable and not used.
- **Records disagree** (the task state names a compaction the session does not): each record is consistent with the
  archive by itself.

Compaction never replays an action. It only rewrites context, and only at a boundary where every tool call has its
recorded result. A call whose result was never recorded keeps the existing "outcome unknown" note.

### Context sizing and token accounting

At each step Nexus resolves the context window and the output allowance, and labels where each came from:

| Source | Meaning |
| --- | --- |
| `advertised` | the connection's `/models` entry (homelab-ai gateway: `context_length`, `max_completion_tokens`, `limits_version`, serving workers; vLLM: `max_model_len`) |
| `operator` | your `--context-limit` (kept when below advertised capacity) |
| `operator_capped_by_advertised` | your setting was above the advertised capacity, which applies |
| `client_default` | nothing advertised and nothing set: 65,536 tokens and an 8,192-token allowance (or a quarter of the window) |

Capabilities are re-read when:

- the model or endpoint changes;
- the provider rejects a request for capacity;
- the gateway reports a different capacity or worker on an admitted request;
- five minutes have passed.

A changed limit is announced as a notice. If the catalog cannot be read for a while, the last valid advertisement for
the same connection is kept, and the failure is labelled.

Each request's prompt is counted in one of these ways (logs `[token_count]`, `/status`, and `tokenAccounting` on
every turn result):

| Count source | Meaning |
| --- | --- |
| `exact_admitted` | the gateway's own count of the request it admitted (`X-AIHost-Prompt-Tokens`, source `exact`), after the fact |
| `exact_sampled_worker` | `/v1/tokenize` counted the exact outbound request (messages, tools, `tool_choice`, settings) on one worker of the alias; see the limitation below |
| `gateway_conservative` | the gateway could not tokenize and returned its conservative estimate |
| `client_estimate` | Nexus's own estimate: no counting capability, or it is unavailable (the reason is given) |

Request counting is used only when the connection advertises it (the homelab-ai gateway). It has these properties:

- **What it counts**: the same request body inference sends, after the same disclosure checks, egress quarantine and
  sanitization.
- **Where it goes**: only the active endpoint, with the connection's own credential. Never a fallback endpoint or
  another provider.
- **Calibration**: when the measured count does not fit, Nexus compacts further, using estimates calibrated to the
  measurement, before sending.
- **When it fails**: if counting fails (`unavailable`, `malformed`, `denied`), the request proceeds on the labelled
  estimate, and counting is retried after a minute. A connection that does not support counting is simply standalone.

`--strict-token-count` (or `NEXUS_STRICT_TOKEN_COUNT=1`) is an explicit opt-in that refuses a request no worker
counted. The result is `TURN BLOCKED - REQUEST NOT MEASURED`. It is off by default; normal standalone operation never
depends on counting.

The output allowance (sent as `max_tokens` to local endpoints) and the **tool-output headroom** are what admission
keeps free next to the prompt. The headroom is `min(4096, window/8)` unless `toolResponseReserveTokens` is
configured. It is a scheduling policy for the next tool results, not a measured or physical limit.

**Limitation (homelab-ai contract as of fb1a2cd):** `/v1/tokenize` picks the first unblocked worker of the alias. It
does not apply routing (`X-Task-Class`, affinity, load, fallback) or the reasoning policy, which rewrites
`chat_template_kwargs` before inference counts and admits. A pre-dispatch count is therefore exact for the sampled
worker and template inputs, not proven for the request inference admits. Nexus labels it `exact_sampled_worker`, and
after inference compares it with the gateway's admitted count and worker (`workerDiffers` on the result). See
`docs/reviews/2026-10-13-homelab-ai-gateway-capability-handoff.md`.

### What to look at

- `/status`:
  - `context`: window and output allowance, with sources;
  - `provider`: discovery, `limits_version`, request counting;
  - `last req`: count, source, worker, client estimate, admitted count;
  - `progress`: steps on the objective, steps since progress, compactions.
- The turn result (`/receipt`, `--json`):
  - `continuation`: segments, cumulative steps, demonstrated loops, state uncertainty;
  - `tokenAccounting`;
  - `persistence` (only when a write failed).
- Logs (non-TTY, or `NEXUS_DEBUG=1`): `[provider_capabilities]`, `[context_admission]`, `[token_count]`,
  `[context_findings]`.

## Developer reference

| Concern | Where |
| --- | --- |
| Identities, progress, repetition, polling, thrash, bounded persisted record | `cli/src/core/execution_tracking.ts` |
| Tracking in the ledger; continuation prompts; pinned evidence | `cli/src/core/objective.ts` (`trackingOf`, `isContinuationPrompt`, `renderPinnedLedger`) |
| Turn loop: state identity per step, backoff, recovery notes, stops | `cli/src/agent.ts` `runTurn`, `workspaceStateIdentity`, `runSubagent` |
| Compaction commit, queue, outcomes, restore | `cli/src/agent.ts` `commitCompaction`, `compactNow`, `requestCompaction`, `drainCompactionQueue`, `restoreConversation` |
| Durable files and archive reading | `cli/src/core/durable_file.ts` (`writeFileDurably`, `withDurableSync`, `appendLinesDurably`, `readArchiveLines`) |
| Host wiring (archive sink, session as part of the commit, `/compact` queue) | `cli/src/sidecar.ts`, `cli/src/repl.ts`, `cli/src/core/app.ts` |
| Capability parsing, limit resolution, count sources, admission headers | `cli/src/core/provider_capabilities.ts` |
| Discovery, request counting, shared outbound body | `cli/src/client.ts` (`discoverAdvertisement`, `countRequestTokens`, `outboundChatBody`) |
| Sizing in admission, measurement, calibration | `cli/src/agent.ts` `refreshCapabilities`, `measureAdmission`, `noteAdmission`, `scaledBudget` |

### Bounded storage

The tracking record is bounded:

- 256 repetition records. When over the bound, the oldest record seen only once is evicted first; records showing
  recurrence are kept.
- Seen-sets of 16-hex digests, 4,096 entries each, oldest out first. The number evicted is kept in `evicted`.
- Event lists of 64 to 128 entries.

A loop must recur on the same action, outcome and state, so it shows up as a repetition record with a count. An
evicted single-count record that recurs is still recognized through the seen-set, and its count restarts at 2. That is
why eviction does not hide a demonstrated loop. Only an objective with more than 4,096 distinct observations between
two occurrences of a loop could lose the first one; the stagnation threshold still bounds that case.

### Costs

- **State identity**: about 50 ms per call on a small repository, about 140 ms on this one. It is computed once per
  step and again only after a call that may have changed the workspace. A computation over 1.5 s disables it for the
  rest of the turn (reported as uncertainty).
- **fsync**: about 50 ms per synced write on the development host. It is paid at compaction commits, segment
  checkpoints and turn ends, not on every mid-turn progress save. Those saves stay atomic (temp file and rename), so
  they survive process death but not power loss.

### Tests

| Area | Test file |
| --- | --- |
| tracking unit tests | `cli/test/execution_tracking.test.ts` |
| capability parsing and limit resolution | `cli/test/provider_capabilities.test.ts` |
| agent-level behaviour against scripted gateways, including real process death at the commit boundary (`test/helpers/compaction_crash_child.ts`) | `cli/test/compaction_continuity.test.ts` |
| the TUI's protocol path for `/compact` | `cli/test/sidecar_compact_queue.test.ts` |

Scripted gateways establish behaviour under their fixtures, not local-model task quality.
