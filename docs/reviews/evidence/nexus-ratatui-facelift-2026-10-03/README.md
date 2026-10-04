# Nexus terminal client facelift evidence

This directory contains a synthetic session fixture, fixed-size before/after terminal captures, and a replayable PTY recording. The fixture uses invented paths, findings, and validation output; it is not runtime evidence about a Nexus task.

## Starting point

- Shared checkout: `/home/mike/nexus-code`, branch `main`, HEAD `731f5d44c7b548938d1f011bd88269b09df2bff4`.
- At task start the shared checkout had 77 changed or untracked paths, including Cloudflare experiment code, evidence, and review documents. Those were treated as pre-existing work and left out of this change. A clean detached worktree was used for implementation.
- No Git remotes were configured in the starting checkout.
- Baseline CLI suite: `npm test` exited 1. The observed gate failures were caused by npm `EALLOWSCRIPTS` output inside `scripts/security_gates.sh`, which led the two `SCAN-001/SCAN-004` assertions to fail. Client projection and task lifecycle tests observed in the run passed.
- Before captures: [REPL](repl-before.txt) and [TUI](tui-before-100x30.txt).

## Baseline client architecture and UX

The CLI and REPL are TypeScript. `InteractiveRepl` owns readline, slash commands, cancellation prompts, and session persistence. `ApplicationCore` and `AutonomousAgent` already own task state, plans, validation receipts, tool messages, cancellation, and outcome semantics. The existing TUI read a snapshot from the agent, drew a two-column dashboard with hand-built Unicode strings, and exited on any of a small set of raw keys. It did not subscribe to the task event emitter or update during a turn. The REPL streamed assistant text and printed step, context-admission, tool argument, and tool-output details inline.

The before capture showed a fixed-width banner and system-oriented status blocks. The presentation foregrounded model/context plumbing, shortened recent activity to five messages, and offered almost no interaction beyond returning to the REPL.

## Ratatui research

Research was performed against Ratatui 0.30.2, its built-in widget examples and showcase, its widget composition guidance, the official event-driven application templates, and the component-library ecosystem page:

- [Ratatui built-in widget examples](https://ratatui.rs/examples/widgets/)
- [Ratatui widget showcase](https://ratatui.rs/showcase/widgets/)
- [Ratatui widget composition](https://ratatui.rs/concepts/widgets/)
- [Official application templates](https://github.com/ratatui/templates)
- [Ratatui component libraries and ratcn](https://ratatui.rs/ecosystem/ratcn/)

The TUI composes Ratatui `Layout`, `Block`, `List`/`ListState`, `Paragraph`, `Clear`, and `TestBackend`; Crossterm supplies terminal events and restoration. It follows the official event-driven loop pattern. `ratcn` 0.0.5 was reviewed (MIT) and not adopted: the screen uses a focused list/detail layout, so its component runtime would add focus and theming machinery without improving this interaction. `tui-textarea` was reviewed (MIT) and not adopted because the TUI is a session inspector, not a second prompt editor.

## Information design and implementation

The primary order is objective, recent activity, validation, plan, then context. Tool results are quiet by default. Model responses are explicitly labeled as model-reported and unverified. Failures remain visible, validation is not inferred from completion, and full tool output remains in the agent transcript and can be opened from the activity detail overlay. The overlay also provides a validation-receipt inspector. `?` opens key help. `↑/↓` or `j/k` navigates and scrolls, Enter or `d` opens activity evidence, `v` opens validation, Escape closes an overlay, and `q` returns to the REPL.

The Ratatui binary receives a short-lived, mode-0600 JSON projection from the TypeScript client and removes it after exit. The projection is derived from existing agent/application state and carries through the selected Nexus theme for the primary accent. It introduces no new task authority, validation, execution, or completion semantics. TUI display state remains read-only. Non-TTY `/tui` output stays usable as a compact text projection.

REPL startup and prompt styling now share the Nexus identity, routine context-admission and step-count messages are quiet unless `NEXUS_DEBUG=1`, and tool output defaults to a short status/summary. Full tool output is retained in the transcript and available from `/tui` evidence details. `/status` still exposes endpoint and runtime details.

## Visual and interaction evidence

- Fixture source: [synthetic session fixture](session-fixture.json).
- After TUI captures at 100×30: [needs attention](tui-after-100x30.txt), [active work](tui-after-active-100x30.txt), and [verified completion](tui-after-success-100x30.txt).
- Actual TUI PTY interaction: [100×30 recording](tui-session-100x30.typescript) with [timing](tui-session-100x30.timing), and [100×30 resized to 76×20, then evidence detail](tui-resize.typescript) with [timing](tui-resize.timing).
- Actual REPL entry-point PTY exercise: [startup, `/status`, `/help`, `/tui`, return, exit](repl-session.typescript) with [timing](repl-session.timing). The TUI fixture recordings show findings and validation detail; all scenario content is synthetic.
- REPL after capture: [REPL](repl-after.txt).
- The UI tests include 76×20 rendering, minimum-size recovery, validation visibility, and full evidence-line retention.

The TUI is a snapshot inspector, matching the old `/tui` invocation boundary. It does not stay live while `runTurn` executes and it does not submit prompts; the REPL remains the execution surface. The REPL remains chronological and readline-based; multiline composition is still not supported. The operator should review the captures and recording for visual acceptance.

## Regression and implementation evidence

Final qualification on 2026-10-04:

- `npm run build`: PASS (`cargo build --release` for all core binaries, then TypeScript `tsc`).
- `cargo test --manifest-path core/Cargo.toml`: PASS, 19 tests across the core binary, Ratatui binary, and two integration targets.
- Ratatui UI tests: PASS, 4 tests for compact layout, minimum terminal recovery, complete evidence display, and theme accent selection.
- Focused TypeScript UI tests: PASS, 3 tests for application projection, synthetic-sensitive-value redaction, and existing TUI projection expectations.
- Full `npm test`: 264 passed, 2 failed out of 266. Both failures are the existing `SCAN-001/SCAN-004` security-gate assertions. `scripts/security_gates.sh` exits after npm reports `EALLOWSCRIPTS` (`--allow-scripts is not allowed in project-scoped installs`). The same failure was present in the pre-change baseline.
- Protected contest source: `node --check experiments/cloudflare-artifacts-vertical-slice/contest-vertical-slice.mjs` PASS; no contest paths are in this worktree's change list. The full contest run was not run because it acquires write-scoped Cloudflare Artifacts credentials and performs remote repository writes; this facelift is not authorized to publish or write remotely.
- TUI PTY exercise: input selection, Enter detail, Escape, help, validation view, quit/terminal restoration, and 100×30 to 76×20 resize were observed. The REPL PTY exercise used `/status`, `/help`, `/tui`, returned to the REPL, and exited cleanly.
- The single-file Rust formatting check (`rustfmt --check --edition 2024 core/src/bin/nexus_tui.rs`) passes. Whole-crate `cargo fmt --check` reports pre-existing formatting differences in unrelated Rust source files; those files were preserved byte-for-byte.

The contest limitation is why `CONTEST_REGRESSION` remains `NOT_RUN`; the local syntax and no-contest-diff checks are not represented as end-to-end contest qualification.

## Third-party dependency/license inventory

| Addition | Version | License | Use |
| --- | --- | --- | --- |
| `ratatui` | 0.30.2 | MIT | TUI rendering, layout, widgets, test backend |
| `crossterm` | 0.29.0 | MIT | Keyboard/resize events and terminal backend |

Both direct additions are permissively licensed for the intended public release. No copied third-party component source was added. `ratcn` 0.0.5 and `tui-textarea` were reviewed as MIT licensed and rejected for the reasons above.

## Public-repository hygiene findings

- The tracked `cli/.env` contains a populated `LOCAL_LLM_API_KEY` assignment. Its value was not printed, copied, or used in this work. Review it for a live credential before public release.
- Tracked Cloudflare contest materials include credential-brokerage and token-output remediation/qualification documents, gateway evidence JSONL, request/event logs, and contest-worker implementation. These may include internal operational details or identifiers and need a separate public-release review. They were not changed by this task.
- At task start, the shared checkout also contained uncommitted and untracked Cloudflare trust-root, credential-lifecycle, recovery, and closure evidence. These were left untouched and are not included in this evidence worktree.

No repository-wide sanitization was performed.
