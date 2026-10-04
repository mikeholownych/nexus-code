//! Turns an approval request's review payload into display lines: a unified diff for file changes, the patch as
//! sent, or the command line. Pure; the sidecar already redacted and capped the text.
use std::ops::Range;
use std::time::Duration;

use similar::{ChangeTag, TextDiff};

use crate::protocol::Review;

const CONTEXT_LINES: usize = 3;
/// Bounds the diff on huge inputs; `similar` falls back to a coarser diff when it runs out of time.
const DIFF_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LineKind {
    Meta,
    Hunk,
    Added,
    Removed,
    Context,
    Command,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReviewLine {
    pub kind: LineKind,
    pub text: String,
}

fn line(kind: LineKind, text: impl Into<String>) -> ReviewLine {
    ReviewLine {
        kind,
        text: text.into(),
    }
}

fn truncation_note() -> ReviewLine {
    line(
        LineKind::Meta,
        "… preview truncated; the action uses the full content",
    )
}

pub fn review_lines(review: &Review) -> Vec<ReviewLine> {
    let mut lines = Vec::new();
    let truncated = match review {
        Review::Change {
            path,
            before,
            after,
            created,
            truncated,
        } => {
            if *created {
                lines.push(line(LineKind::Meta, format!("new file {path}")));
            } else if before.is_none() {
                lines.push(line(
                    LineKind::Meta,
                    format!(
                        "{path}: current content not shown (outside the workspace, unreadable, or too large)"
                    ),
                ));
            }
            lines.extend(unified(path, before.as_deref().unwrap_or(""), after));
            *truncated
        }
        Review::Patch {
            path,
            patch,
            truncated,
        } => {
            lines.push(line(LineKind::Meta, format!("patch {path}")));
            lines.extend(patch.lines().map(classify));
            *truncated
        }
        Review::Shell { command } => {
            lines.extend(command.lines().enumerate().map(|(index, row)| {
                line(
                    LineKind::Command,
                    format!("{} {row}", if index == 0 { "$" } else { " " }),
                )
            }));
            false
        }
        Review::Args { text, truncated } => {
            lines.extend(text.lines().map(|row| line(LineKind::Context, row)));
            *truncated
        }
        Review::Unknown => {
            lines.push(line(
                LineKind::Meta,
                "This request has no preview this view can show.",
            ));
            false
        }
    };
    if truncated {
        lines.push(truncation_note());
    }
    lines
}

/// `start,len` of a hunk range in unified-diff form; an empty range is written `start,0` like git does.
fn hunk_range(range: Range<usize>) -> String {
    if range.is_empty() {
        format!("{},0", range.start)
    } else if range.len() == 1 {
        format!("{}", range.start + 1)
    } else {
        format!("{},{}", range.start + 1, range.len())
    }
}

fn unified(path: &str, before: &str, after: &str) -> Vec<ReviewLine> {
    let diff = TextDiff::configure()
        .timeout(DIFF_TIMEOUT)
        .diff_lines(before, after);
    let mut lines = vec![
        line(LineKind::Meta, format!("--- {path}")),
        line(LineKind::Meta, format!("+++ {path}")),
    ];
    let groups = diff.grouped_ops(CONTEXT_LINES);
    if groups.is_empty() {
        lines.push(line(LineKind::Meta, "no changes"));
    }
    for group in groups {
        let (Some(first), Some(last)) = (group.first(), group.last()) else {
            continue;
        };
        let old = first.old_range().start..last.old_range().end;
        let new = first.new_range().start..last.new_range().end;
        lines.push(line(
            LineKind::Hunk,
            format!("@@ -{} +{} @@", hunk_range(old), hunk_range(new)),
        ));
        for op in &group {
            for change in diff.iter_changes(op) {
                let (kind, sign) = match change.tag() {
                    ChangeTag::Delete => (LineKind::Removed, '-'),
                    ChangeTag::Insert => (LineKind::Added, '+'),
                    ChangeTag::Equal => (LineKind::Context, ' '),
                };
                let text = change.value().trim_end_matches(['\n', '\r']);
                lines.push(line(kind, format!("{sign}{text}")));
            }
        }
    }
    lines
}

fn classify(row: &str) -> ReviewLine {
    let kind = if row.starts_with("+++")
        || row.starts_with("---")
        || row.starts_with("diff ")
        || row.starts_with("index ")
    {
        LineKind::Meta
    } else if row.starts_with("@@") {
        LineKind::Hunk
    } else if row.starts_with('+') {
        LineKind::Added
    } else if row.starts_with('-') {
        LineKind::Removed
    } else {
        LineKind::Context
    };
    line(kind, row)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[ReviewLine], kind: LineKind) -> Vec<&str> {
        lines
            .iter()
            .filter(|line| line.kind == kind)
            .map(|line| line.text.as_str())
            .collect()
    }

    #[test]
    fn a_change_renders_as_a_unified_diff_with_context() {
        let lines = review_lines(&Review::Change {
            path: "src/a.txt".into(),
            before: Some("one\ntwo\nthree\n".into()),
            after: "one\nTWO\nthree\n".into(),
            created: false,
            truncated: false,
        });
        assert_eq!(
            texts(&lines, LineKind::Meta),
            vec!["--- src/a.txt", "+++ src/a.txt"]
        );
        assert_eq!(texts(&lines, LineKind::Hunk), vec!["@@ -1,3 +1,3 @@"]);
        assert_eq!(texts(&lines, LineKind::Removed), vec!["-two"]);
        assert_eq!(texts(&lines, LineKind::Added), vec!["+TWO"]);
        assert_eq!(texts(&lines, LineKind::Context), vec![" one", " three"]);
    }

    #[test]
    fn distant_changes_get_separate_hunks() {
        let before: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let after = before
            .replace("line 2\n", "line two\n")
            .replace("line 18\n", "line eighteen\n");
        let lines = review_lines(&Review::Change {
            path: "f".into(),
            before: Some(before),
            after,
            created: false,
            truncated: false,
        });
        assert_eq!(
            texts(&lines, LineKind::Hunk),
            vec!["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]
        );
    }

    #[test]
    fn single_line_ranges_omit_the_count_like_git() {
        let lines = review_lines(&Review::Change {
            path: "f".into(),
            before: Some("a\n".into()),
            after: "b\nc\n".into(),
            created: false,
            truncated: false,
        });
        assert_eq!(texts(&lines, LineKind::Hunk), vec!["@@ -1 +1,2 @@"]);
    }

    #[test]
    fn new_files_unknown_content_and_truncation_are_labelled() {
        let created = review_lines(&Review::Change {
            path: "x.txt".into(),
            before: None,
            after: "a\nb\n".into(),
            created: true,
            truncated: true,
        });
        assert_eq!(
            created[0],
            ReviewLine {
                kind: LineKind::Meta,
                text: "new file x.txt".into()
            }
        );
        assert_eq!(texts(&created, LineKind::Hunk), vec!["@@ -0,0 +1,2 @@"]);
        assert_eq!(texts(&created, LineKind::Added), vec!["+a", "+b"]);
        assert!(created.last().unwrap().text.contains("truncated"));
        let hidden = review_lines(&Review::Change {
            path: "big.bin".into(),
            before: None,
            after: "x".into(),
            created: false,
            truncated: false,
        });
        assert!(
            hidden[0].text.contains("current content not shown"),
            "{hidden:?}"
        );
        let same = review_lines(&Review::Change {
            path: "s".into(),
            before: Some("a\n".into()),
            after: "a\n".into(),
            created: false,
            truncated: false,
        });
        assert_eq!(same.last().unwrap().text, "no changes");
    }

    #[test]
    fn patches_commands_and_args_are_shown_as_sent() {
        let patch = review_lines(&Review::Patch {
            path: "a.ts".into(),
            patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n same".into(),
            truncated: false,
        });
        assert_eq!(
            patch.iter().map(|line| line.kind).collect::<Vec<_>>(),
            vec![
                LineKind::Meta,
                LineKind::Meta,
                LineKind::Meta,
                LineKind::Hunk,
                LineKind::Removed,
                LineKind::Added,
                LineKind::Context
            ]
        );
        assert_eq!(patch[0].text, "patch a.ts");
        assert_eq!(
            review_lines(&Review::Shell {
                command: "npm test\n--watch".into()
            }),
            vec![
                ReviewLine {
                    kind: LineKind::Command,
                    text: "$ npm test".into()
                },
                ReviewLine {
                    kind: LineKind::Command,
                    text: "  --watch".into()
                },
            ]
        );
        assert_eq!(
            texts(
                &review_lines(&Review::Args {
                    text: "{\n  \"url\": \"u\"\n}".into(),
                    truncated: false
                }),
                LineKind::Context
            ),
            vec!["{", "  \"url\": \"u\"", "}"]
        );
        assert_eq!(review_lines(&Review::Unknown)[0].kind, LineKind::Meta);
    }
}
