//! Live session state. Pure: protocol events and keys go in, actions come out. Outcomes are projected exactly as
//! the sidecar reports them.
use crate::composer::Composer;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::models::{AuthInfo, Connect, ConnectIntent, Fetch, Picker, PickerIntent, Step};
use crate::protocol::{Catalog, Command, Event, PROTOCOL_VERSION, ReceiptSection, Review, Secret, SlashSpec};
use crate::review::{ReviewLine, review_lines};
use crate::slash::{self, Invocation};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ToolStatus {
    Running,
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tone {
    Good,
    Caution,
    Bad,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    User(String),
    Assistant {
        turn_id: String,
        text: String,
    },
    Tool {
        call_id: String,
        tool: String,
        subject: String,
        status: ToolStatus,
        summary: String,
        evidence: String,
    },
    Banner {
        heading: String,
        line: String,
        tone: Tone,
        /// Redacted `inferenceFailure.message`, when the turn reports one.
        failure: Option<String>,
        summary: Option<String>,
        notes: Option<String>,
    },
    Notice(String),
    /// A slash or `!` command as the operator typed it.
    Command(String),
    /// What a command reported. `diff` asks for unified-diff colouring.
    Output {
        success: bool,
        text: String,
        diff: bool,
    },
    /// A quiet informational line from the sidecar or the view.
    Info(String),
    /// The operator's answer to an approval request.
    Decision {
        tool: String,
        subject: String,
        verdict: Verdict,
    },
    /// Steering the operator sent while the agent worked, and what became of it.
    Steer {
        id: String,
        /// As typed, with paste buffers shown by their labels.
        text: String,
        state: SteerState,
        message: String,
    },
    /// The change one file-edit call made (a bounded preview; the call's detail record holds the whole diff).
    Diff {
        call_id: String,
        evidence: String,
        path: String,
        kind: String,
        added: u64,
        removed: u64,
        preview: String,
        truncated: bool,
        total_lines: u64,
        note: Option<String>,
    },
}

/// Where operator steering stands, as the sidecar acknowledged it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SteerState {
    /// Written to the sidecar; no acknowledgement yet.
    Sending,
    /// Held for the agent's next step.
    Queued,
    /// Given to the agent.
    Applied,
    /// The turn was finishing; it starts a follow-up turn.
    Deferred,
    /// The turn ended first; the text went back to the composer.
    Cancelled,
    /// Nothing could take it (a command was running); the text went back to the composer.
    Rejected,
    /// The sidecar had already received it.
    Duplicate,
    /// The sidecar stopped before acknowledging it; the text went back to the composer.
    Lost,
}

impl SteerState {
    fn from_ack(status: &str) -> SteerState {
        match status {
            "queued" => SteerState::Queued,
            "applied" => SteerState::Applied,
            "deferred" => SteerState::Deferred,
            "cancelled" => SteerState::Cancelled,
            "duplicate" => SteerState::Duplicate,
            _ => SteerState::Rejected,
        }
    }

    /// Still owed an outcome by the sidecar.
    pub fn open(self) -> bool {
        matches!(self, SteerState::Sending | SteerState::Queued | SteerState::Deferred)
    }
}

/// What the running turn reported it is doing, and since when (this client's clock).
#[derive(Clone, Debug, PartialEq)]
pub struct Activity {
    pub phase: String,
    pub step: u64,
    pub segment: u64,
    pub tool: Option<String>,
    pub subject: Option<String>,
    pub since: Instant,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Session {
    pub workspace_name: String,
    pub model: String,
    pub mode: String,
    pub branch: Option<String>,
    pub dirty: u64,
    pub busy: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Link {
    Connecting,
    Ready,
    Crashed {
        code: Option<i32>,
        reason: String,
        stderr: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Send(Command),
    Quit,
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Verdict {
    Approved,
    /// Approved, and every later action in the session runs without asking (the sidecar switches to auto).
    ApprovedForSession,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Focus {
    Composer,
    Transcript,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub id: String,
    pub tool: String,
    pub subject: String,
    pub lines: Vec<ReviewLine>,
    pub scroll: usize,
    pub opened: Instant,
}

/// A panel's content: requested from the sidecar, then filled by its answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Loaded<T> {
    Waiting,
    Ready(T),
    Failed(String),
}

/// A tool call's full record as the sidecar keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRecord {
    pub status: String,
    pub args: String,
    pub output: String,
    pub duration_ms: Option<u64>,
    /// The whole diff of the file change the call made.
    pub diff: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detail {
    /// Request id; answers for other ids are ignored.
    pub request: String,
    pub tool: String,
    pub subject: String,
    pub record: Loaded<ToolRecord>,
    pub scroll: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptPanel {
    pub request: String,
    pub sections: Loaded<Vec<ReceiptSection>>,
    pub scroll: usize,
}

/// Keystrokes typed for the draft must not answer an approval modal that opened mid-typing.
pub const APPROVAL_GRACE: Duration = Duration::from_millis(400);

/// Modal panels. While one is open it receives every key except Ctrl-C.
#[derive(Clone, Debug, PartialEq)]
pub enum Overlay {
    Approval(Approval),
    Help { scroll: usize },
    Detail(Detail),
    Receipt(ReceiptPanel),
    /// `/model`: choose a model from any connected provider.
    Models(Picker),
    /// ctrl+p in the picker (or `/connect`): connect a provider.
    Connect(Connect),
    /// ctrl+o in the composer: a paste buffer's full content.
    Paste { number: u32, scroll: usize },
}

/// What the last frame measured. Key handling uses it for page sizes, and it clamps scrolling at the top.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LiveLayout {
    pub transcript_rows: usize,
    /// Largest useful `scroll_back`; `usize::MAX` when the frame did not reach the top of the transcript.
    pub scroll_limit: usize,
    pub overlay_rows: usize,
    pub overlay_limit: usize,
    /// Set when the frame moved the transcript window to show the selected tool call: the `scroll_back` it drew.
    pub followed: Option<usize>,
}

/// Tool calls whose result the turn banner already reports.
const HIDDEN_TOOLS: &[&str] = &["task_completed"];

pub struct LiveState {
    pub link: Link,
    pub session: Session,
    pub transcript: Vec<Entry>,
    pub composer: Composer,
    turn_seq: u64,
    /// Id of the submitted prompt the sidecar has not yet answered with a `turn.result`.
    pending: Option<String>,
    /// Ctrl-C already asked the running turn to stop; another Ctrl-C quits.
    cancel_requested: bool,
    pub focus: Focus,
    pub overlay: Option<Overlay>,
    /// Transcript rows hidden below the viewport; 0 follows the newest line.
    pub scroll_back: usize,
    /// Quit was requested; the frame says so while the sidecar shuts down.
    pub closing: bool,
    layout: LiveLayout,
    pub commands: Vec<SlashSpec>,
    slash_seq: u64,
    /// Highlighted completion row.
    slash_pick: usize,
    /// Esc hid the completion list; editing the draft shows it again.
    slash_dismissed: bool,
    /// Transcript index of the selected tool call (transcript focus only).
    pub selected: Option<usize>,
    /// The next frame should move the window to show the selection.
    pub follow: bool,
    panel_seq: u64,
    /// Commands a sidecar event asked to send (the live loop drains them after applying events).
    outbox: Vec<Action>,
    /// What the running turn last reported doing.
    pub activity: Option<Activity>,
    /// When the current turn started (this client's clock); drives the elapsed time while busy.
    pub turn_started: Option<Instant>,
    steer_seq: u64,
    /// Exact text of steering the sidecar still owes an outcome for, by id, to give back if it is not applied.
    steer_texts: HashMap<String, String>,
    /// The clock frames are drawn at; the live loop advances it before each draw.
    pub now: Instant,
}

impl LiveState {
    pub fn new() -> Self {
        LiveState {
            link: Link::Connecting,
            session: Session::default(),
            transcript: Vec::new(),
            composer: Composer::default(),
            turn_seq: 0,
            pending: None,
            cancel_requested: false,
            focus: Focus::Composer,
            overlay: None,
            scroll_back: 0,
            closing: false,
            layout: LiveLayout::default(),
            commands: Vec::new(),
            slash_seq: 0,
            slash_pick: 0,
            slash_dismissed: false,
            selected: None,
            follow: false,
            panel_seq: 0,
            outbox: Vec::new(),
            activity: None,
            turn_started: None,
            steer_seq: 0,
            steer_texts: HashMap::new(),
            now: Instant::now(),
        }
    }

    /// Advances the drawing clock (the live loop calls it before each frame).
    pub fn set_now(&mut self, now: Instant) {
        self.now = now;
    }

    /// The activity indicator animates only while a turn runs on a live link.
    pub fn animating(&self) -> bool {
        self.session.busy && self.link == Link::Ready && !self.closing && !self.connecting()
    }

    /// Puts returned steering back into the draft (at the end, as a paste buffer when it is long or multi-line).
    fn restore_draft(&mut self, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        if !self.composer.is_empty() {
            self.composer.line_end();
            while !self.composer.at_end() {
                self.composer.down();
                self.composer.line_end();
            }
            self.composer.insert("\n");
        }
        self.composer.paste(text);
    }

    /// Commands queued while applying sidecar events.
    pub fn take_outbox(&mut self) -> Vec<Action> {
        std::mem::take(&mut self.outbox)
    }

    fn next_id(&mut self, prefix: char) -> String {
        self.panel_seq += 1;
        format!("{prefix}{}", self.panel_seq)
    }

    /// Opens the model picker and asks the sidecar for the catalog.
    fn open_models(&mut self, connect: bool, only: Option<String>) -> Option<Action> {
        if self.link != Link::Ready {
            return None;
        }
        let id = self.next_id('m');
        let mut picker = Picker::new(id.clone());
        picker.connect_on_load = connect;
        picker.only = only;
        self.overlay = Some(Overlay::Models(picker));
        Some(Action::Send(Command::ModelsList { id }))
    }

    fn on_models_key(&mut self, key: KeyEvent) -> Option<Action> {
        let Some(Overlay::Models(picker)) = &mut self.overlay else {
            return None;
        };
        let providers = match &picker.catalog {
            Fetch::Ready(catalog) => catalog.providers.clone(),
            _ => Vec::new(),
        };
        match picker.on_key(key)? {
            PickerIntent::Close => {
                self.overlay = None;
                None
            }
            PickerIntent::Select { provider, model } => {
                self.overlay = None;
                let id = self.next_id('x');
                self.transcript.push(Entry::Command(format!("/model {provider} {model}")));
                Some(Action::Send(Command::ModelSelect { id, provider, model }))
            }
            PickerIntent::Connect(at) => {
                let (flow, intent) = Connect::new(providers, at.as_deref());
                self.overlay = Some(Overlay::Connect(flow));
                intent.and_then(|intent| self.connect_intent(intent))
            }
        }
    }

    fn connect_intent(&mut self, intent: ConnectIntent) -> Option<Action> {
        match intent {
            ConnectIntent::Back => self.open_models(false, None),
            ConnectIntent::Connect { provider, method, key } => {
                let id = self.next_id('c');
                if let Some(Overlay::Connect(flow)) = &mut self.overlay {
                    flow.step = Step::Waiting {
                        request: id.clone(),
                        provider: provider.clone(),
                        method: method.clone(),
                        auth: None,
                    };
                }
                Some(Action::Send(Command::ProviderConnect {
                    id,
                    provider,
                    method,
                    key: key.map(Secret),
                }))
            }
            ConnectIntent::Cancel { request } => Some(Action::Send(Command::ProviderCancel { id: request })),
            ConnectIntent::Disconnect { provider } => {
                let id = self.next_id('c');
                Some(Action::Send(Command::ProviderDisconnect { id, provider }))
            }
        }
    }

    fn on_connect_key(&mut self, key: KeyEvent) -> Option<Action> {
        let Some(Overlay::Connect(flow)) = &mut self.overlay else {
            return None;
        };
        let intent = flow.on_key(key)?;
        self.connect_intent(intent)
    }

    fn on_catalog(&mut self, id: String, catalog: Catalog) {
        match &mut self.overlay {
            Some(Overlay::Models(picker)) if picker.request == id => {
                let providers = catalog.providers.clone();
                picker.catalog = Fetch::Ready(catalog);
                picker.focus_current();
                if picker.connect_on_load {
                    let (flow, intent) = Connect::new(providers, None);
                    self.overlay = Some(Overlay::Connect(flow));
                    if let Some(action) = intent.and_then(|intent| self.connect_intent(intent)) {
                        self.outbox.push(action);
                    }
                }
            }
            Some(Overlay::Connect(flow)) if flow.refresh.as_deref() == Some(id.as_str()) => {
                flow.providers = catalog.providers;
                flow.refresh = None;
            }
            _ => {}
        }
    }

    fn on_provider_result(&mut self, id: String, provider: String, success: bool, message: String) {
        if let Some(Overlay::Connect(flow)) = &mut self.overlay {
            let waiting = matches!(&flow.step, Step::Waiting { request, .. } if *request == id);
            if waiting {
                if flow.on_result(&id, success, message.clone()) {
                    self.transcript.push(Entry::Info(message));
                    // Connected: show that provider's models.
                    if let Some(action) = self.open_models(false, Some(provider)) {
                        self.outbox.push(action);
                    }
                }
                return;
            }
            // A disconnect (or a late answer): report it and refresh the provider list.
            flow.notice = Some((success, message));
            let refresh = self.next_id('m');
            if let Some(Overlay::Connect(flow)) = &mut self.overlay {
                flow.refresh = Some(refresh.clone());
            }
            self.outbox.push(Action::Send(Command::ModelsList { id: refresh }));
            return;
        }
        self.transcript.push(Entry::Output {
            success,
            text: message,
            diff: false,
        });
    }

    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested
    }

    /// No session yet: the link is starting, or `hello` arrived but the first `session.state` has not.
    pub fn connecting(&self) -> bool {
        match self.link {
            Link::Connecting => true,
            Link::Ready => self.session.workspace_name.is_empty(),
            Link::Crashed { .. } => false,
        }
    }

    pub fn apply(&mut self, event: Event) {
        if matches!(self.link, Link::Crashed { .. }) {
            return;
        }
        match event {
            Event::Hello { protocol, commands } if protocol == PROTOCOL_VERSION => {
                self.commands = commands;
                self.link = Link::Ready;
            }
            Event::Hello { protocol, .. } => self.fail(
                format!("The agent sidecar speaks protocol {protocol}; this view needs protocol {PROTOCOL_VERSION}."),
                None,
                Vec::new(),
            ),
            Event::SessionState { workspace_name, model, mode, git, busy } => {
                self.session = Session {
                    workspace_name,
                    model,
                    mode,
                    branch: git.as_ref().map(|git| git.branch.clone()),
                    dirty: git.map_or(0, |git| git.dirty),
                    busy,
                };
                self.cancel_requested &= busy;
                self.link = Link::Ready;
                if busy && self.turn_started.is_none() {
                    self.turn_started = Some(Instant::now());
                }
                if !busy {
                    self.turn_started = None;
                    self.activity = None;
                }
            }
            Event::Activity { phase, step, segment, tool, subject } => {
                let since = match &self.activity {
                    Some(previous) if previous.phase == phase && previous.tool == tool => previous.since,
                    _ => Instant::now(),
                };
                self.activity = Some(Activity { phase, step, segment, tool, subject, since });
            }
            Event::FileDiff {
                call_id,
                evidence,
                path,
                kind,
                added,
                removed,
                preview,
                truncated,
                total_lines,
                note,
            } => self.transcript.push(Entry::Diff {
                call_id,
                evidence,
                path,
                kind,
                added,
                removed,
                preview,
                truncated,
                total_lines,
                note,
            }),
            Event::SteerAck { id, status, message, text } => {
                let state = SteerState::from_ack(&status);
                if let Some(Entry::Steer { state: slot, message: note, .. }) = self
                    .transcript
                    .iter_mut()
                    .rev()
                    .find(|entry| matches!(entry, Entry::Steer { id: sent, .. } if *sent == id))
                {
                    *slot = state;
                    *note = message.clone();
                }
                if !state.open() {
                    let kept = self.steer_texts.remove(&id);
                    if matches!(state, SteerState::Cancelled | SteerState::Rejected) {
                        let returned = text.or(kept).unwrap_or_default();
                        self.restore_draft(&returned);
                    }
                }
            }
            Event::AssistantDelta { turn_id, text } => match self.transcript.last_mut() {
                Some(Entry::Assistant { turn_id: last, text: body }) if *last == turn_id => body.push_str(&text),
                _ => self.transcript.push(Entry::Assistant { turn_id, text }),
            },
            Event::ToolStart { call_id, tool, subject, evidence } => {
                if !HIDDEN_TOOLS.contains(&tool.as_str()) {
                    self.transcript.push(Entry::Tool {
                        call_id,
                        tool,
                        subject,
                        status: ToolStatus::Running,
                        summary: String::new(),
                        evidence,
                    });
                }
            }
            Event::ToolEnd { call_id, tool, success, summary } => {
                let open = self.transcript.iter_mut().rev().find(|entry| {
                    matches!(entry, Entry::Tool { call_id: id, tool: name, status: ToolStatus::Running, .. }
                        if *id == call_id && *name == tool)
                });
                if let Some(Entry::Tool { status, summary: slot, .. }) = open {
                    *status = if success { ToolStatus::Succeeded } else { ToolStatus::Failed };
                    *slot = summary;
                }
            }
            Event::ApprovalRequest {
                id,
                tool,
                subject,
                review,
            } => {
                let lines = review_lines(review.as_ref().unwrap_or(&Review::Unknown));
                self.overlay = Some(Overlay::Approval(Approval {
                    id,
                    tool,
                    subject,
                    lines,
                    scroll: 0,
                    opened: Instant::now(),
                }));
            }
            Event::TurnResult { heading, line, turn, model_summary } => {
                self.pending = None;
                self.cancel_requested = false;
                self.activity = None;
                self.interrupt_running_tools();
                self.close_approval();
                let (summary, notes) = model_summary
                    .map_or((None, None), |model| (Some(model.summary), model.notes));
                self.transcript.push(Entry::Banner {
                    heading,
                    line,
                    tone: tone_for(&turn),
                    failure: turn["inferenceFailure"]["message"].as_str().map(str::to_string),
                    summary,
                    notes,
                });
                if let Some(objective) = objective_note(&turn) {
                    self.transcript.push(Entry::Info(objective));
                }
            }
            Event::Error {
                id: Some(id),
                code,
                message,
            } if self.issued_panel(&id) => {
                let waiting = self.waiting_panel() == Some(id.as_str());
                let message = format!("{code}: {message}");
                match &mut self.overlay {
                    // A connect or model-select answer with no panel waiting for it still reaches the operator.
                    _ if !waiting && id.starts_with(['c', 'x']) => self.transcript.push(Entry::Notice(message)),
                    _ if !waiting => {}
                    Some(Overlay::Detail(detail)) => detail.record = Loaded::Failed(message),
                    Some(Overlay::Receipt(panel)) => panel.sections = Loaded::Failed(message),
                    Some(Overlay::Models(picker)) => picker.catalog = Fetch::Failed(message),
                    Some(Overlay::Connect(flow)) => {
                        flow.on_result(&id, false, message);
                    }
                    _ => {}
                }
            }
            Event::Error { id, code, message } => {
                // BUSY means the sidecar is still running a turn, so the composer stays locked.
                if id.is_some() && id == self.pending && code != "BUSY" {
                    self.pending = None;
                    self.session.busy = false;
                    self.cancel_requested = false;
                }
                self.transcript.push(Entry::Notice(format!("{code}: {message}")));
            }
            Event::SlashResult {
                id,
                command,
                success,
                output,
                format,
                composer,
                prompt,
            } => {
                if command == "clear" && success {
                    self.transcript.clear();
                    self.scroll_back = 0;
                    self.selected = None;
                }
                if !output.is_empty() || !success {
                    self.transcript.push(Entry::Output {
                        success,
                        text: output,
                        diff: format.as_deref() == Some("diff"),
                    });
                }
                if let Some(text) = composer {
                    self.composer.insert(&text);
                }
                match prompt {
                    // The command started a turn under its id; `turn.result` releases the composer.
                    Some(prompt) => self.transcript.push(Entry::User(prompt)),
                    None if self.pending.as_deref() == Some(id.as_str()) => self.pending = None,
                    None => {}
                }
            }
            Event::Notice { text } => self.transcript.push(Entry::Info(text)),
            Event::ToolDetail {
                id,
                status,
                args,
                output,
                duration_ms,
                diff,
            } => {
                if let Some(Overlay::Detail(detail)) = &mut self.overlay
                    && detail.request == id
                {
                    detail.record = Loaded::Ready(ToolRecord {
                        status,
                        args,
                        output,
                        duration_ms,
                        diff,
                    });
                }
            }
            Event::Receipt { id, sections } => {
                if let Some(Overlay::Receipt(panel)) = &mut self.overlay
                    && panel.request == id
                {
                    panel.sections = Loaded::Ready(sections);
                }
            }
            Event::ModelsCatalog { id, providers, models, current, recent } => {
                self.on_catalog(id, Catalog { providers, models, current, recent });
            }
            Event::ProviderAuth { id, url, user_code, instructions, .. } => {
                if let Some(Overlay::Connect(flow)) = &mut self.overlay
                    && let Step::Waiting { request, auth, .. } = &mut flow.step
                    && *request == id
                {
                    *auth = Some(AuthInfo { url, user_code, instructions });
                }
            }
            Event::ProviderResult { id, provider, success, message } => {
                self.on_provider_result(id, provider, success, message);
            }
            Event::ModelResult { success, message, .. } => {
                self.transcript.push(Entry::Output {
                    success,
                    text: message,
                    diff: false,
                });
            }
            Event::Unknown => {}
        }
    }

    /// The sidecar stopped or broke protocol; nothing still running can finish.
    pub fn fail(&mut self, reason: String, code: Option<i32>, stderr: Vec<String>) {
        self.close_approval();
        self.interrupt_running_tools();
        self.session.busy = false;
        self.cancel_requested = false;
        self.activity = None;
        self.turn_started = None;
        // Steering the sidecar never acknowledged as applied goes back to the operator instead of vanishing.
        let mut returned = Vec::new();
        for entry in &mut self.transcript {
            if let Entry::Steer { id, state, message, .. } = entry
                && state.open()
            {
                *state = SteerState::Lost;
                *message = "The agent stopped before applying it; the text is back in the composer.".into();
                if let Some(text) = self.steer_texts.remove(id) {
                    returned.push(text);
                }
            }
        }
        for text in returned {
            self.restore_draft(&text);
        }
        self.link = Link::Crashed {
            code,
            reason,
            stderr,
        };
    }

    pub fn restarted(&mut self) {
        self.close_approval();
        if matches!(
            self.overlay,
            Some(Overlay::Detail(_) | Overlay::Receipt(_) | Overlay::Models(_) | Overlay::Connect(_))
        ) {
            self.overlay = None;
        }
        // Evidence ids are numbered per sidecar process; the new one would answer for other calls.
        for entry in &mut self.transcript {
            if let Entry::Tool { evidence, .. } = entry {
                evidence.clear();
            }
        }
        self.link = Link::Connecting;
        self.session.busy = false;
        self.cancel_requested = false;
        self.transcript.push(Entry::Notice(
            "Started a new agent sidecar. It does not remember the conversation above.".to_string(),
        ));
    }

    pub fn on_paste(&mut self, text: &str) {
        if matches!(self.overlay, Some(Overlay::Paste { .. })) {
            return;
        }
        match &mut self.overlay {
            Some(Overlay::Connect(flow)) => return flow.on_paste(text),
            Some(Overlay::Models(picker)) => {
                picker.query.push_str(text.trim());
                picker.pick = 0;
                return;
            }
            _ => {}
        }
        if !matches!(self.link, Link::Crashed { .. }) && self.overlay.is_none() {
            self.slash_pick = 0;
            self.slash_dismissed = false;
            self.composer.paste(text);
        }
    }

    /// Records what the frame measured and clamps scrolling to it.
    pub fn note_layout(&mut self, layout: LiveLayout) {
        if let Some(back) = layout.followed {
            self.scroll_back = back;
            self.follow = false;
        }
        self.scroll_back = self.scroll_back.min(layout.scroll_limit);
        if let Some(
            Overlay::Approval(Approval { scroll, .. })
            | Overlay::Help { scroll }
            | Overlay::Paste { scroll, .. }
            | Overlay::Detail(Detail { scroll, .. })
            | Overlay::Receipt(ReceiptPanel { scroll, .. }),
        ) = &mut self.overlay
        {
            *scroll = (*scroll).min(layout.overlay_limit);
        }
        self.layout = layout;
    }

    fn close_approval(&mut self) {
        if matches!(self.overlay, Some(Overlay::Approval(_))) {
            self.overlay = None;
        }
    }

    fn page(rows: usize) -> usize {
        rows.saturating_sub(1).max(1)
    }

    fn on_approval_key(&mut self, key: KeyEvent, now: Instant) -> Option<Action> {
        let verdict = match key.code {
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => Verdict::Approved,
            KeyCode::Char('a' | 'A') => Verdict::ApprovedForSession,
            KeyCode::Char('n' | 'N') | KeyCode::Esc => Verdict::Denied,
            code => {
                self.scroll_overlay(code);
                return None;
            }
        };
        if let Some(Overlay::Approval(approval)) = &self.overlay
            && now.saturating_duration_since(approval.opened) < APPROVAL_GRACE
        {
            return None;
        }
        let Some(Overlay::Approval(approval)) = self.overlay.take() else {
            return None;
        };
        self.transcript.push(Entry::Decision {
            tool: approval.tool,
            subject: approval.subject,
            verdict,
        });
        Some(Action::Send(match verdict {
            Verdict::Denied => Command::Deny { id: approval.id },
            verdict => Command::Approve {
                id: approval.id,
                always: verdict == Verdict::ApprovedForSession,
            },
        }))
    }

    fn on_help_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('?' | 'q') => self.overlay = None,
            code => self.scroll_overlay(code),
        }
    }

    /// Scrolls the open overlay. The next frame clamps past-the-end values through `note_layout`.
    fn scroll_overlay(&mut self, code: KeyCode) {
        let page = Self::page(self.layout.overlay_rows);
        if let Some(
            Overlay::Approval(Approval { scroll, .. })
            | Overlay::Help { scroll }
            | Overlay::Paste { scroll, .. }
            | Overlay::Detail(Detail { scroll, .. })
            | Overlay::Receipt(ReceiptPanel { scroll, .. }),
        ) = &mut self.overlay
        {
            *scroll = match code {
                KeyCode::Up | KeyCode::Char('k') => scroll.saturating_sub(1),
                KeyCode::Down | KeyCode::Char('j') => scroll.saturating_add(1),
                KeyCode::PageUp => scroll.saturating_sub(page),
                KeyCode::PageDown => scroll.saturating_add(page),
                KeyCode::Home => 0,
                KeyCode::End => usize::MAX,
                _ => *scroll,
            };
        }
    }

    fn on_transcript_key(&mut self, key: KeyEvent) -> Option<Action> {
        let plain = !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        match key.code {
            KeyCode::Char('[') if plain => self.select_tool(true),
            KeyCode::Char(']') if plain => self.select_tool(false),
            KeyCode::Char('v') if plain => return self.open_receipt(),
            KeyCode::Enter if self.selected.is_some() && key.modifiers.is_empty() => {
                return self.open_detail();
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll_back = self.scroll_back.saturating_add(1)
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.scroll_back = self.scroll_back.saturating_sub(1)
            }
            KeyCode::Home | KeyCode::Char('g') => self.scroll_back = usize::MAX,
            KeyCode::End | KeyCode::Char('G') => self.scroll_back = 0,
            KeyCode::Enter => {
                self.focus = Focus::Composer;
                self.selected = None;
            }
            KeyCode::Char(_) if plain => {
                self.focus = Focus::Composer;
                self.selected = None;
                return self.on_composer_key(key);
            }
            _ => {}
        }
        None
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Option<Action> {
        self.on_key_at(key, Instant::now())
    }

    pub fn on_key_at(&mut self, mut key: KeyEvent, now: Instant) -> Option<Action> {
        // Terminals with `stty erase ^H` send 0x08 for Backspace, which crossterm reports as ctrl+h.
        if key.code == KeyCode::Char('h') && key.modifiers.contains(KeyModifiers::CONTROL) {
            key.code = KeyCode::Backspace;
            key.modifiers.remove(KeyModifiers::CONTROL);
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if matches!(self.link, Link::Crashed { .. }) {
            return match key.code {
                KeyCode::Char('r') if !ctrl => Some(Action::Restart),
                KeyCode::Char('q') | KeyCode::Esc => Some(Action::Quit),
                KeyCode::Char('c') if ctrl => Some(Action::Quit),
                _ => None,
            };
        }
        if key.code == KeyCode::Char('c') && ctrl {
            return self.on_ctrl_c();
        }
        match self.overlay {
            Some(Overlay::Approval(_)) => return self.on_approval_key(key, now),
            Some(Overlay::Models(_)) => return self.on_models_key(key),
            Some(Overlay::Connect(_)) => return self.on_connect_key(key),
            Some(Overlay::Help { .. } | Overlay::Detail(_) | Overlay::Receipt(_) | Overlay::Paste { .. }) => {
                if matches!(self.overlay, Some(Overlay::Paste { .. })) && key.code == KeyCode::Char('x') && ctrl {
                    self.overlay = None;
                    self.composer.expand_paste_at_cursor();
                    return None;
                }
                self.on_help_key(key);
                return None;
            }
            None => {}
        }
        if let Some(action) = self.on_completion_key(key) {
            return action;
        }
        let page = Self::page(self.layout.transcript_rows);
        match key.code {
            KeyCode::Tab => {
                self.focus = match self.focus {
                    Focus::Composer => Focus::Transcript,
                    Focus::Transcript => Focus::Composer,
                };
                self.selected = None;
                None
            }
            KeyCode::PageUp => {
                self.scroll_back = self.scroll_back.saturating_add(page);
                None
            }
            KeyCode::PageDown => {
                self.scroll_back = self.scroll_back.saturating_sub(page);
                None
            }
            KeyCode::Esc if self.focus == Focus::Transcript => {
                if self.selected.take().is_none() {
                    self.focus = Focus::Composer;
                }
                None
            }
            KeyCode::Esc if self.session.busy => Some(Action::Send(Command::Cancel)),
            KeyCode::Esc => None,
            _ if self.focus == Focus::Transcript => self.on_transcript_key(key),
            KeyCode::Char('?') if !ctrl && self.composer.is_empty() => {
                self.overlay = Some(Overlay::Help { scroll: 0 });
                None
            }
            _ => self.on_composer_key(key),
        }
    }

    fn on_ctrl_c(&mut self) -> Option<Action> {
        match &self.overlay {
            Some(Overlay::Connect(Connect { step: Step::Waiting { request, auth: Some(_), .. }, .. })) => {
                let id = request.clone();
                self.overlay = None;
                return Some(Action::Send(Command::ProviderCancel { id }));
            }
            Some(
                Overlay::Help { .. }
                | Overlay::Detail(_)
                | Overlay::Receipt(_)
                | Overlay::Models(_)
                | Overlay::Connect(_)
                | Overlay::Paste { .. },
            ) => {
                self.overlay = None;
                return None;
            }
            // Cancelling the turn settles the pending approval on the sidecar; the turn result reports it.
            Some(Overlay::Approval(_)) => self.overlay = None,
            None => {}
        }
        if self.session.busy && self.cancel_requested {
            Some(Action::Quit)
        } else if self.session.busy {
            self.cancel_requested = true;
            Some(Action::Send(Command::Cancel))
        } else if !self.composer.is_empty() {
            self.composer.clear();
            None
        } else {
            Some(Action::Quit)
        }
    }

    /// Readline-style editing: ctrl+a/e/u/k/w/l, alt+b/f, arrows, home/end, word jumps and word delete.
    fn on_composer_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        self.slash_pick = 0;
        // Up/Down walk lines or recalled prompts; a recalled `/diff` must not open the list and take the next Up.
        self.slash_dismissed = matches!(key.code, KeyCode::Up | KeyCode::Down);
        if key.code == KeyCode::Enter && !alt && !shift {
            return self.submit();
        }
        let composer = &mut self.composer;
        match key.code {
            KeyCode::Enter => composer.insert("\n"),
            KeyCode::Backspace if ctrl || alt => composer.delete_word_back(),
            KeyCode::Backspace => composer.backspace(),
            KeyCode::Delete => composer.delete(),
            KeyCode::Left if ctrl || alt => composer.word_left(),
            KeyCode::Right if ctrl || alt => composer.word_right(),
            KeyCode::Left => composer.left(),
            KeyCode::Right => composer.right(),
            KeyCode::Home => composer.line_start(),
            KeyCode::End => composer.line_end(),
            KeyCode::Up => composer.up(),
            KeyCode::Down => composer.down(),
            KeyCode::Char('a') if ctrl => composer.line_start(),
            KeyCode::Char('e') if ctrl => composer.line_end(),
            KeyCode::Char('u') if ctrl => composer.kill_to_line_start(),
            KeyCode::Char('k') if ctrl => composer.kill_to_line_end(),
            KeyCode::Char('w') if ctrl => composer.delete_word_back(),
            KeyCode::Char('l') if ctrl => composer.clear(),
            KeyCode::Char('o') if ctrl => {
                if let Some(paste) = composer.paste_at_cursor() {
                    self.overlay = Some(Overlay::Paste { number: paste.number, scroll: 0 });
                }
            }
            KeyCode::Char('x') if ctrl => {
                composer.expand_paste_at_cursor();
            }
            KeyCode::Char('b') if alt => composer.word_left(),
            KeyCode::Char('f') if alt => composer.word_right(),
            KeyCode::Char(c) if !ctrl && !alt => composer.insert(c.encode_utf8(&mut [0; 4])),
            _ => {}
        }
        None
    }

    fn submit(&mut self) -> Option<Action> {
        if self.link != Link::Ready || self.connecting() || self.composer.expand(self.composer.text()).trim().is_empty() {
            return None;
        }
        // Slash commands are read from the draft as typed: a paste buffer is data, never a command name.
        let raw = self.composer.text().to_string();
        let display = self.composer.display(&raw);
        let invocation = slash::parse(&raw).map(|invocation| match invocation {
            Invocation::Remote { command, args } => Invocation::Remote {
                command,
                args: self.composer.expand(&args),
            },
            other => other,
        });
        if self.session.busy {
            return self.submit_while_busy(display, invocation);
        }
        let text = self.composer.take();
        self.scroll_back = 0;
        self.focus = Focus::Composer;
        if let Some(invocation) = invocation {
            return self.invoke(display, invocation);
        }
        self.turn_seq += 1;
        self.transcript.push(Entry::User(display));
        self.session.busy = true;
        self.turn_started = Some(Instant::now());
        self.activity = None;
        let id = format!("t{}", self.turn_seq);
        self.pending = Some(id.clone());
        Some(Action::Send(Command::PromptSubmit { id, text }))
    }

    /// Enter while the agent works: text becomes steering; read-only commands that are safe during a turn run;
    /// anything else stays in the draft with an explanation.
    fn submit_while_busy(&mut self, display: String, invocation: Option<Invocation>) -> Option<Action> {
        match invocation {
            None => {}
            Some(Invocation::Help) => {
                self.composer.take();
                self.overlay = Some(Overlay::Help { scroll: 0 });
                return None;
            }
            Some(Invocation::Receipt) => {
                self.composer.take();
                return self.open_receipt();
            }
            Some(Invocation::Quit) => return Some(Action::Quit),
            Some(Invocation::Remote { command, args }) if command == "doctor" && !args.split_whitespace().any(|a| a == "--fix") => {
                self.composer.take();
                self.slash_seq += 1;
                let id = format!("s{}", self.slash_seq);
                self.transcript.push(Entry::Command(display));
                return Some(Action::Send(Command::Slash { id, command, args }));
            }
            Some(_) => {
                self.transcript.push(Entry::Notice(
                    "Commands run when the agent is idle (esc cancels the turn). Text without a leading / is sent as steering.".into(),
                ));
                return None;
            }
        }
        let text = self.composer.take();
        self.scroll_back = 0;
        self.focus = Focus::Composer;
        self.steer_seq += 1;
        let id = format!("g{}{}", steer_prefix(), self.steer_seq);
        self.steer_texts.insert(id.clone(), text.clone());
        self.transcript.push(Entry::Steer {
            id: id.clone(),
            text: display,
            state: SteerState::Sending,
            message: String::new(),
        });
        Some(Action::Send(Command::Steer { id, text }))
    }

    fn invoke(&mut self, typed: String, invocation: Invocation) -> Option<Action> {
        match invocation {
            Invocation::Quit => Some(Action::Quit),
            Invocation::Help => {
                self.overlay = Some(Overlay::Help { scroll: 0 });
                None
            }
            Invocation::Receipt => self.open_receipt(),
            Invocation::Models => self.open_models(false, None),
            Invocation::Connect => self.open_models(true, None),
            Invocation::Remote { command, args } => {
                self.slash_seq += 1;
                let id = format!("s{}", self.slash_seq);
                self.transcript.push(Entry::Command(typed));
                self.session.busy = true;
                self.pending = Some(id.clone());
                Some(Action::Send(Command::Slash { id, command, args }))
            }
        }
    }

    /// Slash commands matching the draft while it is a bare `/word` with the cursor at its end, and the
    /// highlighted row. Hidden while the agent is busy, so Esc cancels the turn and Enter cannot run a pick.
    pub fn completion(&self) -> Option<(Vec<&SlashSpec>, usize)> {
        if self.slash_dismissed
            || self.link != Link::Ready
            || self.closing
            || self.session.busy
            || self.overlay.is_some()
            || self.focus != Focus::Composer
            || !self.composer.at_end()
        {
            return None;
        }
        let found = slash::matches(&self.commands, self.composer.text());
        if found.is_empty() {
            return None;
        }
        let pick = self.slash_pick.min(found.len() - 1);
        Some((found, pick))
    }

    /// Keys the completion list takes while it is shown. `None` lets the key through to the composer.
    fn on_completion_key(&mut self, key: KeyEvent) -> Option<Option<Action>> {
        let (count, pick, chosen) = {
            let (found, pick) = self.completion()?;
            (found.len(), pick, found[pick].clone())
        };
        match key.code {
            KeyCode::Up => self.slash_pick = (pick + count - 1) % count,
            KeyCode::Down => self.slash_pick = (pick + 1) % count,
            KeyCode::Esc => self.slash_dismissed = true,
            KeyCode::Tab => self.complete(&chosen.name),
            KeyCode::Enter if key.modifiers.is_empty() => {
                self.complete(&chosen.name);
                if slash::needs_args(&chosen.usage) {
                    return Some(None);
                }
                return Some(self.submit());
            }
            _ => return None,
        }
        Some(None)
    }

    fn complete(&mut self, name: &str) {
        self.composer.clear();
        self.composer.insert(&format!("/{name} "));
    }

    /// Moves the tool selection one call older or newer; the first press selects the newest call.
    fn select_tool(&mut self, older: bool) {
        let tools: Vec<usize> = self
            .transcript
            .iter()
            .enumerate()
            .filter(|(_, entry)| matches!(entry, Entry::Tool { .. } | Entry::Diff { .. }))
            .map(|(index, _)| index)
            .collect();
        let Some(&newest) = tools.last() else {
            return;
        };
        self.selected = Some(match self.selected.filter(|index| tools.contains(index)) {
            None => newest,
            Some(current) if older => tools
                .iter()
                .rev()
                .copied()
                .find(|&index| index < current)
                .unwrap_or(current),
            Some(current) => tools
                .iter()
                .copied()
                .find(|&index| index > current)
                .unwrap_or(current),
        });
        self.follow = true;
    }

    fn open_detail(&mut self) -> Option<Action> {
        if self.link != Link::Ready {
            return None;
        }
        let found = self
            .selected
            .and_then(|index| match self.transcript.get(index) {
                Some(Entry::Tool {
                    tool,
                    subject,
                    evidence,
                    ..
                }) => Some((tool.clone(), subject.clone(), evidence.clone())),
                Some(Entry::Diff { path, evidence, .. }) => Some(("edit_file".to_string(), path.clone(), evidence.clone())),
                _ => None,
            });
        let Some((tool, subject, evidence)) = found else {
            self.selected = None;
            return None;
        };
        if evidence.is_empty() {
            self.transcript.push(Entry::Info(
                "This tool call has no recorded details.".into(),
            ));
            return None;
        }
        self.panel_seq += 1;
        let request = format!("d{}", self.panel_seq);
        self.overlay = Some(Overlay::Detail(Detail {
            request: request.clone(),
            tool,
            subject,
            record: Loaded::Waiting,
            scroll: 0,
        }));
        Some(Action::Send(Command::ToolDetail {
            id: request,
            evidence,
        }))
    }

    fn open_receipt(&mut self) -> Option<Action> {
        if self.link != Link::Ready {
            return None;
        }
        self.panel_seq += 1;
        let request = format!("r{}", self.panel_seq);
        self.overlay = Some(Overlay::Receipt(ReceiptPanel {
            request: request.clone(),
            sections: Loaded::Waiting,
            scroll: 0,
        }));
        Some(Action::Send(Command::Receipt { id: request }))
    }

    /// Whether `id` names a detail or receipt request this client sent, open or not.
    fn issued_panel(&self, id: &str) -> bool {
        id.strip_prefix(['d', 'r', 'm', 'c', 'x'])
            .and_then(|n| n.parse::<u64>().ok())
            .is_some_and(|n| (1..=self.panel_seq).contains(&n))
    }

    /// Request id of the open detail or receipt panel while it waits for its answer.
    fn waiting_panel(&self) -> Option<&str> {
        match &self.overlay {
            Some(Overlay::Detail(Detail {
                request,
                record: Loaded::Waiting,
                ..
            }))
            | Some(Overlay::Receipt(ReceiptPanel {
                request,
                sections: Loaded::Waiting,
                ..
            }))
            | Some(Overlay::Models(Picker {
                request,
                catalog: Fetch::Waiting,
                ..
            })) => Some(request.as_str()),
            Some(Overlay::Connect(Connect {
                step: Step::Waiting { request, .. },
                ..
            })) => Some(request.as_str()),
            _ => None,
        }
    }

    fn interrupt_running_tools(&mut self) {
        for entry in &mut self.transcript {
            if let Entry::Tool { status, .. } = entry
                && *status == ToolStatus::Running
            {
                *status = ToolStatus::Interrupted;
            }
        }
    }
}

/// Prefix that makes steering ids unique across TUI processes: a resumed session keeps the ids it already applied,
/// so a new `g1` must not look like a resend of an old one. Tests use bare ids.
fn steer_prefix() -> String {
    if cfg!(test) {
        return String::new();
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    static PREFIX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PREFIX
        .get_or_init(|| format!("{:x}{:x}-", std::process::id(), nanos % 0xffff_ffff))
        .clone()
}

/// One line on where the operator's objective stands, when the turn reports open requirements or a failed check.
pub fn objective_note(turn: &Value) -> Option<String> {
    let objective = turn.get("objective")?;
    let status = objective["status"].as_str()?;
    if status == "completed" {
        return None;
    }
    let mut parts = vec![format!("Objective {status}")];
    if let Some(remaining) = objective["remaining"].as_array().filter(|items| !items.is_empty()) {
        let ids: Vec<String> = remaining
            .iter()
            .filter_map(Value::as_str)
            .map(|item| item.split_whitespace().take(2).collect::<Vec<_>>().join(" "))
            .collect();
        parts.push(format!("remaining: {}", ids.join(", ")));
    }
    if let Some(check) = objective["failedCheck"].as_str() {
        parts.push(format!("failed check: {check}"));
    }
    if let Some(next) = objective["nextAction"].as_str() {
        parts.push(format!("next: {next}"));
    }
    Some(parts.join(" · "))
}

/// Same projection as `TerminalUI.turnSummary` in `cli/src/ui.ts`.
pub fn tone_for(turn: &Value) -> Tone {
    match (turn["execution"].as_str(), turn["outcome"].as_str()) {
        (Some("COMPLETED"), Some("VERIFIED" | "NOT_REQUIRED")) => Tone::Good,
        (Some("COMPLETED"), _) => Tone::Caution,
        _ => Tone::Bad,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Review;
    use crate::protocol::parse_event;
    use crate::review::{LineKind, review_lines};

    fn ev(json: &str) -> Event {
        parse_event(json).unwrap()
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    fn ready() -> LiveState {
        let mut state = LiveState::new();
        state.apply(ev(r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#));
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":{"branch":"main","dirty":0},"busy":false}"#));
        state
    }

    fn type_text(state: &mut LiveState, text: &str) {
        for c in text.chars() {
            assert_eq!(state.on_key(key(KeyCode::Char(c))), None);
        }
    }

    fn with(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn busy() -> LiveState {
        let mut state = ready();
        type_text(&mut state, "long task");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":true}"#));
        state
    }

    fn steer_state(state: &LiveState, wanted: &str) -> Option<SteerState> {
        state.transcript.iter().find_map(|e| match e {
            Entry::Steer { id, state, .. } if id == wanted => Some(*state),
            _ => None,
        })
    }

    #[test]
    fn steering_is_sent_while_busy_and_follows_its_acknowledgements() {
        let mut state = busy();
        type_text(&mut state, "use tabs");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Steer { id: "g1".into(), text: "use tabs".into() }))
        );
        assert_eq!(steer_state(&state, "g1"), Some(SteerState::Sending));
        state.apply(ev(r#"{"v":1,"type":"steer.ack","id":"g1","status":"queued","message":"Steering queued"}"#));
        assert_eq!(steer_state(&state, "g1"), Some(SteerState::Queued));
        state.apply(ev(r#"{"v":1,"type":"steer.ack","id":"g1","status":"applied","message":"Applied at step 4."}"#));
        assert_eq!(steer_state(&state, "g1"), Some(SteerState::Applied));
        assert!(state.composer.is_empty(), "applied steering is not given back");
    }

    #[test]
    fn cancelled_or_rejected_steering_returns_to_the_composer() {
        let mut state = busy();
        type_text(&mut state, "stop and summarise");
        state.on_key(key(KeyCode::Enter));
        state.apply(ev(r#"{"v":1,"type":"steer.ack","id":"g1","status":"cancelled","message":"Not applied","text":"stop and summarise"}"#));
        assert_eq!(steer_state(&state, "g1"), Some(SteerState::Cancelled));
        assert_eq!(state.composer.expand(state.composer.text()), "stop and summarise");
        state.composer.clear();
        state.on_paste("line one\nline two");
        state.on_key(key(KeyCode::Enter));
        state.apply(ev(r#"{"v":1,"type":"steer.ack","id":"g2","status":"rejected","message":"/test is running"}"#));
        assert_eq!(state.composer.expand(state.composer.text()), "line one\nline two", "text kept by the client when the ack carries none");
    }

    #[test]
    fn steering_the_sidecar_never_acknowledged_returns_when_it_crashes() {
        let mut state = busy();
        type_text(&mut state, "add tests too");
        state.on_key(key(KeyCode::Enter));
        state.fail("The agent sidecar exited unexpectedly.".into(), Some(1), Vec::new());
        assert_eq!(steer_state(&state, "g1"), Some(SteerState::Lost));
        assert_eq!(state.composer.text(), "add tests too");
    }

    #[test]
    fn read_only_doctor_runs_while_busy_but_doctor_fix_waits() {
        let mut state = busy();
        type_text(&mut state, "/doctor");
        assert!(matches!(state.on_key(key(KeyCode::Enter)), Some(Action::Send(Command::Slash { ref command, .. })) if command == "doctor"));
        type_text(&mut state, "/doctor --fix");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "/doctor --fix");
    }

    #[test]
    fn a_pasted_slash_command_is_data_not_a_command() {
        let mut state = ready();
        state.on_paste("/exit\nand then fix the bug");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit { id: "t1".into(), text: "/exit\nand then fix the bug".into() }))
        );
        assert_eq!(state.transcript.last(), Some(&Entry::User("[Pasted text #1: 2 lines]".into())));
    }

    #[test]
    fn ctrl_o_opens_the_paste_and_ctrl_x_there_makes_it_editable() {
        let mut state = ready();
        state.on_paste("a\nb");
        assert_eq!(state.on_key(ctrl('o')), None);
        assert_eq!(state.overlay, Some(Overlay::Paste { number: 1, scroll: 0 }));
        assert_eq!(state.on_key(ctrl('x')), None);
        assert_eq!(state.overlay, None);
        assert_eq!(state.composer, "a\nb");
    }

    #[test]
    fn activity_tracks_phases_and_clears_on_result_or_idle() {
        let mut state = busy();
        assert!(state.turn_started.is_some() && state.animating());
        state.apply(ev(r#"{"v":1,"type":"activity","turn_id":"t1","phase":"tool","step":31,"segment":2,"tool":"run_command","subject":"make test"}"#));
        let first = state.activity.clone().unwrap();
        assert_eq!((first.step, first.segment, first.tool.as_deref()), (31, 2, Some("run_command")));
        state.apply(ev(r#"{"v":1,"type":"activity","turn_id":"t1","phase":"tool","step":31,"segment":2,"tool":"run_command","subject":"make test"}"#));
        assert_eq!(state.activity.as_ref().unwrap().since, first.since, "the same phase keeps its start time");
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"H","line":"L","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":null}"#));
        assert!(state.activity.is_none());
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert!(state.turn_started.is_none() && !state.animating());
    }

    #[test]
    fn a_file_diff_lands_in_the_transcript_and_is_selectable_for_its_full_record() {
        let mut state = busy();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"c1","tool":"edit_file","subject":"a.ts","evidence":"e1"}"#));
        state.apply(ev(r#"{"v":1,"type":"file.diff","turn_id":"t1","call_id":"c1","evidence":"e1","path":"a.ts","kind":"modified","added":1,"removed":1,"preview":"--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b","truncated":true,"total_lines":90}"#));
        assert!(matches!(state.transcript.last(), Some(Entry::Diff { added: 1, removed: 1, truncated: true, .. })));
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert!(matches!(state.on_key(key(KeyCode::Enter)), Some(Action::Send(Command::ToolDetail { ref evidence, .. })) if evidence == "e1"));
    }

    #[test]
    fn open_requirements_from_the_turn_are_reported_under_the_banner() {
        let mut state = busy();
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - REQUIREMENTS OPEN","line":"L","turn":{"execution":"COMPLETED","outcome":"NOT_ESTABLISHED","objective":{"status":"incomplete","remaining":["R2 [open] Reject negatives"],"failedCheck":"not ok 3","nextAction":"Fix R2"}},"model_summary":null}"#));
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info("Objective incomplete · remaining: R2 [open] · failed check: not ok 3 · next: Fix R2".into()))
        );
    }

    #[test]
    fn editing_keys_edit_at_the_cursor() {
        let mut state = ready();
        type_text(&mut state, "fix bug");
        for _ in 0..3 {
            assert_eq!(state.on_key(key(KeyCode::Left)), None);
        }
        type_text(&mut state, "the ");
        assert_eq!(state.composer, "fix the bug");
        assert_eq!(state.on_key(ctrl('e')), None);
        assert_eq!(state.on_key(ctrl('w')), None);
        assert_eq!(state.composer, "fix the ");
        assert_eq!(
            state.on_key(with(KeyCode::Left, KeyModifiers::CONTROL)),
            None
        );
        assert_eq!(state.on_key(ctrl('k')), None);
        assert_eq!(state.composer, "fix ");
        assert_eq!(
            state.on_key(with(KeyCode::Backspace, KeyModifiers::ALT)),
            None
        );
        assert_eq!(state.composer, "");
    }

    #[test]
    fn ctrl_h_from_a_terminal_whose_backspace_sends_bs_deletes_like_backspace() {
        let mut state = ready();
        type_text(&mut state, "fix the bug 👍🏽");
        assert_eq!(state.on_key(ctrl('h')), None);
        assert_eq!(state.composer, "fix the bug ");
        state.on_key(key(KeyCode::Left));
        state.on_key(ctrl('h'));
        assert_eq!(state.composer, "fix the bu ");
        state.on_key(with(
            KeyCode::Char('h'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ));
        assert_eq!(state.composer, "fix the  ");
        state.composer.clear();
        state.apply(hello_with(&[("diff", "/diff")]));
        type_text(&mut state, "/di");
        assert!(state.completion().is_some());
        state.on_key(ctrl('h'));
        assert_eq!(state.composer, "/d");
    }

    #[test]
    fn up_recalls_the_previous_prompt_after_a_turn() {
        let mut state = ready();
        type_text(&mut state, "first");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert_eq!(state.on_key(key(KeyCode::Up)), None);
        assert_eq!(state.composer, "first");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t2".into(),
                text: "first".into()
            }))
        );
    }

    #[test]
    fn paste_inserts_at_the_cursor_and_typing_while_busy_keeps_a_draft() {
        let mut state = ready();
        type_text(&mut state, "ab");
        assert_eq!(state.on_key(key(KeyCode::Left)), None);
        state.on_paste("X\r\nY");
        // A multi-line paste is one buffer in the draft; its exact content is what gets submitted.
        assert_eq!(state.composer.expand(state.composer.text()), "aX\nYb");
        assert_eq!(state.composer.display(state.composer.text()), "a[Pasted text #1: 2 lines]b");
        state.session.busy = true;
        type_text(&mut state, "!");
        assert_eq!(state.composer.expand(state.composer.text()), "aX\nY!b");
        // Enter while the agent works sends the draft as steering (exactly as typed and pasted).
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Steer { id: "g1".into(), text: "aX\nY!b".into() }))
        );
        assert!(state.composer.is_empty());
    }

    #[test]
    fn session_state_fills_the_status_strip() {
        let state = ready();
        assert_eq!(state.link, Link::Ready);
        assert_eq!(
            state.session,
            Session {
                workspace_name: "app".into(),
                model: "m".into(),
                mode: "auto".into(),
                branch: Some("main".into()),
                dirty: 0,
                busy: false,
            }
        );
    }

    #[test]
    fn enter_submits_the_composer_with_increasing_turn_ids() {
        let mut state = ready();
        type_text(&mut state, "fix it");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t1".into(),
                text: "fix it".into()
            }))
        );
        assert_eq!(state.composer, "");
        assert_eq!(state.transcript, vec![Entry::User("fix it".into())]);
        assert!(state.session.busy);
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert_eq!(state.session.branch, None);
        type_text(&mut state, "again");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t2".into(),
                text: "again".into()
            }))
        );
    }

    #[test]
    fn enter_does_nothing_while_connecting_or_empty_and_steers_while_busy() {
        let mut connecting = LiveState::new();
        type_text(&mut connecting, "x");
        assert_eq!(connecting.on_key(key(KeyCode::Enter)), None);
        let mut state = ready();
        type_text(&mut state, "   ");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        state.composer = "work".into();
        state.session.busy = true;
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Steer { id: "g1".into(), text: "work".into() }))
        );
        // A command other than a read-only one stays in the draft while busy, with an explanation.
        state.composer = "/undo".into();
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "/undo");
        assert!(matches!(state.transcript.last(), Some(Entry::Notice(text)) if text.contains("sent as steering")));
    }

    #[test]
    fn enter_does_nothing_between_hello_and_the_first_session_state() {
        let mut state = LiveState::new();
        state.apply(ev(r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#));
        assert!(state.connecting());
        type_text(&mut state, "early");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "early");
        assert!(state.transcript.is_empty());
        assert!(!ready().connecting());
    }

    #[test]
    fn a_busy_rejection_of_the_pending_prompt_keeps_the_composer_locked() {
        let mut state = ready();
        type_text(&mut state, "fix it");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"error","id":"t1","code":"BUSY","message":"A turn is already running; cancel it or wait for its result."}"#));
        assert!(state.session.busy, "the sidecar is still running a turn");
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Notice(
                "BUSY: A turn is already running; cancel it or wait for its result.".into()
            ))
        );
        // The composer stays usable: the next Enter is steering for the running turn, not a second prompt.
        type_text(&mut state, "again");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Steer { id: "g1".into(), text: "again".into() }))
        );
    }

    #[test]
    fn pasted_blocks_and_alt_enter_keep_newlines_in_one_prompt() {
        let mut state = ready();
        state.on_paste("line one\r\nline two");
        assert_eq!(
            state.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)),
            None
        );
        type_text(&mut state, "three");
        assert_eq!(state.on_key(key(KeyCode::Backspace)), None);
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t1".into(),
                text: "line one\nline two\nthre".into()
            }))
        );
    }

    #[test]
    fn ctrl_c_cancels_when_busy_clears_a_draft_and_quits_when_idle() {
        let mut state = ready();
        state.session.busy = true;
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        assert_eq!(
            state.on_key(key(KeyCode::Esc)),
            Some(Action::Send(Command::Cancel))
        );
        state.session.busy = false;
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        type_text(&mut state, "draft");
        assert_eq!(state.on_key(ctrl('l')), None);
        assert_eq!(state.composer, "");
        type_text(&mut state, "draft");
        assert_eq!(state.on_key(ctrl('c')), None);
        assert_eq!(state.composer, "");
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Quit));
    }

    #[test]
    fn a_second_ctrl_c_while_busy_force_quits_but_esc_only_cancels() {
        let mut state = ready();
        type_text(&mut state, "fix it");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        assert_eq!(
            state.on_key(key(KeyCode::Esc)),
            Some(Action::Send(Command::Cancel))
        );
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        assert!(state.cancel_requested());
        assert_eq!(
            state.on_key(key(KeyCode::Esc)),
            Some(Action::Send(Command::Cancel))
        );
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Quit));
    }

    #[test]
    fn the_force_quit_arms_again_only_after_the_turn_ends() {
        let busy = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":true}"#;
        let idle = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#;
        let mut state = ready();
        state.apply(ev(busy));
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#));
        assert!(!state.cancel_requested());
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        state.apply(ev(idle));
        assert!(!state.cancel_requested());
        state.apply(ev(busy));
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        state.fail("gone".into(), None, Vec::new());
        assert!(!state.cancel_requested());
        state.restarted();
        state.apply(ev(busy));
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
    }

    #[test]
    fn streamed_text_groups_by_turn_and_tools_pair_by_call_id() {
        let mut state = ready();
        for line in [
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Let me "}"#,
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"look."}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"a.ts"}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"b","tool":"read_file","subject":"b.ts"}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"b","tool":"read_file","success":false,"summary":"No such file","lines":1}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"const a = 1;","lines":1}"#,
            r#"{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Done."}"#,
        ] {
            state.apply(ev(line));
        }
        assert_eq!(
            state.transcript,
            vec![
                Entry::Assistant {
                    turn_id: "t1".into(),
                    text: "Let me look.".into()
                },
                Entry::Tool {
                    call_id: "a".into(),
                    tool: "read_file".into(),
                    subject: "a.ts".into(),
                    status: ToolStatus::Succeeded,
                    summary: "const a = 1;".into(),
                    evidence: String::new(),
                },
                Entry::Tool {
                    call_id: "b".into(),
                    tool: "read_file".into(),
                    subject: "b.ts".into(),
                    status: ToolStatus::Failed,
                    summary: "No such file".into(),
                    evidence: String::new(),
                },
                Entry::Assistant {
                    turn_id: "t1".into(),
                    text: "Done.".into()
                },
            ]
        );
    }

    #[test]
    fn a_reused_call_id_does_not_rewrite_a_finished_tool() {
        let mut state = ready();
        for line in [
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"call_0","tool":"run_command","subject":"npm test"}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"call_0","tool":"run_command","success":false,"summary":"1 test failed","lines":1}"#,
            r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"call_0","tool":"task_completed","subject":""}"#,
            r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"call_0","tool":"task_completed","success":true,"summary":"Completed","lines":0}"#,
        ] {
            state.apply(ev(line));
        }
        assert_eq!(
            state.transcript,
            vec![Entry::Tool {
                call_id: "call_0".into(),
                tool: "run_command".into(),
                subject: "npm test".into(),
                status: ToolStatus::Failed,
                summary: "1 test failed".into(),
                evidence: String::new(),
            }]
        );
    }

    #[test]
    fn a_hidden_tool_end_does_not_close_a_running_tool_with_the_same_call_id() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"call_0","tool":"run_command","subject":"npm test"}"#));
        state.apply(ev(r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"call_0","tool":"task_completed","success":true,"summary":"Completed","lines":0}"#));
        assert_eq!(
            state.transcript,
            vec![Entry::Tool {
                call_id: "call_0".into(),
                tool: "run_command".into(),
                subject: "npm test".into(),
                status: ToolStatus::Running,
                summary: String::new(),
                evidence: String::new(),
            }]
        );
    }

    #[test]
    fn task_completed_is_left_to_the_banner() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"z","tool":"task_completed","subject":""}"#));
        state.apply(ev(r#"{"v":1,"type":"tool.end","turn_id":"t1","call_id":"z","tool":"task_completed","success":true,"summary":"Completed","lines":0}"#));
        assert!(state.transcript.is_empty());
    }

    #[test]
    fn turn_result_projects_the_reported_outcome_and_closes_open_tools() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"run_command","subject":"npm test"}"#));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped by operator","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#));
        assert!(matches!(
            &state.transcript[0],
            Entry::Tool {
                status: ToolStatus::Interrupted,
                ..
            }
        ));
        assert_eq!(
            state.transcript[1],
            Entry::Banner {
                heading: "TURN INTERRUPTED".into(),
                line: "Stopped by operator".into(),
                tone: Tone::Bad,
                failure: None,
                summary: None,
                notes: None,
            }
        );
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t2","heading":"TURN COMPLETE - VERIFIED","line":"cargo test passed","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":{"summary":"Fixed the parser."}}"#));
        assert_eq!(
            state.transcript[2],
            Entry::Banner {
                heading: "TURN COMPLETE - VERIFIED".into(),
                line: "cargo test passed".into(),
                tone: Tone::Good,
                failure: None,
                summary: Some("Fixed the parser.".into()),
                notes: None,
            }
        );
        for (execution, outcome, tone) in [
            ("COMPLETED", "VERIFIED", Tone::Good),
            ("COMPLETED", "NOT_REQUIRED", Tone::Good),
            ("COMPLETED", "UNVERIFIED", Tone::Caution),
            ("COMPLETED", "NOT_ESTABLISHED", Tone::Caution),
            ("FAILED", "NOT_ESTABLISHED", Tone::Bad),
            ("BLOCKED", "NOT_ESTABLISHED", Tone::Bad),
            ("LIMIT_REACHED", "UNVERIFIED", Tone::Bad),
        ] {
            assert_eq!(
                tone_for(&serde_json::json!({"execution": execution, "outcome": outcome})),
                tone,
                "{execution}/{outcome}"
            );
        }
    }

    #[test]
    fn turn_result_carries_the_inference_failure_message() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN FAILED","line":"Inference failed","turn":{"execution":"FAILED","outcome":"NOT_ESTABLISHED","inferenceFailure":{"kind":"timeout","origin":"gateway","message":"upstream timed out after 60s"}},"model_summary":null}"#));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t2","heading":"TURN FAILED","line":"Stopped","turn":{"execution":"FAILED","outcome":"NOT_ESTABLISHED","inferenceFailure":null},"model_summary":null}"#));
        assert_eq!(
            state.transcript,
            vec![
                Entry::Banner {
                    heading: "TURN FAILED".into(),
                    line: "Inference failed".into(),
                    tone: Tone::Bad,
                    failure: Some("upstream timed out after 60s".into()),
                    summary: None,
                    notes: None,
                },
                Entry::Banner {
                    heading: "TURN FAILED".into(),
                    line: "Stopped".into(),
                    tone: Tone::Bad,
                    failure: None,
                    summary: None,
                    notes: None,
                },
            ]
        );
    }

    #[test]
    fn a_rejected_submit_unlocks_the_composer() {
        let mut state = ready();
        type_text(&mut state, "fix it");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t1".into(),
                text: "fix it".into()
            }))
        );
        state.apply(ev(r#"{"v":1,"type":"error","id":"approval-1","code":"NO_PENDING_APPROVAL","message":"No pending approval with id approval-1."}"#));
        state.apply(ev(
            r#"{"v":1,"type":"error","code":"BAD_REQUEST","message":"not JSON"}"#,
        ));
        assert!(
            state.session.busy,
            "an error for another request must not unlock a running turn"
        );
        state.apply(ev(r#"{"v":1,"type":"error","id":"t1","code":"BAD_REQUEST","message":"prompt.submit needs text"}"#));
        assert!(!state.session.busy);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Notice(
                "BAD_REQUEST: prompt.submit needs text".into()
            ))
        );
        state.apply(ev(
            r#"{"v":1,"type":"error","id":"t1","code":"BUSY","message":"late"}"#,
        ));
        type_text(&mut state, "again");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t2".into(),
                text: "again".into()
            }))
        );
        state.apply(ev(
            r#"{"v":1,"type":"error","id":"t1","code":"BUSY","message":"stale"}"#,
        ));
        assert!(
            state.session.busy,
            "an error for an earlier prompt must not unlock the current turn"
        );
    }

    #[test]
    fn errors_become_notices_and_approval_requests_open_the_review() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"error","id":"t9","code":"BUSY","message":"A turn is already running"}"#));
        state.apply(ev(r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#));
        assert_eq!(
            state.transcript,
            vec![Entry::Notice("BUSY: A turn is already running".into())]
        );
        let opened = opened_at(&state);
        assert_eq!(
            state.overlay,
            Some(Overlay::Approval(Approval {
                id: "approval-1".into(),
                tool: "write_file".into(),
                subject: "x.txt".into(),
                lines: review_lines(&Review::Unknown),
                scroll: 0,
                opened,
            }))
        );
    }

    const APPROVAL: &str = r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}","review":{"kind":"change","path":"x.txt","before":null,"after":"hi\n","created":true,"truncated":false}}"#;

    fn busy_with_approval() -> LiveState {
        let mut state = ready();
        type_text(&mut state, "make x");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(APPROVAL));
        state
    }

    fn opened_at(state: &LiveState) -> Instant {
        let Some(Overlay::Approval(approval)) = &state.overlay else {
            panic!("expected the approval modal");
        };
        approval.opened
    }

    fn past_grace(state: &mut LiveState, code: KeyCode) -> Option<Action> {
        let now = opened_at(state) + APPROVAL_GRACE;
        state.on_key_at(key(code), now)
    }

    #[test]
    fn a_decision_key_right_after_the_modal_opens_is_ignored() {
        let mut state = ready();
        type_text(&mut state, "make x");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        type_text(&mut state, "dra");
        state.apply(ev(APPROVAL));
        let opened = opened_at(&state);
        let transcript = state.transcript.clone();
        let almost = opened + APPROVAL_GRACE - Duration::from_millis(1);
        for (code, now) in [
            (KeyCode::Char('y'), opened),
            (KeyCode::Enter, opened),
            (KeyCode::Char('n'), opened),
            (KeyCode::Esc, opened),
            (KeyCode::Char('y'), almost),
        ] {
            assert_eq!(state.on_key_at(key(code), now), None, "{code:?}");
        }
        assert_eq!(state.transcript, transcript, "no decision is recorded");
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
        assert_eq!(state.composer, "dra", "ignored keys do not reach the draft");
    }

    #[test]
    fn a_decision_key_after_the_grace_approves() {
        let mut state = busy_with_approval();
        assert_eq!(
            past_grace(&mut state, KeyCode::Char('y')),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: false
            }))
        );
        assert_eq!(state.overlay, None);
        assert!(matches!(
            state.transcript.last(),
            Some(Entry::Decision {
                verdict: Verdict::Approved,
                ..
            })
        ));
    }

    #[test]
    fn always_right_after_the_modal_opens_is_ignored() {
        let mut state = busy_with_approval();
        let opened = opened_at(&state);
        let transcript = state.transcript.clone();
        assert_eq!(state.on_key_at(key(KeyCode::Char('a')), opened), None);
        assert_eq!(state.transcript, transcript);
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
        assert_eq!(state.composer, "");
        assert_eq!(
            past_grace(&mut state, KeyCode::Char('a')),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: true
            }))
        );
    }

    #[test]
    fn ctrl_c_right_after_the_modal_opens_still_cancels() {
        let mut state = busy_with_approval();
        let opened = opened_at(&state);
        assert_eq!(
            state.on_key_at(ctrl('c'), opened),
            Some(Action::Send(Command::Cancel))
        );
        assert_eq!(state.overlay, None);
        assert!(state.cancel_requested());
    }

    #[test]
    fn a_paste_under_an_overlay_leaves_the_draft_alone() {
        let mut state = ready();
        type_text(&mut state, "make x");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        type_text(&mut state, "dra");
        state.apply(ev(APPROVAL));
        state.on_paste("ft");
        assert_eq!(state.composer, "dra");
        state.overlay = Some(Overlay::Help { scroll: 0 });
        state.on_paste("ft");
        assert_eq!(state.composer, "dra");
        state.overlay = None;
        state.on_paste("ft");
        assert_eq!(state.composer, "draft");
    }

    #[test]
    fn the_approval_modal_takes_keys_and_records_the_decision() {
        let mut state = busy_with_approval();
        let Some(Overlay::Approval(approval)) = &state.overlay else {
            panic!("expected the approval modal");
        };
        assert!(
            approval
                .lines
                .iter()
                .any(|line| line.kind == LineKind::Added && line.text == "+hi")
        );
        assert_eq!(state.on_key(key(KeyCode::Char('x'))), None);
        assert_eq!(state.composer, "", "keys go to the modal, not the composer");
        assert_eq!(
            past_grace(&mut state, KeyCode::Char('y')),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: false
            }))
        );
        assert_eq!(state.overlay, None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Decision {
                tool: "write_file".into(),
                subject: "x.txt".into(),
                verdict: Verdict::Approved
            })
        );
        state.apply(ev(APPROVAL));
        assert_eq!(
            past_grace(&mut state, KeyCode::Char('a')),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: true
            }))
        );
        state.apply(ev(APPROVAL));
        assert_eq!(
            past_grace(&mut state, KeyCode::Esc),
            Some(Action::Send(Command::Deny {
                id: "approval-1".into()
            }))
        );
        assert!(matches!(
            state.transcript.last(),
            Some(Entry::Decision {
                verdict: Verdict::Denied,
                ..
            })
        ));
    }

    #[test]
    fn ctrl_c_and_the_turn_result_close_a_pending_approval() {
        let mut state = busy_with_approval();
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        assert_eq!(state.overlay, None);
        state.apply(ev(APPROVAL));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#));
        assert_eq!(state.overlay, None);
        state.apply(ev(APPROVAL));
        state.fail("gone".into(), None, Vec::new());
        assert_eq!(state.overlay, None);
    }

    #[test]
    fn approval_scrolling_is_clamped_by_the_last_frame() {
        let mut state = busy_with_approval();
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 0,
            overlay_rows: 4,
            overlay_limit: 6,
            ..LiveLayout::default()
        });
        for code in [KeyCode::Down, KeyCode::Char('j'), KeyCode::PageDown] {
            assert_eq!(state.on_key(key(code)), None);
        }
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Approval(Approval { scroll: 5, .. }))
        ));
        assert_eq!(state.on_key(key(KeyCode::End)), None);
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 0,
            overlay_rows: 4,
            overlay_limit: 6,
            ..LiveLayout::default()
        });
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Approval(Approval { scroll: 6, .. }))
        ));
    }

    #[test]
    fn question_mark_opens_help_only_on_an_empty_composer() {
        let mut state = ready();
        assert_eq!(state.on_key(key(KeyCode::Char('?'))), None);
        assert_eq!(state.overlay, Some(Overlay::Help { scroll: 0 }));
        assert_eq!(state.on_key(key(KeyCode::Char('x'))), None);
        assert_eq!(state.composer, "");
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        assert_eq!(state.overlay, None);
        type_text(&mut state, "why?");
        assert_eq!(state.composer, "why?");
        assert_eq!(state.overlay, None);
        state.overlay = Some(Overlay::Help { scroll: 0 });
        state.apply(ev(APPROVAL));
        assert!(
            matches!(state.overlay, Some(Overlay::Approval(_))),
            "an approval replaces help"
        );
    }

    #[test]
    fn tab_switches_focus_and_the_transcript_scrolls() {
        let mut state = ready();
        let layout = LiveLayout {
            transcript_rows: 10,
            scroll_limit: 50,
            overlay_rows: 0,
            overlay_limit: 0,
            ..LiveLayout::default()
        };
        state.note_layout(layout);
        assert_eq!(state.on_key(key(KeyCode::PageUp)), None);
        assert_eq!(state.scroll_back, 9, "pgup scrolls from the composer too");
        assert_eq!(state.on_key(key(KeyCode::Tab)), None);
        assert_eq!(state.focus, Focus::Transcript);
        assert_eq!(state.on_key(key(KeyCode::Up)), None);
        assert_eq!(state.on_key(key(KeyCode::Char('k'))), None);
        assert_eq!(state.scroll_back, 11);
        assert_eq!(state.on_key(key(KeyCode::Down)), None);
        assert_eq!(state.scroll_back, 10);
        assert_eq!(state.on_key(key(KeyCode::Home)), None);
        state.note_layout(layout);
        assert_eq!(state.scroll_back, 50);
        assert_eq!(state.on_key(key(KeyCode::Char('G'))), None);
        assert_eq!(state.scroll_back, 0);
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        assert_eq!(state.focus, Focus::Composer);
        assert_eq!(state.on_key(key(KeyCode::Tab)), None);
        type_text(&mut state, "x");
        assert_eq!(
            state.focus,
            Focus::Composer,
            "typing returns to the composer"
        );
        assert_eq!(state.composer, "x");
    }

    #[test]
    fn submitting_returns_to_the_newest_line() {
        let mut state = ready();
        state.scroll_back = 7;
        state.focus = Focus::Transcript;
        assert_eq!(state.on_key(key(KeyCode::Char('h'))), None);
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        assert_eq!(state.scroll_back, 0);
    }

    #[test]
    fn model_notes_ride_along_with_the_summary() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"H","line":"L","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":{"summary":"Done.","notes":"Watch the cache."}}"#));
        assert!(matches!(
            state.transcript.last(),
            Some(Entry::Banner { summary: Some(summary), notes: Some(notes), .. })
                if summary == "Done." && notes == "Watch the cache."
        ));
    }

    #[test]
    fn a_failed_sidecar_offers_restart_and_quit_only() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"run_command","subject":"make"}"#));
        state.session.busy = true;
        state.fail(
            "The agent sidecar exited unexpectedly.".into(),
            Some(1),
            vec!["boom".into()],
        );
        assert!(!state.session.busy);
        assert!(matches!(
            &state.transcript[0],
            Entry::Tool {
                status: ToolStatus::Interrupted,
                ..
            }
        ));
        assert_eq!(
            state.link,
            Link::Crashed {
                code: Some(1),
                reason: "The agent sidecar exited unexpectedly.".into(),
                stderr: vec!["boom".into()]
            }
        );
        assert_eq!(state.on_key(key(KeyCode::Char('x'))), None);
        state.on_paste("ignored");
        assert_eq!(state.composer, "");
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert!(
            matches!(state.link, Link::Crashed { .. }),
            "a late event must not revive a crashed link"
        );
        assert_eq!(state.on_key(key(KeyCode::Char('r'))), Some(Action::Restart));
        assert_eq!(state.on_key(key(KeyCode::Char('q'))), Some(Action::Quit));
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Quit));
        state.restarted();
        assert_eq!(state.link, Link::Connecting);
        assert!(
            matches!(state.transcript.last(), Some(Entry::Notice(text)) if text.contains("does not remember"))
        );
    }

    #[test]
    fn a_protocol_mismatch_fails_the_link() {
        let mut state = LiveState::new();
        state.apply(Event::Hello {
            protocol: 2,
            commands: Vec::new(),
        });
        assert!(
            matches!(&state.link, Link::Crashed { reason, .. } if reason.contains("protocol 2"))
        );
    }

    const IDLE_STATE: &str = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#;

    fn hello_with(commands: &[(&str, &str)]) -> Event {
        Event::Hello {
            protocol: 1,
            commands: commands
                .iter()
                .map(|(name, usage)| SlashSpec {
                    name: (*name).into(),
                    usage: (*usage).into(),
                    summary: format!("{name} summary"),
                })
                .collect(),
        }
    }

    #[test]
    fn slash_commands_go_to_the_sidecar_and_results_land_in_the_transcript() {
        let mut state = ready();
        type_text(&mut state, "/diff");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s1".into(),
                command: "diff".into(),
                args: String::new()
            }))
        );
        assert_eq!(state.transcript, vec![Entry::Command("/diff".into())]);
        assert!(state.session.busy);
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s1","command":"diff","success":true,"output":"-a\n+b","format":"diff"}"#));
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Output {
                success: true,
                text: "-a\n+b".into(),
                diff: true
            })
        );
        assert_eq!(state.pending, None);
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "!ls -la");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s2".into(),
                command: "!".into(),
                args: "ls -la".into()
            }))
        );
    }

    #[test]
    fn local_commands_never_reach_the_sidecar() {
        let mut state = ready();
        type_text(&mut state, "/help");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.overlay, Some(Overlay::Help { scroll: 0 }));
        state.on_key(key(KeyCode::Esc));
        type_text(&mut state, "/receipt");
        assert!(matches!(state.on_key(key(KeyCode::Enter)), Some(Action::Send(Command::Receipt { .. }))));
        state.on_key(key(KeyCode::Esc));
        assert!(!state.session.busy);
        type_text(&mut state, "/etc/hosts is wrong");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t1".into(),
                text: "/etc/hosts is wrong".into()
            }))
        );
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/quit");
        assert_eq!(state.on_key(key(KeyCode::Enter)), Some(Action::Quit));
    }

    #[test]
    fn a_command_that_starts_a_turn_stays_pending_until_the_turn_result() {
        let mut state = ready();
        type_text(&mut state, "/history run 1");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s1".into(),
                command: "history".into(),
                args: "run 1".into()
            }))
        );
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s1","command":"history","success":true,"output":"","prompt":"fix it"}"#));
        assert_eq!(state.pending.as_deref(), Some("s1"));
        assert_eq!(
            state.transcript,
            vec![
                Entry::Command("/history run 1".into()),
                Entry::User("fix it".into())
            ]
        );
        state.apply(ev(
            r#"{"v":1,"type":"assistant.delta","turn_id":"s1","text":"On it."}"#,
        ));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"s1","heading":"TURN ENDED - NO CHANGES TO VERIFY","line":"No files changed","turn":{"execution":"COMPLETED","outcome":"NOT_REQUIRED"},"model_summary":null}"#));
        assert_eq!(state.pending, None);
        assert!(matches!(
            state.transcript.last(),
            Some(Entry::Banner { .. })
        ));
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/status");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(
            r#"{"v":1,"type":"error","id":"s2","code":"INTERNAL","message":"boom"}"#,
        ));
        assert!(
            !state.session.busy,
            "an error for the pending command unlocks the composer"
        );
    }

    #[test]
    fn clear_paste_and_notices_change_the_view() {
        let mut state = ready();
        state.transcript.push(Entry::User("old".into()));
        type_text(&mut state, "/clear");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s1","command":"clear","success":true,"output":"Conversation context reset."}"#));
        assert_eq!(
            state.transcript,
            vec![Entry::Output {
                success: true,
                text: "Conversation context reset.".into(),
                diff: false
            }]
        );
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/paste");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"slash.result","id":"s2","command":"paste","success":true,"output":"Pasted 11 characters into the composer.","composer":"pasted text"}"#));
        assert_eq!(state.composer, "pasted text");
        state.apply(ev(
            r#"{"v":1,"type":"notice","text":"Resumed session a (4 messages)."}"#,
        ));
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info("Resumed session a (4 messages).".into()))
        );
    }

    #[test]
    fn the_list_hides_while_busy_or_crashed_and_esc_still_cancels() {
        let mut state = ready();
        state.apply(hello_with(&[("clear", "/clear"), ("diff", "/diff")]));
        type_text(&mut state, "/c");
        assert!(state.completion().is_some());
        state.session.busy = true;
        assert!(state.completion().is_none());
        assert_eq!(
            state.on_key(key(KeyCode::Esc)),
            Some(Action::Send(Command::Cancel))
        );
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "/c");
        state.session.busy = false;
        state.closing = true;
        assert!(state.completion().is_none());
        state.closing = false;
        state.fail("gone".into(), None, Vec::new());
        assert!(state.completion().is_none());
    }

    #[test]
    fn completion_lists_matches_and_tab_or_enter_completes() {
        let mut state = ready();
        state.apply(hello_with(&[
            ("diff", "/diff"),
            ("help", "/help"),
            ("history", "/history [query|run <n>]"),
            ("tdd", "/tdd <issue>"),
        ]));
        let shown = |state: &LiveState| {
            state.completion().map(|(found, pick)| {
                (
                    found
                        .iter()
                        .map(|spec| spec.name.clone())
                        .collect::<Vec<_>>(),
                    pick,
                )
            })
        };
        type_text(&mut state, "/h");
        assert_eq!(
            shown(&state),
            Some((vec!["help".to_string(), "history".to_string()], 0))
        );
        state.on_key(key(KeyCode::Down));
        assert_eq!(shown(&state).unwrap().1, 1);
        state.on_key(key(KeyCode::Up));
        assert_eq!(shown(&state).unwrap().1, 0);
        assert_eq!(state.on_key(key(KeyCode::Tab)), None);
        assert_eq!(state.composer, "/help ");
        assert_eq!(shown(&state), None);
        assert_eq!(
            state.focus,
            Focus::Composer,
            "tab completed instead of switching focus"
        );
        state.on_key(ctrl('l'));
        type_text(&mut state, "/hi");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Slash {
                id: "s1".into(),
                command: "history".into(),
                args: String::new()
            }))
        );
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/td");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            None,
            "a command with a required argument waits for it"
        );
        assert_eq!(state.composer, "/tdd ");
        state.on_key(ctrl('l'));
        type_text(&mut state, "/d");
        state.on_key(key(KeyCode::Esc));
        assert_eq!(shown(&state), None);
        state.on_key(key(KeyCode::Backspace));
        assert_eq!(shown(&state).map(|(found, _)| found.len()), Some(4));
    }

    #[test]
    fn history_recall_walks_past_a_recalled_slash_command() {
        let mut state = ready();
        type_text(&mut state, "fix it");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(IDLE_STATE));
        type_text(&mut state, "/diff");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(IDLE_STATE));
        state.apply(hello_with(&[("diff", "/diff"), ("help", "/help")]));
        assert_eq!(state.on_key(key(KeyCode::Up)), None);
        assert_eq!(state.composer, "/diff");
        assert!(
            state.completion().is_none(),
            "a recalled command does not open the list"
        );
        assert_eq!(state.on_key(key(KeyCode::Up)), None);
        assert_eq!(state.composer, "fix it");
        assert_eq!(state.on_key(key(KeyCode::Down)), None);
        assert_eq!(state.on_key(key(KeyCode::Backspace)), None);
        assert!(state.completion().is_some(), "editing shows the list again");
    }

    fn tool_call(state: &mut LiveState, call: &str, evidence: &str) {
        state.apply(ev(&format!(
            r#"{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"{call}","tool":"read_file","subject":"{call}.ts","evidence":"{evidence}"}}"#
        )));
        state.apply(ev(&format!(
            r#"{{"v":1,"type":"tool.end","turn_id":"t1","call_id":"{call}","tool":"read_file","success":true,"summary":"ok","lines":1,"evidence":"{evidence}"}}"#
        )));
    }

    #[test]
    fn brackets_select_tool_calls_newest_first() {
        let mut state = ready();
        tool_call(&mut state, "a", "e1");
        state.transcript.push(Entry::Info("between".into()));
        tool_call(&mut state, "b", "e2");
        state.on_key(key(KeyCode::Tab));
        assert_eq!(state.selected, None);
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.selected, Some(2));
        assert!(state.follow);
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.selected, Some(0));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.selected, Some(0), "the oldest call stays selected");
        state.on_key(key(KeyCode::Char(']')));
        assert_eq!(state.selected, Some(2));
        state.on_key(key(KeyCode::Esc));
        assert_eq!((state.selected, state.focus), (None, Focus::Transcript));
        state.on_key(key(KeyCode::Esc));
        assert_eq!(state.focus, Focus::Composer);
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char(']')));
        assert_eq!(state.selected, Some(2));
        state.on_key(key(KeyCode::Tab));
        assert_eq!((state.selected, state.focus), (None, Focus::Composer));
    }

    #[test]
    fn enter_on_a_selected_tool_requests_its_detail_and_the_answer_fills_the_panel() {
        let mut state = ready();
        tool_call(&mut state, "a", "e7");
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::ToolDetail {
                id: "d1".into(),
                evidence: "e7".into()
            }))
        );
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { request, tool, subject, record: Loaded::Waiting, .. }))
                if request == "d1" && tool == "read_file" && subject == "a.ts"
        ));
        state.apply(ev(r#"{"v":1,"type":"tool.detail","id":"d0","evidence":"e7","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{}","output":"stale","duration_ms":1}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail {
                record: Loaded::Waiting,
                ..
            }))
        ));
        state.apply(ev(r#"{"v":1,"type":"tool.detail","id":"d1","evidence":"e7","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{\n  \"path\": \"a.ts\"\n}","output":"const a = 1;","duration_ms":12}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { record: Loaded::Ready(record), .. }))
                if record.output == "const a = 1;" && record.duration_ms == Some(12) && record.status == "succeeded"
        ));
        state.on_key(key(KeyCode::Esc));
        assert_eq!(state.overlay, None);
        assert_eq!(state.focus, Focus::Transcript);
    }

    #[test]
    fn a_tool_without_a_record_says_so_and_failed_requests_stay_in_the_panel() {
        let mut state = ready();
        tool_call(&mut state, "a", "");
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info(
                "This tool call has no recorded details.".into()
            ))
        );
        tool_call(&mut state, "b", "e9");
        state.on_key(key(KeyCode::Char(']')));
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        let before = state.transcript.len();
        state.apply(ev(r#"{"v":1,"type":"error","id":"d1","code":"NOT_FOUND","message":"No record of tool call e9."}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Detail(Detail { record: Loaded::Failed(message), .. }))
                if message == "NOT_FOUND: No record of tool call e9."
        ));
        assert_eq!(state.transcript.len(), before);
    }

    #[test]
    fn v_and_slash_receipt_open_the_receipt_panel() {
        let mut state = ready();
        state.on_key(key(KeyCode::Tab));
        assert_eq!(
            state.on_key(key(KeyCode::Char('v'))),
            Some(Action::Send(Command::Receipt { id: "r1".into() }))
        );
        state.apply(ev(r#"{"v":1,"type":"receipt","id":"r1","sections":[{"title":"Last turn","rows":[["outcome","VERIFIED"]]},{"title":"Validation receipt","rows":[],"note":"No validation receipt is active."}]}"#));
        assert!(matches!(
            &state.overlay,
            Some(Overlay::Receipt(ReceiptPanel { sections: Loaded::Ready(sections), .. }))
                if sections.len() == 2 && sections[0].rows == vec![("outcome".to_string(), "VERIFIED".to_string())]
        ));
        state.on_key(key(KeyCode::Esc));
        state.on_key(key(KeyCode::Esc));
        assert_eq!(state.focus, Focus::Composer);
        type_text(&mut state, "/receipt");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::Receipt { id: "r2".into() }))
        );
        assert!(!state.session.busy);
        assert!(state.transcript.is_empty());
    }

    #[test]
    fn ctrl_c_closes_a_panel_and_approvals_take_its_place() {
        let mut state = ready();
        state.on_key(key(KeyCode::Tab));
        assert!(state.on_key(key(KeyCode::Char('v'))).is_some());
        assert_eq!(state.on_key(ctrl('c')), None);
        assert_eq!(state.overlay, None);
        assert!(state.on_key(key(KeyCode::Char('v'))).is_some());
        state.apply(ev(r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#));
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
    }

    #[test]
    fn a_restarted_sidecar_is_never_asked_for_the_old_sidecars_records() {
        let mut state = ready();
        tool_call(&mut state, "a", "e3");
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.fail("exited".into(), Some(1), Vec::new());
        state.restarted();
        assert_eq!(state.overlay, None, "the old sidecar will never answer");
        assert_eq!(state.focus, Focus::Transcript);
        state.on_key(key(KeyCode::Char('[')));
        let before = state.transcript.len();
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            None,
            "nothing is sent before the new sidecar says hello"
        );
        assert_eq!(
            (state.overlay.is_none(), state.transcript.len()),
            (true, before)
        );
        state.apply(ev(r#"{"v":1,"type":"hello","protocol":1,"pid":2}"#));
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Info(
                "This tool call has no recorded details.".into()
            ))
        );
        tool_call(&mut state, "b", "e1");
        state.on_key(key(KeyCode::Char(']')));
        assert!(matches!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::ToolDetail { evidence, .. })) if evidence == "e1"
        ));
    }

    #[test]
    fn a_late_error_for_a_closed_panel_stays_out_of_the_transcript() {
        let mut state = ready();
        tool_call(&mut state, "a", "e1");
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.on_key(key(KeyCode::Esc));
        let before = state.transcript.len();
        state.apply(ev(r#"{"v":1,"type":"error","id":"d1","code":"NOT_FOUND","message":"No record of tool call e1."}"#));
        assert_eq!(state.transcript.len(), before);
        state.apply(ev(
            r#"{"v":1,"type":"error","id":"d9","code":"NOT_FOUND","message":"never asked"}"#,
        ));
        assert_eq!(state.transcript.len(), before + 1);
    }

    #[test]
    fn panel_keys_ignore_ctrl_and_alt_and_typing_drops_the_selection() {
        let mut state = ready();
        tool_call(&mut state, "a", "e1");
        state.on_key(key(KeyCode::Tab));
        assert_eq!(state.on_key(ctrl('v')), None);
        assert_eq!(
            state.on_key(with(KeyCode::Char('['), KeyModifiers::ALT)),
            None
        );
        assert_eq!((state.overlay.is_none(), state.selected), (true, None));
        state.on_key(key(KeyCode::Char('[')));
        assert_eq!(state.on_key(with(KeyCode::Enter, KeyModifiers::ALT)), None);
        assert_eq!(state.overlay, None);
        assert_eq!(state.focus, Focus::Composer);
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        type_text(&mut state, "x");
        assert_eq!((state.focus, state.selected), (Focus::Composer, None));
    }

    #[test]
    fn the_frame_moves_the_window_to_the_selection_once() {
        let mut state = ready();
        state.follow = true;
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 40,
            followed: Some(12),
            ..LiveLayout::default()
        });
        assert_eq!((state.scroll_back, state.follow), (12, false));
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 40,
            ..LiveLayout::default()
        });
        assert_eq!(state.scroll_back, 12);
    }

    const CATALOG: &str = r#"{"v":1,"type":"models.catalog","id":"ID","providers":[{"id":"appliance","label":"Appliance (10.0.8.5:8443)","disclosure":"local","connected":true,"methods":[],"status":"ok"},{"id":"chatgpt","label":"ChatGPT plan","disclosure":"cloud","connected":true,"source":"Codex CLI","external":true,"methods":[{"id":"chatgpt-oauth","label":"Sign in with ChatGPT (unofficial)","kind":"browser","unofficial":true}],"status":"ok"},{"id":"anthropic","label":"Anthropic","disclosure":"cloud","connected":false,"methods":[{"id":"api-key","label":"API key","kind":"key"}],"status":"disconnected"}],"models":[{"provider":"appliance","id":"engineering/b0"},{"provider":"chatgpt","id":"gpt-5-codex"}],"current":{"provider":"appliance","model":"engineering/b0"},"recent":[]}"#;

    fn catalog(id: &str) -> Event {
        ev(&CATALOG.replace("\"ID\"", &format!("\"{id}\"")))
    }

    #[test]
    fn model_slash_opens_the_picker_and_selecting_switches_through_the_sidecar() {
        let mut state = ready();
        type_text(&mut state, "/model");
        let Some(Action::Send(Command::ModelsList { id })) = state.on_key(key(KeyCode::Enter)) else {
            panic!("expected models.list");
        };
        assert!(matches!(state.overlay, Some(Overlay::Models(_))));
        assert!(!state.session.busy, "the picker does not lock the composer");
        state.apply(catalog(&id));
        type_text(&mut state, "codex");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::ModelSelect { id: "x2".into(), provider: "chatgpt".into(), model: "gpt-5-codex".into() }))
        );
        assert!(state.overlay.is_none());
        state.apply(ev(r#"{"v":1,"type":"model.result","id":"x2","success":true,"message":"Model: gpt-5-codex via ChatGPT plan"}"#));
        assert!(matches!(state.transcript.last(), Some(Entry::Output { success: true, .. })));
    }

    #[test]
    fn ctrl_p_connects_a_provider_with_a_key_then_shows_its_models() {
        let mut state = ready();
        type_text(&mut state, "/model");
        let Some(Action::Send(Command::ModelsList { id })) = state.on_key(key(KeyCode::Enter)) else { panic!() };
        state.apply(catalog(&id));
        assert_eq!(state.on_key(ctrl('p')), None);
        assert!(matches!(state.overlay, Some(Overlay::Connect(_))));
        state.on_key(key(KeyCode::Down)); // chatgpt -> anthropic
        assert_eq!(state.on_key(key(KeyCode::Enter)), None, "a single key method opens the key field");
        state.on_paste("sk-ant-SECRET-1\n");
        let Some(Action::Send(Command::ProviderConnect { id: request, provider, method, key: Some(secret) })) = state.on_key(key(KeyCode::Enter)) else {
            panic!("expected provider.connect");
        };
        assert_eq!((provider.as_str(), method.as_str(), secret.0.as_str()), ("anthropic", "api-key", "sk-ant-SECRET-1"));
        assert!(!format!("{:?}", Command::ProviderConnect { id: request.clone(), provider: "a".into(), method: "m".into(), key: Some(secret) }).contains("SECRET"));
        state.apply(ev(&format!(r#"{{"v":1,"type":"provider.result","id":"{request}","provider":"anthropic","success":true,"message":"Anthropic connected (3 models available)."}}"#)));
        let outbox = state.take_outbox();
        assert!(matches!(outbox.as_slice(), [Action::Send(Command::ModelsList { .. })]), "reopens the picker for the provider");
        assert!(matches!(&state.overlay, Some(Overlay::Models(p)) if p.only.as_deref() == Some("anthropic")));
    }

    #[test]
    fn a_sign_in_shows_where_to_go_and_esc_cancels_it() {
        let mut state = ready();
        type_text(&mut state, "/connect");
        let Some(Action::Send(Command::ModelsList { id })) = state.on_key(key(KeyCode::Enter)) else { panic!() };
        state.apply(catalog(&id));
        assert!(matches!(state.overlay, Some(Overlay::Connect(_))), "/connect opens the connect panel once providers are known");
        let Some(Action::Send(Command::ProviderConnect { id: request, key: None, .. })) = state.on_key(key(KeyCode::Enter)) else {
            panic!("chatgpt's only method is a sign-in");
        };
        state.apply(ev(&format!(r#"{{"v":1,"type":"provider.auth","id":"{request}","provider":"chatgpt","url":"https://auth.example/x","instructions":"Sign in"}}"#)));
        assert!(matches!(&state.overlay, Some(Overlay::Connect(c)) if matches!(&c.step, crate::models::Step::Waiting { auth: Some(_), .. })));
        assert_eq!(state.on_key(key(KeyCode::Esc)), Some(Action::Send(Command::ProviderCancel { id: request })));
    }

}
