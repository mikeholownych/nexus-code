//! Rendering for `nexus-tui --live`. Reads `LiveState` only; never decides outcomes.
use std::borrow::Cow;

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, Paragraph, Wrap},
};

use crate::composer::{ComposerLayout, PREFIX_WIDTH};
use crate::live_state::{
    Approval, Entry, Focus, Link, LiveLayout, LiveState, Overlay, Tone, ToolStatus, Verdict,
};
use crate::protocol::SlashSpec;
use crate::review::{LineKind, ReviewLine};
use crate::{ACCENT, MUTED, SURFACE};

pub const MIN_WIDTH: u16 = 40;
pub const MIN_HEIGHT: u16 = 10;
const MAX_COMPOSER_ROWS: u16 = 6;
/// Same cap as the inference failure line in `TerminalUI.turnSummary` (`cli/src/ui.ts`).
const MAX_FAILURE_CHARS: usize = 300;
const TAGLINE: &str = "Understand the work. Inspect the evidence. Keep the decision yours.";

pub fn render_live(frame: &mut Frame, state: &LiveState) -> LiveLayout {
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
        return LiveLayout::default();
    }
    let composer = state.composer.layout(area.width);
    let composer_rows = if matches!(state.link, Link::Crashed { .. }) {
        1
    } else {
        u16::try_from(composer.rows.len())
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
    let mut layout = LiveLayout {
        transcript_rows: usize::from(rows[1].height),
        ..LiveLayout::default()
    };
    match &state.link {
        Link::Crashed {
            code,
            reason,
            stderr,
        } => render_crash(frame, rows[1], *code, reason, stderr),
        _ if state.transcript.is_empty() => render_empty(frame, rows[1]),
        _ => {
            layout.scroll_limit =
                render_transcript(frame, rows[1], &state.transcript, state.scroll_back);
        }
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
    render_composer(frame, inner, state, &composer);
    if let Some((found, pick)) = state.completion() {
        render_completion(frame, rows[1], &found, pick);
    }
    match &state.overlay {
        Some(Overlay::Approval(approval)) => {
            (layout.overlay_rows, layout.overlay_limit) = render_approval(frame, rows[1], approval);
        }
        Some(Overlay::Help { scroll }) => {
            (layout.overlay_rows, layout.overlay_limit) =
                render_help(frame, rows[1], *scroll, &state.commands);
        }
        Some(Overlay::Detail(_) | Overlay::Receipt(_)) => {}
        None => {}
    }
    layout
}

const HELP: &[(&str, &str)] = &[
    ("", "Keys"),
    ("enter", "send the prompt"),
    (
        "shift+enter",
        "new line (alt+enter where shift is not reported)",
    ),
    (
        "↑ / ↓",
        "move between lines; recall earlier prompts from the first line",
    ),
    ("ctrl+a / ctrl+e", "start / end of the line"),
    ("ctrl+u / ctrl+k", "delete to the start / end of the line"),
    ("ctrl+w", "delete the previous word"),
    ("ctrl+l", "clear the draft"),
    ("/", "slash commands: type / to list them, tab completes"),
    (
        "!command",
        "run a shell command directly; !n runs prompt n again",
    ),
    ("tab", "switch between the composer and the transcript"),
    ("pgup / pgdn", "scroll the transcript"),
    ("esc", "close this panel; cancel a running turn"),
    (
        "ctrl+c",
        "cancel a running turn, twice to quit; quit when idle and empty",
    ),
    ("", ""),
    ("", "Approvals (review mode)"),
    ("y / enter", "approve this action"),
    (
        "a",
        "approve this and every later action (switches to auto)",
    ),
    ("n / esc", "deny"),
];

/// A modal rectangle at the top of `area`: one column of margin each side, at most `max_width` wide and
/// `wanted_height` tall, centred horizontally.
fn modal(area: Rect, max_width: u16, wanted_height: u16) -> Rect {
    let width = area.width.saturating_sub(2).min(max_width);
    let height = area.height.min(wanted_height);
    Rect::new(area.x + (area.width - width) / 2, area.y, width, height)
}

fn modal_block(title: &'static str) -> Block<'static> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(
            title,
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ))
}

/// Draws the approval modal; returns the rows available to the review and the largest useful scroll.
fn render_approval(frame: &mut Frame, area: Rect, approval: &Approval) -> (usize, usize) {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let rect = modal(area, area.width, area.height);
    let block = modal_block(" Approval needed ").title_bottom(Line::from(vec![
        Span::styled(" y", key),
        Span::raw(" approve  "),
        Span::styled("a", key),
        Span::raw(" always  "),
        Span::styled("n", key),
        Span::raw(" deny  "),
        Span::styled("↑↓", key),
        Span::raw(" scroll "),
    ]));
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    // The heading names the action being approved, so it keeps its row before the review gets any.
    let head_rows = inner.height.min(2);
    let head = Rect {
        height: head_rows,
        ..inner
    };
    let body = Rect {
        y: inner.y + head_rows,
        height: inner.height - head_rows,
        ..inner
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                tool_verb(&approval.tool),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!(" {}", approval.subject), Style::default().fg(MUTED)),
        ])),
        head,
    );
    let rows = usize::from(body.height);
    let limit = approval.lines.len().saturating_sub(rows);
    let lines: Vec<Line> = approval
        .lines
        .iter()
        .skip(approval.scroll.min(limit))
        .take(rows)
        .map(review_line)
        .collect();
    frame.render_widget(Paragraph::new(lines), body);
    (rows, limit)
}

fn line_style(kind: LineKind) -> Style {
    match kind {
        LineKind::Added => Style::default().fg(Color::Green),
        LineKind::Removed => Style::default().fg(Color::Red),
        LineKind::Hunk => Style::default().fg(Color::Cyan),
        LineKind::Meta => Style::default().fg(MUTED),
        LineKind::Command => Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
        LineKind::Context => Style::default().fg(Color::White),
    }
}

fn review_line(line: &ReviewLine) -> Line<'_> {
    Line::from(Span::styled(expand_tabs(&line.text), line_style(line.kind)))
}

/// How a row of a command's `diff` output is coloured: rows that are not part of a hunk read as headers.
fn diff_row_kind(row: &str) -> LineKind {
    if row.starts_with('+') && !row.starts_with("+++") {
        LineKind::Added
    } else if row.starts_with('-') && !row.starts_with("---") {
        LineKind::Removed
    } else if row.starts_with("@@") {
        LineKind::Hunk
    } else if row.starts_with(' ') {
        LineKind::Context
    } else {
        LineKind::Meta
    }
}

const MAX_COMPLETION_ROWS: usize = 6;

/// Slash-command completion: up to six rows at the bottom of the transcript area, the highlighted one in accent.
fn render_completion(frame: &mut Frame, area: Rect, found: &[&SlashSpec], pick: usize) {
    let shown = found
        .len()
        .min(MAX_COMPLETION_ROWS)
        .min(usize::from(area.height));
    if shown == 0 {
        return;
    }
    let first = (pick + 1).saturating_sub(shown);
    let width = found
        .iter()
        .map(|spec| spec.usage.chars().count())
        .max()
        .unwrap_or(0)
        .min(40);
    let lines: Vec<Line> = found
        .iter()
        .enumerate()
        .skip(first)
        .take(shown)
        .map(|(index, spec)| {
            let style = if index == pick {
                Style::default().fg(Color::Black).bg(ACCENT)
            } else {
                Style::default().fg(Color::White).bg(SURFACE)
            };
            Line::from(Span::styled(
                format!(" {:<width$}  {} ", spec.usage, spec.summary),
                style,
            ))
        })
        .collect();
    let height = u16::try_from(shown).unwrap_or(0);
    let rect = Rect::new(area.x, area.bottom() - height, area.width, height);
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(SURFACE)),
        rect,
    );
}

/// Draws the help panel: keys, then the sidecar's slash commands. Returns its visible rows and largest scroll.
fn render_help(
    frame: &mut Frame,
    area: Rect,
    scroll: usize,
    commands: &[SlashSpec],
) -> (usize, usize) {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let heading = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let white = Style::default().fg(Color::White);
    let mut lines: Vec<Line> = HELP
        .iter()
        .map(|(keys, text)| {
            if keys.is_empty() {
                Line::from(Span::styled(*text, heading))
            } else {
                Line::from(vec![
                    Span::styled(format!("  {keys:<17}"), key),
                    Span::styled(*text, white),
                ])
            }
        })
        .collect();
    if !commands.is_empty() {
        let width = commands
            .iter()
            .map(|spec| spec.usage.chars().count())
            .max()
            .unwrap_or(0)
            .min(34);
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Commands", heading)));
        lines.extend(commands.iter().map(|spec| {
            Line::from(vec![
                Span::styled(format!("  {:<width$}  ", spec.usage), key),
                Span::styled(spec.summary.as_str(), white),
            ])
        }));
    }
    let wanted = u16::try_from(lines.len() + 2).unwrap_or(u16::MAX);
    let rect = modal(area, 96, wanted);
    let block = modal_block(" Help ");
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    let rows = usize::from(inner.height);
    let limit = lines.len().saturating_sub(rows);
    frame.render_widget(
        Paragraph::new(lines).scroll((u16::try_from(scroll.min(limit)).unwrap_or(0), 0)),
        inner,
    );
    (rows, limit)
}

/// Draws the composer rows that hold the cursor and places the terminal cursor while the operator is typing.
fn render_composer(frame: &mut Frame, area: Rect, state: &LiveState, layout: &ComposerLayout) {
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let height = usize::from(area.height);
    let top = (layout.cursor.0 + 1).saturating_sub(height);
    let lines: Vec<Line> = layout
        .rows
        .iter()
        .enumerate()
        .skip(top)
        .take(height)
        .map(|(index, row)| {
            Line::from(vec![
                Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                Span::raw(row.as_str()),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
    let typing = !matches!(state.link, Link::Crashed { .. })
        && state.overlay.is_none()
        && state.focus == Focus::Composer
        && !state.closing;
    if typing && let Ok(row) = u16::try_from(layout.cursor.0 - top) {
        frame.set_cursor_position((area.x + PREFIX_WIDTH + layout.cursor.1, area.y + row));
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
    let busy_width = if session.busy && !state.connecting() {
        u16::try_from(busy.width()).unwrap_or(area.width)
    } else {
        0
    };
    match &state.link {
        _ if state.connecting() => spans.push(Span::styled("  connecting to the agent…", muted)),
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

/// Renders the transcript window `scroll_back` rows above the newest line. Only the entries needed to fill the
/// window are laid out, so the cost follows the window, not the transcript. Returns the largest useful
/// `scroll_back` (`usize::MAX` when the walk stopped before the first entry).
fn render_transcript(
    frame: &mut Frame,
    area: Rect,
    transcript: &[Entry],
    scroll_back: usize,
) -> usize {
    let height = usize::from(area.height);
    let want = height.saturating_add(scroll_back);
    let mut tail = Vec::new();
    let mut total = 0;
    let mut reached_top = true;
    'entries: for (index, entry) in transcript.iter().enumerate().rev() {
        for line in entry_lines(entry, index == 0).into_iter().rev() {
            let rows = wrapped_rows(&line, area.width);
            total += rows;
            tail.push((line, rows));
            if total >= want {
                reached_top = false;
                break 'entries;
            }
        }
    }
    let limit = if reached_top {
        total.saturating_sub(height)
    } else {
        usize::MAX
    };
    let back = scroll_back.min(limit);
    let first_row = total.saturating_sub(height + back);
    tail.reverse();
    let mut skipped = 0;
    let mut covered = 0;
    let mut lines = Vec::new();
    for (line, rows) in tail {
        if lines.is_empty() && skipped + rows <= first_row {
            skipped += rows;
            continue;
        }
        if covered >= height + (first_row - skipped) {
            break;
        }
        covered += rows;
        lines.push(line);
    }
    let offset = u16::try_from(first_row - skipped).unwrap_or(u16::MAX);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((offset, 0)),
        area,
    );
    if back > 0 {
        render_scroll_badge(frame, area, back);
    }
    limit
}

fn render_scroll_badge(frame: &mut Frame, area: Rect, rows_below: usize) {
    let text = format!(" ↓ {rows_below} more rows · pgdn ");
    let width = u16::try_from(text.chars().count())
        .unwrap_or(area.width)
        .min(area.width);
    let at = Rect::new(area.right() - width, area.bottom() - 1, width, 1);
    frame.render_widget(
        Paragraph::new(Span::styled(
            text,
            Style::default().fg(Color::Black).bg(ACCENT),
        )),
        at,
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
            notes,
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
                let mut detail = one_line(failure);
                if let Some((cut, _)) = detail.char_indices().nth(MAX_FAILURE_CHARS) {
                    detail.truncate(cut);
                    detail.push('…');
                }
                lines.push(Line::from(Span::styled(
                    detail,
                    Style::default().fg(Color::Red),
                )));
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
                if let Some(notes) = notes {
                    lines.push(Line::from(Span::styled("Notes:", muted)));
                    lines.extend(
                        notes
                            .split('\n')
                            .map(|row| Line::from(Span::styled(expand_tabs(row), muted))),
                    );
                }
            }
        }
        Entry::Notice(text) => lines.push(Line::from(Span::styled(
            format!("  ! {}", one_line(text)),
            Style::default().fg(Color::Yellow),
        ))),
        Entry::Decision {
            tool,
            subject,
            verdict,
        } => {
            let (glyph, color, label) = match verdict {
                Verdict::Approved | Verdict::ApprovedForSession => ("✓", Color::Green, "approved"),
                Verdict::Denied => ("×", Color::Red, "denied"),
            };
            let mut spans = vec![
                Span::styled(format!("  {glyph} {label} "), Style::default().fg(color)),
                Span::styled(tool_verb(tool), white),
            ];
            if !subject.is_empty() {
                spans.push(Span::styled(format!(" {subject}"), muted));
            }
            if *verdict == Verdict::ApprovedForSession {
                spans.push(Span::styled(" · later actions run without asking", muted));
            }
            lines.push(Line::from(spans));
        }
        Entry::Command(text) => {
            lines.push(Line::default());
            for (index, row) in text.split('\n').enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                    Span::styled(expand_tabs(row), Style::default().fg(ACCENT)),
                ]));
            }
        }
        Entry::Output {
            success,
            text,
            diff,
        } => {
            let base = if *success {
                white
            } else {
                Style::default().fg(Color::Red)
            };
            lines.extend(text.split('\n').map(|row| {
                let style = if *diff {
                    line_style(diff_row_kind(row))
                } else {
                    base
                };
                Line::from(Span::styled(format!("  {}", expand_tabs(row)), style))
            }));
        }
        Entry::Info(text) => lines.push(Line::from(Span::styled(
            format!("  · {}", one_line(text)),
            muted,
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
        .saturating_sub(rows(&detail) + recovery.iter().map(&rows).sum::<usize>());
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

fn composer_hint(state: &LiveState) -> &'static str {
    match (&state.link, state.session.busy) {
        _ if state.closing => " shutting down the agent… ",
        (Link::Crashed { .. }, _) => " r restart · q quit ",
        _ if state.connecting() => " starting the agent… ",
        _ if matches!(state.overlay, Some(Overlay::Approval(_))) => {
            " approval needed · y approve · n deny "
        }
        _ if state.overlay.is_some() => " esc close help ",
        _ if state.completion().is_some() => " tab complete · enter run · esc close ",
        _ if state.focus == Focus::Transcript => " transcript · ↑↓ scroll · tab back ",
        (_, true) if state.cancel_requested() => " cancelling… ctrl-c again to quit ",
        (_, true) => " waiting for the agent ",
        (_, false) => " enter send · shift+enter newline · ? help ",
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
    use crate::live_state::{Focus, LiveLayout, Verdict};
    use crate::protocol::{Event, SlashSpec, parse_event};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend, layout::Position};

    fn draw(state: &LiveState, width: u16, height: u16) -> String {
        draw_measured(state, width, height).0
    }

    fn draw_measured(state: &LiveState, width: u16, height: u16) -> (String, LiveLayout) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut layout = LiveLayout::default();
        terminal
            .draw(|frame| layout = render_live(frame, state))
            .unwrap();
        (terminal.backend().to_string(), layout)
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
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
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
    fn a_long_inference_failure_is_capped_to_one_line() {
        let mut state = ready();
        let message = format!("line one\nline   two {}", "é".repeat(400));
        let result = turn_result(
            "FAILED",
            "NOT_ESTABLISHED",
            "Inference failed",
            &format!(
                r#","inferenceFailure":{{"kind":"http_error","origin":"provider","message":{message:?}}}"#
            ),
            "null",
        );
        feed(&mut state, &[result.as_str()]);
        let screen = rows(&draw(&state, 400, 20));
        let expected = format!("line one line two {}…", "é".repeat(282));
        assert!(screen.contains(&expected), "{screen:#?}");
        assert!(!screen.iter().any(|row| row == "line one"), "{screen:#?}");
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

    fn press(state: &mut LiveState, text: &str) {
        for c in text.chars() {
            state.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
    }

    #[test]
    fn the_terminal_cursor_sits_at_the_composer_cursor() {
        let mut state = ready();
        press(&mut state, "fix");
        state.on_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        assert_eq!(
            terminal.get_cursor_position().unwrap(),
            Position::new(4, 19)
        );
    }

    #[test]
    fn long_drafts_wrap_by_character_and_keep_the_cursor_row_visible() {
        let mut state = ready();
        state.composer = format!("{}END", "x".repeat(400)).as_str().into();
        let screen = rows(&draw(&state, 40, 20));
        assert_eq!(screen[19], format!("  {}END", "x".repeat(400 % 38)));
        assert!(
            screen[13].contains("enter send"),
            "composer is capped at 6 rows: {screen:#?}"
        );
    }

    #[test]
    fn scrolled_back_transcripts_show_older_rows_and_a_badge() {
        let mut state = ready();
        let text = (1..=80)
            .map(|n| format!("row {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        state.apply(Event::AssistantDelta {
            turn_id: "t1".into(),
            text,
        });
        state.scroll_back = 30;
        let (screen, layout) = draw_measured(&state, 60, 16);
        assert_eq!(layout.transcript_rows, 13);
        assert_eq!(
            layout.scroll_limit,
            usize::MAX,
            "the walk stopped before the first entry, so the top is not known yet"
        );
        assert_shows(&screen, &["row 38", "row 50", "↓ 30 more rows · pgdn"]);
        assert!(
            !screen.contains("row 37") && !screen.contains("row 51"),
            "{screen}"
        );
        state.scroll_back = usize::MAX;
        let (top, layout) = draw_measured(&state, 60, 16);
        assert_eq!(layout.scroll_limit, 67);
        assert_shows(&top, &["row 1", "row 13", "↓ 67 more rows"]);
        assert!(!top.contains("row 14"), "{top}");
    }

    #[test]
    fn a_window_that_starts_inside_a_wrapped_line_keeps_the_short_lines_after_it() {
        let mut state = ready();
        let mut text = vec!["w".repeat(100)];
        text.extend((1..=20).map(|n| format!("short {n}")));
        state.apply(Event::AssistantDelta {
            turn_id: "t1".into(),
            text: text.join("\n"),
        });
        state.scroll_back = 9;
        let screen = rows(&draw(&state, 40, 16));
        assert_eq!(screen[1], "w".repeat(40), "{screen:#?}");
        assert_eq!(screen[2], "w".repeat(20), "{screen:#?}");
        for n in 1..=10 {
            assert_eq!(screen[2 + n], format!("short {n}"), "{screen:#?}");
        }
        assert!(screen[13].starts_with("short 11"), "{screen:#?}");
        assert!(
            !screen.iter().any(|row| row.contains("short 12")),
            "{screen:#?}"
        );
    }

    #[test]
    fn decisions_notes_and_focus_render() {
        let mut state = ready();
        state.transcript.push(Entry::Decision {
            tool: "write_file".into(),
            subject: "x.txt".into(),
            verdict: Verdict::Approved,
        });
        state.transcript.push(Entry::Decision {
            tool: "run_command".into(),
            subject: "rm -rf build".into(),
            verdict: Verdict::Denied,
        });
        state.transcript.push(Entry::Decision {
            tool: "edit_file".into(),
            subject: "a.ts".into(),
            verdict: Verdict::ApprovedForSession,
        });
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"H","line":"L","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":{"summary":"Done.","notes":"Watch the cache."}}"#,
            ],
        );
        state.focus = Focus::Transcript;
        let screen = draw(&state, 100, 24);
        assert_shows(
            &screen,
            &[
                "✓ approved Write x.txt",
                "× denied Run rm -rf build",
                "✓ approved Edit a.ts · later actions run without asking",
                "Notes:",
                "Watch the cache.",
                "transcript · ↑↓ scroll · tab back",
            ],
        );
    }

    #[test]
    fn closing_says_so() {
        let mut state = ready();
        state.closing = true;
        assert_shows(&draw(&state, 80, 20), &["shutting down the agent"]);
    }

    fn approval(review: &str) -> String {
        format!(
            r#"{{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"edit_file","subject":"src/x.txt","preview":"{{}}","review":{review}}}"#
        )
    }

    #[test]
    fn the_approval_modal_shows_the_action_a_coloured_diff_and_the_keys() {
        let mut state = ready();
        let request = approval(
            r#"{"kind":"change","path":"src/x.txt","before":"a\nb\nc\n","after":"a\nB\nc\n","created":false,"truncated":false}"#,
        );
        feed(&mut state, &[BUSY, request.as_str()]);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        let screen = terminal.backend().to_string();
        assert_shows(
            &screen,
            &[
                "Approval needed",
                "Edit src/x.txt",
                "@@ -1,3 +1,3 @@",
                "-b",
                "+B",
                "y approve",
                "a always",
                "n deny",
                "approval needed · y approve · n deny",
            ],
        );
        let lines = rows(&screen);
        let added = lines.iter().position(|row| row.contains("+B")).unwrap();
        let column = lines[added].find("+B").unwrap();
        let x = u16::try_from(lines[added][..column].chars().count()).unwrap();
        let cell = &terminal.backend().buffer()[(x, u16::try_from(added).unwrap())];
        assert_eq!(cell.fg, Color::Green);
    }

    #[test]
    fn a_cramped_approval_keeps_the_action_heading_before_the_review() {
        let mut state = ready();
        let request = approval(
            r#"{"kind":"change","path":"src/x.txt","before":"a\nb\nc\n","after":"a\nB\nc\n","created":false,"truncated":false}"#,
        );
        feed(&mut state, &[BUSY, request.as_str()]);
        state.composer = "one\ntwo\nthree\nfour\nfive\nsix".into();
        for height in [11, 12] {
            assert_shows(&draw(&state, 40, height), &["Edit src/x.txt"]);
        }
    }

    #[test]
    fn long_reviews_report_rows_and_limit_and_scroll() {
        let mut state = ready();
        let after: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        let request = approval(&format!(
            r#"{{"kind":"change","path":"n.txt","before":null,"after":{after:?},"created":true,"truncated":false}}"#
        ));
        feed(&mut state, &[request.as_str()]);
        let (screen, layout) = draw_measured(&state, 80, 24);
        assert_eq!(layout.overlay_rows, 17);
        assert_eq!(layout.overlay_limit, 104 - 17);
        assert_shows(&screen, &["new file n.txt", "+line 1"]);
        state.note_layout(layout);
        state.on_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        assert_shows(&draw(&state, 80, 24), &["+line 100"]);
    }

    #[test]
    fn help_lists_the_keys() {
        let mut state = ready();
        state.on_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
        assert_shows(
            &draw(&state, 100, 30),
            &[
                "Keys",
                "shift+enter",
                "ctrl+c",
                "approve this action",
                "esc close help",
            ],
        );
    }

    #[test]
    fn overlays_fit_the_minimum_terminal() {
        let mut state = ready();
        let request = approval(r#"{"kind":"command","command":"npm test"}"#);
        feed(&mut state, &[request.as_str()]);
        assert_shows(&draw(&state, 40, 10), &["$ npm test"]);
        state.overlay = Some(crate::live_state::Overlay::Help { scroll: 0 });
        assert_shows(&draw(&state, 40, 10), &["Keys"]);
    }

    fn spec(name: &str, usage: &str, summary: &str) -> SlashSpec {
        SlashSpec {
            name: name.into(),
            usage: usage.into(),
            summary: summary.into(),
        }
    }

    #[test]
    fn commands_replies_and_info_render_in_the_transcript() {
        let mut state = ready();
        state.transcript = vec![
            Entry::Command("/diff".into()),
            Entry::Output {
                success: true,
                text: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new".into(),
                diff: true,
            },
            Entry::Output {
                success: false,
                text: "Commit failed: nothing staged".into(),
                diff: false,
            },
            Entry::Info("Resumed session a.".into()),
        ];
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        let screen = terminal.backend().to_string();
        assert_shows(
            &screen,
            &[
                "› /diff",
                "  -old",
                "  +new",
                "  Commit failed: nothing staged",
                "  · Resumed session a.",
            ],
        );
        let lines = rows(&screen);
        for (text, color) in [
            ("+new", Color::Green),
            ("-old", Color::Red),
            ("Commit failed", Color::Red),
        ] {
            let row = lines.iter().position(|line| line.contains(text)).unwrap();
            let column = lines[row].find(text).unwrap();
            let x = u16::try_from(lines[row][..column].chars().count()).unwrap();
            let y = u16::try_from(row).unwrap();
            assert_eq!(terminal.backend().buffer()[(x, y)].fg, color, "{text}");
        }
    }

    #[test]
    fn the_completion_list_sits_above_the_composer_with_the_pick_highlighted() {
        let mut state = ready();
        state.commands = vec![
            spec("help", "/help", "List the slash commands"),
            spec(
                "history",
                "/history [query|run <n>]",
                "Search earlier prompts",
            ),
        ];
        for c in "/h".chars() {
            state.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        state.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        let screen = terminal.backend().to_string();
        assert_shows(
            &screen,
            &[
                "/help",
                "List the slash commands",
                "/history [query|run <n>]",
                "tab complete · enter run · esc close",
            ],
        );
        let lines = rows(&screen);
        let picked = lines
            .iter()
            .position(|line| line.contains("Search earlier prompts"))
            .unwrap();
        let composer = lines
            .iter()
            .position(|line| line.starts_with("› /h"))
            .unwrap();
        assert_eq!(
            picked + 2,
            composer,
            "the list ends right above the composer border"
        );
        let y = u16::try_from(picked).unwrap();
        assert_eq!(terminal.backend().buffer()[(1, y)].bg, ACCENT);
    }

    #[test]
    fn help_lists_the_slash_commands_after_the_keys() {
        let mut state = ready();
        state.commands = vec![spec("diff", "/diff", "Uncommitted changes as a diff")];
        state.overlay = Some(crate::live_state::Overlay::Help { scroll: 0 });
        assert_shows(
            &draw(&state, 100, 40),
            &[
                "Keys",
                "!command",
                "Commands",
                "/diff",
                "Uncommitted changes as a diff",
            ],
        );
    }
}
