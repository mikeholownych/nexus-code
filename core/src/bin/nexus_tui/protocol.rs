//! Client side of the Nexus sidecar protocol v1 (`cli/src/protocol.ts`). The sidecar is the authority on every
//! outcome; these types carry what it reports and nothing more.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct GitInfo {
    pub branch: String,
    pub dirty: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelSummary {
    pub summary: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// What the operator is asked to approve (`approvalReview` in `cli/src/approval_review.ts`). Text is already
/// redacted and capped by the sidecar.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum Review {
    #[serde(rename = "change")]
    Change {
        path: String,
        before: Option<String>,
        after: String,
        created: bool,
        truncated: bool,
    },
    #[serde(rename = "patch")]
    Patch {
        path: String,
        patch: String,
        truncated: bool,
    },
    #[serde(rename = "command")]
    Shell { command: String },
    #[serde(rename = "args")]
    Args { text: String, truncated: bool },
    /// A review kind this client does not know; the modal still asks, without a preview.
    #[serde(other)]
    Unknown,
}

/// Sidecar → UI events. Fields this client does not use are ignored by serde.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "hello")]
    Hello { protocol: u64 },
    #[serde(rename = "session.state")]
    SessionState {
        workspace_name: String,
        model: String,
        mode: String,
        git: Option<GitInfo>,
        busy: bool,
    },
    #[serde(rename = "assistant.delta")]
    AssistantDelta { turn_id: String, text: String },
    #[serde(rename = "tool.start")]
    ToolStart {
        call_id: String,
        tool: String,
        subject: String,
    },
    #[serde(rename = "tool.end")]
    ToolEnd {
        call_id: String,
        tool: String,
        success: bool,
        summary: String,
    },
    #[serde(rename = "approval.request")]
    ApprovalRequest {
        id: String,
        tool: String,
        subject: String,
        #[serde(default)]
        review: Option<Review>,
    },
    #[serde(rename = "turn.result")]
    TurnResult {
        heading: String,
        line: String,
        turn: Value,
        model_summary: Option<ModelSummary>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        id: Option<String>,
        code: String,
        message: String,
    },
    /// Event types this client does not render yet, such as `slash.result`.
    #[serde(other)]
    Unknown,
}

/// UI → sidecar commands used by the live view.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "prompt.submit")]
    PromptSubmit { id: String, text: String },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "approve")]
    Approve { id: String, always: bool },
    #[serde(rename = "deny")]
    Deny { id: String },
    #[serde(rename = "shutdown")]
    Shutdown,
}

pub fn parse_event(line: &str) -> Result<Event, String> {
    let value: Value = serde_json::from_str(line)
        .or_else(|err| serde_json::from_str(&replace_lone_surrogates(line)).map_err(|_| err))
        .map_err(|err| format!("not JSON: {err}"))?;
    if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(format!(
            "unsupported protocol version: {}",
            value.get("v").unwrap_or(&Value::Null)
        ));
    }
    serde_json::from_value(value).map_err(|err| format!("invalid event: {err}"))
}

/// The UTF-16 code unit of a `\uXXXX` escape at the start of `text`.
fn escape_unit(text: &str) -> Option<u16> {
    let hex = text.strip_prefix("\\u")?.get(..4)?;
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(hex, 16).ok()
}

/// Rewrites escapes of lone UTF-16 surrogates as `\ufffd`; serde_json rejects them, and a sidecar that truncates
/// text mid-pair can emit one.
fn replace_lone_surrogates(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find('\\') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let consumed = match escape_unit(tail) {
            Some(0xD800..=0xDBFF) if matches!(escape_unit(&tail[6..]), Some(0xDC00..=0xDFFF)) => 12,
            Some(0xD800..=0xDFFF) => {
                out.push_str("\\ufffd");
                rest = &tail[6..];
                continue;
            }
            Some(_) => 6,
            None => tail
                .char_indices()
                .nth(2)
                .map_or(tail.len(), |(index, _)| index),
        };
        out.push_str(&tail[..consumed]);
        rest = &tail[consumed..];
    }
    out.push_str(rest);
    out
}

pub fn encode_command(command: &Command) -> String {
    let mut value = serde_json::to_value(command).expect("protocol commands always serialize");
    if let Value::Object(map) = &mut value {
        map.insert("v".to_string(), Value::from(PROTOCOL_VERSION));
    }
    format!("{value}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_rendered_event_type() {
        assert_eq!(
            parse_event(r#"{"v":1,"type":"hello","protocol":1,"pid":42}"#),
            Ok(Event::Hello { protocol: 1 })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":{"branch":"main","dirty":2},"busy":false}"#
            ),
            Ok(Event::SessionState {
                workspace_name: "app".into(),
                model: "m".into(),
                mode: "auto".into(),
                git: Some(GitInfo {
                    branch: "main".into(),
                    dirty: 2
                }),
                busy: false,
            })
        );
        assert!(matches!(
            parse_event(
                r#"{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"review","git":null,"busy":true}"#
            ),
            Ok(Event::SessionState {
                git: None,
                busy: true,
                ..
            })
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"hi"}"#),
            Ok(Event::AssistantDelta {
                turn_id: "t1".into(),
                text: "hi".into()
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c1","tool":"read_file","subject":"src/a.ts"}"#
            ),
            Ok(Event::ToolStart {
                call_id: "c1".into(),
                tool: "read_file".into(),
                subject: "src/a.ts".into()
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"c1","tool":"read_file","success":false,"summary":"No such file","lines":1}"#
            ),
            Ok(Event::ToolEnd {
                call_id: "c1".into(),
                tool: "read_file".into(),
                success: false,
                summary: "No such file".into()
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#
            ),
            Ok(Event::ApprovalRequest {
                id: "approval-1".into(),
                tool: "write_file".into(),
                subject: "x.txt".into(),
                review: None,
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"error","id":"t2","code":"BUSY","message":"A turn is already running"}"#
            ),
            Ok(Event::Error {
                id: Some("t2".into()),
                code: "BUSY".into(),
                message: "A turn is already running".into()
            })
        );
    }

    #[test]
    fn turn_result_keeps_the_reported_turn_verbatim() {
        let event = parse_event(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#).unwrap();
        let Event::TurnResult {
            heading,
            line,
            turn,
            model_summary,
        } = event
        else {
            panic!("expected turn.result");
        };
        assert_eq!(heading, "TURN INTERRUPTED");
        assert_eq!(line, "Stopped by operator");
        assert_eq!(turn["execution"], "INTERRUPTED");
        assert_eq!(turn["outcome"], "NOT_ESTABLISHED");
        assert_eq!(model_summary, None);
        let with_summary = parse_event(r#"{"v":1,"type":"turn.result","turn_id":"t2","heading":"H","line":"L","turn":{},"model_summary":{"summary":"Fixed it.","notes":"n"}}"#).unwrap();
        assert!(matches!(
            with_summary,
            Event::TurnResult { model_summary: Some(ModelSummary { ref summary, ref notes }), .. }
                if summary == "Fixed it." && notes.as_deref() == Some("n")
        ));
    }

    #[test]
    fn lone_surrogate_escapes_become_replacement_characters() {
        let event = parse_event(
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"c1","tool":"run_command","success":true,"summary":"ok \ud83d","lines":1}"#,
        );
        assert!(
            matches!(&event, Ok(Event::ToolEnd { summary, .. }) if summary == "ok \u{fffd}"),
            "{event:?}"
        );
        let event = parse_event(
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"\ude00 \ud83d\ude00 \\ud83d \ud83d\u0041"}"#,
        );
        assert_eq!(
            event,
            Ok(Event::AssistantDelta {
                turn_id: "t1".into(),
                text: "\u{fffd} 😀 \\ud83d \u{fffd}A".into()
            })
        );
    }

    #[test]
    fn unknown_event_types_are_tolerated() {
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"slash.result","id":"s1","command":"status","success":true,"output":"{}"}"#
            ),
            Ok(Event::Unknown)
        );
    }

    #[test]
    fn rejects_non_protocol_lines() {
        assert!(
            parse_event("Compiling harness")
                .unwrap_err()
                .contains("not JSON")
        );
        assert!(
            parse_event(r#"{"type":"hello","protocol":1}"#)
                .unwrap_err()
                .contains("unsupported protocol version")
        );
        assert!(
            parse_event(r#"{"v":2,"type":"hello","protocol":2}"#)
                .unwrap_err()
                .contains("unsupported protocol version")
        );
        assert!(
            parse_event(r#"{"v":1,"type":"tool.start","call_id":"c1"}"#)
                .unwrap_err()
                .contains("invalid event")
        );
    }

    #[test]
    fn commands_encode_as_single_versioned_lines() {
        for (command, expected) in [
            (
                Command::PromptSubmit {
                    id: "t1".into(),
                    text: "fix\nit".into(),
                },
                serde_json::json!({"v":1,"type":"prompt.submit","id":"t1","text":"fix\nit"}),
            ),
            (Command::Cancel, serde_json::json!({"v":1,"type":"cancel"})),
            (
                Command::Shutdown,
                serde_json::json!({"v":1,"type":"shutdown"}),
            ),
            (
                Command::Approve {
                    id: "approval-1".into(),
                    always: true,
                },
                serde_json::json!({"v":1,"type":"approve","id":"approval-1","always":true}),
            ),
            (
                Command::Deny {
                    id: "approval-1".into(),
                },
                serde_json::json!({"v":1,"type":"deny","id":"approval-1"}),
            ),
        ] {
            let line = encode_command(&command);
            assert!(line.ends_with('\n'));
            assert_eq!(
                line.matches('\n').count(),
                1,
                "embedded newlines must be escaped: {line:?}"
            );
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), expected);
        }
    }

    #[test]
    fn approval_requests_carry_each_review_kind() {
        let review = |json: &str| match parse_event(&format!(
            r#"{{"v":1,"type":"approval.request","id":"a1","turn_id":"t1","tool":"t","subject":"s","preview":"{{}}","review":{json}}}"#
        )) {
            Ok(Event::ApprovalRequest { review, .. }) => review,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            review(
                r#"{"kind":"change","path":"x.txt","before":null,"after":"hi\n","created":true,"truncated":false}"#
            ),
            Some(Review::Change {
                path: "x.txt".into(),
                before: None,
                after: "hi\n".into(),
                created: true,
                truncated: false
            })
        );
        assert_eq!(
            review(r#"{"kind":"patch","path":"a.ts","patch":"@@ -1 +1 @@","truncated":true}"#),
            Some(Review::Patch {
                path: "a.ts".into(),
                patch: "@@ -1 +1 @@".into(),
                truncated: true
            })
        );
        assert_eq!(
            review(r#"{"kind":"command","command":"npm test"}"#),
            Some(Review::Shell {
                command: "npm test".into()
            })
        );
        assert_eq!(
            review(r#"{"kind":"args","text":"{}","truncated":false}"#),
            Some(Review::Args {
                text: "{}".into(),
                truncated: false
            })
        );
        assert_eq!(review(r#"{"kind":"hologram"}"#), Some(Review::Unknown));
    }
}
