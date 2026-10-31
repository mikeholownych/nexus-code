//! Client side of the Nexus sidecar protocol v1 (`cli/src/protocol.ts`). The sidecar is the authority on every
//! outcome; these types carry what it reports and nothing more.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct GitInfo {
    pub branch: String,
    pub dirty: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct PostureInfo {
    pub mode: String,
    pub sandbox: String,
    pub trusted: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelSummary {
    pub summary: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// One entry of the slash-command catalogue the sidecar announces in `hello`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SlashSpec {
    pub name: String,
    pub usage: String,
    pub summary: String,
}

/// A way to connect a provider: an API key, a browser sign-in, or a device-code sign-in.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ConnectMethod {
    pub id: String,
    pub label: String,
    pub kind: String,
    /// Signs in as another vendor's client; the provider's terms may not permit it.
    #[serde(default)]
    pub unofficial: bool,
}

/// A provider as the model picker shows it. `source` names where its credential comes from, never the credential.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct CatalogProvider {
    pub id: String,
    pub label: String,
    pub disclosure: String,
    pub connected: bool,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub external: bool,
    #[serde(default)]
    pub methods: Vec<ConnectMethod>,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct CatalogModel {
    pub provider: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Catalog {
    pub providers: Vec<CatalogProvider>,
    pub models: Vec<CatalogModel>,
    pub current: ModelRef,
    pub recent: Vec<ModelRef>,
}

/// A credential typed by the operator. Serializes as the plain string; never prints.
#[derive(Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// One block of the turn receipt: labelled rows, or a note saying why there are none.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ReceiptSection {
    pub title: String,
    #[serde(default)]
    pub rows: Vec<(String, String)>,
    #[serde(default)]
    pub note: Option<String>,
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
    #[serde(rename = "verifier")]
    Verifier {
        command: String,
        #[serde(default)]
        script: Option<String>,
        #[serde(default)]
        detail: Option<String>,
    },
    #[serde(rename = "args")]
    Args { text: String, truncated: bool },
    /// A review kind this client does not know; the modal still asks, without a preview.
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct HistoryMessage {
    /// `user`, `assistant`, `steering`, `tool` (a tool the agent called; `text` is its subject) or `outcome` (the
    /// last turn's result; `text` is its line).
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub turn: Option<Value>,
}

/// Sidecar → UI events. Fields this client does not use are ignored by serde.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "hello")]
    Hello {
        protocol: u64,
        #[serde(default)]
        commands: Vec<SlashSpec>,
    },
    #[serde(rename = "session.state")]
    SessionState {
        workspace_name: String,
        model: String,
        mode: String,
        git: Option<GitInfo>,
        busy: bool,
        /// The id the session is saved under (absent from older sidecars).
        #[serde(default)]
        session: Option<String>,
        #[serde(default)]
        posture: Option<PostureInfo>,
    },
    #[serde(rename = "assistant.delta")]
    AssistantDelta { turn_id: String, text: String },
    /// What the running turn is doing; sent on each phase change, independent of model output.
    #[serde(rename = "activity")]
    Activity {
        phase: String,
        #[serde(default)]
        step: u64,
        #[serde(default)]
        segment: u64,
        #[serde(default)]
        tool: Option<String>,
        #[serde(default)]
        subject: Option<String>,
        /// The turn's budget: total steps across segments, and the time limit in minutes.
        #[serde(default)]
        max_steps: Option<u64>,
        #[serde(default)]
        max_minutes: Option<u64>,
    },
    /// A file-edit tool changed a file: that operation's own diff, as a bounded preview.
    #[serde(rename = "file.diff")]
    FileDiff {
        call_id: String,
        #[serde(default)]
        evidence: String,
        path: String,
        kind: String,
        added: u64,
        removed: u64,
        preview: String,
        #[serde(default)]
        truncated: bool,
        #[serde(default)]
        total_lines: u64,
        /// Changed and context lines in the whole diff, and its hunks (absent from older sidecars).
        #[serde(default)]
        diff_lines: Option<u64>,
        #[serde(default)]
        hunks: Option<u64>,
        /// The complete diff on disk.
        #[serde(default)]
        full_path: Option<String>,
        #[serde(default)]
        note: Option<String>,
    },
    /// What became of operator steering: queued, applied, deferred, cancelled, rejected or duplicate.
    #[serde(rename = "steer.ack")]
    SteerAck {
        id: String,
        status: String,
        message: String,
        /// Returned text for cancelled or rejected steering.
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(rename = "tool.start")]
    ToolStart {
        call_id: String,
        tool: String,
        subject: String,
        /// Handle for this call's full record in the sidecar; empty from sidecars that keep none.
        #[serde(default)]
        evidence: String,
    },
    #[serde(rename = "tool.end")]
    ToolEnd {
        call_id: String,
        tool: String,
        success: bool,
        summary: String,
        /// Lines of output the tool produced (commands: stdout and stderr).
        #[serde(default)]
        lines: u64,
        /// Commands: the first lines of their output, exit code, run time and whether they timed out.
        #[serde(default)]
        preview: Option<String>,
        #[serde(default)]
        exit_code: Option<i64>,
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default)]
        timed_out: bool,
    },
    #[serde(rename = "approval.request")]
    ApprovalRequest {
        id: String,
        tool: String,
        subject: String,
        #[serde(default)]
        review: Option<Review>,
    },
    #[serde(rename = "checkpoint.choice.request")]
    CheckpointChoiceRequest { id: String, message: String },
    #[serde(rename = "turn.result")]
    TurnResult {
        heading: String,
        line: String,
        turn: Value,
        model_summary: Option<ModelSummary>,
    },
    #[serde(rename = "slash.result")]
    SlashResult {
        id: String,
        command: String,
        success: bool,
        output: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        composer: Option<String>,
        /// Set when the command started a turn with this prompt; the turn's events follow under the same id.
        #[serde(default)]
        prompt: Option<String>,
    },
    #[serde(rename = "notice")]
    Notice { text: String },
    /// A resumed session's recent conversation, oldest first.
    #[serde(rename = "history")]
    History {
        session: String,
        total: u64,
        messages: Vec<HistoryMessage>,
    },
    #[serde(rename = "tool.detail")]
    ToolDetail {
        id: String,
        status: String,
        args: String,
        output: String,
        #[serde(default)]
        duration_ms: Option<u64>,
        /// Full diff of the file change the call made (cut to the sidecar's in-memory limit).
        #[serde(default)]
        diff: Option<String>,
        /// Characters in the complete diff, and where it is on disk.
        #[serde(default)]
        diff_chars: Option<u64>,
        #[serde(default)]
        diff_path: Option<String>,
    },
    #[serde(rename = "receipt")]
    Receipt {
        id: String,
        sections: Vec<ReceiptSection>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        id: Option<String>,
        code: String,
        message: String,
    },
    #[serde(rename = "models.catalog")]
    ModelsCatalog {
        id: String,
        providers: Vec<CatalogProvider>,
        models: Vec<CatalogModel>,
        current: ModelRef,
        #[serde(default)]
        recent: Vec<ModelRef>,
    },
    /// A sign-in waits for the operator: open `url`, and type `user_code` for a device sign-in.
    #[serde(rename = "provider.auth")]
    ProviderAuth {
        id: String,
        provider: String,
        url: String,
        #[serde(default)]
        user_code: Option<String>,
        instructions: String,
    },
    #[serde(rename = "provider.result")]
    ProviderResult {
        id: String,
        provider: String,
        success: bool,
        message: String,
    },
    #[serde(rename = "model.result")]
    ModelResult {
        id: String,
        success: bool,
        message: String,
    },
    /// Event types newer than this client.
    #[serde(other)]
    Unknown,
}

/// UI → sidecar commands used by the live view.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "prompt.submit")]
    PromptSubmit { id: String, text: String },
    /// Guidance for the work in progress; the sidecar answers with `steer.ack`.
    #[serde(rename = "steer")]
    Steer { id: String, text: String },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "approve")]
    Approve { id: String, always: bool },
    #[serde(rename = "deny")]
    Deny { id: String },
    #[serde(rename = "checkpoint.choice")]
    CheckpointChoice { id: String, choice: String },
    #[serde(rename = "slash")]
    Slash {
        id: String,
        command: String,
        args: String,
    },
    #[serde(rename = "tool.detail")]
    ToolDetail { id: String, evidence: String },
    #[serde(rename = "receipt")]
    Receipt { id: String },
    #[serde(rename = "models.list")]
    ModelsList { id: String },
    #[serde(rename = "model.select")]
    ModelSelect {
        id: String,
        provider: String,
        model: String,
    },
    #[serde(rename = "provider.connect")]
    ProviderConnect {
        id: String,
        provider: String,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        key: Option<Secret>,
    },
    #[serde(rename = "provider.cancel")]
    ProviderCancel { id: String },
    #[serde(rename = "provider.disconnect")]
    ProviderDisconnect { id: String, provider: String },
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
            Ok(Event::Hello {
                protocol: 1,
                commands: Vec::new()
            })
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
                session: None,
                posture: None,
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"review","git":null,"busy":false,"posture":{"mode":"review","sandbox":"off","trusted":false}}"#
            ),
            Ok(Event::SessionState {
                workspace_name: "app".into(),
                model: "m".into(),
                mode: "review".into(),
                git: None,
                busy: false,
                session: None,
                posture: Some(PostureInfo {
                    mode: "review".into(),
                    sandbox: "off".into(),
                    trusted: false,
                }),
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
                subject: "src/a.ts".into(),
                evidence: String::new(),
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
                summary: "No such file".into(),
                lines: 1,
                preview: None,
                exit_code: None,
                duration_ms: None,
                timed_out: false,
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
            parse_event(r#"{"v":1,"type":"checkpoint.choice.request","id":"choice-1","turn_id":"t1","message":"Sensitive content prevents checkpointing."}"#),
            Ok(Event::CheckpointChoiceRequest { id: "choice-1".into(), message: "Sensitive content prevents checkpointing.".into() })
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
    fn evidence_details_and_receipts_parse() {
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c1","tool":"read_file","subject":"a.ts","evidence":"e4"}"#),
            Ok(Event::ToolStart { ref evidence, .. }) if evidence == "e4"
        ));
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"tool.detail","id":"d1","evidence":"e4","tool":"read_file","subject":"a.ts","status":"running","args":"{}","output":"","duration_ms":null}"#
            ),
            Ok(Event::ToolDetail {
                id: "d1".into(),
                status: "running".into(),
                args: "{}".into(),
                output: String::new(),
                duration_ms: None,
                diff: None,
                diff_chars: None,
                diff_path: None,
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"receipt","id":"r1","sections":[{"title":"Last turn","rows":[["outcome","VERIFIED"]]},{"title":"Validation receipt","rows":[],"note":"None yet."}]}"#
            ),
            Ok(Event::Receipt {
                id: "r1".into(),
                sections: vec![
                    ReceiptSection {
                        title: "Last turn".into(),
                        rows: vec![("outcome".into(), "VERIFIED".into())],
                        note: None,
                    },
                    ReceiptSection {
                        title: "Validation receipt".into(),
                        rows: Vec::new(),
                        note: Some("None yet.".into()),
                    },
                ],
            })
        );
    }

    #[test]
    fn activity_diff_and_steering_events_parse() {
        assert_eq!(
            parse_event(r#"{"v":1,"type":"activity","turn_id":"t1","phase":"tool","step":31,"segment":2,"tool":"run_command","subject":"make test"}"#),
            Ok(Event::Activity {
                phase: "tool".into(),
                step: 31,
                segment: 2,
                tool: Some("run_command".into()),
                subject: Some("make test".into()),
                max_steps: None,
                max_minutes: None,
            })
        );
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"file.diff","turn_id":"t1","call_id":"c1","evidence":"e2","path":"a.ts","kind":"modified","added":1,"removed":1,"preview":"--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b","truncated":false,"total_lines":5}"#),
            Ok(Event::FileDiff { ref path, added: 1, removed: 1, ref kind, .. }) if path == "a.ts" && kind == "modified"
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"steer.ack","id":"g1","status":"cancelled","message":"Not applied","text":"use tabs"}"#),
            Ok(Event::SteerAck {
                id: "g1".into(),
                status: "cancelled".into(),
                message: "Not applied".into(),
                text: Some("use tabs".into()),
            })
        );
        let line = encode_command(&Command::Steer { id: "g1".into(), text: "use\ntabs".into() });
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            serde_json::json!({"v":1,"type":"steer","id":"g1","text":"use\ntabs"})
        );
    }

    #[test]
    fn unknown_event_types_are_tolerated() {
        assert_eq!(
            parse_event(r#"{"v":1,"type":"future.event","x":1}"#),
            Ok(Event::Unknown)
        );
    }

    #[test]
    fn hello_carries_the_catalogue_and_slash_results_and_notices_parse() {
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"hello","protocol":1,"pid":1,"commands":[{"name":"diff","usage":"/diff","summary":"Uncommitted changes as a diff"}]}"#
            ),
            Ok(Event::Hello {
                protocol: 1,
                commands: vec![SlashSpec {
                    name: "diff".into(),
                    usage: "/diff".into(),
                    summary: "Uncommitted changes as a diff".into()
                }]
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"slash.result","id":"s1","command":"diff","success":true,"output":"-a\n+b","format":"diff"}"#
            ),
            Ok(Event::SlashResult {
                id: "s1".into(),
                command: "diff".into(),
                success: true,
                output: "-a\n+b".into(),
                format: Some("diff".into()),
                composer: None,
                prompt: None,
            })
        );
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"slash.result","id":"s2","command":"history","success":true,"output":"","prompt":"fix it"}"#),
            Ok(Event::SlashResult { prompt: Some(ref prompt), .. }) if prompt == "fix it"
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"notice","text":"Resumed session a (4 messages)."}"#),
            Ok(Event::Notice {
                text: "Resumed session a (4 messages).".into()
            })
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
            (
                Command::CheckpointChoice { id: "choice-1".into(), choice: "without_checkpoint".into() },
                serde_json::json!({"v":1,"type":"checkpoint.choice","id":"choice-1","choice":"without_checkpoint"}),
            ),
            (
                Command::Slash {
                    id: "s1".into(),
                    command: "diff".into(),
                    args: String::new(),
                },
                serde_json::json!({"v":1,"type":"slash","id":"s1","command":"diff","args":""}),
            ),
            (
                Command::ToolDetail {
                    id: "d1".into(),
                    evidence: "e4".into(),
                },
                serde_json::json!({"v":1,"type":"tool.detail","id":"d1","evidence":"e4"}),
            ),
            (
                Command::Receipt { id: "r1".into() },
                serde_json::json!({"v":1,"type":"receipt","id":"r1"}),
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
            review(r#"{"kind":"verifier","command":"npm test","script":"jest","detail":"package.json:scripts.test"}"#),
            Some(Review::Verifier {
                command: "npm test".into(),
                script: Some("jest".into()),
                detail: Some("package.json:scripts.test".into()),
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
