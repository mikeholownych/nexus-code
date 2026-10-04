//! Multi-line prompt editor for the live composer: a text buffer with a grapheme-aware cursor, readline-style
//! editing, and in-memory prompt history. Pure; the view asks it for a wrapped layout.
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const HISTORY_LIMIT: usize = 200;
/// Columns taken by the `› ` / `  ` prefix in front of every composer row.
pub const PREFIX_WIDTH: u16 = 2;
const TAB: &str = "    ";

#[derive(Clone, Debug, Default)]
pub struct Composer {
    text: String,
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
        self.cursor = 0;
    }

    /// Inserts at the cursor. Carriage returns become newlines; control characters other than newline and tab
    /// are dropped (the terminal would not show them and they would throw off the cursor column).
    pub fn insert(&mut self, text: &str) {
        let clean: String = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
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

    /// Hands the draft over for submission, records it in history, and starts an empty draft.
    pub fn take(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
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
                let shown = if grapheme == "\t" { TAB } else { grapheme };
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

#[cfg(test)]
mod tests {
    use super::*;

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
