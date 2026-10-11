//! Multi-line prompt editor for the live composer: a text buffer with a grapheme-aware cursor, readline-style
//! editing, and in-memory prompt history. Pure; the view asks it for a wrapped layout.
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const HISTORY_LIMIT: usize = 200;
/// Pastes with a line break, or longer than this many characters, become a paste buffer instead of draft text.
pub const PASTE_BUFFER_CHARS: usize = 800;
/// First placeholder character (Supplementary Private Use Area-A); paste n is `TOKEN_BASE + n`.
const TOKEN_BASE: u32 = 0xF0000;
const TOKEN_LIMIT: u32 = 0xFFFD;
/// Columns taken by the `› ` / `  ` prefix in front of every composer row.
pub const PREFIX_WIDTH: u16 = 2;
const TAB: &str = "    ";

/// Pasted text held outside the draft. The draft holds a single placeholder character for it, so the paste moves,
/// deletes and wraps as one unit, and its content reaches the agent exactly as pasted.
#[derive(Clone, Debug, PartialEq)]
pub struct Paste {
    pub number: u32,
    pub content: String,
}

impl Paste {
    /// `[Pasted text #1: 24 lines]`, or the character count for one long line.
    pub fn label(&self) -> String {
        let lines = self.content.lines().count().max(1);
        if self.content.contains('\n') {
            let unit = if lines == 1 { "line" } else { "lines" };
            format!("[Pasted text #{}: {lines} {unit}]", self.number)
        } else {
            format!("[Pasted text #{}: {} chars]", self.number, self.content.chars().count())
        }
    }
}

fn token_number(c: char) -> Option<u32> {
    let code = u32::from(c);
    (TOKEN_BASE..TOKEN_BASE + TOKEN_LIMIT)
        .contains(&code)
        .then(|| code - TOKEN_BASE)
}

#[derive(Clone, Debug, Default)]
pub struct Composer {
    text: String,
    /// Paste buffers referenced by placeholders in `text` (kept until the draft is submitted or cleared).
    pastes: Vec<Paste>,
    paste_seq: u32,
    /// Byte offset into `text`, always on a grapheme boundary.
    cursor: usize,
    history: Vec<String>,
    /// Index into `history` while recalling; `None` while editing a draft.
    recall: Option<usize>,
    /// The draft being edited when recall started; Down past the newest prompt brings it back.
    stash: String,
}

/// Composer rows after wrapping (tabs expanded), and the cursor's row and column (column after the prefix).
#[derive(Clone, Debug, PartialEq)]
pub struct ComposerLayout {
    pub rows: Vec<String>,
    pub cursor: (usize, u16),
}

impl From<&str> for Composer {
    fn from(text: &str) -> Self {
        let mut composer = Composer::default();
        composer.insert(text);
        composer
    }
}

impl PartialEq<&str> for Composer {
    fn eq(&self, other: &&str) -> bool {
        self.text == *other
    }
}

impl Composer {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    #[cfg(test)]
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn clear(&mut self) {
        self.edited();
        self.text.clear();
        self.pastes.clear();
        self.cursor = 0;
    }

    /// A bracketed (or detected) paste. A paste with a line break, or a long one, becomes a paste buffer shown as
    /// `[Pasted text #n: N lines]`; its content is kept exactly, apart from terminal line endings (CR, CRLF) which
    /// become newlines. Short single-line pastes are ordinary draft text.
    pub fn paste(&mut self, text: &str) {
        let content = text.replace("\r\n", "\n").replace('\r', "\n");
        if content.is_empty() {
            return;
        }
        if !content.contains('\n') && content.chars().count() <= PASTE_BUFFER_CHARS {
            self.insert(&content);
            return;
        }
        if self.paste_seq + 1 >= TOKEN_LIMIT {
            self.insert(&content);
            return;
        }
        self.paste_seq += 1;
        let number = self.paste_seq;
        self.pastes.push(Paste { number, content });
        let token = char::from_u32(TOKEN_BASE + number).expect("private-use code point");
        self.edited();
        self.text.insert(self.cursor, token);
        self.cursor += token.len_utf8();
    }

    /// The paste whose placeholder is just before the cursor, else just after it.
    pub fn paste_at_cursor(&self) -> Option<&Paste> {
        let before = self.text[..self.cursor].chars().next_back().and_then(token_number);
        let after = self.text[self.cursor..].chars().next().and_then(token_number);
        before
            .or(after)
            .and_then(|number| self.pastes.iter().find(|p| p.number == number))
    }

    /// Replaces the placeholder at the cursor with its content as ordinary, editable draft text.
    pub fn expand_paste_at_cursor(&mut self) -> bool {
        let before = self.text[..self.cursor]
            .char_indices()
            .next_back()
            .filter(|(_, c)| token_number(*c).is_some());
        let after = self.text[self.cursor..]
            .char_indices()
            .next()
            .filter(|(_, c)| token_number(*c).is_some())
            .map(|(i, c)| (self.cursor + i, c));
        let Some((at, token)) = before.or(after) else {
            return false;
        };
        let number = token_number(token).unwrap_or_default();
        let Some(content) = self.pastes.iter().find(|p| p.number == number).map(|p| p.content.clone()) else {
            return false;
        };
        self.edited();
        self.text.replace_range(at..at + token.len_utf8(), &content);
        self.cursor = at + content.len();
        true
    }

    /// The draft with each placeholder replaced by its paste, exactly as it will be submitted.
    pub fn expand(&self, text: &str) -> String {
        text.chars().fold(String::with_capacity(text.len()), |mut out, c| {
            match token_number(c).and_then(|n| self.pastes.iter().find(|p| p.number == n)) {
                Some(paste) => out.push_str(&paste.content),
                None => out.push(c),
            }
            out
        })
    }

    /// The draft with each placeholder shown as its label, for the transcript.
    pub fn display(&self, text: &str) -> String {
        text.chars().fold(String::with_capacity(text.len()), |mut out, c| {
            match token_number(c).and_then(|n| self.pastes.iter().find(|p| p.number == n)) {
                Some(paste) => out.push_str(&paste.label()),
                None => out.push(c),
            }
            out
        })
    }

    /// A paste buffer by number, while the draft still holds it.
    pub fn paste_buffer(&self, number: u32) -> Option<&Paste> {
        self.pastes.iter().find(|p| p.number == number)
    }

    /// Inserts at the cursor. Carriage returns become newlines; control characters other than newline and tab
    /// are dropped (the terminal would not show them and they would throw off the cursor column), and so are
    /// paste placeholder characters, which only `paste` may create.
    pub fn insert(&mut self, text: &str) {
        let clean: String = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .chars()
            .filter(|c| (!c.is_control() || matches!(c, '\n' | '\t')) && token_number(*c).is_none())
            .collect();
        if clean.is_empty() {
            return;
        }
        self.edited();
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
    }

    pub fn backspace(&mut self) {
        if let Some(start) = self.previous_boundary() {
            self.remove(start, self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if let Some(end) = self.next_boundary() {
            self.remove(self.cursor, end);
        }
    }

    pub fn left(&mut self) {
        if let Some(at) = self.previous_boundary() {
            self.cursor = at;
        }
    }

    pub fn right(&mut self) {
        if let Some(at) = self.next_boundary() {
            self.cursor = at;
        }
    }

    pub fn word_left(&mut self) {
        self.cursor = self.word_start();
    }

    pub fn word_right(&mut self) {
        let rest = &self.text[self.cursor..];
        let spaces = rest.len() - rest.trim_start().len();
        let word = rest[spaces..]
            .find(char::is_whitespace)
            .unwrap_or(rest.len() - spaces);
        self.cursor += spaces + word;
    }

    pub fn delete_word_back(&mut self) {
        let start = self.word_start();
        self.remove(start, self.cursor);
    }

    pub fn line_start(&mut self) {
        self.cursor = self.current_line_start();
    }

    pub fn line_end(&mut self) {
        self.cursor = self.current_line_end();
    }

    pub fn at_end(&self) -> bool {
        self.cursor == self.text.len()
    }

    pub fn kill_to_line_start(&mut self) {
        let start = self.current_line_start();
        self.remove(start, self.cursor);
    }

    pub fn kill_to_line_end(&mut self) {
        let end = self.current_line_end();
        self.remove(self.cursor, end);
    }

    /// Moves to the previous line; on the first line, recalls the previous prompt.
    pub fn up(&mut self) {
        let start = self.current_line_start();
        if start == 0 {
            self.recall_older();
            return;
        }
        let column = self.text[start..self.cursor].graphemes(true).count();
        let previous = self.text[..start - 1].rfind('\n').map_or(0, |at| at + 1);
        self.cursor = self.offset_in_line(previous, start - 1, column);
    }

    /// Moves to the next line; on the last line, steps forward through recalled prompts.
    pub fn down(&mut self) {
        let end = self.current_line_end();
        if end == self.text.len() {
            self.recall_newer();
            return;
        }
        let column = self.text[self.current_line_start()..self.cursor]
            .graphemes(true)
            .count();
        let next = end + 1;
        let next_end = self.text[next..]
            .find('\n')
            .map_or(self.text.len(), |at| next + at);
        self.cursor = self.offset_in_line(next, next_end, column);
    }

    /// Hands the draft over for submission with every paste expanded, records it in history, and starts an empty
    /// draft.
    pub fn take(&mut self) -> String {
        let raw = std::mem::take(&mut self.text);
        let text = self.expand(&raw);
        self.pastes.clear();
        self.cursor = 0;
        self.recall = None;
        self.stash.clear();
        if !text.trim().is_empty() && self.history.last() != Some(&text) {
            self.history.push(text.clone());
            if self.history.len() > HISTORY_LIMIT {
                self.history.remove(0);
            }
        }
        text
    }

    /// Wraps the draft into rows of at most `width - PREFIX_WIDTH` columns, breaking between graphemes, and
    /// finds the cursor. A cursor at the end of a full row moves to the start of a new row.
    pub fn layout(&self, width: u16) -> ComposerLayout {
        let room = usize::from(width.saturating_sub(PREFIX_WIDTH).max(1));
        let column = |used: usize| u16::try_from(used).unwrap_or(u16::MAX);
        let mut rows = vec![String::new()];
        let mut cursor = (0, 0);
        let mut offset = 0;
        for (index, line) in self.text.split('\n').enumerate() {
            if index > 0 {
                rows.push(String::new());
                offset += 1;
            }
            let mut used = 0;
            for grapheme in line.graphemes(true) {
                let label = grapheme
                    .chars()
                    .next()
                    .and_then(token_number)
                    .and_then(|n| self.pastes.iter().find(|p| p.number == n))
                    .map(|paste| fit(&paste.label(), room));
                let shown = match &label {
                    Some(label) => label.as_str(),
                    None if grapheme == "\t" => TAB,
                    None => grapheme,
                };
                let cols = shown.width();
                if used > 0 && used + cols > room {
                    rows.push(String::new());
                    used = 0;
                }
                if offset == self.cursor {
                    cursor = (rows.len() - 1, column(used));
                }
                if let Some(row) = rows.last_mut() {
                    row.push_str(shown);
                }
                used += cols;
                offset += grapheme.len();
            }
            if offset == self.cursor {
                if used >= room {
                    rows.push(String::new());
                    used = 0;
                }
                cursor = (rows.len() - 1, column(used));
            }
        }
        ComposerLayout { rows, cursor }
    }

    #[cfg(test)]
    pub fn pastes(&self) -> &[Paste] {
        &self.pastes
    }

    /// Any edit ends history recall; the recalled text becomes the draft.
    fn edited(&mut self) {
        self.recall = None;
        self.stash.clear();
    }

    fn remove(&mut self, start: usize, end: usize) {
        if start < end {
            self.edited();
            self.text.replace_range(start..end, "");
            self.cursor = start;
        }
    }

    fn previous_boundary(&self) -> Option<usize> {
        self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(index, _)| index)
    }

    fn next_boundary(&self) -> Option<usize> {
        self.text[self.cursor..]
            .graphemes(true)
            .next()
            .map(|grapheme| self.cursor + grapheme.len())
    }

    fn word_start(&self) -> usize {
        let before = self.text[..self.cursor].trim_end();
        before
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(0, |(index, c)| index + c.len_utf8())
    }

    fn current_line_start(&self) -> usize {
        self.text[..self.cursor].rfind('\n').map_or(0, |at| at + 1)
    }

    fn current_line_end(&self) -> usize {
        self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |at| self.cursor + at)
    }

    /// Byte offset of the `column`-th grapheme of the line `start..end`, or `end` when the line is shorter.
    fn offset_in_line(&self, start: usize, end: usize, column: usize) -> usize {
        self.text[start..end]
            .grapheme_indices(true)
            .nth(column)
            .map_or(end, |(index, _)| start + index)
    }

    fn recall_older(&mut self) {
        let index = match self.recall {
            None if self.history.is_empty() => return,
            None => {
                self.stash = self.text.clone();
                self.history.len() - 1
            }
            Some(0) => return,
            Some(index) => index - 1,
        };
        self.recall = Some(index);
        self.text = self.history[index].clone();
        self.cursor = self.text.len();
    }

    fn recall_newer(&mut self) {
        let Some(index) = self.recall else {
            return;
        };
        if index + 1 < self.history.len() {
            self.recall = Some(index + 1);
            self.text = self.history[index + 1].clone();
        } else {
            self.recall = None;
            self.text = std::mem::take(&mut self.stash);
        }
        self.cursor = self.text.len();
    }
}

/// `label` cut to `room` columns (with an ellipsis) so a placeholder never overflows its row.
fn fit(label: &str, room: usize) -> String {
    if label.width() <= room {
        return label.to_string();
    }
    let mut out = String::new();
    for c in label.chars() {
        if out.width() + 2 > room {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiline_and_long_pastes_become_buffers_that_expand_exactly() {
        let mut composer = Composer::default();
        composer.insert("fix ");
        let pasted = "  é—中文 🦀\ttab\r\nline two  \r\n\r\n/exit\nlast";
        composer.paste(pasted);
        composer.insert(" and ");
        composer.paste(&"y".repeat(PASTE_BUFFER_CHARS + 1));
        composer.insert(" done");
        assert_eq!(composer.pastes().len(), 2);
        assert_eq!(
            composer.display(composer.text()),
            format!("fix [Pasted text #1: 5 lines] and [Pasted text #2: {} chars] done", PASTE_BUFFER_CHARS + 1)
        );
        let expected = format!("fix   é—中文 🦀\ttab\nline two  \n\n/exit\nlast and {} done", "y".repeat(PASTE_BUFFER_CHARS + 1));
        assert_eq!(composer.take(), expected, "CRLF from the terminal becomes LF; everything else is exact");
        assert!(composer.pastes().is_empty());
    }

    #[test]
    fn a_short_single_line_paste_is_plain_text_and_typed_placeholders_are_dropped() {
        let mut composer = Composer::default();
        composer.paste("hello");
        composer.insert("\u{F0001}x");
        assert_eq!(composer.text(), "hellox");
        assert!(composer.pastes().is_empty());
    }

    #[test]
    fn a_paste_buffer_moves_deletes_and_expands_as_one_unit() {
        let mut composer = Composer::default();
        composer.insert("a");
        composer.paste("one\ntwo");
        composer.insert("b");
        composer.left();
        assert_eq!(composer.paste_at_cursor().map(|p| p.number), Some(1));
        composer.left();
        assert_eq!(composer.cursor(), 1, "one Left crosses the whole placeholder");
        composer.right();
        composer.backspace();
        assert_eq!(composer.expand(composer.text()), "ab", "backspace removes the buffer");
        composer.paste("x\ny");
        assert!(composer.expand_paste_at_cursor());
        assert_eq!(composer.text(), "ax\nyb", "ctrl+x leaves ordinary, editable text");
        assert!(composer.paste_at_cursor().is_none());
    }

    #[test]
    fn a_paste_label_takes_its_display_width_and_never_overflows_a_row() {
        let mut composer = Composer::default();
        composer.paste("1\n2\n3");
        let layout = composer.layout(80);
        assert_eq!(layout.rows, vec!["[Pasted text #1: 3 lines]".to_string()]);
        assert_eq!(layout.cursor, (0, 25));
        let narrow = composer.layout(14);
        assert!(narrow.rows.iter().all(|row| row.width() <= 12), "{:?}", narrow.rows);
    }

    fn typed(text: &str) -> Composer {
        let mut composer = Composer::default();
        composer.insert(text);
        composer
    }

    #[test]
    fn at_end_follows_the_cursor() {
        let mut composer = Composer::from("ab");
        assert!(composer.at_end());
        composer.left();
        assert!(!composer.at_end());
        composer.line_end();
        assert!(composer.at_end());
    }

    #[test]
    fn inserts_at_the_cursor_and_moves_by_grapheme() {
        let mut composer = typed("helo");
        composer.left();
        composer.insert("l");
        assert_eq!(composer.text(), "hello");
        assert_eq!(composer.cursor(), 4);
        let mut emoji = typed("a👩‍💻b");
        emoji.left();
        emoji.backspace();
        assert_eq!(emoji.text(), "ab");
        emoji.line_start();
        emoji.delete();
        assert_eq!(emoji.text(), "b");
    }

    #[test]
    fn word_motions_and_word_delete() {
        let mut composer = typed("fix the parser");
        composer.word_left();
        assert_eq!(composer.cursor(), 8);
        composer.word_left();
        assert_eq!(composer.cursor(), 4);
        composer.word_right();
        assert_eq!(composer.cursor(), 7);
        composer.line_end();
        composer.delete_word_back();
        assert_eq!(composer.text(), "fix the ");
    }

    #[test]
    fn line_keys_work_on_the_current_line() {
        let mut composer = typed("one\ntwo");
        composer.line_start();
        assert_eq!(composer.cursor(), 4);
        composer.kill_to_line_end();
        assert_eq!(composer.text(), "one\n");
        composer.insert("2");
        composer.up();
        assert_eq!(composer.cursor(), 1);
        composer.line_end();
        composer.kill_to_line_start();
        assert_eq!(composer.text(), "\n2");
    }

    #[test]
    fn up_and_down_keep_the_column_where_they_can() {
        let mut composer = typed("long line\nab");
        composer.up();
        assert_eq!(composer.cursor(), 2);
        composer.down();
        assert_eq!(composer.cursor(), 12);
    }

    #[test]
    fn history_recalls_prompts_and_restores_the_draft() {
        let mut composer = Composer::default();
        for prompt in ["first", "second", "second", "   "] {
            composer.insert(prompt);
            composer.take();
        }
        composer.insert("draft");
        composer.up();
        assert_eq!(composer.text(), "second");
        composer.up();
        assert_eq!(composer.text(), "first");
        composer.up();
        assert_eq!(composer.text(), "first");
        composer.down();
        assert_eq!(composer.text(), "second");
        composer.down();
        assert_eq!(composer.text(), "draft");
        composer.up();
        composer.insert("!");
        composer.down();
        assert_eq!(
            composer.text(),
            "second!",
            "editing a recalled prompt makes it the draft"
        );
    }

    #[test]
    fn layout_wraps_by_character_and_places_the_cursor() {
        assert_eq!(
            typed("abcdefghij").layout(10),
            ComposerLayout {
                rows: vec!["abcdefgh".into(), "ij".into()],
                cursor: (1, 2)
            }
        );
        let mut two_lines = typed("ab\ncd");
        two_lines.up();
        two_lines.line_start();
        two_lines.right();
        assert_eq!(
            two_lines.layout(20),
            ComposerLayout {
                rows: vec!["ab".into(), "cd".into()],
                cursor: (0, 1)
            }
        );
        assert_eq!(
            typed("日本語の").layout(10),
            ComposerLayout {
                rows: vec!["日本語の".into(), String::new()],
                cursor: (1, 0)
            }
        );
        assert_eq!(
            typed("日本語の").layout(9),
            ComposerLayout {
                rows: vec!["日本語".into(), "の".into()],
                cursor: (1, 2)
            }
        );
        assert_eq!(
            typed("\tx").layout(20),
            ComposerLayout {
                rows: vec!["    x".into()],
                cursor: (0, 5)
            }
        );
        assert_eq!(
            Composer::default().layout(20),
            ComposerLayout {
                rows: vec![String::new()],
                cursor: (0, 0)
            }
        );
    }

    #[test]
    fn inserted_text_normalises_line_endings_and_drops_control_characters() {
        let composer = Composer::from("a\r\nb\rc\u{1b}[31md\u{7}\te");
        assert_eq!(composer, "a\nb\nc[31md\te");
    }
}
