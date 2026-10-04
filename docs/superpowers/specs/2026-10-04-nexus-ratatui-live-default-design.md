# Nexus Ratatui Live Default — Design

**Date:** 2026-10-04
**Status:** Approved in conversation; awaiting written-spec review
**Goal:** Someone who clones the repo, builds it, and runs `harness` lands in a live, full-screen terminal session whose look and feel competes with frontier coding harnesses (Claude Code, Codex CLI).

## 1. Context

- `harness` with no arguments runs `node cli/dist/index.js repl`, a `readline/promises` REPL (`cli/src/repl.ts`, ~1,465 lines) where agent streaming, spinners (`ora`) and tool output write directly to stdout.
- `/tui` spawns the Ratatui binary `nexus-tui` (`core/src/bin/nexus_tui.rs`) on a static mode-0600 JSON snapshot written by `cli/src/tui.ts`. It is a read-only inspector: it does not update during a turn and cannot submit prompts.
- Turn semantics (`cli/src/core/turn.ts`) are truthful after the Truthful Interruptible Turns slice: `execution` / `outcome` / `acceptance`, cancellation, stream integrity, verifier gating.
- Known defects the current surface cannot fix: multi-line paste delivers only the first line; typed-ahead input is dropped; `/tui` leaks a keystroke into the next REPL command.
- `ApplicationCore` (`cli/src/core/app.ts`) is an `EventEmitter` but emits only coarse events (`task:start/end`, `plan:change`, `state:checkpoint`). The REPL bypasses it and calls `agent.runTurn` directly.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Product ambition | Best local-LLM harness and a general contender against frontier harnesses |
| Backends | Local-first; cloud backends deferred until local is clearly winning |
| Success gate | Dogfooding as the daily driver plus a small fixed eval suite (later work, not this spec) |
| Current priority | Visual surface and first-run experience |
| Default surface | Live full-screen TUI; the readline REPL becomes a fallback |
| Stack | Ratatui (Rust) owns the terminal; the TypeScript agent runs as a headless sidecar |
| Transport | Bidirectional NDJSON over the sidecar's stdio |
| Delivery | All four phases (protocol, live spectator, composer and default entry, polish) |

## 3. Architecture

**Entry points**

- `harness` (no arguments) starts `nexus-tui` in live mode.
- `harness --repl` and `harness repl` keep the current readline REPL for debugging and automation.
- `harness run …` stays headless and unchanged.

**Process model**

```
harness → nexus-tui (owns the terminal, input, rendering)
              │  NDJSON over child stdio, both directions
              ▼
         node cli/dist/sidecar.js (ApplicationCore + AutonomousAgent)
              ├── local LLM gateway (OpenAI-compatible /v1)
              └── harness-core (existing Rust tool engine)
```

**Authority boundary**

- `nexus-tui` never decides success, verification, acceptance, or integration. It renders what the sidecar reports and forwards operator actions.
- The sidecar never writes to the terminal. All operator-facing I/O goes through the protocol.
- The existing snapshot mode stays for tests and `--plain` fixture rendering. It is not the interactive product.

**Failure handling**

If the sidecar exits or emits malformed output, `nexus-tui` shows a recoverable error with restart and quit options. It never falls back to printing raw agent stdout.

## 4. Screen and interaction

**First paint (empty session)**

One composition: the `NEXUS` mark, one short tagline, a quiet status strip (workspace, git badge, model, mode), and a focused multi-line composer. No dashboard cards, no endpoint dump, no help wall.

**During a turn (top to bottom)**

1. Status strip: workspace, git badge, model, mode, and a cancel hint while busy.
2. Transcript: streaming assistant text. Each tool call renders as one quiet line (glyph, verb, subject). Full payloads open only in a detail overlay.
3. Turn banner: projects `execution` and `outcome` exactly as reported in `turn.result`. It never infers success.
4. Composer: multi-line by default. Enter submits; Shift+Enter inserts a newline, with Alt+Enter as a fallback for terminals that cannot distinguish Shift+Enter. Pasted text arrives as one block.

**Overlays (modal, not permanent panes)**

- Approval in review mode: unified diff with approve, deny, and always-allow-for-session.
- Activity and tool evidence detail.
- Validation receipt.
- `?` key help.

**Keys (v1)**

| Key | Action |
|---|---|
| Typing | Compose |
| Enter | Submit |
| Shift+Enter / Alt+Enter | Newline |
| Esc | Close overlay; otherwise no-op |
| Ctrl-C | Cancel the running turn (same semantics as TIT); at idle with an empty composer, exit |
| Ctrl-L | Clear the composer |
| `/` at start of composer | Slash command |
| Tab (idle) | Move focus between transcript and composer |

**Quiet by default.** No per-step context-admission lines, no raw tool JSON, no duplicated `task_completed` summary. `NEXUS_DEBUG=1` restores verbose projection.

## 5. Protocol and sidecar

**Transport.** One child process. Parent is `nexus-tui`; child is `node cli/dist/sidecar.js`. The child's stdin and stdout carry only NDJSON: no banners, no `ora`, no `console.log`. With `NEXUS_DEBUG=1` the child may log to stderr; `nexus-tui` never renders stderr as transcript.

**Framing.** One JSON object per line, UTF-8, each carrying `"v": 1` and a `type`. Requests that need a reply carry `id`; replies echo it. Turn-scoped events carry `turn_id`.

**Sidecar entry point.** New `cli/src/sidecar.ts`, built to `cli/dist/sidecar.js`. It boots `ApplicationCore` from the same config resolution the CLI uses, plus values passed by `nexus-tui`. It does not construct `InteractiveRepl`. It emits protocol events from existing stream, tool, and turn hooks and maps `TurnResult` to `turn.result` one-to-one.

**Minimum message set (phases 1–3)**

| Direction | Types |
|---|---|
| Sidecar → UI | `hello`, `session.state`, `assistant.delta`, `tool.start`, `tool.end`, `approval.request`, `turn.result`, `error` |
| UI → sidecar | `prompt.submit`, `cancel`, `approve`, `deny`, `slash`, `shutdown` |

**Streaming.** `assistant.delta` carries already-redacted text chunks. `tool.end` carries a summary and an evidence reference, not the full body. Oversized fields are capped.

**Approvals.** The sidecar blocks on `approval.request` until it receives `approve`, `deny`, or `cancel` for that `id`. Only one approval is outstanding at a time.

**Cancellation.** `cancel` invokes the existing TIT abort path. The UI shows `INTERRUPTED` only after `turn.result` reports it.

**Compatibility.** The REPL path is unchanged. Snapshot mode in `nexus-tui` remains until live mode covers its tests; afterwards it survives only as the `--plain` fixture renderer.

## 6. Phases

1. **Protocol and headless agent.** Sidecar speaks NDJSON. Golden traces against the deterministic fake gateway cover a full turn: streaming, tool calls, `turn.result`, cancel, and approve/deny. Default entry is not changed.
2. **Live spectator.** `nexus-tui` consumes events and renders the status strip, transcript, tool lines, and turn banner. Launched by a flag; composer may be minimal.
3. **Composer and default entry.** Multi-line composer, approval modal, Ctrl-C cancel, slash commands. `harness` opens the TUI; `--repl` is the escape hatch.
4. **Frontier polish.** Empty-state identity, quiet chrome, themes, diff presentation, resize and minimum-size handling. README and first-run docs updated to describe what actually ships. PTY captures compared against a fixed look-and-feel checklist drawn from Claude Code and Codex CLI (feel, not feature parity).

## 7. Testing and acceptance

- Protocol contract tests (TypeScript): every message type round-trips; the sidecar emits nothing but NDJSON on stdout.
- Golden event traces from the fake gateway for success, failure, interrupt, approval, and denial.
- Ratatui `TestBackend` render tests for empty state, streaming, tool lines, each turn-banner outcome, each overlay, and minimum terminal size.
- PTY recordings of a real-gateway session, kept as evidence.
- Existing `make test` stays green, apart from the two pre-existing `security_gates` failures unless they are fixed separately.

**Done when**

- Clone, `make build`, `harness` opens a live Ratatui session against the local gateway.
- One real turn streams calmly and reports its outcome truthfully; interrupt and approval work.
- Multi-line paste submits the whole block.
- `harness --repl` and `harness run` still work.
- Protocol and Ratatui tests pass; PTY evidence is recorded.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Stdio deadlock or log lines corrupting the protocol | Ban stdout writes in the sidecar; contract test fails on any non-JSON line |
| Sidecar crash mid-turn | TUI error with restart; tools already executed are reported, nothing is retried silently |
| Look-and-feel bikeshedding | Fixed reference captures; visual polish confined to phase 4 |
| Scope creep | Section 9 is binding for this design |

## 9. Out of scope

Cloud model backends; context-engineering productization (A1+E); per-turn change ledger and worktree `integration` dimension; multi-agent panes; web UI; Ink rewrite; contest work; changes to verification semantics beyond projecting them.
