//! Rendering for `nexus-tui --live`. Reads `LiveState` only; never decides outcomes.
use std::borrow::Cow;

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
            Paragraph::new(format!(
                "Nexus needs a larger terminal ({MIN_WIDTH}×{MIN_HEIGHT} minimum)."
            ))
            .style(Style::default().fg(ACCENT))
            .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let composer = composer_paragraph(state);
    let composer_rows = if matches!(state.link, Link::Crashed { .. }) {
        1
    } else {
        u16::try_from(composer.line_count(area.width))
            .unwrap_or(MAX_COMPOSER_ROWS)
            .clamp(1, MAX_COMPOSER_ROWS)
    };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(composer_rows + 1),
        ])
        .split(area);
    render_status(frame, rows[0], state);
    match &state.link {
        Link::Crashed {
            code,
            reason,
            stderr,
        } => render_crash(frame, rows[1], *code, reason, stderr),
        _ if state.transcript.is_empty() => render_empty(frame, rows[1]),
        _ => render_transcript(frame, rows[1], &state.transcript),
    }
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(
            composer_hint(state),
            Style::default().fg(MUTED),
        ));
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

/// `hello` arrived but the first `session.state` has not, so there is no workspace to show yet.
fn connecting(state: &LiveState) -> bool {
    match state.link {
        Link::Connecting => true,
        Link::Ready => state.session.workspace_name.is_empty(),
        Link::Crashed { .. } => false,
    }
}

fn render_status(frame: &mut Frame, area: Rect, state: &LiveState) {
    let session = &state.session;
    let muted = Style::default().fg(MUTED);
    let surface = Style::default().bg(SURFACE);
    let mut spans = vec![Span::styled(
        " NEXUS ",
        Style::default()
            .fg(Color::Black)
            .bg(ACCENT)
            .add_modifier(Modifier::BOLD),
    )];
    let busy = Span::styled(" ● working · esc to cancel ", Style::default().fg(ACCENT));
    let busy_width = if session.busy && !connecting(state) {
        u16::try_from(busy.width()).unwrap_or(area.width)
    } else {
        0
    };
    match &state.link {
        _ if connecting(state) => spans.push(Span::styled("  connecting to the agent…", muted)),
        Link::Crashed { .. } => spans.push(Span::styled(
            "  agent stopped",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )),
        _ => {
            spans.push(Span::styled(
                format!("  {}", session.workspace_name),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ));
            if let Some(branch) = &session.branch {
                spans.push(Span::styled(format!("  ⎇ {branch}"), muted));
                if session.dirty > 0 {
                    spans.push(Span::styled(
                        format!(" ●{}", session.dirty),
                        Style::default().fg(Color::Yellow),
                    ));
                }
            }
            spans.push(Span::styled(format!("  {}", session.model), muted));
            spans.push(Span::styled(format!("  {}", session.mode), muted));
        }
    }
    let [identity, activity] =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(busy_width)]).areas(area);
    frame.render_widget(Paragraph::new(Line::from(spans)).style(surface), identity);
    if busy_width > 0 {
        frame.render_widget(Paragraph::new(Line::from(busy)).style(surface), activity);
    }
}

fn render_empty(frame: &mut Frame, area: Rect) {
    let paragraph = Paragraph::new(Text::from(vec![
        Line::from(Span::styled(
            "N E X U S",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )),
        Line::default(),
        Line::from(Span::styled(TAGLINE, Style::default().fg(MUTED))),
    ]))
    .alignment(Alignment::Center)
    .wrap(Wrap { trim: true });
    let height = u16::try_from(paragraph.line_count(area.width))
        .unwrap_or(area.height)
        .min(area.height);
    let top = area.y + area.height.saturating_sub(height) / 2;
    frame.render_widget(paragraph, Rect::new(area.x, top, area.width, height));
}

/// Renders only the newest entries that fill `area`, bottom-aligned once they overflow it. Wrapping is
/// per line, so the rows of the selected lines equal the bottom rows of the whole transcript.
fn render_transcript(frame: &mut Frame, area: Rect, transcript: &[Entry]) {
    let height = usize::from(area.height);
    let mut tail = Vec::new();
    let mut total = 0;
    'entries: for (index, entry) in transcript.iter().enumerate().rev() {
        for line in entry_lines(entry, index == 0).into_iter().rev() {
            total += wrapped_rows(&line, area.width);
            tail.push(line);
            if total >= height {
                break 'entries;
            }
        }
    }
    tail.reverse();
    let scroll = u16::try_from(total.saturating_sub(height)).unwrap_or(u16::MAX);
    frame.render_widget(
        Paragraph::new(tail)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        area,
    );
}

fn wrapped_rows(line: &Line<'_>, width: u16) -> usize {
    Paragraph::new(line.clone())
        .wrap(Wrap { trim: false })
        .line_count(width)
}

fn expand_tabs(row: &str) -> Cow<'_, str> {
    if row.contains('\t') {
        Cow::Owned(row.replace('\t', "    "))
    } else {
        Cow::Borrowed(row)
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lines for one transcript entry. Entries that open with a blank separator drop it when they come first.
fn entry_lines(entry: &Entry, first: bool) -> Vec<Line<'_>> {
    let white = Style::default().fg(Color::White);
    let muted = Style::default().fg(MUTED);
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let mut lines = Vec::new();
    match entry {
        Entry::User(text) => {
            lines.push(Line::default());
            for (index, row) in text.split('\n').enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                    Span::styled(expand_tabs(row), white.add_modifier(Modifier::BOLD)),
                ]));
            }
        }
        Entry::Assistant { text, .. } => {
            lines.push(Line::default());
            lines.extend(
                text.split('\n')
                    .map(|row| Line::from(Span::styled(expand_tabs(row), white))),
            );
        }
        Entry::Tool {
            tool,
            subject,
            status,
            summary,
            ..
        } => {
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
                ToolStatus::Failed if !summary.is_empty() => spans.push(Span::styled(
                    format!(" — {summary}"),
                    Style::default().fg(Color::Red),
                )),
                ToolStatus::Interrupted => spans.push(Span::styled(
                    " — interrupted",
                    Style::default().fg(Color::Yellow),
                )),
                _ => {}
            }
            lines.push(Line::from(spans));
        }
        Entry::Banner {
            heading,
            line,
            tone,
            failure,
            summary,
        } => {
            let (glyph, color) = match tone {
                Tone::Good => ("✓", Color::Green),
                Tone::Caution => ("!", Color::Yellow),
                Tone::Bad => ("×", Color::Red),
            };
            lines.push(Line::default());
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{glyph} {heading}"),
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("  {}", one_line(line)), muted),
            ]));
            if let Some(failure) = failure {
                lines.extend(failure.split('\n').map(|row| {
                    Line::from(Span::styled(
                        expand_tabs(row),
                        Style::default().fg(Color::Red),
                    ))
                }));
            }
            if let Some(summary) = summary {
                lines.push(Line::default());
                lines.push(Line::from(Span::styled(
                    "Model-reported summary (not independently verified):",
                    white.add_modifier(Modifier::BOLD),
                )));
                lines.extend(
                    summary
                        .split('\n')
                        .map(|row| Line::from(Span::styled(expand_tabs(row), white))),
                );
            }
        }
        Entry::Notice(text) => lines.push(Line::from(Span::styled(
            format!("  ! {}", one_line(text)),
            Style::default().fg(Color::Yellow),
        ))),
    }
    if first && lines.first().is_some_and(|line| line.spans.is_empty()) {
        lines.remove(0);
    }
    lines
}

fn render_crash(frame: &mut Frame, area: Rect, code: Option<i32>, reason: &str, stderr: &[String]) {
    let muted = Style::default().fg(MUTED);
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let exit = code.map_or_else(
        || "no exit code".to_string(),
        |code| format!("exit code {code}"),
    );
    let rows = |line: &Line<'_>| wrapped_rows(line, area.width);
    let heading = Line::from(Span::styled(
        "× The agent sidecar stopped",
        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
    ));
    let detail = Line::from(Span::styled(
        format!("{} ({exit})", one_line(reason)),
        Style::default().fg(Color::White),
    ));
    let recovery = [
        Line::from(vec![
            Span::styled("r", key),
            Span::raw(" restart   "),
            Span::styled("q", key),
            Span::raw(" quit"),
        ]),
        Line::from(Span::styled(
            "A restarted agent does not remember this conversation.",
            muted,
        )),
    ];
    // Priority when rows are short: reason and exit code, recovery keys, heading, spacing, then stderr.
    let mut room = usize::from(area.height)
        .saturating_sub(rows(&detail) + recovery.iter().map(|line| rows(line)).sum::<usize>());
    let mut lines = Vec::new();
    if room > 0 {
        lines.push(heading);
        room -= 1;
    }
    lines.push(detail);
    let gap = room > 0;
    if gap {
        room -= 1;
    }
    let label = Line::from(Span::styled(
        "Last diagnostic lines (secrets redacted):",
        muted,
    ));
    let overhead = 1 + rows(&label);
    if room > overhead {
        room -= overhead;
        let mut tail = Vec::new();
        for row in stderr.iter().rev() {
            let line = Line::from(Span::styled(format!("  {row}"), muted));
            let need = rows(&line);
            if need > room {
                break;
            }
            room -= need;
            tail.push(line);
        }
        if !tail.is_empty() {
            lines.push(Line::default());
            lines.push(label);
            lines.extend(tail.into_iter().rev());
        }
    }
    if gap {
        lines.push(Line::default());
    }
    lines.extend(recovery);
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn composer_paragraph(state: &LiveState) -> Paragraph<'_> {
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let mut lines: Vec<Line> = state
        .composer
        .split('\n')
        .enumerate()
        .map(|(index, text)| {
            Line::from(vec![
                Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                Span::raw(expand_tabs(text)),
            ])
        })
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
        _ if connecting(state) => " starting the agent… ",
        (_, true) if state.cancel_requested() => " cancelling… ctrl-c again to quit ",
        (_, true) => " waiting for the agent ",
        (_, false) => " enter send · alt+enter newline · ctrl-c quit ",
    }
}

/// Short operator-facing verb for a tool; unknown tools fall back to their own name.
pub fn tool_verb(tool: &str) -> String {
    let verb = match tool {
        "read_file" | "batch_read" => "Read",
        "list_dir" | "file_tree" => "List",
        "file_info" | "outline_file" | "cst_symbols" | "lsp_definition" | "lsp_hover"
        | "lsp_diagnostics" => "Inspect",
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
        feed(
            &mut state,
            &[r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#, IDLE],
        );
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
        assert_shows(
            &screen,
            &[
                "NEXUS",
                "payments",
                "⎇ main",
                "●3",
                "engineering/b0",
                "auto",
                "N E X U S",
                TAGLINE,
                "enter send",
                "›",
            ],
        );
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
        assert!(
            state
                .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                .is_some()
        );
        feed(
            &mut state,
            &[
                BUSY,
                r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Checking the parser."}"#,
                r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"src/parser.ts"}"#,
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"export function parse","lines":40}"#,
                r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"b","tool":"run_command","subject":"npm test"}"#,
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"b","tool":"run_command","success":false,"summary":"1 test failed","lines":12}"#,
                r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c","tool":"edit_file","subject":"src/parser.ts"}"#,
            ],
        );
        let busy = draw(&state, 100, 24);
        assert_shows(
            &busy,
            &[
                "› fix the failing test",
                "Checking the parser.",
                "✓ Read src/parser.ts",
                "× Run npm test — 1 test failed",
                "• Edit src/parser.ts",
                "working · esc to cancel",
            ],
        );
        assert!(
            !busy.contains("export function parse"),
            "tool output bodies stay out of the transcript"
        );
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator during edit_file","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#,
                IDLE,
            ],
        );
        let done = draw(&state, 100, 24);
        assert_shows(
            &done,
            &[
                "◌ Edit src/parser.ts — interrupted",
                "× TURN INTERRUPTED",
                "Stopped by operator during edit_file",
                "enter send",
            ],
        );
        assert!(!done.contains("working"));
    }

    #[test]
    fn the_hint_offers_a_force_quit_after_the_first_ctrl_c() {
        let mut state = ready();
        feed(&mut state, &[BUSY]);
        assert_shows(&draw(&state, 40, 12), &["waiting for the agent"]);
        assert!(
            state
                .on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL))
                .is_some()
        );
        assert_shows(&draw(&state, 40, 12), &["cancelling… ctrl-c again to quit"]);
    }

    #[test]
    fn banner_glyph_follows_the_reported_outcome() {
        for (execution, outcome, glyph) in [
            ("COMPLETED", "VERIFIED", "✓"),
            ("COMPLETED", "UNVERIFIED", "!"),
            ("FAILED", "NOT_ESTABLISHED", "×"),
        ] {
            let mut state = ready();
            let result = format!(
                r#"{{"v":1,"type":"turn.result","turn_id":"t1","heading":"HEADING {execution}","line":"detail","turn":{{"execution":"{execution}","outcome":"{outcome}"}},"model_summary":{{"summary":"Model says done."}}}}"#
            );
            feed(&mut state, &[result.as_str()]);
            let screen = draw(&state, 100, 20);
            assert_shows(
                &screen,
                &[
                    format!("{glyph} HEADING {execution}").as_str(),
                    "Model says done.",
                ],
            );
        }
    }

    #[test]
    fn long_transcripts_stay_pinned_to_the_newest_line() {
        let mut state = ready();
        let text = (1..=80)
            .map(|n| format!("row {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        state.apply(Event::AssistantDelta {
            turn_id: "t1".into(),
            text,
        });
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
            vec![
                "Error: Bearer [REDACTED_TOKEN]".into(),
                "at main (sidecar.js:1)".into(),
            ],
        );
        let screen = draw(&state, 100, 24);
        assert_shows(
            &screen,
            &[
                "agent stopped",
                "× The agent sidecar stopped",
                "exited unexpectedly. (exit code 3)",
                "secrets redacted",
                "at main (sidecar.js:1)",
                "r restart",
                "q quit",
                "does not remember",
            ],
        );
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

    fn rows(screen: &str) -> Vec<String> {
        screen
            .lines()
            .map(|row| row.trim_matches('"').trim_end().to_string())
            .collect()
    }

    /// Screen text with row breaks and runs of spaces collapsed, for asserting on wrapped prose.
    fn flat(screen: &str) -> String {
        rows(screen)
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn turn_result(
        execution: &str,
        outcome: &str,
        line: &str,
        extra: &str,
        summary: &str,
    ) -> String {
        format!(
            r#"{{"v":1,"type":"turn.result","turn_id":"t1","heading":"HEADING","line":{line:?},"turn":{{"execution":"{execution}","outcome":"{outcome}"{extra}}},"model_summary":{summary}}}"#
        )
    }

    #[test]
    fn the_model_summary_is_labelled_unverified_and_split_into_rows() {
        let mut state = ready();
        let result = turn_result(
            "COMPLETED",
            "VERIFIED",
            "cargo test passed",
            "",
            r#"{"summary":"Fixed the parser.\nAdded a regression test."}"#,
        );
        feed(&mut state, &[result.as_str()]);
        let screen = rows(&draw(&state, 100, 20));
        let label = screen
            .iter()
            .position(|row| row == "Model-reported summary (not independently verified):");
        let first = screen.iter().position(|row| row == "Fixed the parser.");
        let second = screen
            .iter()
            .position(|row| row == "Added a regression test.");
        assert!(
            label.is_some() && label < first && first < second,
            "{screen:#?}"
        );
    }

    #[test]
    fn an_inference_failure_renders_red_between_the_banner_and_the_summary() {
        let mut state = ready();
        let result = turn_result(
            "FAILED",
            "NOT_ESTABLISHED",
            "Inference failed",
            r#","inferenceFailure":{"kind":"timeout","origin":"gateway","message":"upstream timed out after 60s"}"#,
            r#"{"summary":"Partial work."}"#,
        );
        feed(&mut state, &[result.as_str()]);
        let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
        terminal.draw(|frame| render_live(frame, &state)).unwrap();
        let screen = rows(&terminal.backend().to_string());
        let banner = screen
            .iter()
            .position(|row| row.starts_with("× HEADING"))
            .unwrap();
        let failure = screen
            .iter()
            .position(|row| row == "upstream timed out after 60s")
            .expect("failure row");
        let summary = screen
            .iter()
            .position(|row| row == "Partial work.")
            .unwrap();
        assert!(banner < failure && failure < summary, "{screen:#?}");
        let cell = &terminal.backend().buffer()[(0, u16::try_from(failure).unwrap())];
        assert_eq!(cell.fg, Color::Red);
    }

    #[test]
    fn notices_and_banner_lines_collapse_onto_one_line() {
        let mut state = ready();
        let result = turn_result(
            "FAILED",
            "NOT_ESTABLISHED",
            "line one\nline   two",
            "",
            "null",
        );
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"error","code":"BUSY","message":"first\nsecond"}"#,
                result.as_str(),
            ],
        );
        let screen = draw(&state, 100, 20);
        assert_shows(
            &screen,
            &["! BUSY: first second", "× HEADING  line one line two"],
        );
    }

    #[test]
    fn tabs_expand_for_display_only() {
        let mut state = ready();
        state.composer = "x\ty".into();
        assert!(
            state
                .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                .is_some()
        );
        state.apply(Event::AssistantDelta {
            turn_id: "t1".into(),
            text: "a\tb".into(),
        });
        state.composer = "c\td".into();
        let screen = draw(&state, 80, 20);
        assert_shows(&screen, &["› x    y", "a    b", "› c    d"]);
        assert_eq!(state.composer, "c\td");
        assert_eq!(state.transcript[0], Entry::User("x\ty".into()));
    }

    #[test]
    fn the_crash_screen_keeps_reason_exit_code_and_recovery_at_40x10() {
        let mut state = ready();
        state.composer = "one\ntwo\nthree\nfour\nfive".into();
        state.fail(
            "The agent sidecar exited unexpectedly while streaming a very long response.".into(),
            Some(3),
            (1..=20).map(|n| format!("stderr line {n}")).collect(),
        );
        let small = flat(&draw(&state, 40, 10));
        assert_shows(
            &small,
            &[
                "agent stopped",
                "The agent sidecar exited unexpectedly while streaming a very long response. (exit code 3)",
                "r restart q quit",
                "A restarted agent does not remember this conversation.",
            ],
        );
        let tall = flat(&draw(&state, 40, 18));
        assert_shows(
            &tall,
            &[
                "× The agent sidecar stopped",
                "secrets redacted",
                "stderr line 20",
                "does not remember",
            ],
        );
    }

    #[test]
    fn hello_without_session_state_still_reads_as_connecting() {
        let mut state = LiveState::new();
        feed(
            &mut state,
            &[r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#],
        );
        let screen = draw(&state, 80, 20);
        assert_shows(&screen, &["connecting to the agent", "starting the agent"]);
        assert!(!screen.contains("enter send"), "{screen}");
    }

    #[test]
    fn the_busy_marker_survives_a_40_column_status_strip() {
        let mut state = ready();
        feed(&mut state, &[BUSY]);
        let status = rows(&draw(&state, 40, 10)).remove(0);
        assert!(
            status.contains("NEXUS") && status.contains("● working · esc to cancel"),
            "{status}"
        );
    }

    #[test]
    fn the_tail_matches_the_bottom_of_a_full_render_at_narrow_widths() {
        let mut state = ready();
        state.composer = "first prompt that is long enough to wrap at forty columns".into();
        assert!(
            state
                .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                .is_some()
        );
        let result = turn_result(
            "COMPLETED",
            "UNVERIFIED",
            "no verifier ran",
            "",
            r#"{"summary":"Did the thing."}"#,
        );
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"A streamed paragraph that wraps over several rows when the terminal is only forty columns wide.\n\nThen 日本語の長いテキストを折り返します."}"#,
                r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"run_command","subject":"npm test -- --runInBand src/payments/parser.test.ts"}"#,
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"run_command","success":false,"summary":"1 test failed: expected 3 to equal 4","lines":3}"#,
                result.as_str(),
                r#"{"v":1,"type":"error","code":"BUSY","message":"A turn is already running"}"#,
            ],
        );
        let full = rows(&draw(&state, 40, 200));
        let content = full[1..full.len() - 2]
            .iter()
            .rposition(|row| !row.is_empty())
            .unwrap()
            + 1;
        for height in 10..=30usize {
            let screen = rows(&draw(&state, 40, u16::try_from(height).unwrap()));
            let visible = height - 3;
            let expected = &full[1 + content.saturating_sub(visible)..1 + content];
            assert_eq!(&screen[1..1 + expected.len()], expected, "height {height}");
        }
    }

    #[test]
    fn a_hundred_thousand_entries_still_show_the_newest_line() {
        let mut state = ready();
        for n in 0..100_000 {
            state.apply(Event::AssistantDelta {
                turn_id: format!("t{n}"),
                text: format!("paragraph {n} lorem ipsum dolor sit amet"),
            });
        }
        let screen = draw(&state, 120, 40);
        assert!(screen.contains("paragraph 99999 lorem"), "{screen}");
        assert!(!screen.contains("paragraph 99900 lorem"), "{screen}");
    }
}
