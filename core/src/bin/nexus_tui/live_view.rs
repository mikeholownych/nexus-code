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
    let composer_rows = u16::try_from(composer.line_count(area.width))
        .unwrap_or(MAX_COMPOSER_ROWS)
        .clamp(1, MAX_COMPOSER_ROWS);
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
        _ => render_pinned(
            frame,
            rows[1],
            Paragraph::new(transcript_lines(state)).wrap(Wrap { trim: false }),
        ),
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

fn render_status(frame: &mut Frame, area: Rect, state: &LiveState) {
    let session = &state.session;
    let muted = Style::default().fg(MUTED);
    let mut spans = vec![Span::styled(
        " NEXUS ",
        Style::default()
            .fg(Color::Black)
            .bg(ACCENT)
            .add_modifier(Modifier::BOLD),
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
            if session.busy {
                spans.push(Span::styled(
                    "  ● working · esc to cancel",
                    Style::default().fg(ACCENT),
                ));
            }
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(SURFACE)),
        area,
    );
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
                lines.extend(
                    text.split('\n')
                        .map(|row| Line::from(Span::styled(row, white))),
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
                    Span::styled(format!("  {line}"), muted),
                ]));
                if let Some(summary) = summary {
                    lines.push(Line::from(Span::styled(summary.as_str(), muted)));
                }
            }
            Entry::Notice(text) => lines.push(Line::from(Span::styled(
                format!("  ! {text}"),
                Style::default().fg(Color::Yellow),
            ))),
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
    let exit = code.map_or_else(
        || "no exit code".to_string(),
        |code| format!("exit code {code}"),
    );
    let mut lines = vec![
        Line::from(Span::styled(
            "× The agent sidecar stopped",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            format!("{reason} ({exit})"),
            Style::default().fg(Color::White),
        )),
        Line::default(),
    ];
    let footer = vec![
        Line::default(),
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
    if !stderr.is_empty() {
        lines.push(Line::from(Span::styled(
            "Last diagnostic lines (secrets redacted):",
            muted,
        )));
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
        .map(|(index, text)| {
            Line::from(vec![
                Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                Span::raw(text),
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
}
