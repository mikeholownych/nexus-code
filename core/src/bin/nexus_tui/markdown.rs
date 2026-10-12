//! Markdown for the transcript: what the model writes is shown as formatted text, never as raw markers. Headings,
//! paragraphs (source line breaks kept), bullet and numbered lists with hanging indents, block quotes, rules, fenced
//! code in a gutter block with syntax colours (shared with the diff view) and wrapped long lines, and tables aligned
//! in columns (or listed row by row when they do not fit). Inline: **bold**, *italic*, `code`, [links](url).
//!
//! While a reply streams, the last line may hold an opening marker whose close has not arrived yet; it is hidden
//! rather than shown literally, so the text does not flash `**` and then reflow.
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::diff_view::{self, Fit, Palette};
use crate::highlight;

/// Colours for prose, taken from the theme (the diff palette carries the depth-specific code colours).
#[derive(Clone, Copy)]
pub struct Prose {
    pub text: Color,
    pub heading: Color,
    pub muted: Color,
    pub code: Color,
    pub link: Color,
}

/// The language for a fence label (`ts`, `rust`, `python`, …).
fn fence_lang(label: &str) -> Option<&'static highlight::Lang> {
    let ext = match label.trim().to_ascii_lowercase().as_str() {
        "typescript" | "ts" | "tsx" => "ts",
        "javascript" | "js" | "jsx" | "mjs" => "js",
        "rust" | "rs" => "rs",
        "python" | "py" => "py",
        "go" | "golang" => "go",
        "bash" | "sh" | "shell" | "zsh" | "console" => "sh",
        "json" | "jsonc" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "c" | "cpp" | "c++" | "java" | "kotlin" | "swift" | "cs" => "c",
        _ => return None,
    };
    highlight::lang_for(&format!("x.{ext}"))
}

#[derive(Debug)]
enum Block<'a> {
    Blank,
    Heading(usize, &'a str),
    Rule,
    Paragraph(&'a str),
    Item { depth: usize, marker: String, text: &'a str },
    Quote(&'a str),
    Code { lang: &'a str, lines: Vec<&'a str> },
    Table(Vec<Vec<String>>),
}

fn list_item(line: &str) -> Option<(usize, String, &str)> {
    let indent = line.len() - line.trim_start().len();
    let rest = line.trim_start();
    let (marker, body) = if let Some(body) = rest.strip_prefix("- ").or_else(|| rest.strip_prefix("* ")).or_else(|| rest.strip_prefix("+ ")) {
        ("•".to_string(), body)
    } else {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 3 {
            return None;
        }
        let after = &rest[digits..];
        let body = after.strip_prefix(". ").or_else(|| after.strip_prefix(") "))?;
        (format!("{}.", &rest[..digits]), body)
    };
    Some((indent / 2, marker, body))
}

fn table_cells(line: &str) -> Vec<String> {
    let inner = line.trim().trim_start_matches('|').trim_end_matches('|');
    inner.split('|').map(|cell| cell.trim().to_string()).collect()
}

fn is_table_rule(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|') && t.contains('-') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

fn blocks(text: &str) -> Vec<Block<'_>> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if let Some(label) = trimmed.strip_prefix("```").or_else(|| trimmed.strip_prefix("~~~")) {
            let fence = &trimmed[..3];
            let mut body = Vec::new();
            i += 1;
            // An unclosed fence (a reply still streaming) runs to the end of the text.
            while i < lines.len() {
                if lines[i].trim_start().starts_with(fence) {
                    break;
                }
                body.push(lines[i]);
                i += 1;
            }
            out.push(Block::Code { lang: label.trim(), lines: body });
            i += 1;
            continue;
        }
        if trimmed.starts_with('|') && i + 1 < lines.len() && is_table_rule(lines[i + 1]) {
            let mut rows = vec![table_cells(line)];
            i += 2;
            while i < lines.len() && lines[i].trim_start().starts_with('|') {
                rows.push(table_cells(lines[i]));
                i += 1;
            }
            out.push(Block::Table(rows));
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let block = if line.trim().is_empty() {
            Block::Blank
        } else if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            Block::Heading(hashes, trimmed[hashes..].trim())
        } else if matches!(trimmed.trim_end(), "---" | "***" | "___") {
            Block::Rule
        } else if let Some((depth, marker, body)) = list_item(line) {
            Block::Item { depth, marker, text: body }
        } else if let Some(quote) = trimmed.strip_prefix('>') {
            Block::Quote(quote.strip_prefix(' ').unwrap_or(quote))
        } else {
            Block::Paragraph(line)
        };
        out.push(block);
        i += 1;
    }
    out
}

/// Inline Markdown as styled spans. A marker is formatting only when its close is on the same line; an unclosed one
/// stays literal, except at the end of a streaming reply where it is hidden until the close arrives.
pub fn inline(text: &str, base: Style, prose: &Prose, hide_unclosed: bool) -> Vec<Span<'static>> {
    // Tabs expand to 4-column stops before control characters are made visible.
    let mut expanded = String::with_capacity(text.len());
    for c in text.chars() {
        if c == '\t' {
            let col = UnicodeWidthStr::width(expanded.as_str());
            expanded.push_str(&" ".repeat(4 - col % 4));
        } else {
            expanded.push(c);
        }
    }
    let text = diff_view::safe_text(&expanded);
    let chars: Vec<char> = text.chars().collect();
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut plain = String::new();
    let flush = |plain: &mut String, spans: &mut Vec<Span<'static>>| {
        if !plain.is_empty() {
            spans.push(Span::styled(std::mem::take(plain), base));
        }
    };
    let find = |from: usize, pat: &[char]| -> Option<usize> { (from..chars.len().saturating_sub(pat.len() - 1)).find(|&j| chars[j..j + pat.len()] == *pat) };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        if c == '`' {
            if let Some(end) = find(i + 1, &['`']) {
                flush(&mut plain, &mut spans);
                let code: String = chars[i + 1..end].iter().collect();
                spans.push(Span::styled(code, base.fg(prose.code)));
                i = end + 1;
                continue;
            }
            if hide_unclosed {
                i += 1;
                continue;
            }
        }
        if (c == '*' || c == '_') && next == Some(c) {
            let pat = [c, c];
            if let Some(end) = find(i + 2, &pat).filter(|&e| e > i + 2) {
                flush(&mut plain, &mut spans);
                let inner: String = chars[i + 2..end].iter().collect();
                spans.extend(inline(&inner, base.add_modifier(Modifier::BOLD), prose, false));
                i = end + 2;
                continue;
            }
            if hide_unclosed {
                i += 2;
                continue;
            }
        }
        // Single `*`/`_` emphasis only at a word boundary (snake_case and `a * b` stay as written).
        if (c == '*' || c == '_')
            && next.is_some_and(|n| !n.is_whitespace() && n != c)
            && prev.is_none_or(|p| !p.is_alphanumeric())
            && let Some(end) = (i + 1..chars.len()).find(|&j| chars[j] == c && !chars[j - 1].is_whitespace() && chars.get(j + 1).is_none_or(|n| !n.is_alphanumeric()))
        {
            flush(&mut plain, &mut spans);
            let inner: String = chars[i + 1..end].iter().collect();
            spans.extend(inline(&inner, base.add_modifier(Modifier::ITALIC), prose, false));
            i = end + 1;
            continue;
        }
        if c == '['
            && let Some(close) = find(i + 1, &[']'])
            && chars.get(close + 1) == Some(&'(')
            && let Some(end) = find(close + 2, &[')'])
        {
            flush(&mut plain, &mut spans);
            let label: String = chars[i + 1..close].iter().collect();
            let url: String = chars[close + 2..end].iter().collect();
            spans.push(Span::styled(label.clone(), base.fg(prose.link).add_modifier(Modifier::UNDERLINED)));
            if url != label {
                spans.push(Span::styled(format!(" ({url})"), base.fg(prose.muted)));
            }
            i = end + 1;
            continue;
        }
        plain.push(c);
        i += 1;
    }
    flush(&mut plain, &mut spans);
    spans
}

fn span_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| UnicodeWidthStr::width(s.content.as_ref())).sum()
}

/// Word-wraps styled spans to `width`, the first row after `first` and the others after `rest` (hanging indent).
pub fn wrap(spans: Vec<Span<'static>>, width: usize, first: Vec<Span<'static>>, rest: Vec<Span<'static>>) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut row: Vec<Span<'static>> = first.clone();
    let mut used = span_width(&first);
    let rest_width = span_width(&rest);
    let mut is_first = true;
    // Words keep their trailing spaces; each word carries its style.
    let mut words: Vec<(String, Style)> = Vec::new();
    for span in spans {
        let mut word = String::new();
        for g in span.content.graphemes(true) {
            word.push_str(g);
            if g == " " {
                words.push((std::mem::take(&mut word), span.style));
            }
        }
        if !word.is_empty() {
            words.push((word, span.style));
        }
    }
    let push = |row: &mut Vec<Span<'static>>, text: String, style: Style| match row.last_mut() {
        Some(last) if last.style == style => last.content.to_mut().push_str(&text),
        _ => row.push(Span::styled(text, style)),
    };
    let base_len = |is_first: bool| if is_first { span_width(&first) } else { rest_width };
    for (word, style) in words {
        let w = UnicodeWidthStr::width(word.as_str());
        let visible = UnicodeWidthStr::width(word.trim_end());
        if used + visible > width && used > base_len(is_first) {
            out.push(Line::from(std::mem::take(&mut row)));
            row = rest.clone();
            used = rest_width;
            is_first = false;
        }
        if used + w > width && visible > width.saturating_sub(base_len(is_first)) {
            // One word wider than a row: break it.
            for g in word.graphemes(true) {
                let gw = UnicodeWidthStr::width(g);
                if used + gw > width && used > base_len(is_first) {
                    out.push(Line::from(std::mem::take(&mut row)));
                    row = rest.clone();
                    used = rest_width;
                    is_first = false;
                }
                push(&mut row, g.to_string(), style);
                used += gw;
            }
            continue;
        }
        push(&mut row, word, style);
        used += w;
    }
    out.push(Line::from(row));
    out
}

/// Renders a reply. `streaming` hides unclosed markers on the last line.
pub fn render(text: &str, width: usize, pal: &Palette, prose: &Prose, streaming: bool) -> Vec<Line<'static>> {
    let width = width.max(20);
    let base = Style::default().fg(prose.text);
    let muted = Style::default().fg(prose.muted);
    let all = blocks(text);
    let last = all.len().saturating_sub(1);
    let mut out: Vec<Line<'static>> = Vec::new();
    for (index, block) in all.into_iter().enumerate() {
        let hide = streaming && index == last;
        match block {
            Block::Blank => out.push(Line::default()),
            Block::Heading(level, title) => {
                let style = match level {
                    1 => Style::default().fg(prose.heading).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                    2 => Style::default().fg(prose.heading).add_modifier(Modifier::BOLD),
                    _ => base.add_modifier(Modifier::BOLD),
                };
                out.extend(wrap(inline(title, style, prose, hide), width, Vec::new(), Vec::new()));
            }
            Block::Rule => out.push(Line::from(Span::styled("─".repeat(width.min(60)), muted))),
            Block::Paragraph(line) => out.extend(wrap(inline(line, base, prose, hide), width, Vec::new(), Vec::new())),
            Block::Item { depth, marker, text } => {
                let indent = "  ".repeat(depth.min(4));
                let shown = if marker == "•" { ["•", "◦", "▪"][depth.min(2)].to_string() } else { marker };
                let lead = format!("{indent}{shown} ");
                let hang = " ".repeat(UnicodeWidthStr::width(lead.as_str()));
                out.extend(wrap(inline(text, base, prose, hide), width, vec![Span::styled(lead, muted)], vec![Span::raw(hang)]));
            }
            Block::Quote(text) => {
                let bar = Span::styled("▌ ", muted);
                out.extend(wrap(inline(text, base.add_modifier(Modifier::ITALIC), prose, hide), width, vec![bar.clone()], vec![bar]));
            }
            Block::Code { lang, lines } => out.extend(code_block(lang, &lines, width, pal, prose)),
            Block::Table(rows) => out.extend(table(&rows, width, prose)),
        }
    }
    out
}

/// A fenced code block: a gutter bar, the language as a quiet label, syntax colours on a code background spanning
/// the row, and long lines wrapped onto continuation rows marked `↪` so nothing is hidden.
fn code_block(lang: &str, lines: &[&str], width: usize, pal: &Palette, prose: &Prose) -> Vec<Line<'static>> {
    let bar = Span::styled("  ▎ ", Style::default().fg(pal.bar));
    let bg = pal.code_bg;
    let base = bg.map_or_else(Style::default, |bg| Style::default().bg(bg));
    let room = width.saturating_sub(5).max(8);
    let mut out = Vec::new();
    if !lang.is_empty() {
        out.push(Line::from(vec![bar.clone(), Span::styled(diff_view::safe_text(lang), Style::default().fg(prose.muted).add_modifier(Modifier::ITALIC))]));
    }
    let syntax = fence_lang(lang);
    for line in lines {
        for (n, (mut spans, used)) in diff_view::content_rows(line, syntax, room - 1, Fit::Wrap, pal, prose.text, bg).into_iter().enumerate() {
            let mut row = vec![bar.clone(), Span::styled(if n == 0 { " " } else { "↪" }, base.fg(prose.muted))];
            row.append(&mut spans);
            if used < room - 1 {
                row.push(Span::styled(" ".repeat(room - 1 - used), base));
            }
            out.push(Line::from(row));
        }
    }
    out
}

/// A table aligned in columns with a header rule; when it is wider than the transcript, each row is listed as
/// `header: value` pairs instead, so no cell is cut.
fn table(rows: &[Vec<String>], width: usize, prose: &Prose) -> Vec<Line<'static>> {
    let base = Style::default().fg(prose.text);
    let muted = Style::default().fg(prose.muted);
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let cell = |r: usize, c: usize| rows[r].get(c).map(String::as_str).unwrap_or("");
    let rendered: Vec<Vec<Vec<Span<'static>>>> = (0..rows.len())
        .map(|r| (0..columns).map(|c| inline(cell(r, c), if r == 0 { base.add_modifier(Modifier::BOLD) } else { base }, prose, false)).collect())
        .collect();
    let widths: Vec<usize> = (0..columns).map(|c| rendered.iter().map(|row| span_width(&row[c])).max().unwrap_or(0)).collect();
    let total = 2 + widths.iter().sum::<usize>() + 3 * columns.saturating_sub(1);
    let mut out = Vec::new();
    if total <= width {
        for (r, row) in rendered.into_iter().enumerate() {
            let mut line = vec![Span::raw("  ")];
            for (c, spans) in row.into_iter().enumerate() {
                if c > 0 {
                    line.push(Span::styled(" │ ", muted));
                }
                let pad = widths[c] - span_width(&spans);
                line.extend(spans);
                if c + 1 < columns {
                    line.push(Span::raw(" ".repeat(pad)));
                }
            }
            out.push(Line::from(line));
            if r == 0 {
                let rule: Vec<String> = widths.iter().map(|w| "─".repeat(*w)).collect();
                out.push(Line::from(Span::styled(format!("  {}", rule.join("─┼─")), muted)));
            }
        }
        return out;
    }
    let headers: Vec<String> = (0..columns).map(|c| cell(0, c).to_string()).collect();
    for row in rendered.iter().skip(1) {
        let mut spans = Vec::new();
        for (c, (header, value)) in headers.iter().zip(row).enumerate() {
            if c > 0 {
                spans.push(Span::styled(" · ", muted));
            }
            spans.push(Span::styled(format!("{}: ", diff_view::safe_text(header)), muted));
            spans.extend(value.clone());
        }
        out.extend(wrap(spans, width, vec![Span::styled("  • ", muted)], vec![Span::raw("    ")]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Depth;

    fn prose() -> Prose {
        Prose { text: Color::White, heading: Color::Cyan, muted: Color::Gray, code: Color::Yellow, link: Color::Blue }
    }

    fn texts(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>().trim_end().to_string()).collect()
    }

    const SAMPLE: &str = "## Plan\n\nThe cache sits **between** the `Loader` and *the store*.\n\n1. First step\n2. Second step\n\n- Reads\n  - nested\n\n```ts\nconst x = 1;\n\tindented();\n```\n\n| Option | Default |\n|---|---|\n| size | 512 |\n\n> quoted\n\nSee [docs](https://example.com) and snake_case_name.";

    #[test]
    fn markdown_renders_without_leftover_markers() {
        let lines = render(SAMPLE, 80, &diff_view::palette(Depth::TrueColor), &prose(), false);
        let all = texts(&lines);
        let joined = all.join("\n");
        for marker in ["##", "**", "```", "|---", "](", "> "] {
            assert!(!joined.contains(marker), "{marker:?} left in:\n{joined}");
        }
        assert!(all.contains(&"Plan".to_string()));
        assert!(all.contains(&"The cache sits between the Loader and the store.".to_string()), "{all:#?}");
        assert!(all.contains(&"1. First step".to_string()));
        assert!(all.contains(&"• Reads".to_string()) && all.contains(&"  ◦ nested".to_string()));
        assert!(all.iter().any(|l| l.contains("▎ ts")) && all.iter().any(|l| l.contains("const x = 1;")));
        assert!(all.iter().any(|l| l.contains("      indented();")), "tabs expand inside code: {all:#?}");
        assert!(all.iter().any(|l| l.contains("Option │ Default")) && all.iter().any(|l| l.contains("size   │ 512")), "{all:#?}");
        assert!(all.iter().any(|l| l == "▌ quoted"));
        assert!(all.iter().any(|l| l.contains("See docs (https://example.com) and snake_case_name.")));
        let bold = lines.iter().flat_map(|l| &l.spans).find(|s| s.content == "between").unwrap();
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn list_items_wrap_with_a_hanging_indent_and_long_code_lines_wrap_with_a_marker() {
        let text = "- a list item whose text is long enough to wrap onto a second row in a narrow window\n```\nlet value = \"a very long string literal that cannot fit in the window at all\";\n```";
        let lines = render(text, 40, &diff_view::palette(Depth::TrueColor), &prose(), false);
        let all = texts(&lines);
        assert!(all[0].starts_with("• a list") && all[1].starts_with("  "), "{all:#?}");
        assert!(all.iter().all(|l| UnicodeWidthStr::width(l.as_str()) <= 40), "{all:#?}");
        assert!(all.iter().any(|l| l.contains("▎ ↪")), "continuation rows are marked: {all:#?}");
    }

    #[test]
    fn a_wide_table_lists_rows_instead_of_cutting_cells() {
        let text = "| Name | Description |\n|---|---|\n| cache | a description long enough that the aligned table would not fit in forty columns |";
        let all = texts(&render(text, 40, &diff_view::palette(Depth::TrueColor), &prose(), false));
        assert!(all[0].starts_with("  • Name: cache · Description: a"), "{all:#?}");
        assert!(all.join(" ").split_whitespace().collect::<Vec<_>>().join(" ").contains("forty columns"), "{all:#?}");
    }

    #[test]
    fn streaming_hides_unclosed_markers_on_the_last_line_only() {
        let pal = diff_view::palette(Depth::TrueColor);
        let all = texts(&render("done **bold** here\nnow **partial", 80, &pal, &prose(), true));
        assert_eq!(all, vec!["done bold here", "now partial"]);
        let all = texts(&render("now **partial", 80, &pal, &prose(), false));
        assert_eq!(all, vec!["now **partial"], "a finished reply shows an unmatched marker as written");
        let all = texts(&render("```rust\nfn main() {", 80, &pal, &prose(), true));
        assert!(all.iter().any(|l| l.contains("fn main()")) && !all.iter().any(|l| l.contains('…')), "{all:#?}");
    }

    #[test]
    fn control_characters_and_wide_text_are_safe() {
        let all = texts(&render("bell\u{7} esc\u{1b}[2J 字符 café ✅", 80, &diff_view::palette(Depth::TrueColor), &prose(), false));
        assert_eq!(all, vec!["bell␇ esc␛[2J 字符 café ✅"]);
    }
}
