//! Client side of the Nexus sidecar protocol v1 (`cli/src/protocol.ts`). The sidecar is the authority on every
//! outcome; these types carry what it reports and nothing more.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const PROTOCOL_VERSION: u64 = 1;
/// The inclusive range of protocol versions this client can speak (exactly `PROTOCOL_VERSION` today). A version
/// bump changes this pair; `hello_mismatch` compares it with the range the sidecar announces.
pub const PROTOCOL_MIN: u64 = PROTOCOL_VERSION;
pub const PROTOCOL_MAX: u64 = PROTOCOL_VERSION;

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
    /// The effective sandbox profile (`:workspace`, `:read-only`, `:network` or `unconfined`). Absent from an older sidecar.
    #[serde(default)]
    pub profile: Option<String>,
}

impl PostureInfo {
    /// The profile to show beside the sandbox text, or none when the text already says it or there is nothing to add
    /// (an unconfined session with the sandbox off, or the legacy `none` text).
    pub fn profile_to_show(&self) -> Option<&str> {
        let profile = self.profile.as_deref()?;
        if self.sandbox.starts_with(profile)
            || (profile == "unconfined" && matches!(self.sandbox.as_str(), "off" | "none"))
        {
            return None;
        }
        Some(profile)
    }
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

fn turn_saved_by_default() -> bool {
    true
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
        /// The inclusive range of versions the sidecar can speak. Absent from a sidecar older than capability
        /// negotiation, which speaks exactly `protocol`.
        #[serde(default)]
        protocol_min: Option<u64>,
        #[serde(default)]
        protocol_max: Option<u64>,
        /// Stable features the sidecar supports (absent from older sidecars).
        #[serde(default)]
        capabilities: Vec<String>,
        /// Experimental features the sidecar offers; off until `initialize` asks for them.
        #[serde(default)]
        experimental: Vec<String>,
    },
    /// Answer to `initialize`: the negotiated version and the features in force on this connection. This client
    /// does not send `initialize` yet, so it never expects one; the variant keeps the event from being read as
    /// an unknown type.
    #[serde(rename = "initialized")]
    Initialized {
        id: String,
        protocol: u64,
        #[serde(default)]
        capabilities: Vec<String>,
        #[serde(default)]
        experimental: Vec<String>,
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
        /// Surface facts (v1.1.4 I-3); each is absent from older sidecars.
        #[serde(default)]
        read_only: Option<bool>,
        #[serde(default)]
        context_tokens: Option<u64>,
        #[serde(default)]
        context_limit: Option<u64>,
        #[serde(default)]
        endpoint_kind: Option<String>,
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
    /// The provider's stream went quiet (`stalled`) after `silent_secs` without a chunk, or spoke again.
    #[serde(rename = "stream.stall")]
    StreamStall {
        #[serde(default)]
        stalled: bool,
        #[serde(default)]
        silent_secs: u64,
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
        /// The operator declined the call at its approval prompt: it never ran. Absent from older sidecars.
        #[serde(default)]
        denied: bool,
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
        /// False when the sidecar could not write the session record for this turn. Older sidecars omit it.
        #[serde(default = "turn_saved_by_default")]
        saved: bool,
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
        /// Text to put on the terminal clipboard with an OSC 52 request (no clipboard tool was found).
        #[serde(default)]
        clipboard: Option<String>,
        /// Set when the command started a turn with this prompt; the turn's events follow under the same id.
        #[serde(default)]
        prompt: Option<String>,
    },
    #[serde(rename = "notice")]
    Notice {
        text: String,
        /// A later notice with the same key replaces the earlier one on screen (a live status, not a log line).
        #[serde(default)]
        key: Option<String>,
        /// The raw cause behind the text, for `/details`. Absent from an older sidecar.
        #[serde(default)]
        detail: Option<String>,
    },
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

/// Who is connecting, as sent in `initialize`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

/// UI → sidecar commands used by the live view.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum Command {
    /// Optional capability negotiation, answered with `initialized`. The live view does not send it in this
    /// release (it accepts or refuses the sidecar from `hello` alone); the variant fixes the bytes a client sends,
    /// checked against the shared golden corpus.
    #[allow(dead_code)]
    #[serde(rename = "initialize")]
    Initialize {
        id: String,
        client: ClientInfo,
        protocol_min: u64,
        protocol_max: u64,
        experimental: bool,
    },
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
        #[serde(skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
    },
    #[serde(rename = "provider.cancel")]
    ProviderCancel { id: String },
    #[serde(rename = "provider.local-cancel")]
    ProviderLocalCancel { id: String },
    #[serde(rename = "provider.disconnect")]
    ProviderDisconnect { id: String, provider: String },
    #[serde(rename = "shutdown")]
    Shutdown,
}

/// Why this client cannot work with the sidecar that sent `hello`, or `None` when it can. A sidecar that announces
/// a version range is compatible when the range shares a version with this client's; an older sidecar (no range)
/// must speak exactly `PROTOCOL_VERSION`, as before.
pub fn hello_mismatch(
    protocol: u64,
    protocol_min: Option<u64>,
    protocol_max: Option<u64>,
) -> Option<String> {
    match (protocol_min, protocol_max) {
        (Some(min), Some(max)) => (min > PROTOCOL_MAX || max < PROTOCOL_MIN).then(|| {
            format!(
                "The agent sidecar speaks protocol {min} to {max}; this view needs protocol {PROTOCOL_MIN} to {PROTOCOL_MAX}."
            )
        }),
        _ => (protocol != PROTOCOL_VERSION).then(|| {
            format!(
                "The agent sidecar speaks protocol {protocol}; this view needs protocol {PROTOCOL_VERSION}."
            )
        }),
    }
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
    fn profile_to_show_hides_an_unconfined_profile_when_the_sandbox_text_is_off_or_none() {
        let posture = |sandbox: &str, profile: Option<&str>| PostureInfo {
            mode: "review".into(),
            sandbox: sandbox.into(),
            trusted: true,
            profile: profile.map(Into::into),
        };
        assert_eq!(posture("off", Some("unconfined")).profile_to_show(), None);
        assert_eq!(posture("none", Some("unconfined")).profile_to_show(), None);
        assert_eq!(
            posture("off", Some(":read-only")).profile_to_show(),
            Some(":read-only")
        );
        assert_eq!(
            posture("none", Some(":read-only")).profile_to_show(),
            Some(":read-only")
        );
        assert_eq!(posture("off", None).profile_to_show(), None);
    }

    #[test]
    fn parses_every_rendered_event_type() {
        assert_eq!(
            parse_event(r#"{"v":1,"type":"hello","protocol":1,"pid":42}"#),
            Ok(Event::Hello {
                protocol: 1,
                commands: Vec::new(),
                protocol_min: None,
                protocol_max: None,
                capabilities: Vec::new(),
                experimental: Vec::new()
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
                read_only: None,
                context_tokens: None,
                context_limit: None,
                endpoint_kind: None,
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
                    profile: None,
                }),
                read_only: None,
                context_tokens: None,
                context_limit: None,
                endpoint_kind: None,
            })
        );
        // SB-1: the effective sandbox profile is an additive, optional field of the posture.
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"review","git":null,"busy":false,"posture":{"mode":"review","sandbox":":workspace (bwrap, network off, --sandbox :workspace)","trusted":true,"profile":":workspace"}}"#
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
                    sandbox: ":workspace (bwrap, network off, --sandbox :workspace)".into(),
                    trusted: true,
                    profile: Some(":workspace".into()),
                }),
                read_only: None,
                context_tokens: None,
                context_limit: None,
                endpoint_kind: None,
            })
        );
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"read-only","git":null,"busy":false,"read_only":true,"context_tokens":1200,"context_limit":32768,"endpoint_kind":"cloud"}"#
            ),
            Ok(Event::SessionState {
                workspace_name: "w".into(),
                model: "m".into(),
                mode: "read-only".into(),
                git: None,
                busy: false,
                session: None,
                posture: None,
                read_only: Some(true),
                context_tokens: Some(1200),
                context_limit: Some(32768),
                endpoint_kind: Some("cloud".into()),
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
                denied: false,
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
                r#"{"v":1,"type":"checkpoint.choice.request","id":"choice-1","turn_id":"t1","message":"Sensitive content prevents checkpointing."}"#
            ),
            Ok(Event::CheckpointChoiceRequest {
                id: "choice-1".into(),
                message: "Sensitive content prevents checkpointing.".into()
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
            saved,
        } = event
        else {
            panic!("expected turn.result");
        };
        assert_eq!(heading, "TURN INTERRUPTED");
        assert_eq!(line, "Stopped by operator");
        assert_eq!(turn["execution"], "INTERRUPTED");
        assert_eq!(turn["outcome"], "NOT_ESTABLISHED");
        assert_eq!(model_summary, None);
        assert!(saved, "a sidecar that does not say is taken to have saved");
        let unsaved = parse_event(r#"{"v":1,"type":"turn.result","turn_id":"t3","heading":"H","line":"L","turn":{},"model_summary":null,"saved":false}"#).unwrap();
        assert!(matches!(unsaved, Event::TurnResult { saved: false, .. }));
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
            parse_event(
                r#"{"v":1,"type":"activity","turn_id":"t1","phase":"tool","step":31,"segment":2,"tool":"run_command","subject":"make test"}"#
            ),
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
            parse_event(
                r#"{"v":1,"type":"steer.ack","id":"g1","status":"cancelled","message":"Not applied","text":"use tabs"}"#
            ),
            Ok(Event::SteerAck {
                id: "g1".into(),
                status: "cancelled".into(),
                message: "Not applied".into(),
                text: Some("use tabs".into()),
            })
        );
        let line = encode_command(&Command::Steer {
            id: "g1".into(),
            text: "use\ntabs".into(),
        });
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
                }],
                protocol_min: None,
                protocol_max: None,
                capabilities: Vec::new(),
                experimental: Vec::new()
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
                clipboard: None,
                prompt: None,
            })
        );
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"slash.result","id":"s3","command":"copy","success":true,"output":"asked","clipboard":"a\u001b[2Jb"}"#),
            Ok(Event::SlashResult { clipboard: Some(ref text), .. }) if text == "a\u{1b}[2Jb"
        ));
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"slash.result","id":"s2","command":"history","success":true,"output":"","prompt":"fix it"}"#),
            Ok(Event::SlashResult { prompt: Some(ref prompt), .. }) if prompt == "fix it"
        ));
        assert_eq!(
            parse_event(r#"{"v":1,"type":"notice","text":"Resumed session a (4 messages)."}"#),
            Ok(Event::Notice {
                text: "Resumed session a (4 messages).".into(),
                key: None,
                detail: None,
            })
        );
    }

    #[test]
    fn a_notice_carries_an_optional_key_and_raw_cause_and_an_old_one_still_parses() {
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"notice","text":"Retry 2","key":"provider.recovery","detail":"HTTP 429"}"#
            ),
            Ok(Event::Notice {
                text: "Retry 2".into(),
                key: Some("provider.recovery".into()),
                detail: Some("HTTP 429".into()),
            })
        );
        // A newer sidecar's unknown fields are ignored, as for every event.
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"notice","text":"x","key":"k","future":1}"#),
            Ok(Event::Notice {
                key: Some(_),
                detail: None,
                ..
            })
        ));
    }

    #[test]
    fn a_stream_stall_parses_with_missing_and_unknown_fields() {
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"stream.stall","turn_id":"t1","stalled":true,"silent_secs":30}"#
            ),
            Ok(Event::StreamStall {
                stalled: true,
                silent_secs: 30
            })
        );
        // Missing fields default to "spoke again" (not stalled, no silence): the safe reading of a bare event.
        assert_eq!(
            parse_event(r#"{"v":1,"type":"stream.stall"}"#),
            Ok(Event::StreamStall {
                stalled: false,
                silent_secs: 0
            })
        );
        assert_eq!(
            parse_event(r#"{"v":1,"type":"stream.stall","stalled":true}"#),
            Ok(Event::StreamStall {
                stalled: true,
                silent_secs: 0
            })
        );
        // A newer sidecar's unknown field is ignored, as for every event.
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"stream.stall","stalled":true,"silent_secs":45,"future":{"a":1}}"#
            ),
            Ok(Event::StreamStall {
                stalled: true,
                silent_secs: 45
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
                Command::CheckpointChoice {
                    id: "choice-1".into(),
                    choice: "without_checkpoint".into(),
                },
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
            review(
                r#"{"kind":"verifier","command":"npm test","script":"jest","detail":"package.json:scripts.test"}"#
            ),
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
        // A delete approval is text rows; fields a later sidecar adds beside them (structured facts) are ignored, and a
        // request without them (an older sidecar) parses the same.
        assert_eq!(
            review(
                r#"{"kind":"args","text":"build\ndirectory \u00b7 3 entries","truncated":false,"delete":{"target":"directory","entries":3,"size":6}}"#
            ),
            Some(Review::Args {
                text: "build\ndirectory \u{b7} 3 entries".into(),
                truncated: false
            })
        );
        assert_eq!(
            review(r#"{"kind":"args","text":"{\n  \"path\": \"base.txt\"\n}","truncated":false}"#),
            Some(Review::Args {
                text: "{\n  \"path\": \"base.txt\"\n}".into(),
                truncated: false
            })
        );
        assert_eq!(review(r#"{"kind":"hologram"}"#), Some(Review::Unknown));
    }

    /// Wire-level golden corpus shared with cli/test/protocol_golden.test.ts: the TypeScript sidecar owns
    /// event encoding and the Rust TUI owns command encoding, so each side checks the other's bytes.
    #[test]
    fn golden_protocol_v1_corpus() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../cli/test/fixtures/protocol_v1_golden.jsonl"
        );
        let corpus =
            std::fs::read_to_string(path).expect("the shared protocol corpus must be checked in");
        let mut events = 0;
        let mut commands = 0;
        let mut negotiation = Vec::new();
        let mut older_sidecar = 0;
        for (index, line) in corpus.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let record: Value =
                serde_json::from_str(line).unwrap_or_else(|e| panic!("corpus line {index}: {e}"));
            let name = record["name"]
                .as_str()
                .unwrap_or_else(|| panic!("corpus line {index} has no name"));
            let json = record["json"]
                .as_str()
                .unwrap_or_else(|| panic!("corpus line {index} has no json"));
            let value: Value =
                serde_json::from_str(json).unwrap_or_else(|e| panic!("corpus record {name}: {e}"));
            assert_eq!(
                value["v"],
                Value::from(PROTOCOL_VERSION),
                "corpus record {name} is versioned"
            );
            assert_eq!(
                value["type"],
                Value::from(name),
                "corpus record {name} type matches its name"
            );
            match record["direction"].as_str() {
                Some("event") => {
                    let event = parse_event(json);
                    assert!(
                        event.is_ok(),
                        "the Rust client must accept sidecar event {name}"
                    );
                    // A record marked `older_sidecar` lacks fields the protocol now requires; it is in the corpus
                    // because this client must keep accepting it.
                    if let Some(missing) = record["older_sidecar"].as_array() {
                        older_sidecar += 1;
                        for field in missing {
                            let field = field.as_str().expect("older_sidecar lists field names");
                            assert!(
                                value.get(field).is_none(),
                                "older-sidecar record {name} must lack {field}"
                            );
                        }
                    }
                    match event {
                        Ok(Event::Hello {
                            protocol,
                            protocol_min: Some(min),
                            protocol_max: Some(max),
                            capabilities,
                            experimental,
                            ..
                        }) => {
                            assert_eq!(Value::from(protocol), value["protocol"]);
                            assert_eq!(Value::from(min), value["protocol_min"]);
                            assert_eq!(Value::from(max), value["protocol_max"]);
                            assert_eq!(Value::from(capabilities), value["capabilities"]);
                            assert_eq!(Value::from(experimental), value["experimental"]);
                            assert_eq!(hello_mismatch(protocol, Some(min), Some(max)), None);
                            negotiation.push("hello");
                        }
                        Ok(Event::Initialized {
                            id,
                            protocol,
                            capabilities,
                            experimental,
                        }) => {
                            assert_eq!(Value::from(id), value["id"]);
                            assert_eq!(Value::from(protocol), value["protocol"]);
                            assert_eq!(Value::from(capabilities), value["capabilities"]);
                            assert_eq!(Value::from(experimental), value["experimental"]);
                            negotiation.push("initialized");
                        }
                        _ => assert_ne!(
                            name, "initialized",
                            "initialized must not parse as an unknown event"
                        ),
                    }
                    events += 1;
                }
                Some("command") => {
                    let id = value["id"].as_str().unwrap_or_default();
                    let command = match name {
                        "initialize" => {
                            negotiation.push("initialize");
                            Command::Initialize {
                                id: id.into(),
                                client: ClientInfo {
                                    name: value["client"]["name"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .into(),
                                    version: value["client"]["version"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .into(),
                                },
                                protocol_min: value["protocol_min"].as_u64().unwrap_or_default(),
                                protocol_max: value["protocol_max"].as_u64().unwrap_or_default(),
                                experimental: value["experimental"].as_bool().unwrap_or_default(),
                            }
                        }
                        "prompt.submit" => Command::PromptSubmit {
                            id: id.into(),
                            text: value["text"].as_str().unwrap_or_default().into(),
                        },
                        "steer" => Command::Steer {
                            id: id.into(),
                            text: value["text"].as_str().unwrap_or_default().into(),
                        },
                        "receipt" => Command::Receipt { id: id.into() },
                        "shutdown" => Command::Shutdown,
                        other => panic!("add a Command constructor for corpus command {other}"),
                    };
                    let encoded = serde_json::from_str::<Value>(&encode_command(&command)).unwrap();
                    assert_eq!(
                        encoded, value,
                        "the TUI must emit exactly the recorded bytes for {name}"
                    );
                    commands += 1;
                }
                other => panic!("corpus line {index} has an unknown direction: {other:?}"),
            }
        }
        assert!(
            events >= 4 && commands >= 4,
            "the corpus must cover both wire directions"
        );
        assert_eq!(
            older_sidecar, 2,
            "the corpus keeps its older-sidecar tolerance records (hello without commands, tool.end without evidence)"
        );
        negotiation.sort_unstable();
        assert_eq!(
            negotiation,
            ["hello", "initialize", "initialized"],
            "the corpus must cover capability negotiation: a hello with a version range, initialize and initialized"
        );
    }

    #[test]
    fn hello_parses_with_and_without_the_negotiation_fields() {
        // An older sidecar: no range, no capabilities.
        assert!(matches!(
            parse_event(r#"{"v":1,"type":"hello","protocol":1,"pid":42}"#),
            Ok(Event::Hello { protocol: 1, protocol_min: None, protocol_max: None, capabilities, experimental, .. })
                if capabilities.is_empty() && experimental.is_empty()
        ));
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"hello","protocol":1,"pid":42,"commands":[],"protocol_min":1,"protocol_max":3,"capabilities":["receipt","steer"],"experimental":["x.test"],"added_later":true}"#
            ),
            Ok(Event::Hello {
                protocol: 1,
                commands: Vec::new(),
                protocol_min: Some(1),
                protocol_max: Some(3),
                capabilities: vec!["receipt".into(), "steer".into()],
                experimental: vec!["x.test".into()]
            })
        );
    }

    #[test]
    fn initialized_parses_as_its_own_event() {
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"initialized","id":"i1","protocol":1,"capabilities":["steer"],"experimental":[]}"#
            ),
            Ok(Event::Initialized {
                id: "i1".into(),
                protocol: 1,
                capabilities: vec!["steer".into()],
                experimental: Vec::new()
            })
        );
    }

    #[test]
    fn compatibility_is_range_overlap_when_the_sidecar_announces_a_range() {
        assert_eq!(
            hello_mismatch(PROTOCOL_VERSION, Some(PROTOCOL_MIN), Some(PROTOCOL_MAX)),
            None
        );
        // A newer sidecar that still speaks this client's version, whatever its default is.
        assert_eq!(hello_mismatch(3, Some(1), Some(3)), None);
        assert_eq!(
            hello_mismatch(3, Some(2), Some(3)).as_deref(),
            Some("The agent sidecar speaks protocol 2 to 3; this view needs protocol 1 to 1.")
        );
        assert!(hello_mismatch(0, Some(0), Some(0)).is_some());
    }

    #[test]
    fn an_older_sidecar_must_match_the_version_exactly() {
        assert_eq!(hello_mismatch(PROTOCOL_VERSION, None, None), None);
        assert_eq!(
            hello_mismatch(2, None, None).as_deref(),
            Some("The agent sidecar speaks protocol 2; this view needs protocol 1.")
        );
        // Half a range is not a range: the exact rule applies.
        assert!(hello_mismatch(2, Some(1), None).is_some());
        assert_eq!(hello_mismatch(1, None, Some(9)), None);
    }

    #[test]
    fn initialize_encodes_the_client_and_its_range() {
        let line = encode_command(&Command::Initialize {
            id: "i1".into(),
            client: ClientInfo {
                name: "nexus-tui".into(),
                version: "1.3.0".into(),
            },
            protocol_min: PROTOCOL_MIN,
            protocol_max: PROTOCOL_MAX,
            experimental: false,
        });
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            serde_json::json!({"v":1,"type":"initialize","id":"i1","client":{"name":"nexus-tui","version":"1.3.0"},"protocol_min":1,"protocol_max":1,"experimental":false})
        );
    }

    // ---- Parity with the TypeScript types (cli/src/protocol.ts), driven by the published schema ----
    //
    // `Event` and `Command` are written by hand. These tests replace keeping them in step by eye: the schema
    // generated from the TypeScript types says what exists on the wire, and every difference from this file is
    // either a failure or an entry in one of the lists below, which must stay exact.

    use std::collections::{BTreeMap, BTreeSet};

    /// Schema fields this client does not read, per event. A field the TypeScript type gains fails
    /// `schema_samples_parse_as_their_own_event_variants` until `Event` reads it or it is listed here.
    const EVENT_FIELDS_NOT_READ: &[(&str, &[&str])] = &[
        // The live view shows one turn at a time and matches tool events by `call_id`, so it never reads `turn_id`.
        ("activity", &["turn_id"]),
        // `preview` is the older, plain-text form of `review`.
        ("approval.request", &["preview", "turn_id"]),
        ("checkpoint.choice.request", &["turn_id"]),
        ("file.diff", &["turn_id"]),
        // The pid of the sidecar is the child this client spawned.
        ("hello", &["pid"]),
        // ACP session/load uses these fields for paginated replay and fail-closed errors; the terminal client's
        // legacy resume path sends one recent-history event and does not consume ACP replay metadata.
        ("history", &["error", "page", "pages"]),
        ("stream.stall", &["turn_id"]),
        // The record is found again by the request `id`; the transcript already holds what the call was.
        ("tool.detail", &["evidence", "subject", "tool"]),
        // `evidence` is taken from `tool.start`.
        ("tool.end", &["evidence", "turn_id"]),
        ("tool.start", &["turn_id"]),
        ("turn.result", &["turn_id"]),
        // The header shows `workspace_name`.
        ("session.state", &["workspace"]),
    ];

    /// Commands the schema defines and this client has no variant for. A command the TypeScript union gains fails
    /// `rust_commands_are_the_checked_in_fixture_and_published_commands` until it is added to `Command` or here.
    const COMMANDS_NOT_SENT: &[&str] = &[
        // The live view answers a blocked turn at its approval prompt (`approve` / `deny`), not with `answer`.
        "answer",
    ];

    /// One of every `Command` variant, with each optional field both absent and present.
    fn command_representatives() -> Vec<Command> {
        let id = || "c1".to_string();
        vec![
            Command::Initialize {
                id: id(),
                client: ClientInfo {
                    name: "nexus-tui".into(),
                    version: "1.3.0".into(),
                },
                protocol_min: PROTOCOL_MIN,
                protocol_max: PROTOCOL_MAX,
                experimental: false,
            },
            Command::PromptSubmit {
                id: id(),
                text: "fix\nit".into(),
            },
            Command::Steer {
                id: id(),
                text: "use tabs".into(),
            },
            Command::Cancel,
            Command::Approve {
                id: id(),
                always: true,
            },
            Command::Deny { id: id() },
            Command::CheckpointChoice {
                id: id(),
                choice: "retry".into(),
            },
            Command::Slash {
                id: id(),
                command: "diff".into(),
                args: String::new(),
            },
            Command::ToolDetail {
                id: id(),
                evidence: "e1".into(),
            },
            Command::Receipt { id: id() },
            Command::ModelsList { id: id() },
            Command::ModelSelect {
                id: id(),
                provider: "local".into(),
                model: "m".into(),
            },
            Command::ProviderConnect {
                id: id(),
                provider: "local".into(),
                method: "endpoint".into(),
                key: None,
                endpoint: None,
            },
            Command::ProviderConnect {
                id: id(),
                provider: "local".into(),
                method: "api-key".into(),
                key: Some(Secret("not-a-real-key".into())),
                endpoint: Some("http://127.0.0.1:1/v1".into()),
            },
            Command::ProviderCancel { id: id() },
            Command::ProviderLocalCancel { id: id() },
            Command::ProviderDisconnect {
                id: id(),
                provider: "local".into(),
            },
            Command::Shutdown,
        ]
    }

    fn repo_file(relative: &str) -> String {
        let path = format!("{}/../{relative}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path} must be checked in: {e}"))
    }

    /// Message type → its field names (without `v` and `type`), for one direction of the published schema.
    fn schema_messages(def: &str) -> BTreeMap<String, BTreeSet<String>> {
        let schema: Value = serde_json::from_str(&repo_file(&format!(
            "docs/protocol/sidecar-v{PROTOCOL_VERSION}.schema.json"
        )))
        .expect("the schema is JSON");
        let variants = schema["$defs"][def]["oneOf"]
            .as_array()
            .unwrap_or_else(|| panic!("the schema defines {def}"));
        variants
            .iter()
            .map(|variant| {
                let name = variant["properties"]["type"]["const"]
                    .as_str()
                    .expect("a message variant has a constant type");
                let fields = variant["properties"]
                    .as_object()
                    .expect("a message variant has properties")
                    .keys()
                    .filter(|field| *field != "v" && *field != "type")
                    .cloned()
                    .collect();
                (name.to_string(), fields)
            })
            .collect()
    }

    /// The wire names of the variants of `pub enum <name>` in this file, read from the source: each variant's
    /// `#[serde(rename = "...")]`. Rust has no way to list an enum's variants, and a list kept by hand in a test
    /// would be the hand-sync this replaces. Every variant must carry a rename (the `#[serde(other)]` fallback
    /// excepted), which is asserted, so a variant cannot be missed.
    fn rust_wire_names(name: &str) -> BTreeSet<String> {
        let source = include_str!("protocol.rs");
        let opening = format!("pub enum {name} {{\n");
        let start = source
            .find(&opening)
            .unwrap_or_else(|| panic!("enum {name} is declared in protocol.rs"));
        let body = &source[start + opening.len()..];
        let body = &body[..body.find("\n}\n").expect("the enum body ends")];
        let mut names = BTreeSet::new();
        let (mut variants, mut fallbacks) = (0, 0);
        for line in body.lines() {
            // Variant-level lines are indented by exactly four spaces; fields and their attributes by eight.
            let Some(item) = line
                .strip_prefix("    ")
                .filter(|rest| !rest.starts_with(' '))
            else {
                continue;
            };
            if let Some(rest) = item.strip_prefix("#[serde(rename = \"") {
                let wire = rest
                    .strip_suffix("\")]")
                    .unwrap_or_else(|| panic!("unexpected rename attribute: {line}"));
                assert!(
                    names.insert(wire.to_string()),
                    "{name}: two variants are renamed {wire}"
                );
            } else if item == "#[serde(other)]" {
                fallbacks += 1;
            } else if item.starts_with(|c: char| c.is_ascii_uppercase()) {
                variants += 1;
            }
        }
        assert!(!names.is_empty(), "{name} has variants");
        assert_eq!(
            variants,
            names.len() + fallbacks,
            "every {name} variant needs #[serde(rename = \"<wire type>\")]"
        );
        names
    }

    /// The top-level field names of a parsed message, from its derived `Debug` form (`{:#?}` puts each field of
    /// the variant on its own line, indented by four spaces). No field of `Event` is renamed, so these are the
    /// wire names.
    fn fields_read(debug: &str) -> BTreeSet<String> {
        debug
            .lines()
            .filter_map(|line| line.strip_prefix("    "))
            .filter(|rest| rest.starts_with(|c: char| c.is_ascii_lowercase()))
            .filter_map(|rest| rest.split_once(": ").map(|(field, _)| field.to_string()))
            .collect()
    }

    #[test]
    fn schema_samples_parse_as_their_own_event_variants() {
        let published = schema_messages("SidecarEvent");
        // Every event the schema publishes has a variant here, and every variant here is a published event.
        assert_eq!(
            rust_wire_names("Event"),
            published.keys().cloned().collect(),
            "the Rust Event enum and the schema's events differ: add the variant, or regenerate the schema"
        );
        let not_read: BTreeMap<&str, BTreeSet<String>> = EVENT_FIELDS_NOT_READ
            .iter()
            .map(|(event, fields)| (*event, fields.iter().map(|f| f.to_string()).collect()))
            .collect();
        assert_eq!(
            not_read.len(),
            EVENT_FIELDS_NOT_READ.len(),
            "EVENT_FIELDS_NOT_READ lists an event twice"
        );
        for event in not_read.keys() {
            assert!(
                published.contains_key(*event),
                "EVENT_FIELDS_NOT_READ names {event}, which the schema does not define"
            );
        }

        let samples = repo_file(&format!(
            "cli/test/fixtures/protocol_v{PROTOCOL_VERSION}_schema_samples.jsonl"
        ));
        let mut seen = BTreeSet::new();
        for line in samples.lines() {
            let record: Value = serde_json::from_str(line).expect("a sample record is JSON");
            if record["direction"] != "event" {
                continue;
            }
            let name = record["name"].as_str().expect("a sample has a name");
            let shape = record["shape"].as_str().expect("a sample has a shape");
            let json = record["json"].as_str().expect("a sample has json");
            let event = parse_event(json).unwrap_or_else(|err| {
                panic!("the {shape} {name} sample does not parse: {err}\n{json}\nThe TypeScript type allows this message; make the Rust field optional or add what is missing.")
            });
            let debug = format!("{event:#?}");
            // `Event::Unknown` and `Review::Unknown` are what a type or shape this client lacks parses as.
            let fallback = debug.lines().any(|line| {
                let value = line.trim().trim_end_matches(',');
                value == "Unknown" || value.ends_with(": Unknown")
            });
            assert!(
                !fallback,
                "the {shape} {name} sample parsed as an unknown variant: {debug}"
            );
            seen.insert((name.to_string(), shape.to_string()));
            if shape != "full" {
                continue;
            }
            let read = fields_read(&debug);
            let fields = &published[name];
            assert_eq!(
                read.difference(fields).collect::<Vec<_>>(),
                Vec::<&String>::new(),
                "{name}: Rust reads fields the schema does not define"
            );
            assert_eq!(
                fields.difference(&read).cloned().collect::<BTreeSet<_>>(),
                not_read.get(name).cloned().unwrap_or_default(),
                "{name}: the schema fields this client does not read must equal EVENT_FIELDS_NOT_READ"
            );
        }
        for name in published.keys() {
            for shape in ["minimal", "full"] {
                assert!(
                    seen.contains(&(name.clone(), shape.to_string())),
                    "no {shape} sample for {name}: run `node cli/scripts/gen_protocol_samples.mjs`"
                );
            }
        }
    }

    /// The fixture holds the exact lines this client writes, one command per line. This test keeps it equal to
    /// what `encode_command` produces today; `cli/test/protocol_parity.test.ts` validates each line against the
    /// schema and gives it to the sidecar's `parseCommand`. So a field renamed here fails there. Rewrite the
    /// fixture with `NEXUS_UPDATE_PROTOCOL_FIXTURES=1 cargo test --bin nexus-tui rust_commands`.
    #[test]
    fn rust_commands_are_the_checked_in_fixture_and_published_commands() {
        let relative =
            format!("cli/test/fixtures/protocol_v{PROTOCOL_VERSION}_rust_commands.jsonl");
        let encoded: String = command_representatives()
            .iter()
            .map(encode_command)
            .collect();
        if std::env::var_os("NEXUS_UPDATE_PROTOCOL_FIXTURES").is_some() {
            std::fs::write(
                format!("{}/../{relative}", env!("CARGO_MANIFEST_DIR")),
                &encoded,
            )
            .expect("the fixture is writable");
        }
        assert_eq!(
            repo_file(&relative),
            encoded,
            "{relative} is not what the client serializes: rerun with NEXUS_UPDATE_PROTOCOL_FIXTURES=1 and review the diff"
        );

        let sent: BTreeSet<String> = encoded
            .lines()
            .map(|line| {
                let value: Value = serde_json::from_str(line).expect("a command line is JSON");
                assert_eq!(value["v"], Value::from(PROTOCOL_VERSION));
                value["type"]
                    .as_str()
                    .expect("a command has a type")
                    .to_string()
            })
            .collect();
        assert_eq!(
            sent,
            rust_wire_names("Command"),
            "command_representatives must hold every Command variant"
        );
        let published: BTreeSet<String> = schema_messages("SidecarCommand").into_keys().collect();
        assert_eq!(
            sent.difference(&published).collect::<Vec<_>>(),
            Vec::<&String>::new(),
            "this client can send a command the schema does not define"
        );
        assert_eq!(
            published.difference(&sent).cloned().collect::<Vec<_>>(),
            COMMANDS_NOT_SENT,
            "the published commands this client has no variant for must equal COMMANDS_NOT_SENT"
        );
    }
}
