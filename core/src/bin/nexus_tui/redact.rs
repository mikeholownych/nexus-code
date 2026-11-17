//! Redaction for sidecar stderr, which bypasses the sidecar's own `redactSecrets` (`cli/src/ui.ts`). The patterns
//! mirror `cli/src/redaction_patterns.json`, the one table the TypeScript redactor is built from:
//! `cli/test/redaction_parity.test.ts` fails when the two differ, and both run `cli/test/fixtures/redaction_corpus.json`.
use std::sync::LazyLock;

use regex::Regex;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());

/// OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \`) and the remaining two-character escapes such as `ESC c`.
static OTHER_ESCAPES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]").unwrap());

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"(?i)Bearer\s+[A-Za-z0-9_\-.]{15,}").unwrap(),
            "Bearer [REDACTED_TOKEN]",
        ),
        (
            Regex::new(r#"(?i)((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:basic|bearer|token)\s+["']?)[A-Za-z0-9._~+/=-]{8,}"#).unwrap(),
            "${1}[REDACTED]",
        ),
        (
            Regex::new(r"(?:sk-|ghp_|gho_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_\-]{16,}").unwrap(),
            "[REDACTED_KEY]",
        ),
        (
            Regex::new(r#"(?i)((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)([^"'\s]{6,})(["']?)"#)
                .unwrap(),
            "${1}[REDACTED]${3}",
        ),
    ]
});

/// Redacts stderr one line at a time. A private-key block spanning several lines collapses to a single marker.
#[derive(Default)]
pub struct StderrRedactor {
    in_private_key: bool,
}

impl StderrRedactor {
    /// Returns the redacted line, or `None` when the line is part of a private key being suppressed.
    pub fn line(&mut self, raw: &str) -> Option<String> {
        let line = ANSI.replace_all(raw, "");
        let line: String = OTHER_ESCAPES
            .replace_all(&line, "")
            .chars()
            .filter_map(|c| match c {
                '\t' => Some(' '),
                c if c.is_control() => None,
                c => Some(c),
            })
            .collect();
        let is_key_marker = |kind: &str| line.contains(kind) && line.contains("PRIVATE KEY-----");
        if self.in_private_key {
            if is_key_marker("-----END") {
                self.in_private_key = false;
            }
            return None;
        }
        if is_key_marker("-----BEGIN") {
            self.in_private_key = !is_key_marker("-----END");
            return Some("[REDACTED_PRIVATE_KEY]".to_string());
        }
        Some(apply_patterns(line))
    }
}

/// The literal-pattern step, in table order (cli/src/redaction_patterns.json): the part of `StderrRedactor::line` that
/// the shared corpus (cli/test/fixtures/redaction_corpus.json) exercises on both sides.
fn apply_patterns(line: String) -> String {
    let mut out = line;
    for (pattern, replacement) in PATTERNS.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_the_same_secrets_as_the_sidecar() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(
            redactor.line(r#"✖ Inference error (HTTP 500): {"error":"upstream rejected Bearer abcdefghijklmnopqrstuvwxyz0123"}"#).unwrap(),
            r#"✖ Inference error (HTTP 500): {"error":"upstream rejected Bearer [REDACTED_TOKEN]"}"#
        );
        assert_eq!(
            // Built at runtime so the repository secret scanner does not flag the fixture.
            redactor.line(&format!("key sk-{} leaked", "abcdefghijklmnop1234")).unwrap(),
            "key [REDACTED_KEY] leaked"
        );
        assert_eq!(
            redactor.line("api_key=hunter2hunter2 next").unwrap(),
            "api_key=[REDACTED] next"
        );
        assert_eq!(
            redactor.line(r#""password": "s3cretvalue""#).unwrap(),
            r#""password": "[REDACTED]""#
        );
        assert_eq!(
            redactor.line("plain diagnostic").unwrap(),
            "plain diagnostic"
        );
        assert_eq!(
            redactor.line("Authorization: Basic dXNlcjpwYXNzd29yZA==").unwrap(),
            "Authorization: Basic [REDACTED]"
        );
        assert_eq!(
            redactor.line("authorization=Token abcdefghijklmnop").unwrap(),
            "authorization=Token [REDACTED]"
        );
        assert_eq!(
            redactor.line(r#"{"authorization":"Basic dXNlcjpwYXNzd29yZA=="}"#).unwrap(),
            r#"{"authorization":"Basic [REDACTED]"}"#
        );
    }

    /// The corpus both redactors share. Neither side may drift from it: a pattern added to one redactor only fails
    /// this test or its TypeScript twin (cli/test/redaction_parity.test.ts).
    #[test]
    fn matches_the_shared_redaction_corpus() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../../../cli/test/fixtures/redaction_corpus.json")).unwrap();
        let mut checked = 0;
        for case in corpus["cases"].as_array().unwrap() {
            if case["multiline"].as_bool().unwrap_or(false) {
                continue; // line-by-line with state in Rust: see collapses_a_multi_line_private_key_to_one_marker
            }
            // `⟦⟧` joins keep key-shaped literals out of the committed corpus.
            let input = case["input"].as_str().unwrap().replace("⟦⟧", "");
            let expected = case["expected"].as_str().unwrap();
            assert_eq!(apply_patterns(input.clone()), expected, "corpus case {:?}", case["name"]);
            checked += 1;
        }
        assert!(checked >= 10, "the corpus is read ({checked} cases)");
    }

    #[test]
    fn strips_terminal_escape_sequences() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(
            redactor
                .line("\x1b[31m✖ Working: run_command\x1b[39m")
                .unwrap(),
            "✖ Working: run_command"
        );
    }

    #[test]
    fn strips_other_escape_sequences_and_control_characters() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(
            redactor
                .line("\x1b]8;;http://x\x07link\x1b]8;;\x07 done\tnow\x1bc\x07")
                .unwrap(),
            "link done now"
        );
    }

    #[test]
    fn collapses_a_multi_line_private_key_to_one_marker() {
        let mut redactor = StderrRedactor::default();
        assert_eq!(
            redactor
                .line("-----BEGIN OPENSSH PRIVATE KEY-----")
                .as_deref(),
            Some("[REDACTED_PRIVATE_KEY]")
        );
        assert_eq!(
            redactor.line("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"),
            None
        );
        assert_eq!(redactor.line("-----END OPENSSH PRIVATE KEY-----"), None);
        assert_eq!(redactor.line("after").as_deref(), Some("after"));
    }
}
