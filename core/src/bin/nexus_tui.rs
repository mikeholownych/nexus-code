use std::{
    env, fs,
    io::{self, IsTerminal},
    path::PathBuf,
    time::Duration,
};

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::{
    Terminal,
    backend::TestBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};
use serde::Deserialize;

#[path = "nexus_tui/protocol.rs"]
mod protocol;

const ACCENT: Color = Color::Rgb(103, 232, 249);
const MUTED: Color = Color::Rgb(125, 145, 158);
const SURFACE: Color = Color::Rgb(18, 27, 37);

fn theme_accent(theme: &str) -> Color {
    match theme {
        "catppuccin" => Color::Rgb(137, 220, 235),
        "nord" => Color::Rgb(136, 192, 208),
        "dracula" => Color::Rgb(189, 147, 249),
        "monochrome" => Color::White,
        _ => ACCENT,
    }
}

#[derive(Clone, Debug, Deserialize)]
struct Snapshot {
    model: String,
    workspace: String,
    task_id: String,
    objective: String,
    activity: Vec<Activity>,
    plan: Vec<Milestone>,
    validation: Option<Validation>,
    context: String,
    status: String,
    #[serde(default)]
    theme: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Activity {
    kind: String,
    title: String,
    summary: String,
    detail: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Milestone {
    name: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Validation {
    status: String,
    candidate_id: Option<String>,
    verifier: Option<String>,
}

#[derive(Default)]
struct AppState {
    selected: usize,
    scroll: u16,
    overlay: Overlay,
    done: bool,
}

#[derive(Default, PartialEq)]
enum Overlay {
    #[default]
    None,
    Detail,
    Help,
    Validation,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let first = args
        .next()
        .ok_or("usage: nexus-tui [--plain] SNAPSHOT.json")?;
    let plain = first == "--plain";
    let snapshot_path = PathBuf::from(if plain {
        args.next()
            .ok_or("usage: nexus-tui --plain SNAPSHOT.json")?
    } else {
        first
    });
    let snapshot: Snapshot = serde_json::from_slice(&fs::read(&snapshot_path)?)?;
    if plain {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| render(frame, &snapshot, &mut AppState::default()))?;
        print!("{}", terminal.backend());
        return Ok(());
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("interactive Nexus TUI requires a terminal".into());
    }

    let mut terminal = ratatui::init();
    let result = run(&mut terminal, &snapshot);
    ratatui::restore();
    result?;
    Ok(())
}

fn run<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    snapshot: &Snapshot,
) -> Result<(), Box<dyn std::error::Error>>
where
    B::Error: 'static,
{
    let mut state = AppState::default();
    terminal.draw(|frame| render(frame, snapshot, &mut state))?;
    while !state.done {
        if event::poll(Duration::from_secs(1))? {
            match event::read()? {
                Event::Resize(_, _) => {
                    terminal.draw(|frame| render(frame, snapshot, &mut state))?;
                }
                Event::Key(key) => {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    match state.overlay {
                        Overlay::Detail | Overlay::Help | Overlay::Validation => match key.code {
                            KeyCode::Esc | KeyCode::Char('q') => state.overlay = Overlay::None,
                            KeyCode::Up | KeyCode::Char('k') => {
                                state.scroll = state.scroll.saturating_sub(1)
                            }
                            KeyCode::Down | KeyCode::Char('j') => {
                                state.scroll = state.scroll.saturating_add(1)
                            }
                            _ => {}
                        },
                        Overlay::None => match key.code {
                            KeyCode::Char('q') | KeyCode::Esc => state.done = true,
                            KeyCode::Up | KeyCode::Char('k') => {
                                state.selected = state.selected.saturating_sub(1);
                                state.scroll = 0;
                            }
                            KeyCode::Down | KeyCode::Char('j') => {
                                state.selected = (state.selected + 1)
                                    .min(snapshot.activity.len().saturating_sub(1));
                                state.scroll = 0;
                            }
                            KeyCode::Enter | KeyCode::Char('d') => {
                                if !snapshot.activity.is_empty() {
                                    state.overlay = Overlay::Detail;
                                    state.scroll = 0;
                                }
                            }
                            KeyCode::Char('v') if snapshot.validation.is_some() => {
                                state.overlay = Overlay::Validation;
                                state.scroll = 0;
                            }
                            KeyCode::Char('?') | KeyCode::F(1) => {
                                state.overlay = Overlay::Help;
                                state.scroll = 0;
                            }
                            _ => {}
                        },
                    }
                    terminal.draw(|frame| render(frame, snapshot, &mut state))?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn render(frame: &mut ratatui::Frame, data: &Snapshot, state: &mut AppState) {
    let area = frame.area();
    if area.width < 58 || area.height < 14 {
        frame.render_widget(
            Paragraph::new("Nexus needs a wider terminal (58×14 minimum). Press q to return.")
                .style(Style::default().fg(theme_accent(&data.theme))),
            area,
        );
        return;
    }

    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(2),
        ])
        .split(area);
    render_header(frame, root[0], data);

    let columns = if area.width >= 96 {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
            .split(root[1])
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(64), Constraint::Percentage(36)])
            .split(root[1])
    };
    render_activity(frame, columns[0], data, state);
    render_context(frame, columns[1], data);
    render_footer(frame, root[2], data);

    match state.overlay {
        Overlay::None => {}
        Overlay::Detail => render_detail(frame, data, state),
        Overlay::Help => render_help(frame, data, state),
        Overlay::Validation => render_validation(frame, data, state),
    }
}

fn render_header(frame: &mut ratatui::Frame, area: Rect, data: &Snapshot) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Length(1)])
        .split(area);
    let status_color = match data.status.as_str() {
        "VERIFIED" | "COMPLETE" | "NO CHANGES" | "IDLE" => Color::Green,
        "UNVERIFIED" | "STOPPING" | "BLOCKED" | "LIMIT_REACHED" | "INCOMPLETE" => Color::Yellow,
        "FAILED" | "INTERRUPTED" | "NEEDS ATTENTION" => Color::Red,
        _ => theme_accent(&data.theme),
    };
    let mut top_spans = vec![
        Span::styled(
            " NEXUS ",
            Style::default()
                .fg(Color::Black)
                .bg(theme_accent(&data.theme))
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "  WORKSPACE  ",
            Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            short_path(&data.workspace, if area.width < 82 { 16 } else { 28 }),
            Style::default().fg(Color::White),
        ),
    ];
    if area.width >= 82 {
        top_spans.extend([
            Span::raw("   "),
            Span::styled(one_line(&data.model, 20), Style::default().fg(MUTED)),
        ]);
    }
    top_spans.extend([
        Span::raw("   "),
        Span::styled(
            one_line(&data.status, (area.width / 3) as usize),
            Style::default()
                .fg(status_color)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    let top = Line::from(top_spans);
    frame.render_widget(
        Paragraph::new(top).style(Style::default().bg(SURFACE)),
        rows[0],
    );
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " OBJECTIVE  ",
                Style::default()
                    .fg(theme_accent(&data.theme))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                one_line(&data.objective, area.width.saturating_sub(14) as usize),
                Style::default().fg(Color::White),
            ),
        ])),
        rows[1],
    );
}

fn render_activity(frame: &mut ratatui::Frame, area: Rect, data: &Snapshot, state: &mut AppState) {
    let items = if data.activity.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "No work recorded yet. Start with a prompt in the REPL.",
            Style::default().fg(MUTED),
        )))]
    } else {
        data.activity
            .iter()
            .enumerate()
            .map(|(index, event)| {
                let (glyph, color) = match event.kind.as_str() {
                    "finding" => ("✳", Color::Yellow),
                    "failure" => ("×", Color::Red),
                    "warning" => ("!", Color::Yellow),
                    "change" => ("▸", theme_accent(&data.theme)),
                    "tool" => ("·", MUTED),
                    _ => ("◦", Color::White),
                };
                let marker = if index == state.selected { "›" } else { " " };
                ListItem::new(vec![
                    Line::from(vec![
                        Span::styled(
                            format!("{marker} {glyph} "),
                            Style::default().fg(color).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            &event.title,
                            Style::default()
                                .fg(Color::White)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ]),
                    Line::from(Span::styled(
                        format!(
                            "    {}",
                            one_line(&event.summary, area.width.saturating_sub(8) as usize)
                        ),
                        Style::default().fg(MUTED),
                    )),
                ])
            })
            .collect()
    };
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::LEFT)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(Span::styled(
                    "  RECENT SIGNAL  ",
                    Style::default()
                        .fg(theme_accent(&data.theme))
                        .add_modifier(Modifier::BOLD),
                )),
        )
        .highlight_style(Style::default().bg(SURFACE));
    let mut list_state =
        ListState::default().with_selected((!data.activity.is_empty()).then_some(state.selected));
    frame.render_stateful_widget(list, area, &mut list_state);
}

fn render_context(frame: &mut ratatui::Frame, area: Rect, data: &Snapshot) {
    if area.height <= 6 {
        let validation = data
            .validation
            .as_ref()
            .map(|receipt| receipt.status.as_str())
            .unwrap_or("Not verified");
        let active = data
            .plan
            .iter()
            .find(|item| item.status == "in_progress")
            .map(|item| item.name.as_str())
            .unwrap_or("No active milestone");
        let compact = Text::from(vec![
            Line::from(vec![
                Span::styled(
                    "VALIDATION  ",
                    Style::default()
                        .fg(theme_accent(&data.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    validation,
                    Style::default().fg(if validation == "PASSED" {
                        Color::Green
                    } else {
                        Color::Yellow
                    }),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    "PLAN  ",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    one_line(active, area.width.saturating_sub(8) as usize),
                    Style::default().fg(Color::White),
                ),
            ]),
        ]);
        frame.render_widget(Paragraph::new(compact).wrap(Wrap { trim: true }), area);
        return;
    }
    let mut lines = vec![Line::from(Span::styled(
        "  VALIDATION",
        Style::default()
            .fg(theme_accent(&data.theme))
            .add_modifier(Modifier::BOLD),
    ))];
    if let Some(validation) = &data.validation {
        let color = if validation.status == "PASSED" {
            Color::Green
        } else {
            Color::Red
        };
        lines.push(Line::from(Span::styled(
            format!("  {}", validation.status),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )));
        if let Some(id) = &validation.candidate_id {
            lines.push(Line::from(Span::styled(
                format!("  Candidate {}", short_path(id, 18)),
                Style::default().fg(MUTED),
            )));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "  Not verified",
            Style::default().fg(MUTED),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  PLAN",
        Style::default()
            .fg(theme_accent(&data.theme))
            .add_modifier(Modifier::BOLD),
    )));
    if data.plan.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No milestones",
            Style::default().fg(MUTED),
        )));
    } else {
        for item in data
            .plan
            .iter()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let (glyph, color) = match item.status.as_str() {
                "completed" => ("✓", Color::Green),
                "in_progress" => ("●", theme_accent(&data.theme)),
                _ => ("○", MUTED),
            };
            lines.push(Line::from(vec![
                Span::styled(format!("  {glyph} "), Style::default().fg(color)),
                Span::styled(
                    one_line(&item.name, area.width.saturating_sub(8) as usize),
                    Style::default().fg(Color::White),
                ),
            ]));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  CONTEXT",
        Style::default()
            .fg(theme_accent(&data.theme))
            .add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        format!("  {}", data.context),
        Style::default().fg(MUTED),
    )));
    lines.push(Line::from(Span::styled(
        format!("  Task {}", short_path(&data.task_id, 18)),
        Style::default().fg(MUTED),
    )));
    frame.render_widget(
        Paragraph::new(Text::from(lines)).wrap(Wrap { trim: true }),
        area,
    );
}

fn render_footer(frame: &mut ratatui::Frame, area: Rect, data: &Snapshot) {
    let text = if area.width < 90 {
        "↑↓ move · enter inspect · ? help · q return".to_string()
    } else {
        let validation_key = if data.validation.is_some() {
            "   v validation"
        } else {
            ""
        };
        format!(
            " ↑↓ navigate   enter detail   ? help{validation_key}                         q return to REPL "
        )
    };
    frame.render_widget(
        Paragraph::new(text).style(Style::default().fg(MUTED).bg(SURFACE)),
        area,
    );
}

fn render_detail(frame: &mut ratatui::Frame, data: &Snapshot, state: &AppState) {
    let Some(item) = data.activity.get(state.selected) else {
        return;
    };
    let detail_width = 84usize.saturating_sub(4).max(1);
    let detail_rows = item
        .detail
        .lines()
        .map(|line| line.chars().count().div_ceil(detail_width))
        .sum::<usize>();
    let detail_height = detail_rows.saturating_add(4).clamp(7, 18) as u16;
    let area = centered(frame.area(), 84, detail_height);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(item.detail.as_str())
            .scroll((state.scroll, 0))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(format!(
                        "  {} · evidence · Esc close · ↑↓ scroll  ",
                        item.title
                    ))
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme_accent(&data.theme)))
                    .style(Style::default().bg(SURFACE)),
            ),
        area,
    );
}

fn render_validation(frame: &mut ratatui::Frame, data: &Snapshot, state: &AppState) {
    let Some(receipt) = &data.validation else {
        return;
    };
    let content = format!(
        "Status: {}\nCandidate: {}\nVerifier: {}\n\nA validation receipt describes a check bound to a candidate. A passed receipt does not claim that unrun checks passed.",
        receipt.status,
        receipt.candidate_id.as_deref().unwrap_or("unavailable"),
        receipt.verifier.as_deref().unwrap_or("unavailable")
    );
    let area = centered(frame.area(), 72, 14);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(content)
            .scroll((state.scroll, 0))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title("  VALIDATION RECEIPT  ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme_accent(&data.theme)))
                    .style(Style::default().bg(SURFACE)),
            ),
        area,
    );
}

fn render_help(frame: &mut ratatui::Frame, data: &Snapshot, state: &AppState) {
    let area = centered(frame.area(), 64, 14);
    frame.render_widget(Clear, area);
    frame.render_widget(Paragraph::new("Navigate activity   ↑/↓ or j/k\nInspect selected item   enter or d\nInspect validation   v\nScroll detail   ↑/↓\nClose detail/help   Esc\nReturn to REPL   q\n\nThe session view summarizes activity. Full tool output remains available in each evidence view.").scroll((state.scroll, 0)).wrap(Wrap { trim: false }).block(Block::default().title("  NEXUS KEYS  ").borders(Borders::ALL).border_style(Style::default().fg(theme_accent(&data.theme))).style(Style::default().bg(SURFACE))), area);
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width.saturating_sub(4)).max(1);
    let height = height.min(area.height.saturating_sub(2)).max(1);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

fn one_line(value: &str, max: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let max = max.max(4);
    if clean.chars().count() <= max {
        clean
    } else {
        format!("{}…", clean.chars().take(max - 1).collect::<String>())
    }
}

fn short_path(value: &str, max: usize) -> String {
    one_line(value.rsplit('/').next().unwrap_or(value), max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Snapshot {
        serde_json::from_str(r#"{
          "model":"fixture-model","workspace":"/tmp/long-workspace-name","task_id":"task-abc123",
          "objective":"Map the current request lifecycle and explain verified behavior",
          "activity":[{"kind":"finding","title":"Lifecycle map","summary":"Found 3 validated transitions","detail":"Complete evidence line one\nComplete evidence line two"}],
          "plan":[{"name":"Inspect lifecycle","status":"completed"},{"name":"Verify behavior","status":"in_progress"}],
          "validation":{"status":"PASSED","candidate_id":"candidate-123456","verifier":"cargo test"},
          "context":"18 messages","status":"IDLE"
        }"#).unwrap()
    }

    #[test]
    fn compact_terminal_keeps_objective_and_validation_visible() {
        let data = fixture();
        let backend = TestBackend::new(76, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| render(frame, &data, &mut AppState::default()))
            .unwrap();
        let rendered = terminal.backend().to_string();
        assert!(rendered.contains("OBJECTIVE"));
        assert!(rendered.contains("Lifecycle map"));
        assert!(rendered.contains("PASSED"));
        assert!(rendered.contains("Verify behavior"));
        assert!(rendered.contains("q return"));
    }

    #[test]
    fn narrow_terminal_shows_recovery_instruction() {
        let backend = TestBackend::new(44, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| render(frame, &fixture(), &mut AppState::default()))
            .unwrap();
        assert!(terminal.backend().to_string().contains("58×14 minimum"));
    }

    #[test]
    fn evidence_overlay_keeps_complete_tool_output_inspectable() {
        let data = fixture();
        let mut state = AppState {
            overlay: Overlay::Detail,
            ..AppState::default()
        };
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| render(frame, &data, &mut state))
            .unwrap();
        let rendered = terminal.backend().to_string();
        assert!(rendered.contains("Complete evidence line one"));
        assert!(rendered.contains("Complete evidence line two"));
    }

    #[test]
    fn selected_theme_changes_the_primary_accent() {
        assert_ne!(theme_accent("default"), theme_accent("dracula"));
        assert_eq!(theme_accent("unknown"), ACCENT);
    }
}
