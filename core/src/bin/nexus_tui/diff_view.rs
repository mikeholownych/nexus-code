//! Shared diff rendering for the live TUI: one parser and one row layout used by the transcript's edit cards, the
//! workspace `/diff` output and the full review panel. Rows are laid out to the exact width they are drawn at — an
//! aligned old/new line-number gutter, an explicit `+`/`−` marker, the content with tabs expanded to stops and
//! control characters made visible, and a tinted background spanning the row — so alignment never depends on the
//! terminal's own wrapping. Colour is never the only signal: markers, numbers and labels carry the meaning.
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::highlight::{self, Lang, Token};
use crate::theme::Depth;

/// Diff lines an edit card shows in the transcript before its omission line.
pub const PREVIEW_LINES: usize = 14;
/// Diff lines the workspace `/diff` output shows in the transcript, across all its files.
pub const WORKSPACE_PREVIEW_LINES: usize = 24;
const TAB: usize = 4;
pub const MINUS: &str = "−";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Context,
    Added,
    Removed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DLine {
    pub kind: Kind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
    /// The file ends here without a final newline.
    pub no_eol: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    /// Text after the closing `@@` (git's enclosing-function context), if any.
    pub section: String,
    pub lines: Vec<DLine>,
}

impl Hunk {
    /// First old-file line the hunk covers, and the first line after it.
    fn old_span(&self) -> (u32, u32) {
        if self.old_count == 0 {
            (self.old_start + 1, self.old_start + 1)
        } else {
            (self.old_start, self.old_start + self.old_count)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FilePatch {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub status: Status,
    /// Why there is no line detail (binary file, …).
    pub notes: Vec<String>,
    pub hunks: Vec<Hunk>,
    saw_old_header: bool,
}

impl FilePatch {
    fn new(status: Status) -> Self {
        FilePatch { old_path: None, new_path: None, status, notes: Vec::new(), hunks: Vec::new(), saw_old_header: false }
    }

    pub fn path(&self) -> &str {
        self.new_path.as_deref().or(self.old_path.as_deref()).unwrap_or("(unnamed)")
    }

    pub fn counts(&self) -> (usize, usize) {
        let lines = self.hunks.iter().flat_map(|h| &h.lines);
        let (mut added, mut removed) = (0, 0);
        for line in lines {
            match line.kind {
                Kind::Added => added += 1,
                Kind::Removed => removed += 1,
                Kind::Context => {}
            }
        }
        (added, removed)
    }

    pub fn line_count(&self) -> usize {
        self.hunks.iter().map(|h| h.lines.len()).sum()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Patch {
    pub files: Vec<FilePatch>,
    /// The sidecar's cut marker (`…[truncated N chars]`) when the text was cut to a limit.
    pub truncated: Option<String>,
}

impl Patch {
    pub fn line_count(&self) -> usize {
        self.files.iter().map(FilePatch::line_count).sum()
    }
}

fn strip_prefix(path: &str, prefix: &str) -> Option<String> {
    let path = path.trim_end_matches('\t');
    if path == "/dev/null" {
        return None;
    }
    Some(path.strip_prefix(prefix).unwrap_or(path).to_string())
}

fn hunk_header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, section) = rest.split_once(" @@").unwrap_or((rest, ""));
    let (old, new) = ranges.split_once(" +")?;
    let range = |text: &str| -> Option<(u32, u32)> {
        match text.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (old_start, old_count) = range(old)?;
    let (new_start, new_count) = range(new)?;
    Some(Hunk { old_start, old_count, new_start, new_count, section: section.trim().to_string(), lines: Vec::new() })
}

/// Parses a unified diff (git's or the sidecar's). Hunk bodies are read by their counts, so a removed line whose
/// text starts with `-- ` is never mistaken for a file header.
pub fn parse(text: &str) -> Patch {
    let mut patch = Patch::default();
    let mut current: Option<FilePatch> = None;
    // Lines still owed by the open hunk (old side, new side), and the next line numbers.
    let mut owed = (0u32, 0u32);
    let mut next = (0u32, 0u32);
    for raw in text.split('\n') {
        let mut line = raw;
        if let Some(at) = raw.find("…[truncated ")
            && raw.ends_with(" chars]")
        {
            patch.truncated = Some(raw[at..].to_string());
            line = &raw[..at];
            if line.is_empty() {
                continue;
            }
        }
        if owed != (0, 0)
            && let Some(file) = current.as_mut()
            && let Some(hunk) = file.hunks.last_mut()
        {
            let (kind, body) = match line.chars().next() {
                Some(' ') => (Some(Kind::Context), &line[1..]),
                None => (Some(Kind::Context), ""),
                Some('-') => (Some(Kind::Removed), &line[1..]),
                Some('+') => (Some(Kind::Added), &line[1..]),
                Some('\\') => {
                    if let Some(last) = hunk.lines.last_mut() {
                        last.no_eol = true;
                    }
                    continue;
                }
                _ => (None, ""),
            };
            if let Some(kind) = kind {
                let old = (kind != Kind::Added).then_some(next.0);
                let new = (kind != Kind::Removed).then_some(next.1);
                if kind != Kind::Added {
                    next.0 += 1;
                    owed.0 = owed.0.saturating_sub(1);
                }
                if kind != Kind::Removed {
                    next.1 += 1;
                    owed.1 = owed.1.saturating_sub(1);
                }
                hunk.lines.push(DLine { kind, old, new, text: body.to_string(), no_eol: false });
                continue;
            }
            owed = (0, 0);
        }
        if line.starts_with('\\') {
            // The marker after a hunk's last line, once its counts are satisfied.
            if let Some(last) = current.as_mut().and_then(|f| f.hunks.last_mut()).and_then(|h| h.lines.last_mut()) {
                last.no_eol = true;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("diff --git ") {
            patch.files.extend(current.take());
            let mut file = FilePatch::new(Status::Modified);
            if let Some((a, b)) = rest.rsplit_once(" b/") {
                file.old_path = strip_prefix(a, "a/");
                file.new_path = Some(b.to_string());
            }
            current = Some(file);
        } else if let Some(rest) = line.strip_prefix("--- ") {
            if current.as_ref().is_none_or(|f| f.saw_old_header || !f.hunks.is_empty()) {
                patch.files.extend(current.take());
                current = Some(FilePatch::new(Status::Modified));
            }
            let file = current.as_mut().expect("a file section is open");
            file.saw_old_header = true;
            file.old_path = strip_prefix(rest, "a/");
            if file.old_path.is_none() {
                file.status = Status::Added;
            }
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            let file = current.get_or_insert_with(|| FilePatch::new(Status::Modified));
            file.new_path = strip_prefix(rest, "b/");
            if file.new_path.is_none() {
                file.status = Status::Deleted;
            }
        } else if line.starts_with("@@ ") {
            if let Some(hunk) = hunk_header(line) {
                owed = (hunk.old_count, hunk.new_count);
                next = (hunk.old_start.max(1), hunk.new_start.max(1));
                if hunk.old_count == 0 {
                    next.0 = hunk.old_start + 1;
                }
                if hunk.new_count == 0 {
                    next.1 = hunk.new_start + 1;
                }
                current.get_or_insert_with(|| FilePatch::new(Status::Modified)).hunks.push(hunk);
            }
        } else if let Some(file) = current.as_mut() {
            if line.starts_with("new file mode") {
                file.status = Status::Added;
                file.old_path = None;
            } else if line.starts_with("deleted file mode") {
                file.status = Status::Deleted;
                file.new_path = None;
            } else if let Some(from) = line.strip_prefix("rename from ") {
                file.status = Status::Renamed;
                file.old_path = Some(from.to_string());
            } else if let Some(to) = line.strip_prefix("rename to ") {
                file.status = Status::Renamed;
                file.new_path = Some(to.to_string());
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                file.notes.push("binary file — no line diff".to_string());
            }
        }
    }
    patch.files.extend(current);
    patch
}

/// Theme tokens for diffs at one colour depth.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub add_bg: Option<Color>,
    pub del_bg: Option<Color>,
    pub add_fg: Color,
    pub del_fg: Color,
    pub number: Color,
    pub add_number: Color,
    pub del_number: Color,
    pub bar: Color,
    pub text: Color,
    pub meta: Color,
    pub syntax: Option<Syntax>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Syntax {
    pub keyword: Color,
    pub string: Color,
    pub comment: Color,
    pub number: Color,
    pub type_name: Color,
}

impl Syntax {
    fn color(&self, token: Token, text: Color) -> Color {
        match token {
            Token::Plain => text,
            Token::Keyword => self.keyword,
            Token::Str => self.string,
            Token::Comment => self.comment,
            Token::Number => self.number,
            Token::Type => self.type_name,
        }
    }
}

/// The diff palette for a colour depth. 24-bit and 256-colour terminals get muted tinted rows with syntax colours
/// chosen for at least 4.5:1 contrast on every row background; 16-colour and monochrome terminals get coloured (or
/// plain) text without backgrounds, where the `+`/`−` markers carry the meaning.
pub fn palette(depth: Depth) -> Palette {
    match depth {
        Depth::TrueColor => Palette {
            add_bg: Some(Color::Rgb(22, 56, 36)),
            del_bg: Some(Color::Rgb(70, 27, 33)),
            add_fg: Color::Rgb(126, 231, 135),
            del_fg: Color::Rgb(255, 138, 138),
            number: Color::Rgb(108, 124, 136),
            add_number: Color::Rgb(128, 190, 142),
            del_number: Color::Rgb(218, 146, 150),
            bar: Color::Rgb(62, 76, 88),
            text: Color::Rgb(222, 228, 233),
            meta: Color::Rgb(125, 145, 158),
            syntax: Some(Syntax {
                keyword: Color::Rgb(212, 172, 255),
                string: Color::Rgb(240, 202, 142),
                comment: Color::Rgb(152, 168, 180),
                number: Color::Rgb(255, 176, 128),
                type_name: Color::Rgb(124, 208, 255),
            }),
        },
        Depth::Ansi256 => Palette {
            add_bg: Some(Color::Indexed(22)),
            del_bg: Some(Color::Indexed(52)),
            add_fg: Color::Indexed(120),
            del_fg: Color::Indexed(217),
            number: Color::Indexed(244),
            add_number: Color::Indexed(151),
            del_number: Color::Indexed(181),
            bar: Color::Indexed(239),
            text: Color::Indexed(254),
            meta: Color::Indexed(247),
            syntax: Some(Syntax {
                keyword: Color::Indexed(189),
                string: Color::Indexed(223),
                comment: Color::Indexed(251),
                number: Color::Indexed(224),
                type_name: Color::Indexed(159),
            }),
        },
        Depth::Ansi16 | Depth::Mono => Palette {
            add_bg: None,
            del_bg: None,
            add_fg: Color::Green,
            del_fg: Color::Red,
            number: Color::DarkGray,
            add_number: Color::Green,
            del_number: Color::Red,
            bar: Color::DarkGray,
            text: Color::Reset,
            meta: Color::DarkGray,
            syntax: None,
        },
    }
}

/// Columns of a diff row: `indent`, the gutter bar, aligned old/new numbers, the marker, then content.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub width: usize,
    pub indent: usize,
    pub num_width: usize,
}

impl Geometry {
    /// Indent, bar, space, old number, space, new number, space, marker, space.
    pub fn prefix(&self) -> usize {
        self.indent + 2 * self.num_width + 6
    }

    pub fn content(&self) -> usize {
        self.width.saturating_sub(self.prefix()).max(1)
    }
}

/// How content wider than the row is shown: wrapped onto continuation rows, or clipped at a horizontal offset with
/// `‹`/`›` marking the hidden parts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fit {
    Wrap,
    Clip(usize),
}

pub fn digits(n: u32) -> usize {
    n.max(1).to_string().len()
}

/// One display cell group: a grapheme (or a visible stand-in for a control character) and its column width.
#[derive(Clone, Debug, PartialEq)]
struct Cell {
    text: String,
    width: usize,
    /// `None` paints as metadata (the clip markers).
    token: Option<Token>,
}

/// The visible stand-in for a character a terminal would interpret: control pictures for C0 controls (`␛` for ESC),
/// `␡` for DEL, `<U+XXXX>` for C1 controls and bidirectional overrides. `None` for ordinary characters.
pub fn visible_control(c: char) -> Option<String> {
    let code = c as u32;
    match code {
        0x00..=0x1f => char::from_u32(0x2400 + code).map(String::from),
        0x7f => Some("␡".to_string()),
        0x80..=0x9f | 0x61c | 0x200e | 0x200f | 0x202a..=0x202e | 0x2066..=0x2069 => Some(format!("<U+{code:04X}>")),
        _ => None,
    }
}

/// Text safe to draw: every control character replaced by its visible stand-in (tabs and newlines included).
pub fn safe_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match visible_control(c) {
            Some(stand_in) => out.push_str(&stand_in),
            None => out.push(c),
        }
    }
    out
}

fn cells(text: &str, lang: Option<&Lang>) -> Vec<Cell> {
    let tokens = lang.map(|lang| highlight::highlight(lang, text)).unwrap_or_default();
    let mut token_at = tokens.iter().peekable();
    let mut out: Vec<Cell> = Vec::new();
    let mut col = 0;
    for (offset, grapheme) in text.grapheme_indices(true) {
        while token_at.peek().is_some_and(|(_, end, _)| *end <= offset) {
            token_at.next();
        }
        let token = token_at.peek().map_or(Token::Plain, |(_, _, t)| *t);
        if grapheme == "\t" {
            let spaces = TAB - col % TAB;
            for _ in 0..spaces {
                out.push(Cell { text: " ".into(), width: 1, token: Some(token) });
            }
            col += spaces;
            continue;
        }
        if grapheme.chars().any(|c| visible_control(c).is_some()) {
            for c in grapheme.chars() {
                let shown = visible_control(c).unwrap_or_else(|| c.to_string());
                for piece in shown.chars() {
                    let width = UnicodeWidthStr::width(piece.to_string().as_str()).max(1);
                    out.push(Cell { text: piece.to_string(), width, token: Some(token) });
                    col += width;
                }
            }
            continue;
        }
        let width = UnicodeWidthStr::width(grapheme);
        if width == 0 {
            match out.last_mut() {
                Some(previous) => previous.text.push_str(grapheme),
                None => out.push(Cell { text: grapheme.to_string(), width: 0, token: Some(token) }),
            }
            continue;
        }
        out.push(Cell { text: grapheme.to_string(), width, token: Some(token) });
        col += width;
    }
    out
}

/// Display width of a diff line's content (tabs expanded, controls made visible).
pub fn content_width(text: &str) -> usize {
    cells(text, None).iter().map(|c| c.width).sum()
}

fn spaces(n: usize) -> Cell {
    Cell { text: " ".repeat(n), width: n, token: Some(Token::Plain) }
}

/// Splits content cells into rows of at most `width` columns.
fn fit_rows(cells: Vec<Cell>, width: usize, fit: Fit) -> Vec<Vec<Cell>> {
    match fit {
        Fit::Wrap => {
            let mut rows = vec![Vec::new()];
            let mut used = 0;
            for cell in cells {
                if used + cell.width > width && used > 0 {
                    rows.push(Vec::new());
                    used = 0;
                }
                used += cell.width;
                rows.last_mut().expect("a row is open").push(cell);
            }
            rows
        }
        Fit::Clip(left) => {
            let total: usize = cells.iter().map(|c| c.width).sum();
            let right = left + width;
            let mut row = Vec::new();
            let mut col = 0;
            for cell in cells {
                let (start, end) = (col, col + cell.width);
                col = end;
                if end <= left || (cell.width == 0 && start < left) {
                    continue;
                }
                if start < left {
                    // A wide character cut by the left edge: its visible half becomes blank.
                    row.push(spaces((end - left).min(width)));
                    continue;
                }
                if end > right {
                    if start < right {
                        row.push(spaces(right - start));
                    }
                    break;
                }
                row.push(cell);
            }
            let mut used: usize = row.iter().map(|c| c.width).sum();
            if total > right && width > 1 {
                while used > width - 1 {
                    let last = row.pop().expect("cells fill the row");
                    used -= last.width;
                }
                if used < width - 1 {
                    row.push(spaces(width - 1 - used));
                }
                row.push(Cell { text: "›".into(), width: 1, token: None });
            }
            if left > 0 && total > 0 && width > 1 {
                let mut removed = 0;
                while removed < 1 && !row.is_empty() {
                    removed += row.remove(0).width;
                }
                if removed > 1 {
                    row.insert(0, spaces(removed - 1));
                }
                row.insert(0, Cell { text: "‹".into(), width: 1, token: None });
            }
            vec![row]
        }
    }
}

/// The rows (one, or more when wrapping) that show one diff line, each exactly `geo.width` columns wide.
pub fn line_rows(line: &DLine, geo: Geometry, fit: Fit, pal: &Palette, lang: Option<&Lang>) -> Vec<Line<'static>> {
    let bg = match line.kind {
        Kind::Added => pal.add_bg,
        Kind::Removed => pal.del_bg,
        Kind::Context => None,
    };
    let base = bg.map_or_else(Style::default, |bg| Style::default().bg(bg));
    let (marker, marker_color, number_color) = match line.kind {
        Kind::Added => ("+", pal.add_fg, pal.add_number),
        Kind::Removed => (MINUS, pal.del_fg, pal.del_number),
        Kind::Context => (" ", pal.number, pal.number),
    };
    // Without row backgrounds the changed text itself takes the marker's colour.
    let plain_fg = match (line.kind, pal.add_bg.is_some()) {
        (Kind::Added, false) => pal.add_fg,
        (Kind::Removed, false) => pal.del_fg,
        _ => pal.text,
    };
    let content = geo.content();
    let rows = fit_rows(cells(&line.text, lang.filter(|_| pal.syntax.is_some())), content, fit);
    let number = |n: Option<u32>| n.map_or_else(|| " ".repeat(geo.num_width), |n| format!("{n:>width$}", width = geo.num_width));
    let mut out = Vec::with_capacity(rows.len());
    for (index, row) in rows.into_iter().enumerate() {
        let first = index == 0;
        let mut spans = vec![
            Span::raw(" ".repeat(geo.indent)),
            Span::styled("▎", Style::default().fg(pal.bar)),
            Span::styled(" ", base),
        ];
        if first {
            spans.push(Span::styled(number(line.old), base.fg(if line.kind == Kind::Removed { number_color } else { pal.number })));
            spans.push(Span::styled(" ", base));
            spans.push(Span::styled(number(line.new), base.fg(if line.kind == Kind::Added { number_color } else { pal.number })));
            spans.push(Span::styled(" ", base));
            spans.push(Span::styled(marker, base.fg(marker_color).add_modifier(Modifier::BOLD)));
        } else {
            // A continuation row: no numbers, the marker repeated faintly so the row still reads as +/−.
            spans.push(Span::styled(" ".repeat(2 * geo.num_width + 2), base));
            spans.push(Span::styled(marker, base.fg(marker_color).add_modifier(Modifier::DIM)));
        }
        spans.push(Span::styled(" ", base));
        let mut used = 0;
        for cell in row {
            used += cell.width;
            let fg = match (cell.token, pal.syntax) {
                (None, _) => pal.meta,
                (Some(token), Some(syntax)) => syntax.color(token, plain_fg),
                (Some(_), None) => plain_fg,
            };
            spans.push(Span::styled(cell.text, base.fg(fg)));
        }
        if used < content {
            spans.push(Span::styled(" ".repeat(content - used), base));
        }
        out.push(Line::from(spans));
    }
    if line.no_eol {
        out.push(meta_row(geo, pal, "\\ no newline at end of file"));
    }
    out
}

/// A quiet row inside a diff block (hunk gaps, notes): gutter bar, then text clipped to the width.
pub fn meta_row(geo: Geometry, pal: &Palette, text: &str) -> Line<'static> {
    let room = geo.width.saturating_sub(geo.indent + 2);
    Line::from(vec![
        Span::raw(" ".repeat(geo.indent)),
        Span::styled("▎", Style::default().fg(pal.bar)),
        Span::raw(" "),
        Span::styled(clip(&safe_text(text), room), Style::default().fg(pal.meta)),
    ])
}

/// A quiet block of text inside a diff block that must stay readable whole (omission lines, notes): wrapped at
/// word boundaries under the gutter bar instead of clipped.
pub fn meta_rows(geo: Geometry, pal: &Palette, text: &str) -> Vec<Line<'static>> {
    let room = geo.width.saturating_sub(geo.indent + 2).max(8);
    let style = Style::default().fg(pal.meta);
    wrap_at_breaks(&safe_text(text), room)
        .into_iter()
        .map(|row| {
            Line::from(vec![
                Span::raw(" ".repeat(geo.indent)),
                Span::styled("▎", Style::default().fg(pal.bar)),
                Span::raw(" "),
                Span::styled(row, style),
            ])
        })
        .collect()
}

/// Splits `text` into rows of at most `width` columns, breaking after spaces and `/` where possible and inside a
/// word only when one word is wider than a row.
pub fn wrap_at_breaks(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut row = String::new();
    let mut used = 0;
    // Pieces end just after a break opportunity, so joining them restores the text exactly.
    let mut pieces: Vec<String> = Vec::new();
    let mut piece = String::new();
    for grapheme in text.graphemes(true) {
        piece.push_str(grapheme);
        if grapheme == " " || grapheme == "/" {
            pieces.push(std::mem::take(&mut piece));
        }
    }
    if !piece.is_empty() {
        pieces.push(piece);
    }
    for piece in pieces {
        let w = UnicodeWidthStr::width(piece.as_str());
        if used + w.min(UnicodeWidthStr::width(piece.trim_end())) > width && used > 0 {
            rows.push(std::mem::take(&mut row).trim_end().to_string());
            used = 0;
        }
        if w > width {
            for grapheme in piece.graphemes(true) {
                let gw = UnicodeWidthStr::width(grapheme);
                if used + gw > width && used > 0 {
                    rows.push(std::mem::take(&mut row));
                    used = 0;
                }
                row.push_str(grapheme);
                used += gw;
            }
            continue;
        }
        row.push_str(&piece);
        used += w;
    }
    if !row.is_empty() || rows.is_empty() {
        rows.push(row.trim_end().to_string());
    }
    rows
}

/// `text` cut to `width` columns, ending in `…` when cut.
pub fn clip(text: &str, width: usize) -> String {
    if UnicodeWidthStr::width(text) <= width {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for grapheme in text.graphemes(true) {
        let w = UnicodeWidthStr::width(grapheme);
        if used + w + 1 > width {
            break;
        }
        used += w;
        out.push_str(grapheme);
    }
    out.push('…');
    out
}

/// The text between two hunks: how many unchanged lines separate them.
fn gap_text(previous: Option<&Hunk>, hunk: &Hunk, coordinates: bool) -> Option<String> {
    let first = hunk.old_span().0;
    let unchanged = match previous {
        Some(previous) => first.saturating_sub(previous.old_span().1),
        None => first.saturating_sub(1),
    };
    let mut text = match (previous, unchanged) {
        (None, 0) if !coordinates => return None,
        (None, 0) => String::new(),
        (None, n) => format!("⋯ {n} unchanged line{} above", if n == 1 { "" } else { "s" }),
        (Some(_), n) => format!("⋯ {n} unchanged line{}", if n == 1 { "" } else { "s" }),
    };
    if coordinates {
        let header = format!("@@ {MINUS}{},{} +{},{} @@", hunk.old_start, hunk.old_count, hunk.new_start, hunk.new_count);
        text = if text.is_empty() { header } else { format!("{text} · {header}") };
        if !hunk.section.is_empty() {
            text.push(' ');
            text.push_str(&hunk.section);
        }
    }
    Some(text)
}

/// Splits a path into a directory part and the file name, eliding leading directories (`…/`) so the whole fits in
/// `width` columns where possible. The file name is never cut.
pub fn fit_path(path: &str, width: usize) -> (String, String) {
    let path = safe_text(path);
    let (dir, base) = match path.rfind('/') {
        Some(at) => (path[..=at].to_string(), path[at + 1..].to_string()),
        None => (String::new(), path.clone()),
    };
    if UnicodeWidthStr::width(path.as_str()) <= width || dir.is_empty() {
        return (dir, base);
    }
    let room = width.saturating_sub(UnicodeWidthStr::width(base.as_str()) + 2);
    let parts: Vec<&str> = dir.trim_end_matches('/').split('/').collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0;
    for part in parts.iter().rev() {
        let w = UnicodeWidthStr::width(*part) + 1;
        if used + w > room {
            break;
        }
        used += w;
        kept.insert(0, part);
    }
    let dir = if kept.is_empty() { "…/".to_string() } else { format!("…/{}/", kept.join("/")) };
    (dir, base)
}

pub fn verb(status: Status) -> &'static str {
    match status {
        Status::Added => "Created",
        Status::Modified => "Edited",
        Status::Deleted => "Deleted",
        Status::Renamed => "Renamed",
    }
}

/// `Edited dir/file.rs  +4 −2`: the spans of a file heading after `lead`, with the path fitted to `width`.
pub fn heading_spans(lead: Vec<Span<'static>>, status: Status, path: &str, old_path: Option<&str>, counts: Option<(usize, usize)>, width: usize, pal: &Palette) -> Vec<Span<'static>> {
    let white = Style::default().fg(pal.text).add_modifier(Modifier::BOLD);
    let muted = Style::default().fg(pal.meta);
    let verb = verb(status);
    let lead_width: usize = lead.iter().map(Span::width).sum();
    let counts_text = counts.map(|(a, r)| format!("  +{a} {MINUS}{r}"));
    let renamed = old_path.filter(|_| status == Status::Renamed).map(|old| format!("{} → ", safe_text(old)));
    let room = width
        .saturating_sub(lead_width + verb.len() + 1)
        .saturating_sub(counts_text.as_deref().map_or(0, UnicodeWidthStr::width))
        .saturating_sub(renamed.as_deref().map_or(0, UnicodeWidthStr::width));
    let (dir, base) = fit_path(path, room);
    let mut spans = lead;
    spans.push(Span::styled(format!("{verb} "), white));
    if let Some(renamed) = renamed {
        spans.push(Span::styled(renamed, muted));
    }
    spans.push(Span::styled(dir, muted));
    spans.push(Span::styled(base, white));
    if let Some((added, removed)) = counts {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(format!("+{added}"), Style::default().fg(pal.add_fg)));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(format!("{MINUS}{removed}"), Style::default().fg(pal.del_fg)));
    }
    spans
}

/// Plain words for the sidecar's reason a change has no line detail.
pub fn note_text(note: &str) -> String {
    let reason = note.strip_prefix("no line detail: ").unwrap_or(note);
    if reason.contains("binary") {
        "binary file — no line diff".to_string()
    } else if let Some(size) = reason.strip_prefix("larger than ") {
        let bytes: Option<u64> = size.trim_end_matches(" bytes").parse().ok();
        match bytes {
            Some(bytes) => format!("file larger than {} MB — no line diff", bytes / (1024 * 1024)),
            None => format!("file larger than {size} — no line diff"),
        }
    } else if reason.contains("not a regular file") {
        "not a regular file — no line diff".to_string()
    } else {
        format!("could not be read ({reason}) — no line diff")
    }
}

/// The change one file-edit call made, as the transcript holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct DiffCard {
    pub evidence: String,
    pub path: String,
    pub kind: String,
    pub added: u64,
    pub removed: u64,
    /// The sidecar's bounded preview, parsed.
    pub preview: Patch,
    pub truncated: bool,
    pub total_lines: u64,
    pub diff_lines: Option<u64>,
    pub hunks: Option<u64>,
    pub note: Option<String>,
    pub full_path: Option<String>,
}

impl DiffCard {
    pub fn status(&self) -> Status {
        match self.kind.as_str() {
            "added" => Status::Added,
            "deleted" => Status::Deleted,
            _ => Status::Modified,
        }
    }

    /// Changed and context lines in the whole diff.
    pub fn total_diff_lines(&self) -> usize {
        match self.diff_lines {
            Some(n) => usize::try_from(n).unwrap_or(usize::MAX),
            // Older sidecars: the preview's lines plus every raw line it did not carry.
            None => {
                let raw_shown = self.preview.files.iter().map(|f| 2 + f.hunks.len() + f.line_count()).sum::<usize>();
                self.preview.line_count() + usize::try_from(self.total_lines).unwrap_or(0).saturating_sub(raw_shown)
            }
        }
    }
}

/// How a card's omission line points at the review: the shortcut that opens this card's diff.
pub struct CardContext<'a> {
    pub width: usize,
    pub glyph: (&'static str, Color),
    pub selected: Option<Style>,
    pub review_hint: &'a str,
}

/// An edit card: a blank separator, `✓ Edited path +a −r`, up to `PREVIEW_LINES` diff lines in a gutter-marked block
/// with hunk gaps, then an omission line with the exact count of lines not shown.
pub fn card_lines(card: &DiffCard, pal: &Palette, ctx: &CardContext<'_>) -> Vec<Line<'static>> {
    let mut lines = vec![Line::default()];
    let lead = vec![Span::styled(format!("  {} ", ctx.glyph.0), Style::default().fg(ctx.glyph.1))];
    let counts = card.note.is_none().then_some((card.added as usize, card.removed as usize));
    let mut heading = Line::from(heading_spans(lead, card.status(), &card.path, None, counts, ctx.width, pal));
    if let Some(selected) = ctx.selected {
        heading = heading.patch_style(selected);
    }
    lines.push(heading);
    let file = card.preview.files.first();
    let shown: Vec<(usize, usize)> = file
        .map(|f| f.hunks.iter().enumerate().flat_map(|(h, hunk)| (0..hunk.lines.len()).map(move |l| (h, l))).take(PREVIEW_LINES).collect())
        .unwrap_or_default();
    let max_number = file
        .map(|f| shown.iter().map(|&(h, l)| {
            let line = &f.hunks[h].lines[l];
            line.old.unwrap_or(0).max(line.new.unwrap_or(0))
        }).max().unwrap_or(1))
        .unwrap_or(1);
    let geo = Geometry { width: ctx.width, indent: 4, num_width: digits(max_number) };
    if let Some(note) = &card.note {
        lines.extend(meta_rows(geo, pal, &note_text(note)));
    }
    let lang = highlight::lang_for(&card.path);
    let mut last_hunk = None;
    if let Some(file) = file {
        for &(h, l) in &shown {
            if last_hunk != Some(h) {
                if let Some(previous) = last_hunk
                    && let Some(text) = gap_text(Some(&file.hunks[previous]), &file.hunks[h], false)
                {
                    lines.push(meta_row(geo, pal, &text));
                }
                last_hunk = Some(h);
            }
            lines.extend(line_rows(&file.hunks[h].lines[l], geo, Fit::Wrap, pal, lang));
        }
    }
    let more = card.total_diff_lines().saturating_sub(shown.len());
    if more > 0 {
        let hunks_shown = last_hunk.map_or(0, |h| h + 1);
        let more_hunks = card.hunks.map_or(0, |n| usize::try_from(n).unwrap_or(0)).saturating_sub(hunks_shown);
        let hunks = match more_hunks {
            0 => String::new(),
            1 => " in 1 more hunk".to_string(),
            n => format!(" in {n} more hunks"),
        };
        lines.extend(meta_rows(geo, pal, &format!("… {more} more line{}{hunks} · {}", if more == 1 { "" } else { "s" }, ctx.review_hint)));
    }
    lines
}

/// The workspace `/diff` output in the transcript: a scope label, then each file's heading and rows, at most
/// `WORKSPACE_PREVIEW_LINES` diff lines in all, then the omission line. `None` when the text is not a diff.
pub fn workspace_lines(text: &str, pal: &Palette, width: usize, selected: Option<Style>, review_hint: &str) -> Option<Vec<Line<'static>>> {
    let patch = parse(text);
    if patch.files.is_empty() {
        return None;
    }
    let mut label = Line::from(Span::styled(
        "  Workspace diff (git diff: unstaged changes to tracked files) · includes changes not made in this session",
        Style::default().fg(pal.meta).add_modifier(Modifier::ITALIC),
    ));
    if let Some(selected) = selected {
        label = label.patch_style(selected);
    }
    let mut lines = vec![label];
    let mut budget = WORKSPACE_PREVIEW_LINES;
    let mut files_shown = 0;
    for file in &patch.files {
        if budget == 0 {
            break;
        }
        files_shown += 1;
        let (added, removed) = file.counts();
        lines.push(Line::from(heading_spans(vec![Span::raw("  ")], file.status, file.path(), file.old_path.as_deref(), file.notes.is_empty().then_some((added, removed)), width, pal)));
        let take: Vec<&DLine> = file.hunks.iter().flat_map(|h| &h.lines).take(budget).collect();
        let max_number = take.iter().map(|l| l.old.unwrap_or(0).max(l.new.unwrap_or(0))).max().unwrap_or(1);
        let geo = Geometry { width, indent: 4, num_width: digits(max_number) };
        for note in &file.notes {
            lines.push(meta_row(geo, pal, note));
        }
        let lang = highlight::lang_for(file.path());
        let mut taken = 0;
        let mut previous: Option<&Hunk> = None;
        'hunks: for hunk in &file.hunks {
            if let Some(text) = previous.and_then(|p| gap_text(Some(p), hunk, false)) {
                lines.push(meta_row(geo, pal, &text));
            }
            for line in &hunk.lines {
                if taken == budget {
                    break 'hunks;
                }
                lines.extend(line_rows(line, geo, Fit::Wrap, pal, lang));
                taken += 1;
            }
            previous = Some(hunk);
        }
        budget -= taken;
    }
    let more = patch.line_count().saturating_sub(WORKSPACE_PREVIEW_LINES.min(patch.line_count()));
    let geo = Geometry { width, indent: 4, num_width: 1 };
    if more > 0 {
        let files = patch.files.len() - files_shown;
        let in_files = match files {
            0 => String::new(),
            1 => " and 1 more file".to_string(),
            n => format!(" and {n} more files"),
        };
        lines.extend(meta_rows(geo, pal, &format!("… {more} more line{}{in_files} · {review_hint}", if more == 1 { "" } else { "s" })));
    }
    if patch.truncated.is_some() {
        lines.extend(meta_rows(geo, pal, "output limit reached — run `git diff` in the workspace for the rest"));
    }
    Some(lines)
}

/// One logical row of the review panel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Row {
    File(usize),
    Note(usize, usize),
    Gap(usize, usize),
    Line(usize, usize, usize),
    Blank,
}

/// The review panel's logical rows: each file's heading and notes, then each hunk (a gap row with its coordinates,
/// then its lines), with a blank row between files.
pub fn panel_rows(patch: &Patch) -> Vec<Row> {
    let mut rows = Vec::new();
    for (f, file) in patch.files.iter().enumerate() {
        if f > 0 {
            rows.push(Row::Blank);
        }
        rows.push(Row::File(f));
        rows.extend((0..file.notes.len()).map(|n| Row::Note(f, n)));
        for (h, hunk) in file.hunks.iter().enumerate() {
            rows.push(Row::Gap(f, h));
            rows.extend((0..hunk.lines.len()).map(|l| Row::Line(f, h, l)));
        }
    }
    rows
}

/// Number width that aligns every line number of `patch`.
pub fn patch_num_width(patch: &Patch) -> usize {
    let max = patch
        .files
        .iter()
        .flat_map(|f| &f.hunks)
        .map(|h| (h.old_start + h.old_count).max(h.new_start + h.new_count))
        .max()
        .unwrap_or(1);
    digits(max)
}

/// Widest content of any line in `patch`, for the horizontal scroll limit.
pub fn patch_max_width(patch: &Patch) -> usize {
    patch.files.iter().flat_map(|f| &f.hunks).flat_map(|h| &h.lines).map(|l| content_width(&l.text)).max().unwrap_or(0)
}

/// The display lines of one logical panel row.
pub fn panel_row_lines(patch: &Patch, row: Row, geo: Geometry, fit: Fit, pal: &Palette) -> Vec<Line<'static>> {
    match row {
        Row::Blank => vec![Line::default()],
        Row::File(f) => {
            let file = &patch.files[f];
            let counts = file.notes.is_empty().then(|| file.counts());
            // The full path, wrapped by characters when it is wider than the panel: never elided here.
            let text = Line::from(heading_spans(vec![Span::raw(" ".repeat(geo.indent))], file.status, file.path(), file.old_path.as_deref(), counts, usize::MAX / 2, pal));
            wrap_spans(text, geo.width)
        }
        Row::Note(f, n) => vec![meta_row(geo, pal, &patch.files[f].notes[n])],
        Row::Gap(f, h) => {
            let file = &patch.files[f];
            let previous = h.checked_sub(1).map(|p| &file.hunks[p]);
            let text = gap_text(previous, &file.hunks[h], true).unwrap_or_default();
            vec![meta_row(geo, pal, &text)]
        }
        Row::Line(f, h, l) => {
            let file = &patch.files[f];
            line_rows(&file.hunks[h].lines[l], geo, fit, pal, highlight::lang_for(file.path()))
        }
    }
}

/// Breaks a styled line into lines of at most `width` columns, by grapheme.
fn wrap_spans(line: Line<'static>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut out: Vec<Line<'static>> = vec![Line::default()];
    let mut used = 0;
    for span in line.spans {
        let mut piece = String::new();
        for grapheme in span.content.graphemes(true) {
            let w = UnicodeWidthStr::width(grapheme);
            if used + w > width && used > 0 {
                if !piece.is_empty() {
                    out.last_mut().expect("a line is open").spans.push(Span::styled(std::mem::take(&mut piece), span.style));
                }
                out.push(Line::default());
                used = 0;
            }
            piece.push_str(grapheme);
            used += w;
        }
        if !piece.is_empty() {
            out.last_mut().expect("a line is open").spans.push(Span::styled(piece, span.style));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::contrast;

    fn text_of(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    fn rgb(color: Color) -> (u8, u8, u8) {
        match color {
            Color::Rgb(r, g, b) => (r, g, b),
            Color::Indexed(i) => {
                const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];
                match i {
                    16..=231 => {
                        let i = i - 16;
                        (CUBE[(i / 36) as usize], CUBE[((i / 6) % 6) as usize], CUBE[(i % 6) as usize])
                    }
                    232..=255 => {
                        let v = 8 + 10 * (i - 232);
                        (v, v, v)
                    }
                    _ => panic!("not a 256-colour entry"),
                }
            }
            other => panic!("no RGB for {other:?}"),
        }
    }

    const SAMPLE: &str = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,4 +1,5 @@\n fn a() {}\n-let x = 1;\n+let x = 2;\n+let y = 3;\n \n \tindented\n@@ -40,3 +41,3 @@ fn tail()\n keep\n--- old dashes\n+++ new pluses\n";

    #[test]
    fn a_unified_diff_parses_with_exact_line_numbers_and_header_like_lines_inside_hunks() {
        let patch = parse(SAMPLE);
        assert_eq!(patch.files.len(), 1, "a removed line starting with --- is not a new file: {patch:?}");
        let file = &patch.files[0];
        assert_eq!((file.path(), file.status), ("src/lib.rs", Status::Modified));
        assert_eq!(file.counts(), (3, 2));
        let first = &file.hunks[0].lines;
        assert_eq!((first[1].kind, first[1].old, first[1].new), (Kind::Removed, Some(2), None));
        assert_eq!((first[2].kind, first[2].old, first[2].new), (Kind::Added, None, Some(2)));
        assert_eq!((first[4].text.as_str(), first[4].old, first[4].new), ("", Some(3), Some(4)), "a blank context line keeps its place");
        assert_eq!(first[5].text, "\tindented");
        let second = &file.hunks[1];
        assert_eq!(second.section, "fn tail()");
        assert_eq!((second.lines[1].kind, second.lines[1].text.as_str()), (Kind::Removed, "-- old dashes"));
        assert_eq!((second.lines[2].kind, second.lines[2].new), (Kind::Added, Some(42)));
    }

    #[test]
    fn git_headers_give_added_deleted_renamed_and_binary_files_and_the_cut_marker_is_kept() {
        let text = "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n\
diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n\
diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n\\ No newline at end of file\n\
diff --git a/new.rs b/new.rs\nnew file mode 100644\n--- /dev/null\n+++ b/new.rs\n@@ -0,0 +1 @@\n+fn main() {}…[truncated 900 chars]";
        let patch = parse(text);
        let summary: Vec<(Status, &str, Option<&str>)> = patch.files.iter().map(|f| (f.status, f.path(), f.old_path.as_deref())).collect();
        assert_eq!(
            summary,
            vec![
                (Status::Renamed, "new.txt", Some("old.txt")),
                (Status::Modified, "img.png", Some("img.png")),
                (Status::Deleted, "gone.txt", Some("gone.txt")),
                (Status::Added, "new.rs", None),
            ]
        );
        assert_eq!(patch.files[1].notes, vec!["binary file — no line diff".to_string()]);
        assert!(patch.files[2].hunks[0].lines[0].no_eol, "the marker after the counts are met applies to the last line");
        assert_eq!(patch.files[3].hunks[0].lines[0].text, "fn main() {}");
        assert_eq!(patch.truncated.as_deref(), Some("…[truncated 900 chars]"));
    }

    #[test]
    fn rows_are_exactly_the_width_with_aligned_gutters_and_explicit_markers() {
        let patch = parse(SAMPLE);
        let pal = palette(Depth::TrueColor);
        let geo = Geometry { width: 60, indent: 4, num_width: 2 };
        let lines: Vec<Line> = patch.files[0].hunks[0].lines.iter().flat_map(|l| line_rows(l, geo, Fit::Wrap, &pal, None)).collect();
        let texts: Vec<String> = lines.iter().map(text_of).collect();
        for (line, text) in lines.iter().zip(&texts) {
            assert_eq!(line.width(), 60, "{text:?}");
        }
        assert!(texts[0].starts_with("    ▎  1  1   fn a() {}"), "{:?}", texts[0]);
        assert!(texts[1].starts_with("    ▎  2    − let x = 1;"), "{:?}", texts[1]);
        assert!(texts[2].starts_with("    ▎     2 + let x = 2;"), "{:?}", texts[2]);
        assert!(texts[5].starts_with("    ▎  4  5       indented"), "a tab expands to the next stop: {:?}", texts[5]);
        // The tint spans the visible width of a changed row, and only of changed rows.
        assert_eq!(lines[1].spans.last().unwrap().style.bg, pal.del_bg);
        assert_eq!(lines[2].spans.last().unwrap().style.bg, pal.add_bg);
        assert_eq!(lines[0].spans.last().unwrap().style.bg, None);
    }

    #[test]
    fn wide_characters_and_long_lines_wrap_without_splitting_and_clip_with_markers() {
        let line = DLine { kind: Kind::Added, old: None, new: Some(7), text: "字".repeat(30), no_eol: false };
        let pal = palette(Depth::TrueColor);
        let geo = Geometry { width: 40, indent: 4, num_width: 1 };
        let wrapped = line_rows(&line, geo, Fit::Wrap, &pal, None);
        assert!(wrapped.len() > 1);
        for row in &wrapped {
            assert_eq!(row.width(), 40, "{:?}", text_of(row));
        }
        let joined: String = wrapped.iter().map(text_of).collect::<String>();
        assert_eq!(joined.matches('字').count(), 30, "nothing is lost when wrapping");
        let clipped = line_rows(&line, geo, Fit::Clip(3), &pal, None);
        assert_eq!(clipped.len(), 1);
        let text = text_of(&clipped[0]);
        assert_eq!(clipped[0].width(), 40);
        assert!(text.contains('‹') && text.ends_with('›'), "{text:?}");
    }

    #[test]
    fn control_characters_are_shown_not_sent_and_alignment_survives() {
        let line = DLine { kind: Kind::Context, old: Some(1), new: Some(1), text: "a\u{1b}[31mred\rb\u{202e}x\u{7f}".into(), no_eol: true };
        let pal = palette(Depth::TrueColor);
        let geo = Geometry { width: 60, indent: 4, num_width: 1 };
        let rows = line_rows(&line, geo, Fit::Wrap, &pal, None);
        let text = text_of(&rows[0]);
        assert!(text.contains("a␛[31mred␍b<U+202E>x␡"), "{text:?}");
        assert!(!text.chars().any(|c| c.is_control()), "no control character reaches the terminal");
        assert_eq!(rows[0].width(), 60);
        assert!(text_of(&rows[1]).contains("no newline at end of file"));
    }

    #[test]
    fn a_card_bounds_its_preview_and_counts_exactly_what_it_omits() {
        let mut text = String::from("--- a/f.txt\n+++ b/f.txt\n@@ -1,20 +1,20 @@\n");
        for i in 1..=20 {
            text.push_str(&format!("-old {i}\n+new {i}\n"));
        }
        text.push_str("@@ -90,2 +90,2 @@\n-a\n+b");
        let card = DiffCard {
            evidence: "e1".into(),
            path: "dir/f.txt".into(),
            kind: "modified".into(),
            added: 21,
            removed: 21,
            preview: parse(&text),
            truncated: false,
            total_lines: 0,
            diff_lines: Some(42),
            hunks: Some(2),
            note: None,
            full_path: None,
        };
        let pal = palette(Depth::TrueColor);
        let lines = card_lines(&card, &pal, &CardContext { width: 80, glyph: ("✓", Color::Green), selected: None, review_hint: "ctrl+d to review" });
        let texts: Vec<String> = lines.iter().map(text_of).collect();
        assert_eq!(texts[0], "");
        assert_eq!(texts[1], format!("  ✓ Edited dir/f.txt  +21 {MINUS}21"));
        assert_eq!(texts.iter().filter(|t| t.contains("old ") || t.contains("new ")).count(), PREVIEW_LINES);
        assert!(texts.last().unwrap().contains(&format!("… {} more lines in 1 more hunk · ctrl+d to review", 42 - PREVIEW_LINES)), "{:?}", texts.last());
    }

    #[test]
    fn omission_lines_wrap_under_the_gutter_instead_of_losing_the_review_control() {
        let pal = palette(Depth::TrueColor);
        let geo = Geometry { width: 40, indent: 4, num_width: 2 };
        let rows: Vec<String> = meta_rows(geo, &pal, "… 7 more lines in 1 more hunk · tab, [ ] to select, enter to review").iter().map(text_of).collect();
        assert!(rows.len() > 1);
        assert!(rows.iter().all(|r| r.starts_with("    ▎ ") && UnicodeWidthStr::width(r.as_str()) <= 40), "{rows:?}");
        let joined: String = rows.iter().map(|r| r.trim_start_matches("    ▎ ")).collect::<Vec<_>>().join(" ");
        assert_eq!(joined, "… 7 more lines in 1 more hunk · tab, [ ] to select, enter to review");
        assert_eq!(wrap_at_breaks("a/very/long/path/configuration_loader.rs", 22), vec!["a/very/long/path/", "configuration_loader.r", "s"]);
    }

    #[test]
    fn long_paths_keep_the_file_name_and_elide_leading_directories() {
        let (dir, base) = fit_path("core/src/bin/nexus_tui/live_view.rs", 24);
        assert_eq!(base, "live_view.rs");
        assert!(dir.starts_with("…/") && dir.ends_with('/'), "{dir}");
        assert!(UnicodeWidthStr::width(format!("{dir}{base}").as_str()) <= 24);
        assert_eq!(fit_path("a/b.rs", 80), ("a/".into(), "b.rs".into()));
    }

    #[test]
    fn syntax_colours_keep_at_least_4_5_to_1_contrast_on_every_row_background() {
        // The terminal's own background is assumed dark (the TUI's theme is dark); checked against black and the
        // TUI surface colour.
        for depth in [Depth::TrueColor, Depth::Ansi256] {
            let pal = palette(depth);
            let syntax = pal.syntax.unwrap();
            let backgrounds = [rgb(pal.add_bg.unwrap()), rgb(pal.del_bg.unwrap()), (0, 0, 0), (18, 27, 37)];
            for fg in [pal.text, pal.add_fg, pal.del_fg, syntax.keyword, syntax.string, syntax.comment, syntax.number, syntax.type_name] {
                for bg in backgrounds {
                    let ratio = contrast(rgb(fg), bg);
                    assert!(ratio >= 4.5, "{depth:?}: {fg:?} on {bg:?} is {ratio:.2}:1");
                }
            }
        }
    }

    #[test]
    fn panel_rows_cover_every_file_hunk_and_line() {
        let patch = parse(SAMPLE);
        let rows = panel_rows(&patch);
        assert_eq!(rows.iter().filter(|r| matches!(r, Row::Gap(..))).count(), 2);
        assert_eq!(rows.iter().filter(|r| matches!(r, Row::Line(..))).count(), patch.line_count());
        let pal = palette(Depth::TrueColor);
        let geo = Geometry { width: 80, indent: 0, num_width: patch_num_width(&patch) };
        let gap = text_of(&panel_row_lines(&patch, Row::Gap(0, 1), geo, Fit::Clip(0), &pal)[0]);
        assert!(gap.contains("⋯ 35 unchanged lines") && gap.contains("@@ −40,3 +41,3 @@ fn tail()"), "{gap}");
    }
}
