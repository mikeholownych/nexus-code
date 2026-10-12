//! A small lexical highlighter for diff rows: keywords, strings, comments, numbers and type-like names for common
//! languages, chosen by file extension. It is line-based on purpose — a diff shows fragments of a file, so nothing
//! outside the line is known. A block comment or string that spans lines is coloured on the line that opens it, and
//! continuation lines that start with `*` (the usual doc-comment style) are coloured as comment. Anything it does not
//! recognise stays plain text, so a wrong guess costs colour, never content.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token {
    Plain,
    Keyword,
    Str,
    Comment,
    Number,
    Type,
}

pub struct Lang {
    line_comments: &'static [&'static str],
    block_comment: Option<(&'static str, &'static str)>,
    quotes: &'static [char],
    keywords: &'static [&'static str],
    /// Capitalised identifiers read as type names.
    types: bool,
    /// `'` opens a string only around one character (`'a'`, `'\n'`), so Rust lifetimes stay plain.
    strict_single_quote: bool,
}

const C_LIKE_COMMENT: Option<(&str, &str)> = Some(("/*", "*/"));

static RUST: Lang = Lang {
    line_comments: &["//"],
    block_comment: C_LIKE_COMMENT,
    quotes: &['"', '\''],
    keywords: &[
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn",
        "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self",
        "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
    ],
    types: true,
    strict_single_quote: true,
};

static TYPESCRIPT: Lang = Lang {
    line_comments: &["//"],
    block_comment: C_LIKE_COMMENT,
    quotes: &['"', '\'', '`'],
    keywords: &[
        "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
        "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from",
        "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "of",
        "private", "protected", "public", "readonly", "return", "set", "static", "super", "switch", "this", "throw",
        "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
    ],
    types: true,
    strict_single_quote: false,
};

static PYTHON: Lang = Lang {
    line_comments: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    keywords: &[
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "match",
        "nonlocal", "not", "or", "pass", "raise", "return", "self", "try", "while", "with", "yield",
    ],
    types: true,
    strict_single_quote: false,
};

static GO: Lang = Lang {
    line_comments: &["//"],
    block_comment: C_LIKE_COMMENT,
    quotes: &['"', '`', '\''],
    keywords: &[
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "false", "for", "func",
        "go", "goto", "if", "import", "interface", "map", "nil", "package", "range", "return", "select", "struct",
        "switch", "true", "type", "var",
    ],
    types: true,
    strict_single_quote: false,
};

static SHELL: Lang = Lang {
    line_comments: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    keywords: &[
        "case", "do", "done", "elif", "else", "esac", "exit", "export", "fi", "for", "function", "if", "in", "local",
        "readonly", "return", "set", "then", "until", "while",
    ],
    types: false,
    strict_single_quote: false,
};

static C_FAMILY: Lang = Lang {
    line_comments: &["//"],
    block_comment: C_LIKE_COMMENT,
    quotes: &['"', '\''],
    keywords: &[
        "auto", "bool", "break", "case", "char", "class", "const", "continue", "default", "do", "double", "else",
        "enum", "extends", "extern", "false", "final", "float", "for", "fun", "if", "implements", "import", "int",
        "interface", "long", "namespace", "new", "null", "nullptr", "package", "private", "protected", "public",
        "return", "short", "signed", "sizeof", "static", "struct", "switch", "template", "this", "throw", "true",
        "try", "typedef", "union", "unsigned", "using", "val", "var", "virtual", "void", "volatile", "while",
    ],
    types: true,
    strict_single_quote: false,
};

static DATA: Lang = Lang {
    line_comments: &["#"],
    block_comment: None,
    quotes: &['"', '\''],
    keywords: &["true", "false", "null", "yes", "no", "on", "off"],
    types: false,
    strict_single_quote: false,
};

static JSON: Lang = Lang {
    line_comments: &[],
    block_comment: None,
    quotes: &['"'],
    keywords: &["true", "false", "null"],
    types: false,
    strict_single_quote: false,
};

/// The language for a path, by extension; `None` leaves the content plain.
pub fn lang_for(path: &str) -> Option<&'static Lang> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if matches!(name, "Makefile" | "Dockerfile" | ".bashrc" | ".zshrc" | ".profile") {
        return Some(&SHELL);
    }
    let ext = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())?;
    Some(match ext.as_str() {
        "rs" => &RUST,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => &TYPESCRIPT,
        "py" | "pyi" => &PYTHON,
        "go" => &GO,
        "sh" | "bash" | "zsh" => &SHELL,
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "java" | "kt" | "kts" | "cs" | "swift" => &C_FAMILY,
        "toml" | "yaml" | "yml" | "ini" | "cfg" | "conf" | "env" => &DATA,
        "json" | "jsonc" => &JSON,
        _ => return None,
    })
}

fn ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '$'
}

fn ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Byte ranges of `text` with their token class, covering the whole line in order.
pub fn highlight(lang: &Lang, text: &str) -> Vec<(usize, usize, Token)> {
    let mut out: Vec<(usize, usize, Token)> = Vec::new();
    let mut push = |start: usize, end: usize, token: Token| {
        if start >= end {
            return;
        }
        match out.last_mut() {
            Some(last) if last.2 == token && last.1 == start => last.1 = end,
            _ => out.push((start, end, token)),
        }
    };
    let trimmed = text.trim_start();
    if lang.block_comment.is_some() && (trimmed.starts_with("* ") || trimmed == "*" || trimmed.starts_with("*/")) {
        push(0, text.len(), Token::Comment);
        return out;
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let at = |i: usize| chars.get(i).map(|(_, c)| *c);
    let byte = |i: usize| chars.get(i).map_or(text.len(), |(b, _)| *b);
    let mut i = 0;
    while i < chars.len() {
        let start = byte(i);
        let rest = &text[start..];
        if let Some(prefix) = lang.line_comments.iter().find(|p| rest.starts_with(**p)) {
            // `#` is a comment only at a word boundary (so `$#` or `a#b` stay plain in shell and data files).
            let boundary = *prefix != "#" || i == 0 || at(i - 1).is_some_and(char::is_whitespace);
            if boundary {
                push(start, text.len(), Token::Comment);
                return out;
            }
        }
        if let Some((open, close)) = lang.block_comment
            && rest.starts_with(open)
        {
            let end = rest[open.len()..].find(close).map_or(text.len(), |at| start + open.len() + at + close.len());
            push(start, end, Token::Comment);
            while i < chars.len() && byte(i) < end {
                i += 1;
            }
            continue;
        }
        let c = chars[i].1;
        if lang.quotes.contains(&c) {
            if c == '\'' && lang.strict_single_quote {
                let char_literal = match (at(i + 1), at(i + 2), at(i + 3)) {
                    (Some('\\'), Some(_), _) => true,
                    (Some(x), Some('\''), _) if x != '\'' => true,
                    _ => false,
                };
                if !char_literal {
                    push(start, byte(i + 1), Token::Plain);
                    i += 1;
                    continue;
                }
            }
            let mut j = i + 1;
            while j < chars.len() {
                match chars[j].1 {
                    '\\' => j += 2,
                    q if q == c => {
                        j += 1;
                        break;
                    }
                    _ => j += 1,
                }
            }
            let end = byte(j.min(chars.len()));
            push(start, end, Token::Str);
            i = j.min(chars.len());
            continue;
        }
        if c.is_ascii_digit() && !(i > 0 && at(i - 1).is_some_and(ident_char)) {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].1.is_ascii_alphanumeric() || chars[j].1 == '_' || chars[j].1 == '.') {
                j += 1;
            }
            push(start, byte(j), Token::Number);
            i = j;
            continue;
        }
        if ident_start(c) {
            let mut j = i + 1;
            while j < chars.len() && ident_char(chars[j].1) {
                j += 1;
            }
            let word = &text[start..byte(j)];
            let token = if lang.keywords.contains(&word) {
                Token::Keyword
            } else if lang.types && c.is_uppercase() && word.chars().any(char::is_lowercase) {
                Token::Type
            } else {
                Token::Plain
            };
            push(start, byte(j), token);
            i = j;
            continue;
        }
        push(start, byte(i + 1), Token::Plain);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classes(path: &str, text: &str) -> Vec<(String, Token)> {
        highlight(lang_for(path).unwrap(), text)
            .into_iter()
            .filter(|(_, _, t)| *t != Token::Plain)
            .map(|(s, e, t)| (text[s..e].to_string(), t))
            .collect()
    }

    #[test]
    fn keywords_strings_comments_numbers_and_types_are_classified() {
        assert_eq!(
            classes("a.ts", r#"const x: Foo = "a // b" + 42; // note"#),
            vec![
                ("const".into(), Token::Keyword),
                ("Foo".into(), Token::Type),
                (r#""a // b""#.into(), Token::Str),
                ("42".into(), Token::Number),
                ("// note".into(), Token::Comment),
            ]
        );
        assert_eq!(classes("x.py", "def f(): return 'it''s'  # c")[0], ("def".into(), Token::Keyword));
    }

    #[test]
    fn rust_lifetimes_stay_plain_and_char_literals_are_strings() {
        let found = classes("lib.rs", "fn f<'a>(x: &'a str) -> char { 'x' }");
        assert!(found.contains(&("'x'".into(), Token::Str)));
        assert!(!found.iter().any(|(text, t)| *t == Token::Str && text.contains("'a")), "{found:?}");
    }

    #[test]
    fn ranges_cover_the_line_and_unknown_files_are_plain() {
        let text = "let s = \"unterminated  é 字";
        let ranges = highlight(lang_for("m.rs").unwrap(), text);
        assert_eq!(ranges.first().unwrap().0, 0);
        assert_eq!(ranges.last().unwrap().1, text.len());
        assert!(ranges.windows(2).all(|w| w[0].1 == w[1].0));
        assert!(lang_for("README").is_none());
        assert!(lang_for("notes.unknown").is_none());
    }

    #[test]
    fn doc_comment_continuations_and_shell_hash_boundaries() {
        assert_eq!(classes("a.rs", "   * continued doc"), vec![("   * continued doc".into(), Token::Comment)]);
        assert!(classes("run.sh", "echo $# args").iter().all(|(_, t)| *t != Token::Comment));
    }
}
