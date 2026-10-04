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
        success: bool,
        summary: String,
    },
    #[serde(rename = "approval.request")]
    ApprovalRequest { tool: String, subject: String },
    #[serde(rename = "turn.result")]
    TurnResult {
        heading: String,
        line: String,
        turn: Value,
        model_summary: Option<ModelSummary>,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
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
    #[serde(rename = "shutdown")]
    Shutdown,
}

pub fn parse_event(line: &str) -> Result<Event, String> {
    let value: Value = serde_json::from_str(line).map_err(|err| format!("not JSON: {err}"))?;
    if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(format!(
            "unsupported protocol version: {}",
            value.get("v").unwrap_or(&Value::Null)
        ));
    }
    serde_json::from_value(value).map_err(|err| format!("invalid event: {err}"))
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
                success: false,
                summary: "No such file".into()
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#
            ),
            Ok(Event::ApprovalRequest {
                tool: "write_file".into(),
                subject: "x.txt".into()
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"error","id":"t2","code":"BUSY","message":"A turn is already running"}"#
            ),
            Ok(Event::Error {
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
        assert!(
            matches!(with_summary, Event::TurnResult { model_summary: Some(ModelSummary { ref summary }), .. } if summary == "Fixed it.")
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
}
