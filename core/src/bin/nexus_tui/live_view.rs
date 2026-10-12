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
use crate::diff_view::{self, CardContext, Fit, Geometry, Palette};
use crate::live_state::{
    Approval, Detail, DiffReview, Entry, Focus, Link, LiveLayout, LiveState, Loaded, Overlay, ReceiptPanel,
    ReviewScope, SteerState, Tone, ToolRecord, ToolStatus, Verdict,
};
use crate::theme;
use std::time::Duration;
use crate::models::{Connect, Fetch, Picker, Row, Step};
use crate::protocol::{ReceiptSection, SlashSpec};
use crate::review::{LineKind, ReviewLine};
use crate::{ACCENT, MUTED, SURFACE};

pub const MIN_WIDTH: u16 = 40;
pub const MIN_HEIGHT: u16 = 10;
const MAX_COMPOSER_ROWS: u16 = 6;
/// Same cap as the inference failure line in `TerminalUI.turnSummary` (`cli/src/ui.ts`).
const MAX_FAILURE_CHARS: usize = 300;
const TAGLINE: &str = "Understand the work. Inspect the evidence. Keep the decision yours.";
/// Background of the selected tool call in the transcript.
const SELECTED: Color = Color::Rgb(38, 52, 66);
/// Spinner frames; one per `FRAME` of wall-clock time, so the animation never depends on model output.
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
pub const FRAME: Duration = Duration::from_millis(100);

/// The spinner frame for `elapsed` since the turn started.
pub fn spinner_frame(elapsed: Duration) -> &'static str {
    SPINNER[(elapsed.as_millis() / FRAME.as_millis()) as usize % SPINNER.len()]
}

/// `m:ss` (or `h:mm:ss`) of elapsed wall-clock time.
pub fn clock(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    if secs >= 3600 {
        format!("{}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)
    } else {
        format!("{}:{:02}", secs / 60, secs % 60)
    }
}

/// What the activity line says the agent is doing.
fn phase_text(state: &LiveState) -> String {
    let Some(activity) = &state.activity else {
        return "waiting for the agent".to_string();
    };
    let tool = activity.tool.as_deref().map(tool_verb);
    let subject = activity.subject.as_deref().map(one_line).filter(|s| !s.is_empty());
    let mut text = match activity.phase.as_str() {
        "inference" => "thinking".to_string(),
        "tool" => format!("{}{}", tool.unwrap_or_else(|| "running a tool".into()), subject.map(|s| format!(" {s}")).unwrap_or_default()),
        "approval" => "waiting for your approval".to_string(),
        "provider_wait" => "waiting for the inference provider".to_string(),
        "verifying" => format!("verifying{}", activity.tool.as_deref().map(|t| format!(" ({t})")).unwrap_or_default()),
        "compacting" => "compacting the context".to_string(),
        other => other.replace('_', " "),
    };
    if activity.phase != "inference" && activity.phase != "compacting" {
        let phase_elapsed = state.now.saturating_duration_since(activity.since);
        if phase_elapsed >= Duration::from_secs(2) {
            text.push_str(&format!(" {}", clock(phase_elapsed)));
        }
    }
    text
}

/// The busy line: spinner, phase, turn elapsed time, step and segment. Static text when the turn waits on the
/// operator (no animation implies no progress is expected without them).
pub fn activity_line(state: &LiveState) -> String {
    let started = state.turn_started.unwrap_or(state.now);
    let elapsed = state.now.saturating_duration_since(started);
    let mut parts = Vec::new();
    match &state.activity {
        Some(activity) if activity.step > 0 => {
            parts.push(format!("step {}", activity.step));
            if activity.segment > 1 {
                parts.push(format!("segment {}", activity.segment));
            }
        }
        _ => {}
    }
    let tail = if parts.is_empty() { String::new() } else { format!(" · {}", parts.join(" · ")) };
    format!(" {} {} · {}{tail} ", spinner_frame(elapsed), phase_text(state), clock(elapsed))
}

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
            let drawn = render_transcript(frame, rows[1], state);
            layout.scroll_limit = drawn.limit;
            layout.followed = state.follow.then_some(drawn.back);
            layout.top = drawn.top;
            layout.anchored = drawn.anchored;
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
        Some(Overlay::Detail(detail)) => {
            (layout.overlay_rows, layout.overlay_limit) = render_detail(frame, rows[1], detail);
        }
        Some(Overlay::Receipt(panel)) => {
            (layout.overlay_rows, layout.overlay_limit) = render_receipt(frame, rows[1], panel);
        }
        Some(Overlay::Models(picker)) => render_models(frame, rows[1], picker),
        Some(Overlay::Connect(flow)) => render_connect(frame, rows[1], flow),
        Some(Overlay::Paste { number, scroll }) => {
            (layout.overlay_rows, layout.overlay_limit) = render_paste(frame, rows[1], state, *number, *scroll);
        }
        Some(Overlay::Review(review)) => {
            (layout.overlay_rows, layout.overlay_limit, layout.overlay_hlimit) = render_review(frame, rows[1], state, review);
        }
        None => {}
    }
    theme::downsample(frame.buffer_mut(), state.depth);
    layout
}

/// The complete diff of one operation (or the cumulative workspace diff), with hunk and file/edit navigation,
/// vertical and horizontal scrolling and a wrap toggle. Returns the body rows, the largest useful `top` and the
/// largest useful `left`.
fn render_review(frame: &mut Frame, area: Rect, state: &LiveState, review: &DiffReview) -> (usize, usize, usize) {
    let pal = diff_view::palette(state.depth);
    let muted = Style::default().fg(MUTED);
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    // The whole transcript area: tinted transcript rows never show beside the panel.
    let rect = area;
    let (title, between) = match &review.scope {
        ReviewScope::Operation { .. } => (" Edit diff · this operation only ", "edit"),
        ReviewScope::Workspace { .. } => (" Workspace diff · unstaged changes to tracked files (git diff) ", "file"),
    };
    let mut keys = vec![Span::styled(" esc", key), Span::raw(" back  "), Span::styled("↑↓", key), Span::raw(" scroll  ")];
    if !review.wrap {
        keys.extend([Span::styled("←→", key), Span::raw(" pan  ")]);
    }
    keys.extend([Span::styled("n p", key), Span::raw(" hunk  "), Span::styled("[ ]", key), Span::raw(format!(" {between}  "))]);
    keys.extend([Span::styled("w", key), Span::raw(if review.wrap { " no wrap " } else { " wrap " })]);
    if matches!(review.scope, ReviewScope::Operation { .. }) {
        keys.extend([Span::raw(" "), Span::styled("i", key), Span::raw(" call ")]);
    }
    let mut block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(title, Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)))
        .title_bottom(Line::from(keys));
    let inner_width = usize::from(rect.width.saturating_sub(2));
    // The heading: what is shown, the operation's place among this session's edits, and any limit on it.
    let mut head: Vec<Line> = Vec::new();
    match &review.scope {
        ReviewScope::Operation { entry, path } => {
            let card = state.transcript.get(*entry).and_then(Entry::card);
            let edits: Vec<usize> = state.transcript.iter().enumerate().filter(|(_, e)| e.card().is_some()).map(|(i, _)| i).collect();
            let rank = edits.iter().position(|i| i == entry).map_or(0, |p| p + 1);
            let (status, mut counts) = card.map_or((diff_view::Status::Modified, None), |c| (c.status(), c.note.is_none().then_some((c.added as usize, c.removed as usize))));
            // Once the complete diff is loaded, its own counts are authoritative.
            if let Loaded::Ready(content) = &review.content
                && let Some(file) = content.patch.files.first()
                && file.notes.is_empty()
            {
                counts = Some(file.counts());
            }
            let mut spans = diff_view::heading_spans(Vec::new(), status, path, None, counts, usize::MAX / 2, &pal);
            spans.push(Span::styled(format!("   edit {rank} of {}", edits.len()), muted));
            head.extend(wrap_line(Line::from(spans), inner_width));
        }
        ReviewScope::Workspace { .. } => {
            if let Loaded::Ready(content) = &review.content {
                let (added, removed) = content.patch.files.iter().map(diff_view::FilePatch::counts).fold((0, 0), |a, c| (a.0 + c.0, a.1 + c.1));
                let files = content.patch.files.len();
                head.extend(wrap_line(Line::from(vec![
                    Span::styled(format!("{files} file{} changed  ", if files == 1 { "" } else { "s" }), Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
                    Span::styled(format!("+{added}"), Style::default().fg(pal.add_fg)),
                    Span::raw(" "),
                    Span::styled(format!("{}{removed}", diff_view::MINUS), Style::default().fg(pal.del_fg)),
                    Span::styled("   includes changes not made in this session", muted),
                ]), inner_width));
            }
        }
    }
    if let Loaded::Ready(content) = &review.content
        && let Some(limit) = &content.limit
    {
        head.extend(wrap_line(Line::from(Span::styled(diff_view::safe_text(limit), Style::default().fg(Color::Yellow))), inner_width));
    }
    let inner = block.clone().inner(rect);
    let head_rows = u16::try_from(head.len()).unwrap_or(u16::MAX).min(inner.height.saturating_sub(1));
    let body = Rect { y: inner.y + head_rows, height: inner.height - head_rows, ..inner };
    let height = usize::from(body.height);
    let (lines, limit, hlimit) = match &review.content {
        Loaded::Waiting => (vec![Line::from(Span::styled("Loading the complete diff…", muted))], 0, 0),
        Loaded::Failed(message) => (
            vec![
                Line::from(Span::styled(one_line(message), Style::default().fg(Color::Red))),
                Line::from(Span::styled("The preview in the transcript is unchanged.", muted)),
            ],
            0,
            0,
        ),
        Loaded::Ready(content) => {
            let geo = Geometry { width: usize::from(body.width), indent: 1, num_width: content.num_width };
            let hlimit = content.max_width.saturating_sub(geo.content());
            // Clamped here as well as after the frame: a pan past the end must never draw an empty row.
            let fit = if review.wrap { Fit::Wrap } else { Fit::Clip(review.left.min(hlimit)) };
            let row_lines = |row| diff_view::panel_row_lines(&content.patch, row, geo, fit, &pal);
            // The largest `top` that still fills the body: walk up from the last row.
            let mut limit = content.rows.len();
            let mut filled = 0;
            while limit > 0 && filled < height {
                limit -= 1;
                filled += row_lines(content.rows[limit]).len();
            }
            if filled > height {
                limit += 1;
            }
            let limit = limit.min(content.rows.len().saturating_sub(1));
            let top = review.top.min(limit);
            let mut lines = Vec::new();
            for row in content.rows.iter().skip(top) {
                if lines.len() >= height {
                    break;
                }
                lines.extend(row_lines(*row));
            }
            lines.truncate(height);
            if content.rows.is_empty() {
                lines.push(Line::from(Span::styled("The diff has no line changes.", muted)));
            }
            let shown_last = (top + lines.len()).min(content.rows.len());
            block = block.title(
                Line::from(Span::styled(format!(" rows {}–{shown_last} of {} ", top + 1, content.rows.len()), muted)).right_aligned(),
            );
            (lines, limit, hlimit)
        }
    };
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    frame.render_widget(Paragraph::new(head), Rect { height: head_rows, ..inner });
    frame.render_widget(Paragraph::new(lines), body);
    (height, limit, hlimit)
}

/// Breaks a styled line into lines no wider than `width`, after a space or `/` where possible (paths and headings).
fn wrap_line(line: Line<'static>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    // Characters with their styles, then the break points chosen on the plain text.
    let cells: Vec<(char, Style)> = line.spans.iter().flat_map(|span| span.content.chars().map(move |c| (c, span.style))).collect();
    let text: String = cells.iter().map(|(c, _)| *c).collect();
    let rows = diff_view::wrap_at_breaks(&text, width);
    let mut out = Vec::new();
    let mut at = 0;
    for row in rows {
        // Skip the spaces a break consumed.
        while at < cells.len() && cells[at].0 == ' ' && !row.starts_with(' ') {
            at += 1;
        }
        let count = row.chars().count();
        let mut spans: Vec<Span<'static>> = Vec::new();
        for (c, style) in &cells[at..(at + count).min(cells.len())] {
            match spans.last_mut() {
                Some(last) if last.style == *style => last.content.to_mut().push(*c),
                _ => spans.push(Span::styled(c.to_string(), *style)),
            }
        }
        at += count;
        out.push(Line::from(spans));
    }
    out
}

/// A paste buffer's full content, as it will be submitted.
fn render_paste(frame: &mut Frame, area: Rect, state: &LiveState, number: u32, scroll: usize) -> (usize, usize) {
    let muted = Style::default().fg(MUTED);
    let rect = modal(area, area.width, area.height);
    let (title, lines) = match state.composer.paste_buffer(number) {
        Some(paste) => (
            paste.label(),
            paste
                .content
                .split('\n')
                .enumerate()
                .map(|(index, row)| {
                    Line::from(vec![
                        Span::styled(format!("{:>4} ", index + 1), muted),
                        Span::styled(expand_tabs(row).into_owned(), Style::default().fg(Color::White)),
                    ])
                })
                .collect::<Vec<_>>(),
        ),
        None => (format!("Paste #{number}"), vec![Line::from(Span::styled("This paste is no longer in the draft.", muted))]),
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(format!(" {title} "), Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)))
        .title_bottom(key_hints(&[("esc", "close"), ("↑↓", "scroll"), ("ctrl+x", "edit inline")]));
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    scroll_body(frame, inner, lines, scroll)
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
    ("paste", "multi-line or long pastes become [Pasted text #n] buffers; newlines in them never send"),
    ("ctrl+o", "view the paste buffer at the cursor"),
    ("ctrl+d", "review the complete diff of the selected (or newest) edit or /diff"),
    ("ctrl+x", "edit the paste buffer at the cursor as ordinary text"),
    ("backspace", "right after a paste buffer: remove it"),
    (
        "enter (working)",
        "send steering: the agent applies it at its next step; esc cancels the turn",
    ),
    ("/", "slash commands: type / to list them, tab completes"),
    ("/model", "choose a model from the appliance or any connected cloud provider"),
    ("ctrl+p", "in /model: connect a provider (API key or sign-in); /connect opens it directly"),
    (
        "!command",
        "run a shell command directly; !n runs prompt n again",
    ),
    ("tab", "switch between the composer and the transcript"),
    ("pgup / pgdn", "scroll the transcript"),
    (
        "[ / ]",
        "in the transcript: select the previous / next tool call",
    ),
    (
        "enter",
        "in the transcript: open the selected tool call's details",
    ),
    ("v", "in the transcript: open the receipt for the last turn"),
    ("", ""),
    ("", "Diff review (ctrl+d, or enter on an edit)"),
    ("n / p", "next / previous hunk"),
    ("] / [", "next / previous edit (workspace diff: file)"),
    ("← → / 0", "pan long lines; back to the start"),
    ("w", "wrap long lines instead of panning"),
    ("i", "the edit's tool call record"),
    ("note", "edits by file tools show their own diff; changes made by shell commands appear only in /diff"),
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

fn panel_keys() -> Line<'static> {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    Line::from(vec![
        Span::styled(" esc", key),
        Span::raw(" close  "),
        Span::styled("↑↓", key),
        Span::raw(" scroll "),
    ])
}

/// Renders wrapped `lines` from wrapped row `scroll`; returns the visible rows and the largest useful scroll.
fn scroll_body(
    frame: &mut Frame,
    area: Rect,
    lines: Vec<Line<'_>>,
    scroll: usize,
) -> (usize, usize) {
    let rows = usize::from(area.height);
    let total: usize = lines
        .iter()
        .map(|line| wrapped_rows(line, area.width))
        .sum();
    let limit = total.saturating_sub(rows);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((u16::try_from(scroll.min(limit)).unwrap_or(u16::MAX), 0)),
        area,
    );
    (rows, limit)
}

fn duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

/// Draws a tool call's full record; returns the rows available to it and the largest useful scroll.
fn render_detail(frame: &mut Frame, area: Rect, detail: &Detail) -> (usize, usize) {
    let muted = Style::default().fg(MUTED);
    let rect = modal(area, area.width, area.height);
    let block = modal_block(" Tool call ").title_bottom(panel_keys());
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    // The heading names the call, so it keeps its rows before the record gets any.
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
    let title = Line::from(vec![
        Span::styled(
            tool_verb(&detail.tool),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" {}", detail.subject), muted),
    ]);
    let mut status = Vec::new();
    let lines = match &detail.record {
        Loaded::Waiting => vec![Line::from(Span::styled(
            "Loading the recorded call…",
            muted,
        ))],
        Loaded::Failed(message) => vec![Line::from(Span::styled(
            one_line(message),
            Style::default().fg(Color::Red),
        ))],
        Loaded::Ready(record) => {
            let (label, color) = match record.status.as_str() {
                "succeeded" => ("succeeded", Color::Green),
                "failed" => ("failed", Color::Red),
                _ => ("running", ACCENT),
            };
            status.push(Span::styled(label, Style::default().fg(color)));
            if let Some(ms) = record.duration_ms {
                status.push(Span::styled(format!(" · {}", duration(ms)), muted));
            }
            record_lines(record)
        }
    };
    // A long subject (a whole command line) is clipped so the status row stays visible.
    frame.render_widget(Paragraph::new(vec![title, Line::from(status)]), head);
    scroll_body(frame, body, lines, detail.scroll)
}

fn record_lines(record: &ToolRecord) -> Vec<Line<'_>> {
    let heading = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let white = Style::default().fg(Color::White);
    let mut lines = vec![Line::from(Span::styled("Arguments", heading))];
    lines.extend(
        record
            .args
            .split('\n')
            .map(|row| Line::from(Span::styled(expand_tabs(row), white))),
    );
    if let Some(diff) = &record.diff {
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Diff (this call's change only)", heading)));
        lines.extend(
            diff.split('\n')
                .map(|row| Line::from(Span::styled(expand_tabs(&diff_view::safe_text(row)).into_owned(), line_style(diff_row_kind(row))))),
        );
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled("Output", heading)));
    if record.output.is_empty() {
        let empty = if record.status == "running" {
            "(still running)"
        } else {
            "(no output)"
        };
        lines.push(Line::from(Span::styled(empty, Style::default().fg(MUTED))));
    } else {
        lines.extend(
            record
                .output
                .split('\n')
                .map(|row| Line::from(Span::styled(expand_tabs(row), white))),
        );
    }
    lines
}

/// Draws the receipt panel; returns its visible rows and the largest useful scroll.
fn render_receipt(frame: &mut Frame, area: Rect, panel: &ReceiptPanel) -> (usize, usize) {
    let muted = Style::default().fg(MUTED);
    let lines = match &panel.sections {
        Loaded::Waiting => vec![Line::from(Span::styled("Loading the receipt…", muted))],
        Loaded::Failed(message) => vec![Line::from(Span::styled(
            one_line(message),
            Style::default().fg(Color::Red),
        ))],
        Loaded::Ready(sections) => receipt_lines(sections),
    };
    let inner_width = area.width.saturating_sub(2).min(96).saturating_sub(2);
    let content: usize = lines
        .iter()
        .map(|line| wrapped_rows(line, inner_width))
        .sum();
    let wanted = u16::try_from(content.saturating_add(2)).unwrap_or(u16::MAX);
    let rect = modal(area, 96, wanted);
    let block = modal_block(" Receipt ").title_bottom(panel_keys());
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    scroll_body(frame, inner, lines, panel.scroll)
}

fn receipt_lines(sections: &[ReceiptSection]) -> Vec<Line<'_>> {
    let heading = Style::default()
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);
    let muted = Style::default().fg(MUTED);
    let mut lines = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        if index > 0 {
            lines.push(Line::default());
        }
        lines.push(Line::from(Span::styled(one_line(&section.title), heading)));
        for (label, value) in &section.rows {
            lines.push(Line::from(vec![
                Span::styled(format!("  {:<15}", one_line(label)), muted),
                Span::styled(one_line(value), Style::default().fg(verdict_color(value))),
            ]));
        }
        if let Some(note) = &section.note {
            lines.push(Line::from(Span::styled(
                format!("  {}", one_line(note)),
                muted,
            )));
        }
    }
    lines
}

/// Colours outcome words in the receipt; every other value stays white.
fn verdict_color(value: &str) -> Color {
    match value {
        "PASSED" | "VERIFIED" | "COMPLETED" | "success" => Color::Green,
        "FAILED" | "INVALIDATED" | "NOT_ESTABLISHED" | "INTERRUPTED" | "BLOCKED"
        | "LIMIT_REACHED" | "failure" => Color::Red,
        "UNVERIFIED" => Color::Yellow,
        _ => Color::White,
    }
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
    let elapsed = state
        .now
        .saturating_duration_since(state.turn_started.unwrap_or(state.now));
    let busy = Span::styled(
        format!(" {} working · esc to cancel ", spinner_frame(elapsed)),
        Style::default().fg(ACCENT),
    );
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

/// What the transcript frame drew, for `LiveLayout`.
struct TranscriptFrame {
    /// Largest useful `scroll_back` (`usize::MAX` when the walk stopped before the first entry).
    limit: usize,
    /// The `scroll_back` drawn.
    back: usize,
    /// The row at the top of the window: (entry index, rows from it to the end of its entry).
    top: Option<(usize, usize)>,
    /// Set when the window was kept on `LiveState::anchor`: the `scroll_back` that took.
    anchored: Option<usize>,
}

/// Renders the transcript window `scroll_back` rows above the newest line, with the selected entry highlighted.
/// With `follow`, the window first moves the least distance that shows the whole selected entry above the bottom row
/// (its top when it is taller than the window). While scrolled back, the window stays on the row it showed at its
/// top (`LiveState::anchor`) as entries arrive or grow below it, so reading is never interrupted by a scroll jump.
/// Only the entries needed to fill the window are laid out, so the cost follows the window, not the transcript.
fn render_transcript(frame: &mut Frame, area: Rect, state: &LiveState) -> TranscriptFrame {
    let transcript = &state.transcript;
    let selected = state.selected.filter(|_| state.focus == Focus::Transcript);
    let height = usize::from(area.height);
    let pal = diff_view::palette(state.depth);
    let selected_reviewable = selected.filter(|&i| transcript.get(i).is_some_and(Entry::reviewable));
    let lines_of = |index: usize| -> Vec<Line<'_>> {
        let review_hint = if selected == Some(index) {
            "enter to review"
        } else if selected_reviewable.is_none() && state.last_reviewable == Some(index) {
            "ctrl+d to review"
        } else {
            "tab, [ ] to select, enter to review"
        };
        entry_lines(
            &transcript[index],
            &EntryContext {
                first: index == 0,
                width: area.width,
                selected: selected == Some(index),
                after_card: index > 0 && transcript[index - 1].card().is_some(),
                review_hint,
                pal: &pal,
            },
        )
    };
    let rows_of = |lines: &[Line<'_>]| lines.iter().map(|line| wrapped_rows(line, area.width)).sum::<usize>();
    let mut back = state.scroll_back;
    let mut anchored = None;
    let mut target = selected.filter(|_| state.follow);
    if back > 0
        && target.is_none()
        && let Some((entry, rows_in_entry)) = state.anchor
        && entry < transcript.len()
    {
        let below: usize = (entry + 1..transcript.len()).map(|i| rows_of(&lines_of(i))).sum();
        back = (rows_in_entry + below).saturating_sub(height);
        anchored = Some(back);
    }
    // Walked from the newest line up: (line, its rows, entry index, rows from it to its entry's end, rows from it to
    // the bottom).
    let mut tail = Vec::new();
    let mut total: usize = 0;
    let mut reached_top = true;
    'entries: for index in (0..transcript.len()).rev() {
        let below = total;
        let mut in_entry = 0;
        for line in lines_of(index).into_iter().rev() {
            let rows = wrapped_rows(&line, area.width);
            total = total.saturating_add(rows);
            in_entry += rows;
            tail.push((line, rows, index, in_entry, total));
            if target.is_none() && total >= height.saturating_add(back) {
                reached_top = false;
                break 'entries;
            }
        }
        if target == Some(index) {
            // One row short of the bottom, where the scroll badge would cover the entry.
            back = back
                .min(below.saturating_sub(1))
                .max(total.saturating_sub(height));
            target = None;
            if total >= height.saturating_add(back) {
                reached_top = false;
                break;
            }
        }
    }
    let limit = if reached_top {
        total.saturating_sub(height)
    } else {
        usize::MAX
    };
    let back = back.min(limit);
    let first_row = total.saturating_sub(height.saturating_add(back));
    let reach = height.saturating_add(back);
    let top = tail
        .iter()
        .find(|(_, _, _, _, to_bottom)| *to_bottom >= reach)
        .map(|(_, _, index, in_entry, to_bottom)| (*index, in_entry - (to_bottom - reach)));
    tail.reverse();
    let mut skipped = 0;
    let mut covered = 0;
    let mut lines = Vec::new();
    for (line, rows, ..) in tail {
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
    TranscriptFrame { limit, back, top, anchored }
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

/// How one transcript entry is drawn: its place and the frame it is drawn into.
struct EntryContext<'a> {
    first: bool,
    width: u16,
    selected: bool,
    /// The entry before it is an edit card (a plain tool row then opens with a blank row, so cards stay separated).
    after_card: bool,
    /// The control that opens this entry's complete diff, as the omission line names it.
    review_hint: &'a str,
    pal: &'a Palette,
}

/// Lines for one transcript entry. Entries that open with a blank separator drop it when they come first.
fn entry_lines<'a>(entry: &'a Entry, ctx: &EntryContext<'_>) -> Vec<Line<'a>> {
    let white = Style::default().fg(Color::White);
    let muted = Style::default().fg(MUTED);
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let highlight = Style::default().bg(SELECTED).add_modifier(Modifier::BOLD);
    let width = usize::from(ctx.width);
    let card_context = |glyph: (&'static str, Color)| CardContext {
        width,
        glyph,
        selected: ctx.selected.then_some(highlight),
        review_hint: ctx.review_hint,
    };
    let mut lines = Vec::new();
    match entry {
        // An edit that succeeded (or is finishing) shows its change as a card on its own tool row.
        Entry::Tool { status, diff: Some(card), .. } if *status != ToolStatus::Failed => {
            let glyph = match status {
                ToolStatus::Running => ("•", ACCENT),
                ToolStatus::Interrupted => ("◌", Color::Yellow),
                _ => ("✓", Color::Green),
            };
            let mut lines = diff_view::card_lines(card, ctx.pal, &card_context(glyph));
            if ctx.first {
                lines.remove(0);
            }
            return lines;
        }
        Entry::Diff { card, .. } => {
            let mut lines = diff_view::card_lines(card, ctx.pal, &card_context(("✓", Color::Green)));
            if ctx.first {
                lines.remove(0);
            }
            return lines;
        }
        Entry::Output { success: true, text, diff: true } => {
            if let Some(lines) = diff_view::workspace_lines(text, ctx.pal, width, ctx.selected.then_some(highlight), ctx.review_hint) {
                return lines;
            }
            lines.extend(text.split('\n').map(|row| {
                Line::from(Span::styled(format!("  {}", expand_tabs(&diff_view::safe_text(row))), line_style(diff_row_kind(row))))
            }));
        }
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
            if ctx.after_card {
                lines.push(Line::default());
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
        Entry::Steer {
            text,
            state,
            message,
            ..
        } => {
            let (label, color) = match state {
                SteerState::Sending => ("sending", ACCENT),
                SteerState::Queued => ("queued for the next step", ACCENT),
                SteerState::Applied => ("applied", Color::Green),
                SteerState::Deferred => ("starts a follow-up turn", ACCENT),
                SteerState::Cancelled => ("not applied", Color::Yellow),
                SteerState::Rejected => ("not applied", Color::Yellow),
                SteerState::Duplicate => ("already received", MUTED),
                SteerState::Lost => ("not delivered", Color::Red),
            };
            lines.push(Line::default());
            for (index, row) in text.split('\n').enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(if index == 0 { "↳ " } else { "  " }, prompt),
                    Span::styled(expand_tabs(row), white),
                ]));
            }
            let mut status = vec![Span::styled(format!("  steering · {label}"), Style::default().fg(color))];
            if !message.is_empty() && !matches!(state, SteerState::Queued | SteerState::Applied) {
                status.push(Span::styled(format!(" — {}", one_line(message)), muted));
            }
            lines.push(Line::from(status));
        }
    }
    if ctx.first && lines.first().is_some_and(|line| line.spans.is_empty()) {
        lines.remove(0);
    }
    if ctx.selected {
        lines = lines.into_iter().map(|line| line.patch_style(highlight)).collect();
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

fn composer_hint(state: &LiveState) -> Cow<'static, str> {
    let hint = match (&state.link, state.session.busy) {
        _ if state.closing => " shutting down the agent… ",
        (Link::Crashed { .. }, _) => " r restart · q quit ",
        _ if state.connecting() => " starting the agent… ",
        _ if matches!(state.overlay, Some(Overlay::Approval(_))) => {
            " approval needed · y approve · n deny "
        }
        _ if matches!(state.overlay, Some(Overlay::Help { .. })) => " esc close help ",
        _ if matches!(state.overlay, Some(Overlay::Review(_))) => " reviewing a diff · esc returns to the transcript and your draft ",
        _ if state.overlay.is_some() => " esc close · ↑↓ scroll ",
        _ if state.completion().is_some() => " tab complete · enter run · esc close ",
        _ if state.focus == Focus::Transcript => {
            " transcript · ↑↓ scroll · [ ] tools · enter details · ctrl+d diff · v receipt · tab back "
        }
        _ if state.composer.paste_at_cursor().is_some() => {
            " ctrl+o view paste · ctrl+x edit inline · backspace remove "
        }
        (_, true) if state.cancel_requested() => {
            let elapsed = state.now.saturating_duration_since(state.turn_started.unwrap_or(state.now));
            return Cow::Owned(format!(" {} cancelling… ctrl-c again to quit ", spinner_frame(elapsed)));
        }
        (_, true) if !state.composer.is_empty() => {
            return Cow::Owned(format!("{}· enter steers ", activity_line(state)));
        }
        (_, true) => return Cow::Owned(activity_line(state)),
        (_, false) => " enter send · shift+enter newline · ? help ",
    };
    Cow::Borrowed(hint)
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

    #[test]
    fn the_activity_indicator_animates_from_the_clock_and_shows_phase_elapsed_and_step() {
        let mut state = ready();
        feed(&mut state, &[BUSY, r#"{"v":1,"type":"activity","turn_id":"t1","phase":"tool","step":31,"segment":2,"tool":"run_command","subject":"make test"}"#]);
        let start = state.turn_started.unwrap();
        state.set_now(start + std::time::Duration::from_millis(65_150));
        let a = draw(&state, 120, 12);
        assert_shows(&a, &["⠙ Run make test", "1:05", "step 31 · segment 2"]);
        state.set_now(start + std::time::Duration::from_millis(65_250));
        let b = draw(&state, 120, 12);
        assert_ne!(a, b, "the next frame differs without any sidecar event");
        assert_eq!(spinner_frame(std::time::Duration::from_millis(0)), "⠋");
        assert_eq!(clock(std::time::Duration::from_secs(3725)), "1:02:05");
    }

    #[test]
    fn the_indicator_says_what_it_waits_for_and_stops_on_completion_and_disconnection() {
        let mut state = ready();
        feed(&mut state, &[BUSY]);
        assert_shows(&draw(&state, 100, 12), &["waiting for the agent"]);
        feed(&mut state, &[r#"{"v":1,"type":"activity","turn_id":"t1","phase":"provider_wait","step":3,"segment":1}"#]);
        assert_shows(&draw(&state, 100, 12), &["waiting for the inference provider"]);
        feed(&mut state, &[r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x","preview":"{}"}"#]);
        assert_shows(&draw(&state, 100, 12), &["approval needed"]);
        state.overlay = None;
        feed(&mut state, &[IDLE]);
        let idle = draw(&state, 100, 12);
        assert!(!idle.contains("working") && idle.contains("enter send"), "{idle}");
        feed(&mut state, &[BUSY]);
        state.fail("gone".into(), None, Vec::new());
        assert!(!draw(&state, 100, 12).contains("esc to cancel"));
    }

    #[test]
    fn diff_entries_and_steering_render_readably_and_the_detail_shows_the_whole_diff() {
        let mut state = ready();
        feed(&mut state, &[
            BUSY,
            r#"{"v":1,"type":"file.diff","turn_id":"t1","call_id":"c1","evidence":"e1","path":"src/a.ts","kind":"modified","added":2,"removed":1,"preview":"--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n ctx","truncated":true,"total_lines":120}"#,
            r#"{"v":1,"type":"file.diff","turn_id":"t1","call_id":"c2","evidence":"e2","path":"gone.txt","kind":"deleted","added":0,"removed":3,"preview":"","truncated":false,"total_lines":0}"#,
        ]);
        state.composer = "keep the CSV format".into();
        state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let screen = draw(&state, 100, 24);
        assert_shows(&screen, &["✓ Edited src/a.ts  +2 −1", "▎ 1   − old", "▎   1 + new", "… 113 more lines", "✓ Deleted gone.txt  +0 −3", "↳ keep the CSV format", "steering · sending"]);
        state.overlay = Some(Overlay::Detail(Detail {
            request: "d1".into(),
            tool: "edit_file".into(),
            subject: "src/a.ts".into(),
            record: Loaded::Ready(ToolRecord {
                status: "succeeded".into(),
                args: "{}".into(),
                output: "ok".into(),
                duration_ms: Some(3),
                diff: Some("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -100 +100 @@\n-line 100\n+line one hundred".into()),
            }),
            scroll: 0,
        }));
        assert_shows(&draw(&state, 100, 24), &["Diff (this call's change only)", "+line one hundred"]);
    }

    #[test]
    fn a_paste_buffer_shows_compactly_in_the_composer_and_fully_in_its_panel() {
        let mut state = ready();
        state.on_paste(&(1..=24).map(|n| format!("row {n}")).collect::<Vec<_>>().join("\n"));
        assert_shows(&draw(&state, 80, 20), &["› [Pasted text #1: 24 lines]", "ctrl+o view paste"]);
        state.on_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));
        assert_shows(&draw(&state, 80, 30), &["Pasted text #1: 24 lines", "   1 row 1", "  20 row 20"]);
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
            status.contains("NEXUS") && status.contains("working · esc to cancel"),
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
                "transcript · ↑↓ scroll · [ ] tools · enter details · ctrl+d diff · v receipt · tab back",
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
            &draw(&state, 100, 60),
            &[
                "Keys",
                "shift+enter",
                "ctrl+c",
                "approve this action",
                "esc close help",
                "ctrl+o",
                "enter (working)",
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
                "Workspace diff (git diff: unstaged changes to tracked files)",
                "Edited x  +1 −1",
                "▎ 1   − old",
                "▎   1 + new",
                "  Commit failed: nothing staged",
                "  · Resumed session a.",
            ],
        );
        let lines = rows(&screen);
        for (text, color) in [
            ("+ new", Color::Rgb(126, 231, 135)),
            ("− old", Color::Rgb(255, 138, 138)),
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
            &draw(&state, 100, 60),
            &[
                "Keys",
                "!command",
                "Commands",
                "/diff",
                "Uncommitted changes as a diff",
            ],
        );
    }

    fn with_tool(evidence: &str) -> LiveState {
        let mut state = ready();
        feed(
            &mut state,
            &[
                &format!(
                    r#"{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"a.ts","evidence":"{evidence}"}}"#
                ),
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"ok","lines":1}"#,
            ],
        );
        state
    }

    fn press_key(state: &mut LiveState, code: KeyCode) {
        state.on_key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    /// Background, foreground and modifiers of the cell where `text` starts.
    fn cell_at(state: &LiveState, width: u16, height: u16, text: &str) -> (Color, Color, Modifier) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, state);
            })
            .unwrap();
        let lines = rows(&terminal.backend().to_string());
        let row = lines.iter().position(|line| line.contains(text)).unwrap();
        let column = lines[row].find(text).unwrap();
        let x = u16::try_from(lines[row][..column].chars().count()).unwrap();
        let cell = &terminal.backend().buffer()[(x, u16::try_from(row).unwrap())];
        (cell.bg, cell.fg, cell.modifier)
    }

    #[test]
    fn the_selected_tool_is_highlighted_while_the_transcript_has_focus() {
        let mut state = with_tool("e1");
        press_key(&mut state, KeyCode::Tab);
        press_key(&mut state, KeyCode::Char('['));
        assert_eq!(cell_at(&state, 80, 20, "a.ts").0, SELECTED);
        assert!(
            cell_at(&state, 80, 20, "a.ts").2.contains(Modifier::BOLD),
            "the selection shows without colour too"
        );
        press_key(&mut state, KeyCode::Tab);
        assert_ne!(cell_at(&state, 80, 20, "a.ts").0, SELECTED);
    }

    #[test]
    fn selecting_a_tool_above_the_window_scrolls_it_into_view_once() {
        let mut state = with_tool("e1");
        let long: Vec<String> = (1..=60).map(|n| format!("line {n}")).collect();
        state.transcript.push(Entry::Assistant {
            turn_id: "t1".into(),
            text: long.join("\n"),
        });
        press_key(&mut state, KeyCode::Tab);
        press_key(&mut state, KeyCode::Char('['));
        let (screen, layout) = draw_measured(&state, 80, 20);
        assert_shows(&screen, &["a.ts"]);
        let back = layout.followed.expect("the frame followed the selection");
        assert_eq!(
            back, 45,
            "the window moved just far enough to show the call"
        );
        state.note_layout(layout);
        assert_eq!((state.scroll_back, state.follow), (back, false));
        let (_, again) = draw_measured(&state, 80, 20);
        assert_eq!(again.followed, None);
    }

    #[test]
    fn the_detail_panel_shows_status_arguments_and_output() {
        let mut state = with_tool("e1");
        press_key(&mut state, KeyCode::Tab);
        press_key(&mut state, KeyCode::Char('['));
        press_key(&mut state, KeyCode::Enter);
        assert_shows(
            &draw(&state, 80, 24),
            &[
                "Tool call",
                "Loading the recorded call…",
                "esc close · ↑↓ scroll",
            ],
        );
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"tool.detail","id":"d1","evidence":"e1","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{\n  \"path\": \"a.ts\"\n}","output":"const a = 1;\nconst b = 2;","duration_ms":1500}"#,
            ],
        );
        assert_shows(
            &draw(&state, 80, 24),
            &[
                "Read a.ts",
                "succeeded · 1.5 s",
                "Arguments",
                "\"path\": \"a.ts\"",
                "Output",
                "const b = 2;",
            ],
        );
    }

    #[test]
    fn a_newer_selected_call_is_not_hidden_under_the_scroll_badge() {
        let mut state = with_tool("e1");
        let long: Vec<String> = (1..=60).map(|n| format!("line {n}")).collect();
        let filler = |state: &mut LiveState| {
            state.transcript.push(Entry::Assistant {
                turn_id: "t1".into(),
                text: long.join("\n"),
            })
        };
        filler(&mut state);
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"b","tool":"read_file","subject":"b.ts","evidence":"e2"}"#,
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"b","tool":"read_file","success":true,"summary":"ok","lines":1}"#,
            ],
        );
        filler(&mut state);
        press_key(&mut state, KeyCode::Tab);
        for code in [KeyCode::Char('['), KeyCode::Char('['), KeyCode::Char(']')] {
            press_key(&mut state, code);
            let (_, layout) = draw_measured(&state, 80, 20);
            state.note_layout(layout);
        }
        let screen = draw(&state, 80, 20);
        let lines = rows(&screen);
        let row = lines
            .iter()
            .find(|line| line.contains("b.ts"))
            .expect("b.ts is on screen");
        assert!(!row.contains("more rows"), "{screen}");
        assert_shows(&screen, &["more rows"]);
    }

    #[test]
    fn a_long_subject_leaves_the_status_visible_and_failures_keep_their_lines() {
        let mut state = ready();
        state.overlay = Some(Overlay::Detail(Detail {
            request: "d1".into(),
            tool: "run_command".into(),
            subject: "x".repeat(190),
            record: Loaded::Ready(ToolRecord {
                status: "failed".into(),
                args: "{}".into(),
                output: String::new(),
                duration_ms: Some(1500),
                diff: None,
            }),
            scroll: 0,
        }));
        assert_shows(&draw(&state, 80, 24), &["failed · 1.5 s", "Arguments"]);
        assert_shows(&draw(&state, 40, 12), &["failed · 1.5 s"]);
        state.overlay = Some(Overlay::Detail(Detail {
            request: "d1".into(),
            tool: "read_file".into(),
            subject: "a.ts".into(),
            record: Loaded::Failed("NOT_FOUND: line one\nline two".into()),
            scroll: 0,
        }));
        assert_shows(&draw(&state, 80, 24), &["line one line two"]);
    }

    #[test]
    fn the_receipt_panel_lists_sections_rows_and_notes() {
        let mut state = ready();
        press_key(&mut state, KeyCode::Tab);
        assert_shows(
            &draw(&state, 100, 24),
            &["[ ] tools · enter details · ctrl+d diff · v receipt · tab back"],
        );
        press_key(&mut state, KeyCode::Char('v'));
        feed(
            &mut state,
            &[
                r#"{"v":1,"type":"receipt","id":"r1","sections":[{"title":"Last turn","rows":[["execution","COMPLETED"],["outcome","VERIFIED"]]},{"title":"Validation receipt","rows":[],"note":"No validation receipt is active."}]}"#,
            ],
        );
        assert_shows(
            &draw(&state, 100, 24),
            &[
                "Receipt",
                "Last turn",
                "outcome",
                "Validation receipt",
                "No validation receipt is active.",
            ],
        );
        assert_eq!(cell_at(&state, 100, 24, "VERIFIED").1, Color::Green);
    }

    const CATALOG: &str = r#"{"v":1,"type":"models.catalog","id":"ID","providers":[{"id":"appliance","label":"Appliance (10.0.8.5:8443)","disclosure":"local","connected":true,"methods":[],"status":"ok"},{"id":"chatgpt","label":"ChatGPT plan","disclosure":"cloud","connected":true,"source":"Codex CLI","external":true,"methods":[{"id":"chatgpt-oauth","label":"Sign in with ChatGPT (unofficial)","kind":"browser","unofficial":true}],"status":"ok"},{"id":"anthropic","label":"Anthropic","disclosure":"cloud","connected":false,"methods":[{"id":"api-key","label":"API key","kind":"key"}],"status":"disconnected"}],"models":[{"provider":"appliance","id":"engineering/b0"},{"provider":"chatgpt","id":"gpt-5-codex"}],"current":{"provider":"appliance","model":"engineering/b0"},"recent":[]}"#;

    #[test]
    fn model_picker_groups_providers_marks_current_and_offers_connect() {
        let mut state = ready();
        for c in "/model".chars() {
            state.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let screen = draw(&state, 100, 24);
        assert!(screen.contains("Select model"));
        assert!(screen.contains("Listing models"));
        feed(&mut state, &[&CATALOG.replace("\"ID\"", "\"m1\"")]);
        let screen = draw(&state, 100, 24);
        assert!(screen.contains("Appliance (10.0.8.5:8443)"), "{screen}");
        assert!(screen.contains("● engineering/b0"), "{screen}");
        assert!(screen.contains("via Codex CLI"), "{screen}");
        assert!(screen.contains("+ Connect Anthropic"), "{screen}");
        assert!(screen.contains("ctrl+p"), "{screen}");
    }

    #[test]
    fn key_entry_is_masked_and_unofficial_sign_in_is_labelled() {
        let mut state = ready();
        for c in "/model".chars() {
            state.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        feed(&mut state, &[&CATALOG.replace("\"ID\"", "\"m1\"")]);
        state.on_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
        let screen = draw(&state, 100, 24);
        assert!(screen.contains("Connect a provider"), "{screen}");
        assert!(screen.contains("connected via Codex CLI"), "{screen}");
        assert!(screen.contains("unofficial sign-in"), "{screen}");
        state.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        state.on_paste("sk-ant-VISIBLE-NEVER");
        let screen = draw(&state, 100, 24);
        assert!(!screen.contains("VISIBLE"), "the key is never drawn: {screen}");
        assert!(screen.contains("••••"), "{screen}");
        assert!(screen.contains("20 characters"), "{screen}");
    }

}


// ---------------------------------------------------------------- model picker and provider connection

fn titled_block(title: String) -> Block<'static> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(title, Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)))
}

fn key_hints(pairs: &[(&'static str, &'static str)]) -> Line<'static> {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let mut spans = Vec::new();
    for (k, text) in pairs {
        spans.push(Span::styled(format!(" {k}"), key));
        spans.push(Span::styled(format!(" {text} "), Style::default().fg(MUTED)));
    }
    Line::from(spans)
}

/// Draws `lines` in `area`, scrolled so that line `focus` is visible.
fn list_window(frame: &mut Frame, area: Rect, lines: Vec<Line<'_>>, focus: usize) {
    let rows = usize::from(area.height);
    let offset = if rows == 0 { 0 } else { (focus + 1).saturating_sub(rows) };
    let shown: Vec<Line> = lines.into_iter().skip(offset).take(rows).collect();
    frame.render_widget(Paragraph::new(shown), area);
}

fn render_models(frame: &mut Frame, area: Rect, picker: &Picker) {
    let rect = modal(area, 96, area.height);
    let title = match (&picker.only, &picker.catalog) {
        (Some(only), Fetch::Ready(catalog)) => {
            let label = catalog.providers.iter().find(|p| &p.id == only).map_or(only.as_str(), |p| p.label.as_str());
            format!(" Select model — {label} ")
        }
        _ => " Select model ".to_string(),
    };
    let block = titled_block(title);
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    if inner.height < 3 {
        return;
    }
    let search = Rect::new(inner.x, inner.y, inner.width, 1);
    let list = Rect::new(inner.x, inner.y + 2, inner.width, inner.height.saturating_sub(3));
    let footer = Rect::new(inner.x, inner.bottom() - 1, inner.width, 1);
    let prompt = Span::styled("› ", Style::default().fg(ACCENT).add_modifier(Modifier::BOLD));
    let query = if picker.query.is_empty() {
        Span::styled("type to filter by provider or model", Style::default().fg(MUTED))
    } else {
        Span::styled(format!("{}▏", picker.query), Style::default().fg(Color::White))
    };
    frame.render_widget(Paragraph::new(Line::from(vec![prompt, query])), search);
    frame.render_widget(
        Paragraph::new(key_hints(&[("enter", "use"), ("ctrl+p", "connect a provider"), ("↑↓", "move"), ("esc", "close")])),
        footer,
    );
    match &picker.catalog {
        Fetch::Waiting => frame.render_widget(
            Paragraph::new(Span::styled("Listing models from the appliance and connected providers…", Style::default().fg(MUTED))),
            list,
        ),
        Fetch::Failed(message) => frame.render_widget(
            Paragraph::new(Span::styled(format!("Could not list models: {message}"), Style::default().fg(Color::Red)))
                .wrap(Wrap { trim: false }),
            list,
        ),
        Fetch::Ready(_) => {
            let rows = picker.rows();
            let selected = picker.selected().map(|(index, _)| index);
            let filtered = !picker.query.trim().is_empty();
            if rows.is_empty() {
                frame.render_widget(Paragraph::new(Span::styled("No model matches.", Style::default().fg(MUTED))), list);
                return;
            }
            let mut in_recent = false;
            let lines: Vec<Line> = rows
                .iter()
                .enumerate()
                .map(|(index, row)| {
                    let highlight = Some(index) == selected;
                    let base = if highlight { Style::default().fg(Color::Black).bg(ACCENT) } else { Style::default().fg(Color::White) };
                    match row {
                        Row::Header { title, detail } => {
                            in_recent = title == "Recent";
                            Line::from(vec![
                                Span::styled(title.clone(), Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
                                Span::styled(if detail.is_empty() { String::new() } else { format!("  {detail}") }, Style::default().fg(MUTED)),
                            ])
                        }
                        Row::Model { model, provider_label, current, .. } => {
                            let marker = if *current { "● " } else { "  " };
                            let mut spans = vec![Span::styled(format!("  {marker}{model}"), if *current && !highlight { base.fg(ACCENT) } else { base })];
                            if filtered || in_recent {
                                spans.push(Span::styled(format!("  {provider_label}"), if highlight { base } else { Style::default().fg(MUTED) }));
                            }
                            Line::from(spans)
                        }
                        Row::Connect { label, .. } => Line::from(Span::styled(
                            format!("  + Connect {label}…"),
                            if highlight { base } else { Style::default().fg(Color::Yellow) },
                        )),
                        Row::Note(note) => Line::from(Span::styled(format!("  {note}"), Style::default().fg(MUTED).add_modifier(Modifier::ITALIC))),
                    }
                })
                .collect();
            list_window(frame, list, lines, selected.unwrap_or(0));
        }
    }
}

fn render_connect(frame: &mut Frame, area: Rect, flow: &Connect) {
    let rect = modal(area, 96, area.height.min(24));
    let block = titled_block(" Connect a provider ".into());
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    if inner.height < 3 {
        return;
    }
    let white = Style::default().fg(Color::White);
    let muted = Style::default().fg(MUTED);
    let warn = Style::default().fg(Color::Yellow);
    let selected = Style::default().fg(Color::Black).bg(ACCENT);
    let mut lines: Vec<Line> = Vec::new();
    if let Some((ok, message)) = &flow.notice {
        lines.push(Line::from(Span::styled(message.clone(), Style::default().fg(if *ok { Color::Green } else { Color::Red }))));
        lines.push(Line::default());
    }
    let label = |id: &str| flow.provider(id).map_or_else(|| id.to_string(), |p| p.label.clone());
    let mut focus = 0;
    let hints: &[(&'static str, &'static str)] = match &flow.step {
        Step::Providers { pick } => {
            for (index, p) in flow.list().iter().enumerate() {
                if index == *pick {
                    focus = lines.len();
                }
                let (mark, mark_style) = if p.connected { ("✓", Style::default().fg(Color::Green)) } else { ("○", muted) };
                let status = match (&p.source, p.connected) {
                    (Some(source), true) => format!("connected via {source}"),
                    _ => "not connected".to_string(),
                };
                let unofficial = p.methods.iter().any(|m| m.unofficial);
                let row = if index == *pick { selected } else { white };
                lines.push(Line::from(vec![
                    Span::styled(format!(" {mark} "), if index == *pick { selected } else { mark_style }),
                    Span::styled(format!("{:<20}", p.label), row),
                    Span::styled(format!(" {status}"), if index == *pick { selected } else { muted }),
                    Span::styled(if unofficial { "  unofficial sign-in".to_string() } else { String::new() }, if index == *pick { selected } else { warn }),
                ]));
            }
            &[("enter", "connect"), ("ctrl+d", "remove Nexus's saved credential"), ("esc", "back to models")]
        }
        Step::Methods { provider, pick } => {
            lines.push(Line::from(Span::styled(format!("How do you want to connect {}?", label(provider)), white.add_modifier(Modifier::BOLD))));
            lines.push(Line::default());
            let methods = flow.methods(provider);
            for (index, m) in methods.iter().enumerate() {
                if index == *pick {
                    focus = lines.len();
                }
                lines.push(Line::from(Span::styled(format!("  {}", m.label), if index == *pick { selected } else { white })));
            }
            if methods.get(*pick).is_some_and(|m| m.unofficial) {
                lines.push(Line::default());
                lines.push(Line::from(Span::styled(
                    "Unofficial: this signs in as another vendor's client. The provider's terms may not permit it.",
                    warn,
                )));
            }
            &[("enter", "choose"), ("esc", "back")]
        }
        Step::Key { provider, input, error } => {
            lines.push(Line::from(Span::styled(format!("{} API key", label(provider)), white.add_modifier(Modifier::BOLD))));
            lines.push(Line::default());
            let dots = "•".repeat(input.chars().count().min(48));
            lines.push(Line::from(vec![
                Span::styled("› ", Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)),
                Span::styled(format!("{dots}▏"), white),
                Span::styled(if input.is_empty() { String::new() } else { format!("  {} characters", input.chars().count()) }, muted),
            ]));
            focus = lines.len() - 1;
            if let Some(error) = error {
                lines.push(Line::from(Span::styled(error.clone(), Style::default().fg(Color::Red))));
            }
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                format!("Paste or type the key. Nexus checks it with {} before saving it to ~/.config/nexus/credentials.json (owner-only).", label(provider)),
                muted,
            )));
            &[("enter", "verify and save"), ("ctrl+u", "clear"), ("esc", "back")]
        }
        Step::Waiting { provider, method, auth, .. } => {
            match auth {
                None if method == "api-key" => lines.push(Line::from(Span::styled(format!("Checking the key with {}…", label(provider)), white))),
                None => lines.push(Line::from(Span::styled(format!("Starting {} sign-in…", label(provider)), white))),
                Some(info) => {
                    lines.push(Line::from(Span::styled(info.instructions.clone(), white)));
                    lines.push(Line::default());
                    lines.push(Line::from(vec![Span::styled("Open  ", muted), Span::styled(info.url.clone(), Style::default().fg(ACCENT).add_modifier(Modifier::UNDERLINED))]));
                    if let Some(code) = &info.user_code {
                        lines.push(Line::from(vec![Span::styled("Code  ", muted), Span::styled(code.clone(), white.add_modifier(Modifier::BOLD))]));
                    }
                    lines.push(Line::default());
                    lines.push(Line::from(Span::styled("Waiting for you to finish in the browser…", muted)));
                }
            }
            if auth.is_some() { &[("esc", "cancel sign-in")] } else { &[("esc", "back")] }
        }
    };
    let body = Rect::new(inner.x, inner.y, inner.width, inner.height.saturating_sub(1));
    let footer = Rect::new(inner.x, inner.bottom() - 1, inner.width, 1);
    if matches!(flow.step, Step::Providers { .. } | Step::Methods { .. }) {
        list_window(frame, body, lines, focus);
    } else {
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), body);
    }
    frame.render_widget(Paragraph::new(key_hints(hints)), footer);
}

#[cfg(test)]
mod diff_tests {
    //! The edit cards, the workspace diff and the review panel as the operator sees them.
    use super::*;
    use crate::live_state::{Action, ReviewContent};
    use crate::protocol::{Command, parse_event};
    use crate::theme::Depth;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    const HELLO: &str = r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#;
    const BUSY: &str = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":true}"#;

    fn state() -> LiveState {
        let mut state = LiveState::new();
        feed(&mut state, &[HELLO, BUSY]);
        state
    }

    fn feed(state: &mut LiveState, lines: &[&str]) {
        for line in lines {
            state.apply(parse_event(line).unwrap());
        }
    }

    fn draw(state: &mut LiveState, width: u16, height: u16) -> Terminal<TestBackend> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut layout = LiveLayout::default();
        terminal.draw(|frame| layout = render_live(frame, state)).unwrap();
        state.note_layout(layout);
        terminal
    }

    fn screen(terminal: &Terminal<TestBackend>) -> Vec<String> {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0;
                while x < buffer.area.width {
                    let cell = &buffer[(x, y)];
                    row.push_str(cell.symbol());
                    x += u16::try_from(unicode_width::UnicodeWidthStr::width(cell.symbol()).max(1)).unwrap();
                }
                row.trim_end().to_string()
            })
            .collect()
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    fn json(text: &str) -> String {
        serde_json::to_string(text).unwrap()
    }

    fn edit(call: &str, evidence: &str, path: &str, diff: &str, extra: &str) -> Vec<String> {
        vec![
            format!(r#"{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"{call}","tool":"edit_file","subject":"{path}","evidence":"{evidence}"}}"#),
            format!(
                r#"{{"v":1,"type":"file.diff","turn_id":"t1","call_id":"{call}","evidence":"{evidence}","path":"{path}","kind":"modified","added":1,"removed":1,"preview":{},"truncated":false,"total_lines":0{extra}}}"#,
                json(diff)
            ),
            format!(r#"{{"v":1,"type":"tool.end","turn_id":"t1","call_id":"{call}","tool":"edit_file","success":true,"summary":"ok","lines":1,"evidence":"{evidence}"}}"#),
        ]
    }

    fn feed_owned(state: &mut LiveState, lines: Vec<String>) {
        for line in lines {
            state.apply(parse_event(&line).unwrap());
        }
    }

    const SMALL: &str = "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {}\n-let x = 1;\n+let x = 2;\n \n";

    #[test]
    fn an_edit_shows_once_as_a_card_on_its_tool_row_and_a_repeated_event_replaces_it() {
        let mut state = state();
        feed_owned(&mut state, edit("c1", "e1", "src/a.rs", SMALL, r#","diff_lines":4,"hunks":1"#));
        feed_owned(&mut state, edit("c1", "e1", "src/a.rs", SMALL, r#","diff_lines":4,"hunks":1"#)[1..2].to_vec());
        let rows = screen(&draw(&mut state, 80, 16));
        assert_eq!(rows.iter().filter(|r| r.contains("Edited src/a.rs")).count(), 1, "{rows:#?}");
        assert!(!rows.iter().any(|r| r.contains("Edit src/a.rs")), "the plain tool row is replaced by the card: {rows:#?}");
        assert!(rows.iter().any(|r| r == &format!("  ✓ Edited src/a.rs  +1 {}1", diff_view::MINUS)), "{rows:#?}");
        assert!(rows.iter().any(|r| r.starts_with("    ▎ 2   − let x = 1;")), "{rows:#?}");
        assert!(!rows.iter().any(|r| r.contains("more line")), "a complete preview has no omission line");
    }

    #[test]
    fn a_failed_edit_shows_its_error_and_never_a_change() {
        let mut state = state();
        let mut events = edit("c1", "e1", "src/a.rs", SMALL, "");
        events[2] = r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"c1","tool":"edit_file","success":false,"summary":"old_string not found","lines":1,"evidence":"e1"}"#.into();
        feed_owned(&mut state, events);
        // A file.diff that arrives after the failure is not attached to the failed call either.
        feed_owned(&mut state, edit("c1", "e1", "src/a.rs", SMALL, "")[1..2].to_vec());
        let rows = screen(&draw(&mut state, 80, 16));
        assert!(rows.iter().any(|r| r.contains("× Edit src/a.rs — old_string not found")), "{rows:#?}");
        let failed_row = rows.iter().position(|r| r.contains("× Edit")).unwrap();
        assert!(!rows[failed_row..].iter().skip(1).take(1).any(|r| r.contains("− let x")), "no diff under the failure: {rows:#?}");
        let Entry::Tool { diff, .. } = &state.transcript.iter().find(|e| matches!(e, Entry::Tool { .. })).unwrap() else { unreachable!() };
        assert!(diff.is_none());
    }

    #[test]
    fn rows_stay_aligned_and_inside_narrow_terminals_with_long_paths_lines_unicode_and_tabs() {
        let long_line = format!("+\tlet message = \"{}\"; // 字符 é", "x".repeat(120));
        let diff = format!("--- a/a/very/long/path/to/some/deeply/nested/module/file_name.ts\n+++ b/a/very/long/path/to/some/deeply/nested/module/file_name.ts\n@@ -9,2 +9,3 @@\n context\n-\told\n{long_line}\n+\n");
        let mut state = state();
        feed_owned(&mut state, edit("c1", "e1", "a/very/long/path/to/some/deeply/nested/module/file_name.ts", &diff, ""));
        for width in [40u16, 60, 120] {
            let terminal = draw(&mut state, width, 30);
            let rows = screen(&terminal);
            for row in &rows {
                assert!(unicode_width::UnicodeWidthStr::width(row.as_str()) <= usize::from(width), "{width}: {row:?}");
            }
            let heading = rows.iter().find(|r| r.contains("file_name.ts")).unwrap_or_else(|| panic!("{rows:#?}"));
            assert!(heading.contains("Edited"), "{heading}");
            // Every numbered diff row puts its marker in the same column.
            let markers: Vec<usize> = rows
                .iter()
                .filter(|r| r.starts_with("    ▎") && r.chars().nth(6).is_some_and(|c| c.is_ascii_digit() || c == ' ') && !r.contains('⋯'))
                .filter_map(|r| r.chars().position(|c| c == '+' || c == '−'))
                .collect();
            assert!(markers.windows(2).all(|w| w[0] == w[1]), "{width}: {markers:?} {rows:#?}");
            assert!(rows.iter().any(|r| r.contains("字符")), "wide characters survive wrapping at {width}");
        }
    }

    #[test]
    fn ctrl_d_opens_the_complete_diff_and_esc_returns_with_the_draft_and_position_kept() {
        let mut state = state();
        for i in 0..30 {
            state.transcript.push(Entry::Info(format!("line {i}")));
        }
        feed_owned(&mut state, edit("c1", "e1", "src/a.rs", SMALL, ""));
        state.composer = "half-typed thought".into();
        draw(&mut state, 80, 20);
        state.on_key(key(KeyCode::PageUp));
        draw(&mut state, 80, 20);
        let back = state.scroll_back;
        assert!(back > 0);
        let action = state.on_key(ctrl('d'));
        let Some(Action::Send(Command::ToolDetail { id, evidence })) = action else { panic!("{action:?}") };
        assert_eq!(evidence, "e1");
        let mut full = String::from("--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {}\n-let x = 1;\n+let x = 2;\n \n@@ -200,2 +200,2 @@\n-old tail\n+new tail\n same");
        full.push('\n');
        feed(&mut state, &[&format!(
            r#"{{"v":1,"type":"tool.detail","id":"{id}","evidence":"e1","tool":"edit_file","subject":"src/a.rs","status":"succeeded","args":"{{}}","output":"","duration_ms":3,"diff":{},"diff_chars":99999,"diff_path":"/home/u/.nexus/sessions/s.diffs/e1-c1.diff"}}"#,
            json(&full)
        )]);
        let rows = screen(&draw(&mut state, 80, 20));
        let all = rows.join("\n");
        assert!(all.contains("Edit diff · this operation only"), "{all}");
        assert!(all.contains("edit 1 of 1"), "{all}");
        let unwrapped: String = rows.iter().map(|r| r.trim_start_matches(' ').trim_start_matches('│').trim_end_matches('│').trim_end()).collect();
        assert!(unwrapped.contains("The complete diff is in /home/u/.nexus/sessions/s.diffs/e1-c1.diff"), "the limit and the retrieval path are disclosed: {all}");
        assert_eq!(rows.iter().filter(|r| r.contains("Edited src/a.rs")).count(), 1, "one heading, with the full diff's counts: {all}");
        assert!(all.contains(&format!("Edited src/a.rs  +2 {}2", diff_view::MINUS)), "{all}");
        assert!(all.contains("@@ −200,2 +200,2 @@"), "{all}");
        // n jumps to the next hunk (in a panel too short to show both).
        draw(&mut state, 80, 13);
        state.on_key(key(KeyCode::Char('n')));
        let rows = screen(&draw(&mut state, 80, 13));
        let body: Vec<&String> = rows.iter().skip_while(|r| !r.contains("e1-c1.diff")).skip(1).take_while(|r| !r.contains("╰")).collect();
        assert!(body.iter().any(|r| r.contains("@@ −200,2")), "{rows:#?}");
        assert!(!body.iter().any(|r| r.contains("fn a()")), "the first hunk scrolled away: {rows:#?}");
        state.on_key(key(KeyCode::Esc));
        assert!(state.overlay.is_none());
        draw(&mut state, 80, 20);
        assert_eq!(state.composer.text(), "half-typed thought");
        assert_eq!(state.scroll_back, back, "the transcript position is where it was");
    }

    #[test]
    fn the_review_pans_long_lines_with_markers_and_wraps_on_request() {
        let mut state = state();
        let long = format!("--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-short\n+{}END", "abcdefghij".repeat(20));
        state.overlay = Some(Overlay::Review(DiffReview {
            request: String::new(),
            scope: ReviewScope::Workspace { entry: 0 },
            content: Loaded::Ready(ReviewContent::new(diff_view::parse(&long), None)),
            top: 0,
            left: 0,
            wrap: false,
        }));
        state.transcript.push(Entry::Output { success: true, text: long.clone(), diff: true });
        let rows = screen(&draw(&mut state, 60, 16));
        let added = rows.iter().find(|r| r.contains("+ abcdefghij")).unwrap().clone();
        assert!(added.contains("›│"), "clipped content is marked at the panel edge: {added:?}");
        for _ in 0..40 {
            state.on_key(key(KeyCode::Right));
        }
        let rows = screen(&draw(&mut state, 60, 16));
        let added = rows.iter().find(|r| r.contains('‹') && r.contains(" + ")).unwrap_or_else(|| panic!("{rows:#?}"));
        assert!(added.contains("END"), "panning reaches the end of the line: {added:?}");
        state.on_key(key(KeyCode::Char('w')));
        let rows = screen(&draw(&mut state, 60, 16));
        let panel = &rows[..rows.len() - 1];
        assert!(panel.iter().any(|r| r.contains("END")) && !panel.iter().any(|r| r.contains('›')), "{rows:#?}");
    }

    #[test]
    fn while_scrolled_back_arriving_diffs_do_not_move_what_the_operator_reads() {
        let mut state = state();
        for i in 0..60 {
            state.transcript.push(Entry::Info(format!("history line {i}")));
        }
        draw(&mut state, 80, 20);
        state.on_key(key(KeyCode::PageUp));
        let before = screen(&draw(&mut state, 80, 20));
        feed_owned(&mut state, edit("c1", "e1", "src/a.rs", SMALL, ""));
        feed_owned(&mut state, edit("c2", "e2", "src/b.rs", SMALL, ""));
        let after = screen(&draw(&mut state, 80, 20));
        assert_eq!(before[1..15], after[1..15], "the reading window stays put");
        for _ in 0..10 {
            state.on_key(key(KeyCode::PageDown));
        }
        let bottom = screen(&draw(&mut state, 80, 20));
        assert!(bottom.iter().any(|r| r.contains("Edited src/b.rs")), "end returns to the newest: {bottom:#?}");
    }

    #[test]
    fn limited_colour_and_monochrome_keep_markers_and_drop_backgrounds() {
        for depth in [Depth::Ansi256, Depth::Ansi16, Depth::Mono] {
            let mut state = state();
            state.depth = depth;
            feed_owned(&mut state, edit("c1", "e1", "src/a.rs", SMALL, ""));
            let terminal = draw(&mut state, 80, 14);
            let rows = screen(&terminal);
            let y = rows.iter().position(|r| r.contains("− let x = 1;")).unwrap_or_else(|| panic!("{depth:?} {rows:#?}"));
            let buffer = terminal.backend().buffer();
            for x in 0..80u16 {
                let cell = &buffer[(x, u16::try_from(y).unwrap())];
                assert!(!matches!(cell.fg, Color::Rgb(..)) && !matches!(cell.bg, Color::Rgb(..)), "{depth:?}: no 24-bit colour is sent");
                if depth == Depth::Mono {
                    assert_eq!((cell.fg, cell.bg), (Color::Reset, Color::Reset));
                }
                if depth == Depth::Ansi16 {
                    assert!(matches!(cell.bg, Color::Reset), "16 colours: no row backgrounds");
                }
            }
            assert!(rows.iter().any(|r| r.contains("+ let x = 2;")), "{depth:?}: markers carry the meaning");
        }
    }

    #[test]
    fn terminal_escapes_in_file_content_are_shown_never_emitted() {
        let mut state = state();
        let diff = "--- a/e.txt\n+++ b/e.txt\n@@ -1 +1 @@\n-plain\n+\u{1b}]52;c;aGk=\u{7}\u{1b}[2Jgone\u{9b}x";
        feed_owned(&mut state, edit("c1", "e1", "e.txt", diff, ""));
        let terminal = draw(&mut state, 80, 12);
        let buffer = terminal.backend().buffer();
        assert!(buffer.content.iter().all(|cell| !cell.symbol().chars().any(char::is_control)), "no control character is drawn");
        let rows = screen(&terminal);
        assert!(rows.iter().any(|r| r.contains("+ ␛]52;c;aGk=␇␛[2Jgone<U+009B>x")), "{rows:#?}");
    }

    #[test]
    fn a_large_edit_is_bounded_with_an_exact_omission_count_and_the_review_shortcut() {
        let mut diff = String::from("--- a/big.txt\n+++ b/big.txt\n@@ -1,0 +1,62 @@\n");
        for i in 1..=37 {
            diff.push_str(&format!("+line {i}\n"));
        }
        let mut state = state();
        feed_owned(&mut state, edit("c1", "e1", "big.txt", diff.trim_end(), r#","diff_lines":62,"hunks":1"#));
        let rows = screen(&draw(&mut state, 80, 30));
        assert_eq!(rows.iter().filter(|r| r.contains("+ line")).count(), diff_view::PREVIEW_LINES);
        let omission = format!("… {} more lines · ctrl+d to review", 62 - diff_view::PREVIEW_LINES);
        assert!(rows.iter().any(|r| r.contains(&omission)), "{rows:#?}");
        // Selected in the transcript, the same card names enter.
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        let rows = screen(&draw(&mut state, 80, 30));
        assert!(rows.iter().any(|r| r.contains("more lines · enter to review")), "{rows:#?}");
    }

    #[test]
    fn a_missing_final_newline_is_marked_on_the_line_it_belongs_to() {
        let mut state = state();
        let diff = "--- a/n.txt\n+++ b/n.txt\n@@ -1 +1 @@\n-last\n\\ No newline at end of file\n+last";
        feed_owned(&mut state, edit("c1", "e1", "n.txt", diff, ""));
        let rows = screen(&draw(&mut state, 80, 12));
        let removed = rows.iter().position(|r| r.contains("− last")).unwrap();
        assert!(rows[removed + 1].contains("\\ no newline at end of file"), "{rows:#?}");
        assert!(rows[removed + 2].contains("+ last"));
    }
}
