# Nexus TUI Live Spectator (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nexus-tui --live` (and `harness --live`) starts the phase-1 Node sidecar, renders its protocol events as a live full-screen session (status strip, streaming transcript, one-line tool calls, truthful turn banner), and accepts prompts through a minimal composer.

**Architecture:** Five focused modules under `core/src/bin/nexus_tui/`, attached to the existing binary root with `#[path]` so Cargo does not mistake them for extra binaries and the snapshot inspector stays untouched. `protocol` mirrors the TS protocol; `redact` mirrors `redactSecrets` for stderr; `sidecar` owns the child process with plain threads and an `mpsc` channel (stderr is always drained and redacted on capture); `live_state` is a pure reducer (events and keys in, actions out); `live_view` renders `LiveState` with Ratatui; `live` wires them into `LiveApp` (testable without a terminal) and the crossterm event loop.

**Tech Stack:** Rust 2024 (rustc 1.95), ratatui 0.30.2 (+ `unstable-rendered-line-info` for exact wrapped-line counts), crossterm 0.29 (bracketed paste), serde/serde_json, regex, std threads. Tests use `TestBackend` and fake sidecars written as `sh -c` scripts; one test talks to the real `cli/dist/sidecar.js`.

**Spec:** `docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md` (sections 3, 4, 5, 6 phase 2, 7). **Phase 1 plan:** `docs/superpowers/plans/2026-10-04-nexus-tui-sidecar-protocol.md`.

---

## Before you start

- Work in an isolated worktree (superpowers:using-git-worktrees). The main checkout has unrelated uncommitted Cloudflare/Issue 12 files; never stage them.
- Build once: `make build` (Rust release build plus `cli/dist`). The real-sidecar test in Task 3 needs `cli/dist/sidecar.js`.
- Rust tests for this binary: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui` (baseline: 4 tests pass). Filter by module, e.g. `... --bin nexus-tui protocol::`.
- New modules are not referenced by `main` until Task 6, so `dead_code` warnings for them are expected in Tasks 1–5. Do not add `allow` attributes; Task 7 requires zero warnings.
- Format only the files you touch: `rustfmt --edition 2024 core/src/bin/nexus_tui/<file>.rs` (do not run `cargo fmt` on the whole crate).
- Shell commands may pass through an `rtk` wrapper. Read real test counts from the output; never trust an exit code alone.
- The TS CLI suite (`npm --prefix cli test`) has 2 known failures in `security_gates.test.ts`; this plan does not touch TypeScript.

## Decisions refined from the spec (binding for this plan)

- **Launch:** `nexus-tui --live [--sidecar PATH] [--node BIN] [-- SIDECAR_ARGS...]`; `harness --live [SIDECAR_ARGS...]` wraps it. The default `harness` entry is unchanged (phase 3).
- **Composer (minimal):** Enter submits; Alt+Enter or Shift+Enter (when the terminal reports it) inserts a newline; bracketed paste inserts the whole block; Backspace; Ctrl-L clears.
- **Keys:** Esc while busy sends `cancel`. Ctrl-C: busy → `cancel`; idle with a draft → clear draft; idle and empty → quit. Crash screen: `r` restart, `q`/Esc/Ctrl-C quit.
- **Approvals and slash commands** are phase 3. The sidecar runs in `auto` mode, so approvals do not occur; if one arrives anyway the transcript says so and Esc cancels the turn.
- **Turn banner** uses the same projection as `TerminalUI.turnSummary` (`cli/src/ui.ts`): COMPLETED + VERIFIED/NOT_REQUIRED → ✓ green; other COMPLETED → ! yellow; everything else → × red. Heading and line are the sidecar's text, verbatim.
- **Open tool rows** still running when `turn.result` arrives (or when the sidecar dies) render as interrupted. The view never shows a tool as succeeded without a `tool.end` saying so.
- **`task_completed`** tool lines are hidden; the banner and the model summary already report it.
- **Crash screen** shows the reason, exit code, the last stderr lines (redacted on capture, ANSI stripped), and restart/quit. A non-protocol stdout line is never displayed (it bypassed redaction); it stops the sidecar.
- **Restart** starts a fresh sidecar; the transcript stays and a notice says the new agent does not remember it.
- **Transcript** is pinned to the newest line in this phase (no scrollback; phase 3 adds focus and scrolling).

## File structure

| File | Status | Responsibility |
|---|---|---|
| `core/Cargo.toml` | Modify | Enable ratatui `unstable-rendered-line-info` |
| `core/src/bin/nexus_tui.rs` | Modify | `#[path]` module declarations; `--live` branch in `main` |
| `core/src/bin/nexus_tui/protocol.rs` | Create | Event/command types, `parse_event`, `encode_command` |
| `core/src/bin/nexus_tui/redact.rs` | Create | `StderrRedactor` (mirror of `redactSecrets`, ANSI stripping, multi-line private keys) |
| `core/src/bin/nexus_tui/sidecar.rs` | Create | Child process, stdout reader → channel, bounded redacted stderr tail, reap/shutdown |
| `core/src/bin/nexus_tui/live_state.rs` | Create | Pure reducer: session, transcript, composer, link state, key handling |
| `core/src/bin/nexus_tui/live_view.rs` | Create | Ratatui rendering of `LiveState` |
| `core/src/bin/nexus_tui/live.rs` | Create | `resolve_spec`, `LiveApp`, terminal event loop |
| `harness.sh` | Modify | `harness --live` |

---

### Task 1: Protocol types

**Files:**
- Create: `core/src/bin/nexus_tui/protocol.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declaration after `use serde::Deserialize;`, line 17)

- [ ] **Step 1: Declare the module**

In `core/src/bin/nexus_tui.rs`, directly after `use serde::Deserialize;` add:

```rust

#[path = "nexus_tui/protocol.rs"]
mod protocol;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/protocol.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_rendered_event_type() {
        assert_eq!(
            parse_event(r#"{"v":1,"type":"hello","protocol":1,"pid":42}"#),
            Ok(Event::Hello { protocol: 1 })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":{"branch":"main","dirty":2},"busy":false}"#),
            Ok(Event::SessionState {
                workspace_name: "app".into(),
                model: "m".into(),
                mode: "auto".into(),
                git: Some(GitInfo { branch: "main".into(), dirty: 2 }),
                busy: false,
            })
        );
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"review","git":null,"busy":true}"#),
            Ok(Event::SessionState { git: None, busy: true, .. })
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"hi"}"#),
            Ok(Event::AssistantDelta { turn_id: "t1".into(), text: "hi".into() })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c1","tool":"read_file","subject":"src/a.ts"}"#),
            Ok(Event::ToolStart { call_id: "c1".into(), tool: "read_file".into(), subject: "src/a.ts".into() })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"c1","tool":"read_file","success":false,"summary":"No such file","lines":1}"#),
            Ok(Event::ToolEnd { call_id: "c1".into(), success: false, summary: "No such file".into() })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#),
            Ok(Event::ApprovalRequest { tool: "write_file".into(), subject: "x.txt".into() })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"error","id":"t2","code":"BUSY","message":"A turn is already running"}"#),
            Ok(Event::Error { code: "BUSY".into(), message: "A turn is already running".into() })
        );
    }

    #[test]
    fn turn_result_keeps_the_reported_turn_verbatim() {
        let event = parse_event(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#).unwrap();
        let Event::TurnResult { heading, line, turn, model_summary } = event else {
            panic!("expected turn.result");
        };
        assert_eq!(heading, "TURN INTERRUPTED");
        assert_eq!(line, "Stopped by operator");
        assert_eq!(turn["execution"], "INTERRUPTED");
        assert_eq!(turn["outcome"], "NOT_ESTABLISHED");
        assert_eq!(model_summary, None);
        let with_summary = parse_event(r#"{"v":1,"type":"turn.result","turn_id":"t2","heading":"H","line":"L","turn":{},"model_summary":{"summary":"Fixed it.","notes":"n"}}"#).unwrap();
        assert!(matches!(with_summary, Event::TurnResult { model_summary: Some(ModelSummary { ref summary }), .. } if summary == "Fixed it."));
    }

    #[test]
    fn unknown_event_types_are_tolerated() {
        assert_eq!(
            parse_event(r#"{"v":1,"type":"slash.result","id":"s1","command":"status","success":true,"output":"{}"}"#),
            Ok(Event::Unknown)
        );
    }

    #[test]
    fn rejects_non_protocol_lines() {
        assert!(parse_event("Compiling harness").unwrap_err().contains("not JSON"));
        assert!(parse_event(r#"{"type":"hello","protocol":1}"#).unwrap_err().contains("unsupported protocol version"));
        assert!(parse_event(r#"{"v":2,"type":"hello","protocol":2}"#).unwrap_err().contains("unsupported protocol version"));
        assert!(parse_event(r#"{"v":1,"type":"tool.start","call_id":"c1"}"#).unwrap_err().contains("invalid event"));
    }

    #[test]
    fn commands_encode_as_single_versioned_lines() {
        for (command, expected) in [
            (
                Command::PromptSubmit { id: "t1".into(), text: "fix\nit".into() },
                serde_json::json!({"v":1,"type":"prompt.submit","id":"t1","text":"fix\nit"}),
            ),
            (Command::Cancel, serde_json::json!({"v":1,"type":"cancel"})),
            (Command::Shutdown, serde_json::json!({"v":1,"type":"shutdown"})),
        ] {
            let line = encode_command(&command);
            assert!(line.ends_with('\n'));
            assert_eq!(line.matches('\n').count(), 1, "embedded newlines must be escaped: {line:?}");
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), expected);
        }
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui protocol::`
Expected: compile errors (`parse_event`, `Event`, `Command`, `encode_command`, `GitInfo`, `ModelSummary`, `Value` not found).

- [ ] **Step 4: Implement the module (above the test module)**

```rust
//! Client side of the Nexus sidecar protocol v1 (`cli/src/protocol.ts`). The sidecar is the authority on every
//! outcome; these types carry what it reports and nothing more.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct GitInfo {
    pub branch: String,
    pub dirty: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelSummary {
    pub summary: String,
}

/// Sidecar → UI events. Fields this client does not use are ignored by serde.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "hello")]
    Hello { protocol: u64 },
    #[serde(rename = "session.state")]
    SessionState {
        workspace_name: String,
        model: String,
        mode: String,
        git: Option<GitInfo>,
        busy: bool,
    },
    #[serde(rename = "assistant.delta")]
    AssistantDelta { turn_id: String, text: String },
    #[serde(rename = "tool.start")]
    ToolStart {
        call_id: String,
        tool: String,
        subject: String,
    },
    #[serde(rename = "tool.end")]
    ToolEnd {
        call_id: String,
        success: bool,
        summary: String,
    },
    #[serde(rename = "approval.request")]
    ApprovalRequest { tool: String, subject: String },
    #[serde(rename = "turn.result")]
    TurnResult {
        heading: String,
        line: String,
        turn: Value,
        model_summary: Option<ModelSummary>,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
    /// Event types this client does not render yet, such as `slash.result`.
    #[serde(other)]
    Unknown,
}

/// UI → sidecar commands used by the live view.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "prompt.submit")]
    PromptSubmit { id: String, text: String },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "shutdown")]
    Shutdown,
}

pub fn parse_event(line: &str) -> Result<Event, String> {
    let value: Value = serde_json::from_str(line).map_err(|err| format!("not JSON: {err}"))?;
    if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(format!(
            "unsupported protocol version: {}",
            value.get("v").unwrap_or(&Value::Null)
        ));
    }
    serde_json::from_value(value).map_err(|err| format!("invalid event: {err}"))
}

pub fn encode_command(command: &Command) -> String {
    let mut value = serde_json::to_value(command).expect("protocol commands always serialize");
    if let Value::Object(map) = &mut value {
        map.insert("v".to_string(), Value::from(PROTOCOL_VERSION));
    }
    format!("{value}\n")
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui protocol::`
Expected: 5 tests pass. Then `cargo test --manifest-path core/Cargo.toml --bin nexus-tui`: 9 pass (4 existing + 5).

- [ ] **Step 6: Format and commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/protocol.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/protocol.rs
git commit -m "feat(tui): protocol v1 client types for the live sidecar"
```

---

### Task 2: Stderr redaction

**Files:**
- Create: `core/src/bin/nexus_tui/redact.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declaration)

- [ ] **Step 1: Declare the module**

In `core/src/bin/nexus_tui.rs`, after the `mod protocol;` declaration add:

```rust
#[path = "nexus_tui/redact.rs"]
mod redact;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/redact.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_the_same_secrets_as_the_sidecar() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(
            redactor.line(r#"✖ Inference error (HTTP 500): {"error":"upstream rejected Bearer abcdefghijklmnopqrstuvwxyz0123"}"#).unwrap(),
            r#"✖ Inference error (HTTP 500): {"error":"upstream rejected Bearer [REDACTED_TOKEN]"}"#
        );
        assert_eq!(redactor.line("key sk-abcdefghijklmnop1234 leaked").unwrap(), "key [REDACTED_KEY] leaked");
        assert_eq!(redactor.line("api_key=hunter2hunter2 next").unwrap(), "api_key=[REDACTED] next");
        assert_eq!(redactor.line(r#""password": "s3cretvalue""#).unwrap(), r#""password": "[REDACTED]""#);
        assert_eq!(redactor.line("plain diagnostic").unwrap(), "plain diagnostic");
    }

    #[test]
    fn strips_terminal_escape_sequences() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(redactor.line("\x1b[31m✖ Working: run_command\x1b[39m").unwrap(), "✖ Working: run_command");
    }

    #[test]
    fn collapses_a_multi_line_private_key_to_one_marker() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(redactor.line("-----BEGIN OPENSSH PRIVATE KEY-----").as_deref(), Some("[REDACTED_PRIVATE_KEY]"));
        assert_eq!(redactor.line("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"), None);
        assert_eq!(redactor.line("-----END OPENSSH PRIVATE KEY-----"), None);
        assert_eq!(redactor.line("after").as_deref(), Some("after"));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui redact::`
Expected: compile error (`StderrRedactor` not found).

- [ ] **Step 4: Implement (above the test module)**

```rust
//! Redaction for sidecar stderr, which bypasses the sidecar's own `redactSecrets` (`cli/src/ui.ts`). Keep these
//! patterns in step with that function.
use std::sync::LazyLock;

use regex::Regex;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"(?i)Bearer\s+[A-Za-z0-9_\-.]{15,}").unwrap(),
            "Bearer [REDACTED_TOKEN]",
        ),
        (
            Regex::new(r"(?:sk-|ghp_|gho_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_\-]{16,}").unwrap(),
            "[REDACTED_KEY]",
        ),
        (
            Regex::new(r#"(?i)((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)([^"'\s]{6,})(["']?)"#)
                .unwrap(),
            "${1}[REDACTED]${3}",
        ),
    ]
});

/// Redacts stderr one line at a time. A private-key block spanning several lines collapses to a single marker.
#[derive(Default)]
pub struct StderrRedactor {
    in_private_key: bool,
}

impl StderrRedactor {
    /// Returns the redacted line, or `None` when the line is part of a private key being suppressed.
    pub fn line(&mut self, raw: &str) -> Option<String> {
        let line = ANSI.replace_all(raw, "");
        let is_key_marker = |kind: &str| line.contains(kind) && line.contains("PRIVATE KEY-----");
        if self.in_private_key {
            if is_key_marker("-----END") {
                self.in_private_key = false;
            }
            return None;
        }
        if is_key_marker("-----BEGIN") {
            self.in_private_key = !is_key_marker("-----END");
            return Some("[REDACTED_PRIVATE_KEY]".to_string());
        }
        let mut out = line.into_owned();
        for (pattern, replacement) in PATTERNS.iter() {
            out = pattern.replace_all(&out, *replacement).into_owned();
        }
        Some(out)
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui redact::`
Expected: 3 tests pass.

- [ ] **Step 6: Format and commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/redact.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/redact.rs
git commit -m "feat(tui): redact sidecar stderr with the sidecar's own secret patterns"
```

---

### Task 3: Sidecar process

**Files:**
- Create: `core/src/bin/nexus_tui/sidecar.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declaration)

- [ ] **Step 1: Declare the module**

After the `mod redact;` declaration add:

```rust
#[path = "nexus_tui/sidecar.rs"]
mod sidecar;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/sidecar.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const WAIT: Duration = Duration::from_secs(5);

    fn sh(script: &str) -> SidecarSpec {
        SidecarSpec { program: "sh".into(), args: vec!["-c".into(), script.into()] }
    }

    #[test]
    fn forwards_events_flags_malformed_lines_and_reports_the_exit_code() {
        let (tx, rx) = mpsc::channel();
        let mut sidecar = Sidecar::spawn(
            &sh(r#"echo '{"v":1,"type":"hello","protocol":1,"pid":7}'; echo 'Compiling...'; read line; echo "got $line" >&2; exit 3"#),
            tx,
        )
        .unwrap();
        assert!(matches!(rx.recv_timeout(WAIT).unwrap(), SidecarMsg::Event(Event::Hello { protocol: 1 })));
        assert!(matches!(rx.recv_timeout(WAIT).unwrap(), SidecarMsg::Malformed));
        sidecar.send(&Command::Cancel).unwrap();
        assert!(matches!(rx.recv_timeout(WAIT).unwrap(), SidecarMsg::Closed));
        assert_eq!(sidecar.reap(WAIT), Some(3));
        let tail = sidecar.stderr_tail();
        assert_eq!(tail.len(), 1, "{tail:?}");
        assert!(tail[0].starts_with("got {"), "{tail:?}");
        assert!(tail[0].contains(r#""type":"cancel""#) && tail[0].contains(r#""v":1"#), "{tail:?}");
    }

    #[test]
    fn a_stderr_flood_cannot_block_the_child_and_the_tail_stays_bounded_and_redacted() {
        let (tx, rx) = mpsc::channel();
        let mut sidecar = Sidecar::spawn(
            &sh(r#"i=0; while [ $i -lt 20000 ]; do echo "noise line $i Bearer abcdefghijklmnopqrstuvwxyz"; i=$((i+1)); done >&2; echo '{"v":1,"type":"hello","protocol":1,"pid":7}'"#),
            tx,
        )
        .unwrap();
        assert!(matches!(rx.recv_timeout(Duration::from_secs(30)).unwrap(), SidecarMsg::Event(Event::Hello { .. })));
        assert!(matches!(rx.recv_timeout(WAIT).unwrap(), SidecarMsg::Closed));
        assert_eq!(sidecar.reap(WAIT), Some(0));
        let tail = sidecar.stderr_tail();
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert!(tail.last().unwrap().starts_with("noise line 19999"), "{tail:?}");
        assert!(tail.iter().all(|line| line.contains("[REDACTED_TOKEN]") && !line.contains("abcdefghijklmnop")));
    }

    #[test]
    fn shutdown_kills_a_child_that_ignores_it() {
        let (tx, _rx) = mpsc::channel();
        let sidecar = Sidecar::spawn(&sh("exec sleep 30"), tx).unwrap();
        let started = Instant::now();
        assert_eq!(sidecar.shutdown(Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn speaks_to_the_real_node_sidecar() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let script = repo.join("cli/dist/sidecar.js");
        if !script.is_file() || Process::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node or cli/dist/sidecar.js unavailable (run make build)");
            return;
        }
        let spec = SidecarSpec {
            program: "node".into(),
            args: vec![
                script.display().to_string(),
                "-w".into(),
                repo.display().to_string(),
                "-m".into(),
                "m".into(),
                "-e".into(),
                "http://127.0.0.1:9/v1".into(),
            ],
        };
        let (tx, rx) = mpsc::channel();
        let sidecar = Sidecar::spawn(&spec, tx).unwrap();
        assert!(matches!(rx.recv_timeout(Duration::from_secs(20)).unwrap(), SidecarMsg::Event(Event::Hello { protocol: 1 })));
        match rx.recv_timeout(Duration::from_secs(20)).unwrap() {
            SidecarMsg::Event(Event::SessionState { model, busy, .. }) => {
                assert_eq!(model, "m");
                assert!(!busy);
            }
            other => panic!("expected session.state, got {other:?}"),
        }
        assert_eq!(sidecar.shutdown(Duration::from_secs(10)), Some(0));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui sidecar::`
Expected: compile errors (`Sidecar`, `SidecarSpec`, `SidecarMsg`, `STDERR_TAIL_LINES` not found).

- [ ] **Step 4: Implement (above the test module)**

```rust
//! Owns the sidecar child process. Stdout lines arrive as `SidecarMsg`s on a channel. Stderr is always drained
//! (a full pipe would block the child) into a bounded tail that is redacted on capture.
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{Command, Event, encode_command, parse_event};
use crate::redact::StderrRedactor;

pub const STDERR_TAIL_LINES: usize = 40;

#[derive(Debug)]
pub enum SidecarMsg {
    Event(Event),
    /// A stdout line that is not a protocol event. Its text is dropped: it bypassed the sidecar's redaction.
    Malformed,
    /// Stdout reached end of file; the child is exiting or has exited.
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SidecarSpec {
    pub program: String,
    pub args: Vec<String>,
}

pub struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_done: mpsc::Receiver<()>,
}

impl Sidecar {
    pub fn spawn(spec: &SidecarSpec, events: mpsc::Sender<SidecarMsg>) -> io::Result<Sidecar> {
        let mut child = Process::new(&spec.program)
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let tail = Arc::clone(&stderr_tail);
        let (done, stderr_done) = mpsc::channel();
        thread::spawn(move || {
            let mut redactor = StderrRedactor::default();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(clean) = redactor.line(&line) {
                    let mut tail = tail.lock().unwrap();
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(clean);
                }
            }
            let _ = done.send(());
        });

        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let message = parse_event(&line).map_or(SidecarMsg::Malformed, SidecarMsg::Event);
                if events.send(message).is_err() {
                    return;
                }
            }
            let _ = events.send(SidecarMsg::Closed);
        });

        Ok(Sidecar { child, stdin, stderr_tail, stderr_done })
    }

    pub fn send(&mut self, command: &Command) -> io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "sidecar stdin is closed"))?;
        stdin.write_all(encode_command(command).as_bytes())?;
        stdin.flush()
    }

    /// Waits up to `grace` for the child to exit, then kills it. Returns the exit code, or `None` when it was
    /// ended by a signal.
    pub fn reap(&mut self, grace: Duration) -> Option<i32> {
        let deadline = Instant::now() + grace;
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = self.child.kill();
                    break self.child.wait().ok();
                }
            }
        };
        let _ = self.stderr_done.recv_timeout(Duration::from_millis(500));
        status.and_then(|status| status.code())
    }

    /// Asks the sidecar to shut down, closes its stdin, and reaps it.
    pub fn shutdown(mut self, grace: Duration) -> Option<i32> {
        let _ = self.send(&Command::Shutdown);
        self.stdin = None;
        self.reap(grace)
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap().iter().cloned().collect()
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `make build` (if `cli/dist/sidecar.js` is missing), then `cargo test --manifest-path core/Cargo.toml --bin nexus-tui sidecar::`
Expected: 4 tests pass, and the real-sidecar test does **not** print the "skipping" line (run with `-- --nocapture` once to confirm). Run the filter 3 times to check for flakiness.

- [ ] **Step 6: Format and commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/sidecar.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/sidecar.rs
git commit -m "feat(tui): sidecar process with event channel and redacted stderr tail"
```

---

### Task 4: Live state reducer

**Files:**
- Create: `core/src/bin/nexus_tui/live_state.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declaration)

- [ ] **Step 1: Declare the module**

After the `mod sidecar;` declaration add:

```rust
#[path = "nexus_tui/live_state.rs"]
mod live_state;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/live_state.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::parse_event;

    fn ev(json: &str) -> Event {
        parse_event(json).unwrap()
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    fn ready() -> LiveState {
        let mut state = LiveState::new();
        state.apply(ev(r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#));
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":{"branch":"main","dirty":0},"busy":false}"#));
        state
    }

    fn type_text(state: &mut LiveState, text: &str) {
        for c in text.chars() {
            assert_eq!(state.on_key(key(KeyCode::Char(c))), None);
        }
    }

    #[test]
    fn session_state_fills_the_status_strip() {
        let state = ready();
        assert_eq!(state.link, Link::Ready);
        assert_eq!(
            state.session,
            Session {
                workspace_name: "app".into(),
                model: "m".into(),
                mode: "auto".into(),
                branch: Some("main".into()),
                dirty: 0,
                busy: false,
            }
        );
    }

    #[test]
    fn enter_submits_the_composer_with_increasing_turn_ids() {
        let mut state = ready();
        type_text(&mut state, "fix it");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit { id: "t1".into(), text: "fix it".into() }))
        );
        assert_eq!(state.composer, "");
        assert_eq!(state.transcript, vec![Entry::User("fix it".into())]);
        assert!(state.session.busy);
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert_eq!(state.session.branch, None);
        type_text(&mut state, "again");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit { id: "t2".into(), text: "again".into() }))
        );
    }

    #[test]
    fn enter_does_nothing_while_connecting_busy_or_empty() {
        let mut connecting = LiveState::new();
        type_text(&mut connecting, "x");
        assert_eq!(connecting.on_key(key(KeyCode::Enter)), None);
        let mut state = ready();
        type_text(&mut state, "   ");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        state.composer = "work".into();
        state.session.busy = true;
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "work");
    }

    #[test]
    fn pasted_blocks_and_alt_enter_keep_newlines_in_one_prompt() {
        let mut state = ready();
        state.on_paste("line one\r\nline two");
        assert_eq!(state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)), None);
        type_text(&mut state, "three");
        assert_eq!(state.on_key(key(KeyCode::Backspace)), None);
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit { id: "t1".into(), text: "line one\nline two\nthre".into() }))
        );
    }

    #[test]
    fn ctrl_c_cancels_when_busy_clears_a_draft_and_quits_when_idle() {
        let mut state = ready();
        state.session.busy = true;
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        assert_eq!(state.on_key(key(KeyCode::Esc)), Some(Action::Send(Command::Cancel)));
        state.session.busy = false;
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        type_text(&mut state, "draft");
        assert_eq!(state.on_key(ctrl('l')), None);
        assert_eq!(state.composer, "");
        type_text(&mut state, "draft");
        assert_eq!(state.on_key(ctrl('c')), None);
        assert_eq!(state.composer, "");
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Quit));
    }

    #[test]
    fn streamed_text_groups_by_turn_and_tools_pair_by_call_id() {
        let mut state = ready();
        for line in [
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Let me "}"#,
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"look."}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"a.ts"}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"b","tool":"read_file","subject":"b.ts"}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"b","tool":"read_file","success":false,"summary":"No such file","lines":1}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"const a = 1;","lines":1}"#,
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Done."}"#,
        ] {
            state.apply(ev(line));
        }
        assert_eq!(
            state.transcript,
            vec![
                Entry::Assistant { turn_id: "t1".into(), text: "Let me look.".into() },
                Entry::Tool {
                    call_id: "a".into(),
                    tool: "read_file".into(),
                    subject: "a.ts".into(),
                    status: ToolStatus::Succeeded,
                    summary: "const a = 1;".into(),
                },
                Entry::Tool {
                    call_id: "b".into(),
                    tool: "read_file".into(),
                    subject: "b.ts".into(),
                    status: ToolStatus::Failed,
                    summary: "No such file".into(),
                },
                Entry::Assistant { turn_id: "t1".into(), text: "Done.".into() },
            ]
        );
    }

    #[test]
    fn task_completed_is_left_to_the_banner() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"z","tool":"task_completed","subject":""}"#));
        state.apply(ev(r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"z","tool":"task_completed","success":true,"summary":"Completed","lines":0}"#));
        assert!(state.transcript.is_empty());
    }

    #[test]
    fn turn_result_projects_the_reported_outcome_and_closes_open_tools() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"run_command","subject":"npm test"}"#));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#));
        assert!(matches!(&state.transcript[0], Entry::Tool { status: ToolStatus::Interrupted, .. }));
        assert_eq!(
            state.transcript[1],
            Entry::Banner { heading: "TURN INTERRUPTED".into(), line: "Stopped by operator".into(), tone: Tone::Bad, summary: None }
        );
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t2","heading":"TURN COMPLETE - VERIFIED","line":"cargo test passed","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":{"summary":"Fixed the parser."}}"#));
        assert_eq!(
            state.transcript[2],
            Entry::Banner {
                heading: "TURN COMPLETE - VERIFIED".into(),
                line: "cargo test passed".into(),
                tone: Tone::Good,
                summary: Some("Fixed the parser.".into()),
            }
        );
        for (execution, outcome, tone) in [
            ("COMPLETED", "VERIFIED", Tone::Good),
            ("COMPLETED", "NOT_REQUIRED", Tone::Good),
            ("COMPLETED", "UNVERIFIED", Tone::Caution),
            ("COMPLETED", "NOT_ESTABLISHED", Tone::Caution),
            ("FAILED", "NOT_ESTABLISHED", Tone::Bad),
            ("BLOCKED", "NOT_ESTABLISHED", Tone::Bad),
            ("LIMIT_REACHED", "UNVERIFIED", Tone::Bad),
        ] {
            assert_eq!(tone_for(&serde_json::json!({"execution": execution, "outcome": outcome})), tone, "{execution}/{outcome}");
        }
    }

    #[test]
    fn errors_and_approval_requests_become_notices() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"error","id":"t9","code":"BUSY","message":"A turn is already running"}"#));
        state.apply(ev(r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#));
        assert_eq!(state.transcript[0], Entry::Notice("BUSY: A turn is already running".into()));
        assert!(matches!(&state.transcript[1], Entry::Notice(text) if text.contains("write_file x.txt") && text.contains("Esc")));
    }

    #[test]
    fn a_failed_sidecar_offers_restart_and_quit_only() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"run_command","subject":"make"}"#));
        state.session.busy = true;
        state.fail("The agent sidecar exited unexpectedly.".into(), Some(1), vec!["boom".into()]);
        assert!(!state.session.busy);
        assert!(matches!(&state.transcript[0], Entry::Tool { status: ToolStatus::Interrupted, .. }));
        assert_eq!(
            state.link,
            Link::Crashed { code: Some(1), reason: "The agent sidecar exited unexpectedly.".into(), stderr: vec!["boom".into()] }
        );
        assert_eq!(state.on_key(key(KeyCode::Char('x'))), None);
        state.on_paste("ignored");
        assert_eq!(state.composer, "");
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert!(matches!(state.link, Link::Crashed { .. }), "a late event must not revive a crashed link");
        assert_eq!(state.on_key(key(KeyCode::Char('r'))), Some(Action::Restart));
        assert_eq!(state.on_key(key(KeyCode::Char('q'))), Some(Action::Quit));
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Quit));
        state.restarted();
        assert_eq!(state.link, Link::Connecting);
        assert!(matches!(state.transcript.last(), Some(Entry::Notice(text)) if text.contains("does not remember")));
    }

    #[test]
    fn a_protocol_mismatch_fails_the_link() {
        let mut state = LiveState::new();
        state.apply(Event::Hello { protocol: 2 });
        assert!(matches!(&state.link, Link::Crashed { reason, .. } if reason.contains("protocol 2")));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_state::`
Expected: compile errors (`LiveState`, `Link`, `Entry`, ... not found).

- [ ] **Step 4: Implement (above the test module)**

```rust
//! Live session state. Pure: protocol events and keys go in, actions come out. Outcomes are projected exactly as
//! the sidecar reports them.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;

use crate::protocol::{Command, Event, PROTOCOL_VERSION};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ToolStatus {
    Running,
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tone {
    Good,
    Caution,
    Bad,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    User(String),
    Assistant { turn_id: String, text: String },
    Tool { call_id: String, tool: String, subject: String, status: ToolStatus, summary: String },
    Banner { heading: String, line: String, tone: Tone, summary: Option<String> },
    Notice(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Session {
    pub workspace_name: String,
    pub model: String,
    pub mode: String,
    pub branch: Option<String>,
    pub dirty: u64,
    pub busy: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Link {
    Connecting,
    Ready,
    Crashed { code: Option<i32>, reason: String, stderr: Vec<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Send(Command),
    Quit,
    Restart,
}

/// Tool calls whose result the turn banner already reports.
const HIDDEN_TOOLS: &[&str] = &["task_completed"];

pub struct LiveState {
    pub link: Link,
    pub session: Session,
    pub transcript: Vec<Entry>,
    pub composer: String,
    turn_seq: u64,
}

impl LiveState {
    pub fn new() -> Self {
        LiveState {
            link: Link::Connecting,
            session: Session::default(),
            transcript: Vec::new(),
            composer: String::new(),
            turn_seq: 0,
        }
    }

    pub fn apply(&mut self, event: Event) {
        if matches!(self.link, Link::Crashed { .. }) {
            return;
        }
        match event {
            Event::Hello { protocol } if protocol == PROTOCOL_VERSION => self.link = Link::Ready,
            Event::Hello { protocol } => self.fail(
                format!("The agent sidecar speaks protocol {protocol}; this view needs protocol {PROTOCOL_VERSION}."),
                None,
                Vec::new(),
            ),
            Event::SessionState { workspace_name, model, mode, git, busy } => {
                self.session = Session {
                    workspace_name,
                    model,
                    mode,
                    branch: git.as_ref().map(|git| git.branch.clone()),
                    dirty: git.map_or(0, |git| git.dirty),
                    busy,
                };
                self.link = Link::Ready;
            }
            Event::AssistantDelta { turn_id, text } => match self.transcript.last_mut() {
                Some(Entry::Assistant { turn_id: last, text: body }) if *last == turn_id => body.push_str(&text),
                _ => self.transcript.push(Entry::Assistant { turn_id, text }),
            },
            Event::ToolStart { call_id, tool, subject } => {
                if !HIDDEN_TOOLS.contains(&tool.as_str()) {
                    self.transcript.push(Entry::Tool {
                        call_id,
                        tool,
                        subject,
                        status: ToolStatus::Running,
                        summary: String::new(),
                    });
                }
            }
            Event::ToolEnd { call_id, success, summary } => {
                let open = self
                    .transcript
                    .iter_mut()
                    .rev()
                    .find(|entry| matches!(entry, Entry::Tool { call_id: id, .. } if *id == call_id));
                if let Some(Entry::Tool { status, summary: slot, .. }) = open {
                    *status = if success { ToolStatus::Succeeded } else { ToolStatus::Failed };
                    *slot = summary;
                }
            }
            Event::ApprovalRequest { tool, subject } => self.transcript.push(Entry::Notice(format!(
                "{tool} {subject} is waiting for approval, which this view cannot give yet. Press Esc to cancel the turn."
            ))),
            Event::TurnResult { heading, line, turn, model_summary } => {
                self.interrupt_running_tools();
                self.transcript.push(Entry::Banner {
                    heading,
                    line,
                    tone: tone_for(&turn),
                    summary: model_summary.map(|model| model.summary),
                });
            }
            Event::Error { code, message } => self.transcript.push(Entry::Notice(format!("{code}: {message}"))),
            Event::Unknown => {}
        }
    }

    /// The sidecar stopped or broke protocol; nothing still running can finish.
    pub fn fail(&mut self, reason: String, code: Option<i32>, stderr: Vec<String>) {
        self.interrupt_running_tools();
        self.session.busy = false;
        self.link = Link::Crashed { code, reason, stderr };
    }

    pub fn restarted(&mut self) {
        self.link = Link::Connecting;
        self.session.busy = false;
        self.transcript.push(Entry::Notice(
            "Started a new agent sidecar. It does not remember the conversation above.".to_string(),
        ));
    }

    pub fn on_paste(&mut self, text: &str) {
        if !matches!(self.link, Link::Crashed { .. }) {
            self.composer.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
        }
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if matches!(self.link, Link::Crashed { .. }) {
            return match key.code {
                KeyCode::Char('r') if !ctrl => Some(Action::Restart),
                KeyCode::Char('q') | KeyCode::Esc => Some(Action::Quit),
                KeyCode::Char('c') if ctrl => Some(Action::Quit),
                _ => None,
            };
        }
        match key.code {
            KeyCode::Char('c') if ctrl => {
                if self.session.busy {
                    Some(Action::Send(Command::Cancel))
                } else if !self.composer.is_empty() {
                    self.composer.clear();
                    None
                } else {
                    Some(Action::Quit)
                }
            }
            KeyCode::Char('l') if ctrl => {
                self.composer.clear();
                None
            }
            KeyCode::Esc if self.session.busy => Some(Action::Send(Command::Cancel)),
            KeyCode::Enter if key.modifiers.intersects(KeyModifiers::ALT | KeyModifiers::SHIFT) => {
                self.composer.push('\n');
                None
            }
            KeyCode::Enter => self.submit(),
            KeyCode::Backspace => {
                self.composer.pop();
                None
            }
            KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.composer.push(c);
                None
            }
            _ => None,
        }
    }

    fn submit(&mut self) -> Option<Action> {
        if self.link != Link::Ready || self.session.busy || self.composer.trim().is_empty() {
            return None;
        }
        self.turn_seq += 1;
        let text = std::mem::take(&mut self.composer);
        self.transcript.push(Entry::User(text.clone()));
        self.session.busy = true;
        Some(Action::Send(Command::PromptSubmit { id: format!("t{}", self.turn_seq), text }))
    }

    fn interrupt_running_tools(&mut self) {
        for entry in &mut self.transcript {
            if let Entry::Tool { status, .. } = entry
                && *status == ToolStatus::Running
            {
                *status = ToolStatus::Interrupted;
            }
        }
    }
}

/// Same projection as `TerminalUI.turnSummary` in `cli/src/ui.ts`.
pub fn tone_for(turn: &Value) -> Tone {
    match (turn["execution"].as_str(), turn["outcome"].as_str()) {
        (Some("COMPLETED"), Some("VERIFIED" | "NOT_REQUIRED")) => Tone::Good,
        (Some("COMPLETED"), _) => Tone::Caution,
        _ => Tone::Bad,
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_state::`
Expected: 11 tests pass.

- [ ] **Step 6: Format and commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_state.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/live_state.rs
git commit -m "feat(tui): live session reducer projecting sidecar events and keys"
```

---

### Task 5: Live view rendering

**Files:**
- Create: `core/src/bin/nexus_tui/live_view.rs`
- Modify: `core/Cargo.toml` (ratatui features), `core/src/bin/nexus_tui.rs` (module declaration)

- [ ] **Step 1: Enable exact wrapped-line counts and declare the module**

In `core/Cargo.toml` change the ratatui line to:

```toml
ratatui = { version = "0.30.2", default-features = false, features = ["crossterm", "unstable-rendered-line-info"] }
```

In `core/src/bin/nexus_tui.rs`, after the `mod live_state;` declaration add:

```rust
#[path = "nexus_tui/live_view.rs"]
mod live_view;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/live_view.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Event, parse_event};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    fn draw(state: &LiveState, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| render_live(frame, state)).unwrap();
        terminal.backend().to_string()
    }

    fn feed(state: &mut LiveState, lines: &[&str]) {
        for line in lines {
            state.apply(parse_event(line).unwrap());
        }
    }

    const IDLE: &str = r#"{"v":1,"type":"session.state","workspace":"/w/payments","workspace_name":"payments","model":"engineering/b0","mode":"auto","git":{"branch":"main","dirty":3},"busy":false}"#;
    const BUSY: &str = r#"{"v":1,"type":"session.state","workspace":"/w/payments","workspace_name":"payments","model":"engineering/b0","mode":"auto","git":{"branch":"main","dirty":3},"busy":true}"#;

    fn ready() -> LiveState {
        let mut state = LiveState::new();
        feed(&mut state, &[r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#, IDLE]);
        state
    }

    fn assert_shows(screen: &str, expected: &[&str]) {
        for text in expected {
            assert!(screen.contains(text), "missing {text:?} in\n{screen}");
        }
    }

    #[test]
    fn empty_session_shows_identity_status_and_composer_only() {
        let screen = draw(&ready(), 100, 24);
        assert_shows(&screen, &["NEXUS", "payments", "⎇ main", "●3", "engineering/b0", "auto", "N E X U S", TAGLINE, "enter send", "›"]);
    }

    #[test]
    fn connecting_view_says_so() {
        let screen = draw(&LiveState::new(), 80, 20);
        assert_shows(&screen, &["connecting to the agent", "starting the agent"]);
    }

    #[test]
    fn a_turn_renders_prompt_stream_tool_lines_and_a_truthful_banner() {
        let mut state = ready();
        state.composer = "fix the failing test".into();
        assert!(state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)).is_some());
        feed(&mut state, &[
            BUSY,
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Checking the parser."}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"src/parser.ts"}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"export function parse","lines":40}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"b","tool":"run_command","subject":"npm test"}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"b","tool":"run_command","success":false,"summary":"1 test failed","lines":12}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c","tool":"edit_file","subject":"src/parser.ts"}"#,
        ]);
        let busy = draw(&state, 100, 24);
        assert_shows(&busy, &[
            "› fix the failing test",
            "Checking the parser.",
            "✓ Read src/parser.ts",
            "× Run npm test — 1 test failed",
            "• Edit src/parser.ts",
            "working · esc to cancel",
        ]);
        assert!(!busy.contains("export function parse"), "tool output bodies stay out of the transcript");
        feed(&mut state, &[
            r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator during edit_file","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#,
            IDLE,
        ]);
        let done = draw(&state, 100, 24);
        assert_shows(&done, &["◌ Edit src/parser.ts — interrupted", "× TURN INTERRUPTED", "Stopped by operator during edit_file", "enter send"]);
        assert!(!done.contains("working"));
    }

    #[test]
    fn banner_glyph_follows_the_reported_outcome() {
        for (execution, outcome, glyph) in [("COMPLETED", "VERIFIED", "✓"), ("COMPLETED", "UNVERIFIED", "!"), ("FAILED", "NOT_ESTABLISHED", "×")] {
            let mut state = ready();
            let result = format!(
                r#"{{"v":1,"type":"turn.result","turn_id":"t1","heading":"HEADING {execution}","line":"detail","turn":{{"execution":"{execution}","outcome":"{outcome}"}},"model_summary":{{"summary":"Model says done."}}}}"#
            );
            feed(&mut state, &[result.as_str()]);
            let screen = draw(&state, 100, 20);
            assert_shows(&screen, &[format!("{glyph} HEADING {execution}").as_str(), "Model says done."]);
        }
    }

    #[test]
    fn long_transcripts_stay_pinned_to_the_newest_line() {
        let mut state = ready();
        let text = (1..=80).map(|n| format!("row {n}")).collect::<Vec<_>>().join("\n");
        state.apply(Event::AssistantDelta { turn_id: "t1".into(), text });
        let screen = draw(&state, 60, 16);
        assert!(screen.contains("row 80"), "{screen}");
        assert!(!screen.contains("row 50"), "{screen}");
    }

    #[test]
    fn crash_screen_shows_reason_exit_redacted_tail_and_recovery_keys() {
        let mut state = ready();
        state.fail(
            "The agent sidecar exited unexpectedly.".into(),
            Some(3),
            vec!["Error: Bearer [REDACTED_TOKEN]".into(), "at main (sidecar.js:1)".into()],
        );
        let screen = draw(&state, 100, 24);
        assert_shows(&screen, &[
            "agent stopped",
            "× The agent sidecar stopped",
            "exited unexpectedly. (exit code 3)",
            "secrets redacted",
            "at main (sidecar.js:1)",
            "r restart",
            "q quit",
            "does not remember",
        ]);
    }

    #[test]
    fn multi_line_drafts_grow_the_composer() {
        let mut state = ready();
        state.composer = "first line\nsecond line".into();
        let screen = draw(&state, 80, 20);
        assert_shows(&screen, &["› first line", "  second line"]);
    }

    #[test]
    fn tiny_terminals_get_a_size_message() {
        assert!(draw(&ready(), 30, 8).contains("40×10 minimum"));
    }

    #[test]
    fn tool_verbs_cover_core_tools_and_fall_back_to_the_name() {
        assert_eq!(tool_verb("read_file"), "Read");
        assert_eq!(tool_verb("run_command"), "Run");
        assert_eq!(tool_verb("browser_click"), "browser click");
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_view::`
Expected: compile errors (`render_live`, `TAGLINE`, `tool_verb`, `LiveState` imports not found).

- [ ] **Step 4: Implement (above the test module)**

```rust
//! Rendering for `nexus-tui --live`. Reads `LiveState` only; never decides outcomes.
use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::live_state::{Entry, Link, LiveState, Tone, ToolStatus};
use crate::{ACCENT, MUTED, SURFACE};

pub const MIN_WIDTH: u16 = 40;
pub const MIN_HEIGHT: u16 = 10;
const MAX_COMPOSER_ROWS: u16 = 6;
const TAGLINE: &str = "Understand the work. Inspect the evidence. Keep the decision yours.";

pub fn render_live(frame: &mut Frame, state: &LiveState) {
    let area = frame.area();
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        frame.render_widget(
            Paragraph::new(format!("Nexus needs a larger terminal ({MIN_WIDTH}×{MIN_HEIGHT} minimum)."))
                .style(Style::default().fg(ACCENT))
                .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let composer = composer_paragraph(state);
    let composer_rows = u16::try_from(composer.line_count(area.width))
        .unwrap_or(MAX_COMPOSER_ROWS)
        .clamp(1, MAX_COMPOSER_ROWS);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1), Constraint::Length(composer_rows + 1)])
        .split(area);
    render_status(frame, rows[0], state);
    match &state.link {
        Link::Crashed { code, reason, stderr } => render_crash(frame, rows[1], *code, reason, stderr),
        _ if state.transcript.is_empty() => render_empty(frame, rows[1]),
        _ => render_pinned(frame, rows[1], Paragraph::new(transcript_lines(state)).wrap(Wrap { trim: false })),
    }
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(composer_hint(state), Style::default().fg(MUTED)));
    let inner = block.inner(rows[2]);
    frame.render_widget(block, rows[2]);
    render_pinned(frame, inner, composer);
}

/// Renders a wrapped paragraph scrolled so its last line sits at the bottom of `area`.
fn render_pinned(frame: &mut Frame, area: Rect, paragraph: Paragraph<'_>) {
    let total = u16::try_from(paragraph.line_count(area.width)).unwrap_or(u16::MAX);
    let scroll = total.saturating_sub(area.height);
    frame.render_widget(paragraph.scroll((scroll, 0)), area);
}

fn render_status(frame: &mut Frame, area: Rect, state: &LiveState) {
    let session = &state.session;
    let muted = Style::default().fg(MUTED);
    let mut spans = vec![Span::styled(
        " NEXUS ",
        Style::default().fg(Color::Black).bg(ACCENT).add_modifier(Modifier::BOLD),
    )];
    match &state.link {
        Link::Connecting => spans.push(Span::styled("  connecting to the agent…", muted)),
        Link::Crashed { .. } => spans.push(Span::styled(
            "  agent stopped",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )),
        Link::Ready => {
            spans.push(Span::styled(
                format!("  {}", session.workspace_name),
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
            ));
            if let Some(branch) = &session.branch {
                spans.push(Span::styled(format!("  ⎇ {branch}"), muted));
                if session.dirty > 0 {
                    spans.push(Span::styled(format!(" ●{}", session.dirty), Style::default().fg(Color::Yellow)));
                }
            }
            spans.push(Span::styled(format!("  {}", session.model), muted));
            spans.push(Span::styled(format!("  {}", session.mode), muted));
            if session.busy {
                spans.push(Span::styled("  ● working · esc to cancel", Style::default().fg(ACCENT)));
            }
        }
    }
    frame.render_widget(Paragraph::new(Line::from(spans)).style(Style::default().bg(SURFACE)), area);
}

fn render_empty(frame: &mut Frame, area: Rect) {
    let paragraph = Paragraph::new(Text::from(vec![
        Line::from(Span::styled("N E X U S", Style::default().fg(ACCENT).add_modifier(Modifier::BOLD))),
        Line::default(),
        Line::from(Span::styled(TAGLINE, Style::default().fg(MUTED))),
    ]))
    .alignment(Alignment::Center)
    .wrap(Wrap { trim: true });
    let height = u16::try_from(paragraph.line_count(area.width)).unwrap_or(area.height).min(area.height);
    let top = area.y + area.height.saturating_sub(height) / 2;
    frame.render_widget(paragraph, Rect::new(area.x, top, area.width, height));
}

fn transcript_lines(state: &LiveState) -> Vec<Line<'_>> {
    let white = Style::default().fg(Color::White);
    let muted = Style::default().fg(MUTED);
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let mut lines = Vec::new();
    for entry in &state.transcript {
        match entry {
            Entry::User(text) => {
                lines.push(Line::default());
                for (index, row) in text.split('\n').enumerate() {
                    lines.push(Line::from(vec![
                        Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                        Span::styled(row, white.add_modifier(Modifier::BOLD)),
                    ]));
                }
            }
            Entry::Assistant { text, .. } => {
                lines.push(Line::default());
                lines.extend(text.split('\n').map(|row| Line::from(Span::styled(row, white))));
            }
            Entry::Tool { tool, subject, status, summary, .. } => {
                let (glyph, color) = match status {
                    ToolStatus::Running => ("•", ACCENT),
                    ToolStatus::Succeeded => ("✓", Color::Green),
                    ToolStatus::Failed => ("×", Color::Red),
                    ToolStatus::Interrupted => ("◌", Color::Yellow),
                };
                let mut spans = vec![
                    Span::styled(format!("  {glyph} "), Style::default().fg(color)),
                    Span::styled(tool_verb(tool), white),
                ];
                if !subject.is_empty() {
                    spans.push(Span::styled(format!(" {subject}"), muted));
                }
                match status {
                    ToolStatus::Failed if !summary.is_empty() => {
                        spans.push(Span::styled(format!(" — {summary}"), Style::default().fg(Color::Red)))
                    }
                    ToolStatus::Interrupted => {
                        spans.push(Span::styled(" — interrupted", Style::default().fg(Color::Yellow)))
                    }
                    _ => {}
                }
                lines.push(Line::from(spans));
            }
            Entry::Banner { heading, line, tone, summary } => {
                let (glyph, color) = match tone {
                    Tone::Good => ("✓", Color::Green),
                    Tone::Caution => ("!", Color::Yellow),
                    Tone::Bad => ("×", Color::Red),
                };
                lines.push(Line::default());
                lines.push(Line::from(vec![
                    Span::styled(format!("{glyph} {heading}"), Style::default().fg(color).add_modifier(Modifier::BOLD)),
                    Span::styled(format!("  {line}"), muted),
                ]));
                if let Some(summary) = summary {
                    lines.push(Line::from(Span::styled(summary.as_str(), muted)));
                }
            }
            Entry::Notice(text) => {
                lines.push(Line::from(Span::styled(format!("  ! {text}"), Style::default().fg(Color::Yellow))))
            }
        }
    }
    if lines.first().is_some_and(|line| line.spans.is_empty()) {
        lines.remove(0);
    }
    lines
}

fn render_crash(frame: &mut Frame, area: Rect, code: Option<i32>, reason: &str, stderr: &[String]) {
    let muted = Style::default().fg(MUTED);
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let exit = code.map_or_else(|| "no exit code".to_string(), |code| format!("exit code {code}"));
    let mut lines = vec![
        Line::from(Span::styled(
            "× The agent sidecar stopped",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(format!("{reason} ({exit})"), Style::default().fg(Color::White))),
        Line::default(),
    ];
    let footer = vec![
        Line::default(),
        Line::from(vec![Span::styled("r", key), Span::raw(" restart   "), Span::styled("q", key), Span::raw(" quit")]),
        Line::from(Span::styled("A restarted agent does not remember this conversation.", muted)),
    ];
    if !stderr.is_empty() {
        lines.push(Line::from(Span::styled("Last diagnostic lines (secrets redacted):", muted)));
        let room = usize::from(area.height).saturating_sub(lines.len() + footer.len());
        lines.extend(
            stderr[stderr.len().saturating_sub(room)..]
                .iter()
                .map(|row| Line::from(Span::styled(format!("  {row}"), muted))),
        );
    }
    lines.extend(footer);
    frame.render_widget(Paragraph::new(lines), area);
}

fn composer_paragraph(state: &LiveState) -> Paragraph<'_> {
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let mut lines: Vec<Line> = state
        .composer
        .split('\n')
        .enumerate()
        .map(|(index, text)| Line::from(vec![Span::styled(if index == 0 { "› " } else { "  " }, prompt), Span::raw(text)]))
        .collect();
    let crashed = matches!(state.link, Link::Crashed { .. });
    if let Some(last) = lines.last_mut().filter(|_| !crashed) {
        last.push_span(Span::styled("▏", Style::default().fg(ACCENT)));
    }
    Paragraph::new(lines).wrap(Wrap { trim: false })
}

fn composer_hint(state: &LiveState) -> &'static str {
    match (&state.link, state.session.busy) {
        (Link::Crashed { .. }, _) => " r restart · q quit ",
        (Link::Connecting, _) => " starting the agent… ",
        (Link::Ready, true) => " waiting for the agent ",
        (Link::Ready, false) => " enter send · alt+enter newline · ctrl-c quit ",
    }
}

/// Short operator-facing verb for a tool; unknown tools fall back to their own name.
pub fn tool_verb(tool: &str) -> String {
    let verb = match tool {
        "read_file" | "batch_read" => "Read",
        "list_dir" | "file_tree" => "List",
        "file_info" | "outline_file" | "cst_symbols" | "lsp_definition" | "lsp_hover" | "lsp_diagnostics" => "Inspect",
        "find_files" => "Find",
        "search_code" | "search_symbols" | "trigram_search" | "hybrid_search" => "Search",
        "edit_file" | "patch_file" => "Edit",
        "write_file" => "Write",
        "delete_file" => "Delete",
        "run_command" => "Run",
        "run_tests" => "Test",
        "git_status" => "Git status",
        "git_diff" => "Diff",
        "git_log" => "Git log",
        "fetch_web" => "Fetch",
        "search_web" => "Web search",
        "update_plan" => "Plan",
        "spawn_subagent" => "Delegate",
        "manage_knowledge" => "Remember",
        "activate_skill" => "Skill",
        _ => return tool.replace('_', " "),
    };
    verb.to_string()
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_view::`
Expected: 9 tests pass. If a `TestBackend` string assertion fails only because of how a wide or ambiguous-width glyph is laid out, print the screen, confirm the glyph renders, and adjust that single assertion's expected text to what the buffer actually shows; do not change rendering semantics to satisfy a test.

- [ ] **Step 6: Format and commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_view.rs
git add core/Cargo.toml core/Cargo.lock core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): live view with status strip, streaming transcript, tool lines and turn banner"
```

(`core/Cargo.lock` only if it changed.)

---

### Task 6: Live app loop, `--live` flag, `harness --live`

**Files:**
- Create: `core/src/bin/nexus_tui/live.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declaration and `main`), `harness.sh`

- [ ] **Step 1: Declare the module**

After the `mod live_view;` declaration add:

```rust
#[path = "nexus_tui/live.rs"]
mod live;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/live.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_state::Entry;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::time::Instant;

    const HELLO: &str = r#"echo '{"v":1,"type":"hello","protocol":1,"pid":1}'; echo '{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":false}'"#;

    fn fake_sidecar(script: &str) -> SidecarSpec {
        SidecarSpec { program: "sh".into(), args: vec!["-c".into(), script.into()] }
    }

    fn pump_until(app: &mut LiveApp, done: impl Fn(&LiveState) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(&app.state) {
            assert!(Instant::now() < deadline, "timed out; link {:?}, transcript {:?}", app.state.link, app.state.transcript);
            app.pump();
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn drives_a_full_turn_and_quits_cleanly() {
        let script = format!(
            r#"{HELLO}
read prompt
case "$prompt" in *'"type":"prompt.submit"'*) ;; *) exit 9;; esac
case "$prompt" in *'"text":"hi"'*) ;; *) exit 9;; esac
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":true}}'
echo '{{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Hello from the fake agent."}}'
echo '{{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - NO CHANGES TO VERIFY","line":"No files changed","turn":{{"execution":"COMPLETED","outcome":"NOT_REQUIRED"}},"model_summary":null}}'
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":false}}'
read shutdown
case "$shutdown" in *'"type":"shutdown"'*) exit 0;; *) exit 8;; esac"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| s.link == Link::Ready && s.session.model == "m");
        for code in [KeyCode::Char('h'), KeyCode::Char('i'), KeyCode::Enter] {
            if let Some(action) = app.state.on_key(KeyEvent::new(code, KeyModifiers::NONE)) {
                assert!(app.handle(action));
            }
        }
        pump_until(&mut app, |s| !s.session.busy && s.transcript.iter().any(|e| matches!(e, Entry::Banner { .. })));
        assert!(app.state.transcript.iter().any(|e| matches!(e, Entry::Assistant { text, .. } if text == "Hello from the fake agent.")));
        assert_eq!(app.state.link, Link::Ready, "the fake exits 9 on an unexpected prompt, which would crash the link");
        let quit = app.state.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(quit, Some(Action::Quit));
        assert!(!app.handle(quit.unwrap()));
    }

    #[test]
    fn an_exiting_sidecar_becomes_a_crash_screen_and_restart_starts_a_new_one() {
        let script = format!("{HELLO}; echo 'fatal: gateway exploded' >&2; exit 4");
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| matches!(s.link, Link::Crashed { .. }));
        let Link::Crashed { code, stderr, reason } = app.state.link.clone() else { unreachable!() };
        assert_eq!(code, Some(4));
        assert_eq!(stderr, vec!["fatal: gateway exploded".to_string()]);
        assert!(reason.contains("exited unexpectedly"));
        assert!(app.handle(Action::Restart));
        assert_eq!(app.state.link, Link::Connecting);
        pump_until(&mut app, |s| matches!(s.link, Link::Crashed { .. }));
        assert!(app.state.transcript.iter().any(|e| matches!(e, Entry::Notice(text) if text.contains("does not remember"))));
    }

    #[test]
    fn non_protocol_output_stops_the_sidecar_promptly() {
        let script = format!("{HELLO}; echo 'Compiling project...'; exec sleep 30");
        let started = Instant::now();
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| matches!(&s.link, Link::Crashed { reason, .. } if reason.contains("not part of the protocol")));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_missing_program_is_reported_not_panicked() {
        let app = LiveApp::start(SidecarSpec { program: "/nonexistent/node".into(), args: vec![] });
        assert!(matches!(&app.state.link, Link::Crashed { reason, .. } if reason.contains("Could not start")));
    }

    #[test]
    fn resolve_spec_prefers_flags_then_env_then_the_build_layout() {
        let root = std::env::temp_dir().join(format!("nexus-live-spec-{}", std::process::id()));
        let dist = root.join("cli/dist");
        std::fs::create_dir_all(&dist).unwrap();
        let bundled = dist.join("sidecar.js");
        std::fs::write(&bundled, "").unwrap();
        let custom = root.join("custom.js");
        std::fs::write(&custom, "").unwrap();
        let exe = root.join("core/target/release/nexus-tui");

        let from_layout = resolve_spec(vec!["--".into(), "-m".into(), "deep".into()], None, None, Some(exe.clone())).unwrap();
        assert_eq!(
            from_layout,
            SidecarSpec { program: "node".into(), args: vec![bundled.display().to_string(), "-m".into(), "deep".into()] }
        );
        let from_env = resolve_spec(vec![], Some(custom.display().to_string()), Some("/opt/node".into()), Some(exe.clone())).unwrap();
        assert_eq!(from_env, SidecarSpec { program: "/opt/node".into(), args: vec![custom.display().to_string()] });
        let from_flags = resolve_spec(
            vec!["--sidecar".into(), bundled.display().to_string(), "--node".into(), "nodejs".into()],
            Some(custom.display().to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(from_flags, SidecarSpec { program: "nodejs".into(), args: vec![bundled.display().to_string()] });
        assert!(resolve_spec(vec![], Some(root.join("missing.js").display().to_string()), None, None).unwrap_err().contains("make build"));
        assert!(resolve_spec(vec!["--bogus".into()], None, None, Some(exe)).unwrap_err().contains("unknown option --bogus"));
        assert!(resolve_spec(vec!["--node".into()], None, None, None).unwrap_err().contains("usage"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui live::`
Expected: compile errors (`LiveApp`, `resolve_spec`, ... not found).

- [ ] **Step 4: Implement (above the test module)**

```rust
//! `nexus-tui --live`: runs the agent sidecar and renders its protocol events in the terminal.
use std::{io, path::PathBuf, sync::mpsc, time::Duration};

use crossterm::{
    event::{self, DisableBracketedPaste, EnableBracketedPaste, Event as TermEvent, KeyEventKind},
    execute,
};

use crate::live_state::{Action, Link, LiveState};
use crate::live_view::render_live;
use crate::sidecar::{Sidecar, SidecarMsg, SidecarSpec};

const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const EXIT_GRACE: Duration = Duration::from_secs(2);
const INPUT_POLL: Duration = Duration::from_millis(30);

pub const LIVE_USAGE: &str = "usage: nexus-tui --live [--sidecar PATH] [--node BIN] [-- SIDECAR_ARGS...]";

/// Resolves the sidecar command line. Precedence: flags, then `NEXUS_SIDECAR` / `NEXUS_NODE`, then the
/// `cli/dist/sidecar.js` of the checkout whose `core/target/<profile>/` holds this binary.
pub fn resolve_spec(
    args: Vec<String>,
    env_sidecar: Option<String>,
    env_node: Option<String>,
    exe: Option<PathBuf>,
) -> Result<SidecarSpec, String> {
    let mut sidecar = env_sidecar.map(PathBuf::from);
    let mut node = env_node.unwrap_or_else(|| "node".to_string());
    let mut passthrough = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--sidecar" => sidecar = Some(PathBuf::from(args.next().ok_or(LIVE_USAGE)?)),
            "--node" => node = args.next().ok_or(LIVE_USAGE)?,
            "--" => {
                passthrough.extend(args.by_ref());
                break;
            }
            other => return Err(format!("unknown option {other}\n{LIVE_USAGE}")),
        }
    }
    let sidecar = sidecar
        .or_else(|| exe.and_then(|exe| exe.ancestors().nth(4).map(|root| root.join("cli/dist/sidecar.js"))))
        .ok_or("cannot locate cli/dist/sidecar.js; pass --sidecar PATH")?;
    if !sidecar.is_file() {
        return Err(format!(
            "sidecar not found at {}; run `make build` or pass --sidecar PATH",
            sidecar.display()
        ));
    }
    let mut spec_args = vec![sidecar.display().to_string()];
    spec_args.extend(passthrough);
    Ok(SidecarSpec { program: node, args: spec_args })
}

/// The live session without the terminal: sidecar lifecycle plus state. The event loop feeds it keys.
pub struct LiveApp {
    pub state: LiveState,
    spec: SidecarSpec,
    sidecar: Option<Sidecar>,
    messages: mpsc::Receiver<SidecarMsg>,
}

impl LiveApp {
    pub fn start(spec: SidecarSpec) -> LiveApp {
        let (_, messages) = mpsc::channel();
        let mut app = LiveApp { state: LiveState::new(), spec, sidecar: None, messages };
        app.spawn();
        app
    }

    fn spawn(&mut self) {
        let (sender, messages) = mpsc::channel();
        self.messages = messages;
        match Sidecar::spawn(&self.spec, sender) {
            Ok(sidecar) => self.sidecar = Some(sidecar),
            Err(err) => self.state.fail(
                format!("Could not start the agent sidecar with {}: {err}", self.spec.program),
                None,
                Vec::new(),
            ),
        }
    }

    /// Applies every pending sidecar message. Returns true when the screen needs a redraw.
    pub fn pump(&mut self) -> bool {
        let mut changed = false;
        while self.sidecar.is_some() {
            let Ok(message) = self.messages.try_recv() else { break };
            changed = true;
            match message {
                SidecarMsg::Event(event) => {
                    self.state.apply(event);
                    if matches!(self.state.link, Link::Crashed { .. })
                        && let Some(mut sidecar) = self.sidecar.take()
                    {
                        sidecar.reap(Duration::ZERO);
                    }
                }
                SidecarMsg::Malformed => {
                    self.stop("The agent sidecar wrote output that is not part of the protocol.", Duration::ZERO)
                }
                SidecarMsg::Closed => self.stop("The agent sidecar exited unexpectedly.", EXIT_GRACE),
            }
        }
        changed
    }

    fn stop(&mut self, reason: &str, grace: Duration) {
        if let Some(mut sidecar) = self.sidecar.take() {
            let code = sidecar.reap(grace);
            self.state.fail(reason.to_string(), code, sidecar.stderr_tail());
        }
    }

    /// Carries out an operator action. Returns false when the app should exit.
    pub fn handle(&mut self, action: Action) -> bool {
        match action {
            Action::Send(command) => {
                if let Some(sidecar) = self.sidecar.as_mut() {
                    // A failed write means the child is gone; its Closed message reports that.
                    let _ = sidecar.send(&command);
                }
                true
            }
            Action::Quit => {
                if let Some(sidecar) = self.sidecar.take() {
                    sidecar.shutdown(SHUTDOWN_GRACE);
                }
                false
            }
            Action::Restart => {
                if let Some(mut sidecar) = self.sidecar.take() {
                    sidecar.reap(Duration::ZERO);
                }
                self.state.restarted();
                self.spawn();
                true
            }
        }
    }
}

pub fn run_live(spec: SidecarSpec) -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal = ratatui::init();
    let _ = execute!(io::stdout(), EnableBracketedPaste);
    let result = event_loop(&mut terminal, LiveApp::start(spec));
    let _ = execute!(io::stdout(), DisableBracketedPaste);
    ratatui::restore();
    result
}

fn event_loop(terminal: &mut ratatui::DefaultTerminal, mut app: LiveApp) -> Result<(), Box<dyn std::error::Error>> {
    let mut redraw = true;
    loop {
        redraw |= app.pump();
        if redraw {
            terminal.draw(|frame| render_live(frame, &app.state))?;
            redraw = false;
        }
        if !event::poll(INPUT_POLL)? {
            continue;
        }
        let action = match event::read()? {
            TermEvent::Key(key) if key.kind == KeyEventKind::Press => app.state.on_key(key),
            TermEvent::Paste(text) => {
                app.state.on_paste(&text);
                None
            }
            TermEvent::Resize(_, _) => None,
            _ => continue,
        };
        redraw = true;
        if let Some(action) = action
            && !app.handle(action)
        {
            return Ok(());
        }
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path core/Cargo.toml --bin nexus-tui live::`
Expected: 5 tests pass. Run it 3 times to check for flakiness.

- [ ] **Step 6: Wire `--live` into `main`**

In `core/src/bin/nexus_tui.rs` replace the start of `main` (from `let mut args` through `let plain = first == "--plain";`) with:

```rust
    let mut args = env::args_os().skip(1);
    let first = args.next().ok_or(
        "usage: nexus-tui [--plain] SNAPSHOT.json\n       nexus-tui --live [--sidecar PATH] [--node BIN] [-- SIDECAR_ARGS...]",
    )?;
    if first == "--live" {
        let rest = args.map(|arg| arg.to_string_lossy().into_owned()).collect();
        let spec = live::resolve_spec(
            rest,
            env::var("NEXUS_SIDECAR").ok(),
            env::var("NEXUS_NODE").ok(),
            env::current_exe().ok(),
        )?;
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err("interactive Nexus TUI requires a terminal".into());
        }
        return live::run_live(spec);
    }
    let plain = first == "--plain";
```

- [ ] **Step 7: Add `harness --live`**

In `harness.sh`, insert this branch directly after the `if [[ $# -eq 0 ]]; then ... ` block's `exec` line (before the `elif [[ "$1" == "check" ]] ...` line):

```bash
elif [[ "$1" == "--live" ]]; then
  shift
  TUI_BIN="$SCRIPT_DIR/core/target/release/nexus-tui"
  if [[ ! -x "$TUI_BIN" ]]; then
    echo "nexus-tui is not built. Run 'make build' in $SCRIPT_DIR first." >&2
    exit 1
  fi
  exec "$TUI_BIN" --live --sidecar "$SCRIPT_DIR/cli/dist/sidecar.js" --node "$NODE_EXEC" -- "$@"
```

- [ ] **Step 8: Verify the binary and launcher**

Run:

```bash
cargo build --release --manifest-path core/Cargo.toml --bin nexus-tui 2>&1 | grep -E '^(warning|error)' ; echo "build done"
./core/target/release/nexus-tui --live --bogus; echo "exit=$?"
./core/target/release/nexus-tui --live --sidecar /nonexistent.js; echo "exit=$?"
./harness.sh --live < /dev/null; echo "exit=$?"
cargo test --manifest-path core/Cargo.toml --bin nexus-tui
```

Expected: no `warning`/`error` lines from the build; `unknown option --bogus` plus usage and `exit=1`; `sidecar not found at /nonexistent.js` and `exit=1`; `interactive Nexus TUI requires a terminal` and `exit=1`; all nexus-tui tests pass (4 existing + 37 new = 41).

- [ ] **Step 9: Format and commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live.rs core/src/bin/nexus_tui.rs
git diff --stat core/src/bin/nexus_tui.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/live.rs harness.sh
git commit -m "feat(tui): nexus-tui --live drives the sidecar; harness --live launches it"
```

If `rustfmt` reformats pre-existing parts of `nexus_tui.rs` beyond the lines this plan touches, revert those hunks (`git checkout -p core/src/bin/nexus_tui.rs`) so the diff stays limited to the module declarations and `main`.

---

### Task 7: Full verification and PTY smoke

**Files:** none expected (fix-ups only if a check fails)

- [ ] **Step 1: Build, lint and test everything**

```bash
make build
cargo clippy --manifest-path core/Cargo.toml --bin nexus-tui --all-targets 2>&1 | grep -E 'nexus_tui' | head -40
cargo test --manifest-path core/Cargo.toml
npm --prefix cli test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
```

Expected: build succeeds; no clippy warnings that point into `core/src/bin/nexus_tui.rs` or `core/src/bin/nexus_tui/` (pre-existing warnings elsewhere are out of scope; fix any in the new files and commit `fix(tui): clippy findings in live view`); all cargo tests pass; CLI suite shows only the 2 known failures.

- [ ] **Step 2: PTY smoke — startup, empty state, quit, no orphan**

First write the PTY driver used by this step and the next (a scratch file, not committed):

```bash
cat > /tmp/nexus_live_pty.py <<'PY'
"""Drives `harness --live` in a pseudo-terminal. Every read has a timeout, so a stuck TUI fails instead of hanging."""
import fcntl, os, pty, re, select, struct, termios, time

class Live:
    def __init__(self, repo, args, rows=30, cols=100):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.execv(f"{repo}/harness.sh", [f"{repo}/harness.sh", "--live", *args])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.out = b""

    def read_until(self, marker, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline and marker not in self.out:
            if select.select([self.fd], [], [], 0.25)[0]:
                try:
                    self.out += os.read(self.fd, 65536)
                except OSError:
                    break
        return marker in self.out

    def text(self):
        return re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]", b" ", self.out).decode("utf-8", "replace")

    def send(self, data):
        os.write(self.fd, data)

    def wait_exit(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if select.select([self.fd], [], [], 0.1)[0]:
                try:
                    self.out += os.read(self.fd, 65536)
                except OSError:
                    pass
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
        os.kill(self.pid, 9)
        return "timeout (killed)"
PY
```

Then run:

```bash
PYTHONPATH=/tmp python3 - <<'PY'
import os, subprocess, time
from nexus_live_pty import Live
repo = os.getcwd()
live = Live(repo, ["-m", "m", "-e", "http://127.0.0.1:9/v1"])
print("saw identity:", live.read_until(b"Understand", 20) and b"NEXUS" in live.out)
live.send(b"\x03")
print("exit status", live.wait_exit(10))
time.sleep(0.5)
left = subprocess.run(["pgrep", "-f", f"{repo}/cli/dist/sidecar.js"], capture_output=True, text=True).stdout.strip()
print("orphan sidecars:", left or "none")
PY
```

Expected: `saw identity: True`, `exit status 0`, and `orphan sidecars: none`.

- [ ] **Step 3: PTY smoke — one real turn against the local gateway**

Skip with a note if `curl -sf http://127.0.0.1:18010/v1/models > /dev/null` fails.

```bash
SMOKE=$(mktemp -d /tmp/nexus-live-smoke-XXXX) && cd "$SMOKE" && printf 'hello\n' > notes.txt && git init -q && git add . && git -c user.name=t -c user.email=t@t.invalid commit -qm init && cd - > /dev/null
SMOKE="$SMOKE" PYTHONPATH=/tmp python3 - <<'PY'
import os
from nexus_live_pty import Live
live = Live(os.getcwd(), ["-w", os.environ["SMOKE"]], rows=32, cols=110)
print("ready:", live.read_until(b"send", 30))
live.send(b"List the files in this workspace, then stop. Do not modify anything.")
live.send(b"\r")
print("saw banner:", live.read_until(b"TURN", 240))
text = live.text()
print("saw tool line:", any(verb in text for verb in ("List", "Read", "Run", "Search")))
live.send(b"\x03")
print("exit status", live.wait_exit(15))
PY
rm -rf "$SMOKE" /tmp/nexus_live_pty.py
```

Expected: `ready: True`, `saw banner: True`, `exit status 0`, and normally `saw tool line: True`. Record the printed lines in the task report. This is a smoke check, not a committed test; a model that answers without tools is acceptable as long as the banner appears.

- [ ] **Step 4: Commit only if Step 1 required fixes**

```bash
git status --short
```

Expected: clean, or only the clippy fix-up commit from Step 1.

---

## Not in this plan (next plans)

- **Phase 3:** approval modal (diff preview, approve / deny / always), slash commands with `slash.result`, transcript focus and scrollback (Tab, PageUp/PageDown), keyboard-enhancement Shift+Enter detection, `harness` default entry and `--repl`, session persistence from the sidecar, sidecar `hello` before model auto-detection (with a timeout).
- **Phase 4:** themes in live mode, diff presentation, empty-state polish, README and first-run docs, PTY captures against the look-and-feel checklist.
- **Tracked defects outside this plan:** the agent's own inference-error line prints raw gateway bodies to stderr (redacted here on capture, but the REPL still prints them); cancel during approval is labelled as tool settling by the agent; per-delta redaction can miss a secret split across deltas.
