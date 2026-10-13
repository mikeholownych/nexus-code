//! Live session state. Pure: protocol events and keys go in, actions come out. Outcomes are projected exactly as
//! the sidecar reports them.
use crate::composer::Composer;
use crate::diff_view::{self, DiffCard, Patch};
use crate::theme::Depth;
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
        /// The change this call made to a file, when it is a file edit that succeeded.
        diff: Option<Box<DiffCard>>,
        /// When it started (this client's clock), how long it took, and what a command printed.
        run: Box<ToolRun>,
    },
    Banner {
        heading: String,
        line: String,
        /// The outcome in words, its cause, the next action and any items it names (open requirements).
        outcome: Box<Outcome>,
        tone: Tone,
        /// Redacted `inferenceFailure.message`, when the turn reports one.
        failure: Option<String>,
        summary: Option<String>,
        notes: Option<String>,
    },
    Notice(String),
    /// A slash or `!` command as the operator typed it.
    Command(String),
    /// The full text of a submitted prompt that held paste buffers (the prompt line shows their labels).
    Pasted(String),
    /// A message of a resumed conversation, shown under the resume divider.
    Earlier { role: String, text: String },
    /// A tool the agent called in a resumed conversation: name and subject (its result stays in the session record).
    EarlierTool { tool: String, subject: String },
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
    /// The change one file-edit call made, when no tool row for the call is in the transcript (it is otherwise
    /// shown on that row). A bounded preview; the call's detail record holds the whole diff.
    Diff { call_id: String, card: Box<DiffCard> },
}

impl Entry {
    /// The edit card this entry shows, if any.
    pub fn card(&self) -> Option<&DiffCard> {
        match self {
            Entry::Tool { diff: Some(card), .. } | Entry::Diff { card, .. } => Some(card),
            _ => None,
        }
    }

    /// Entries the diff review opens: edit cards and successful workspace diffs.
    pub fn reviewable(&self) -> bool {
        self.card().is_some() || matches!(self, Entry::Output { diff: true, success: true, .. })
    }
}

/// A tool call's timing and, for commands, its output. Timing comes from this client's clock, so it is
/// presentation, not identity: two runs compare equal when their output does.
#[derive(Clone, Debug, Default)]
pub struct ToolRun {
    pub started: Option<Instant>,
    pub duration_ms: Option<u64>,
    pub output: Option<ToolOutput>,
}

impl PartialEq for ToolRun {
    fn eq(&self, other: &Self) -> bool {
        self.output == other.output
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutput {
    /// The first lines (bounded by the sidecar), and how many lines there were in all.
    pub preview: String,
    pub lines: u64,
    pub exit_code: Option<i64>,
    pub timed_out: bool,
}

/// A turn's outcome as the operator reads it: derived only from the reported execution, outcome and reason.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    pub title: String,
    pub cause: Option<String>,
    pub next: Option<String>,
    pub items: Vec<String>,
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
    /// The turn's step budget and time limit, when the sidecar reports them.
    pub max_steps: Option<u64>,
    pub max_minutes: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Session {
    pub workspace_name: String,
    pub model: String,
    pub mode: String,
    pub branch: Option<String>,
    pub dirty: u64,
    pub busy: bool,
    /// The saved session's id, when the sidecar reports it.
    pub session_id: Option<String>,
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
    /// The proposed file change as a diff, when the review carries one (drawn with the shared diff view).
    pub patch: Option<Patch>,
    /// The decision Enter takes, once the operator has chosen one with ←/→, tab or `a`; none at first, so a stray
    /// Enter never decides.
    pub focus: Option<Verdict>,
    pub scroll: usize,
    /// When the panel was first on screen (until then, when the request arrived); the grace period counts from it.
    pub opened: Instant,
    /// The panel has been drawn. No decision is taken before that.
    pub shown: bool,
    /// Whether `y`, `n` and `a` may answer it: only when the operator was not typing just before the panel appeared
    /// and has typed nothing into it since. Otherwise a decision needs ←/→ then Enter (or Esc to deny).
    pub letters: bool,
    /// When the current choice was made, by the key just pressed (cleared by any other key except scrolling): Enter
    /// takes a choice only right after the key that made it, once it has been on screen for a moment.
    pub focus_at: Option<Instant>,
    /// "Approve all later actions" was confirmed once with Enter; a second Enter, a moment later, decides it.
    pub confirm_all_at: Option<Instant>,
    /// Something was typed into the panel: its letters never answer it again (even after a resize).
    pub typed_into: bool,
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

/// What the diff review shows: one operation's own change, or the cumulative workspace diff.
#[derive(Clone, Debug, PartialEq)]
pub enum ReviewScope {
    /// The edit card at transcript `entry`, whose call's full diff comes from its evidence record.
    Operation { entry: usize, path: String },
    /// The `/diff` output at transcript `entry`.
    Workspace { entry: usize },
}

/// A diff ready to review: parsed once, with its logical rows and measurements.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewContent {
    pub patch: Patch,
    pub rows: Vec<diff_view::Row>,
    pub num_width: usize,
    pub max_width: usize,
    /// Why what is shown is not the whole diff, and how to get the rest.
    pub limit: Option<String>,
}

impl ReviewContent {
    pub fn new(patch: Patch, limit: Option<String>) -> Self {
        let rows = diff_view::panel_rows(&patch);
        Self::with_rows(patch, rows, limit)
    }

    /// One operation's diff: the panel heading already names its file, so the per-file heading row is left out.
    pub fn operation(patch: Patch, limit: Option<String>) -> Self {
        let rows = diff_view::panel_rows(&patch).into_iter().filter(|row| !matches!(row, diff_view::Row::File(_) | diff_view::Row::Blank)).collect();
        Self::with_rows(patch, rows, limit)
    }

    fn with_rows(patch: Patch, rows: Vec<diff_view::Row>, limit: Option<String>) -> Self {
        let num_width = diff_view::patch_num_width(&patch);
        let max_width = diff_view::patch_max_width(&patch);
        ReviewContent { patch, rows, num_width, max_width, limit }
    }
}

/// The full diff review panel.
#[derive(Clone, Debug, PartialEq)]
pub struct DiffReview {
    /// Request id of the detail record it waits for (operation scope).
    pub request: String,
    pub scope: ReviewScope,
    pub content: Loaded<ReviewContent>,
    /// First logical row shown.
    pub top: usize,
    /// Columns panned right (when not wrapping).
    pub left: usize,
    pub wrap: bool,
}

/// Keystrokes typed for the draft must not answer an approval modal that opened mid-typing.
pub const APPROVAL_GRACE: Duration = Duration::from_millis(400);
/// A decision key counts only after a pause in typing this long: a `y`, `n` or Enter inside a run of typed text is
/// part of that text, not an answer (people type several keys a second; nobody decides that fast mid-word).
pub const APPROVAL_QUIET: Duration = Duration::from_millis(600);
/// Typing this recent when the panel first appears means the operator was mid-sentence: `y`/`n`/`a` are then not
/// answers for that panel (a slow typist's next letter could be any of them).
pub const APPROVAL_TYPING_RECENT: Duration = Duration::from_secs(2);
/// A choice made with ←/→ (and the first confirmation of "approve all later actions") is on screen this long before
/// Enter takes it: a cursor key followed by Enter out of editing habit decides nothing.
pub const APPROVAL_CHOICE_SHOWN: Duration = Duration::from_millis(400);

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
    /// ctrl+d, or enter on an edit card or workspace diff: the complete diff.
    Review(DiffReview),
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
    /// Columns the diff review can still pan right, and its content width.
    pub overlay_hlimit: usize,
    /// The transcript row at the top of the window: (entry index, rows from that row to the end of its entry).
    pub top: Option<(usize, usize)>,
    /// Set when the frame kept the window on `LiveState::anchor` while content arrived: the `scroll_back` it drew.
    pub anchored: Option<usize>,
    /// The approval panel was drawn with its heading, decisions and at least one row of the change visible.
    pub approval_drawn: bool,
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
    /// Colours the terminal can show.
    pub depth: Depth,
    /// While scrolled back: the row the window keeps at its top as entries arrive or grow below it.
    pub anchor: Option<(usize, usize)>,
    /// Transcript index of the newest entry the diff review can open.
    pub last_reviewable: Option<usize>,
    /// Output arrived below the window while the operator was scrolled back.
    pub unseen: bool,
    /// When the operator last typed a character, Enter or Backspace (the quiet period for approvals).
    last_typed: Option<Instant>,
    /// An approval that arrived while another panel was open.
    /// Approvals waiting behind an open panel (or another approval), oldest first.
    pending_approvals: std::collections::VecDeque<Approval>,
    /// Enter was pressed while the agent was starting: send the draft once it is ready.
    pub submit_when_ready: bool,
    /// The next assistant text starts a new reply (a new model step began since the last text).
    assistant_break: bool,
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
            depth: Depth::TrueColor,
            anchor: None,
            last_reviewable: None,
            unseen: false,
            assistant_break: false,
            last_typed: None,
            pending_approvals: std::collections::VecDeque::new(),
            submit_when_ready: false,
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
        let content = matches!(
            event,
            Event::AssistantDelta { .. }
                | Event::ToolStart { .. }
                | Event::ToolEnd { .. }
                | Event::FileDiff { .. }
                | Event::TurnResult { .. }
                | Event::Notice { .. }
                | Event::SlashResult { .. }
                | Event::SteerAck { .. }
                | Event::History { .. }
        );
        self.apply_event(event);
        self.promote_pending_approval();
        if self.submit_when_ready && self.link == Link::Ready && !self.connecting() {
            self.submit_when_ready = false;
            if let Some(action) = self.submit() {
                self.outbox.push(action);
            }
        }
        if content && self.scroll_back > 0 {
            self.unseen = true;
        }
    }

    fn apply_event(&mut self, event: Event) {
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
            Event::SessionState { workspace_name, model, mode, git, busy, session } => {
                self.session = Session {
                    session_id: session,
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
            Event::Activity { phase, step, segment, tool, subject, max_steps, max_minutes } => {
                if self.activity.as_ref().is_none_or(|previous| previous.step != step) {
                    self.assistant_break = true;
                }
                let since = match &self.activity {
                    Some(previous) if previous.phase == phase && previous.tool == tool => previous.since,
                    _ => Instant::now(),
                };
                self.activity = Some(Activity { phase, step, segment, tool, subject, since, max_steps, max_minutes });
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
                diff_lines,
                hunks,
                full_path,
                note,
            } => {
                let card = Box::new(DiffCard {
                    evidence,
                    path: diff_view::safe_text(&path),
                    kind,
                    added,
                    removed,
                    preview: diff_view::parse(&preview),
                    truncated,
                    total_lines,
                    diff_lines,
                    hunks,
                    note,
                    full_path,
                });
                self.attach_diff(call_id, card);
            }
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
            // One entry per model reply: text after a new step (a tool call, a continuation) starts a new one.
            Event::AssistantDelta { turn_id, text } => match self.transcript.last_mut() {
                Some(Entry::Assistant { turn_id: last, text: body }) if *last == turn_id && !self.assistant_break => body.push_str(&text),
                _ => {
                    self.assistant_break = false;
                    self.transcript.push(Entry::Assistant { turn_id, text });
                }
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
                        diff: None,
                        run: Box::new(ToolRun { started: Some(self.now.max(Instant::now())), ..ToolRun::default() }),
                    });
                }
            }
            Event::ToolEnd { call_id, tool, success, summary, lines, preview, exit_code, duration_ms, timed_out } => {
                let open = self.transcript.iter_mut().rev().find(|entry| {
                    matches!(entry, Entry::Tool { call_id: id, tool: name, status: ToolStatus::Running, .. }
                        if *id == call_id && *name == tool)
                });
                if let Some(Entry::Tool { status, summary: slot, diff, run, .. }) = open {
                    *status = if success { ToolStatus::Succeeded } else { ToolStatus::Failed };
                    *slot = summary;
                    run.duration_ms = duration_ms.or_else(|| run.started.map(|t| u64::try_from(t.elapsed().as_millis()).unwrap_or(u64::MAX)));
                    if let Some(preview) = preview {
                        run.output = Some(ToolOutput { preview, lines, exit_code, timed_out });
                    }
                    // A failed call never shows a change as if it had succeeded.
                    if !success {
                        *diff = None;
                    }
                }
            }
            Event::ApprovalRequest {
                id,
                tool,
                subject,
                review,
            } => {
                let lines = review_lines(review.as_ref().unwrap_or(&Review::Unknown));
                let text: String = lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>().join("\n");
                let mut patch = Some(diff_view::parse(&text)).filter(|patch| patch.files.iter().any(|file| !file.hunks.is_empty()));
                // The review says whether the file is new; its diff headers do not (no /dev/null side).
                if let (Some(patch), Some(Review::Change { created: true, .. })) = (patch.as_mut(), review.as_ref())
                    && let Some(file) = patch.files.first_mut()
                {
                    file.status = diff_view::Status::Added;
                }
                let approval = Approval {
                    id,
                    tool,
                    subject,
                    lines,
                    patch,
                    focus: None,
                    scroll: 0,
                    opened: Instant::now(),
                    shown: false,
                    // As it would be if drawn now; set again when it is first drawn.
                    letters: self.last_typed.is_none_or(|at| at.elapsed() >= APPROVAL_TYPING_RECENT) && self.composer.is_empty(),
                    focus_at: None,
                    confirm_all_at: None,
                    typed_into: false,
                };
                // Another panel is open: the approval waits behind it (a key meant for that panel must never answer
                // it), and opens as soon as that panel closes.
                // An approval already open is never replaced by a later one: that one waits too.
                match &self.overlay {
                    None => self.overlay = Some(Overlay::Approval(approval)),
                    Some(_) => self.pending_approvals.push_back(approval),
                }
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
                    outcome: Box::new(outcome_for(&turn)),
                    tone: tone_for(&turn),
                    failure: turn["inferenceFailure"]["message"].as_str().map(str::to_string),
                    summary,
                    notes,
                });
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
                    Some(Overlay::Review(review)) => review.content = Loaded::Failed(message),
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
                    self.anchor = None;
                    self.last_reviewable = None;
                }
                // A resume reads like the resume notice at startup (one style for the same event).
                if command == "resume" && success {
                    self.transcript.push(Entry::Info(output));
                } else if !output.is_empty() || !success {
                    let diff = format.as_deref() == Some("diff");
                    self.transcript.push(Entry::Output {
                        success,
                        text: output,
                        diff,
                    });
                    if diff && success {
                        self.last_reviewable = Some(self.transcript.len() - 1);
                    }
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
            Event::History { session, total, messages } => {
                let shown = messages.iter().filter(|m| m.role != "tool" && m.role != "outcome").count();
                self.transcript.push(Entry::Info(if shown as u64 == total {
                    format!("Earlier conversation of session {session} ({total} messages)")
                } else {
                    format!("Earlier conversation of session {session} (the last {shown} of {total} messages)")
                }));
                for message in messages {
                    match (message.role.as_str(), message.turn) {
                        ("tool", _) => self.transcript.push(Entry::EarlierTool {
                            tool: message.tool.unwrap_or_default(),
                            subject: message.text,
                        }),
                        // The last turn's outcome, as it was reported when the turn ended.
                        ("outcome", Some(turn)) => self.transcript.push(Entry::Banner {
                            heading: message.heading.unwrap_or_default(),
                            line: message.text,
                            outcome: Box::new(outcome_for(&turn)),
                            tone: tone_for(&turn),
                            failure: turn["inferenceFailure"]["message"].as_str().map(str::to_string),
                            summary: None,
                            notes: None,
                        }),
                        ("outcome", None) => {}
                        _ => self.transcript.push(Entry::Earlier { role: message.role, text: message.text }),
                    }
                }
            }
            Event::ToolDetail {
                id,
                status,
                args,
                output,
                duration_ms,
                diff,
                diff_chars,
                diff_path,
            } => {
                if let Some(Overlay::Review(review)) = &mut self.overlay
                    && review.request == id
                {
                    review.content = match diff {
                        Some(text) => {
                            let shown = text.chars().count() as u64;
                            let limit = match (diff_chars, &diff_path) {
                                (Some(total), Some(path)) if total > shown => Some(format!(
                                    "Showing the first {shown} of {total} characters. The complete diff is in {path}"
                                )),
                                (Some(total), None) if total > shown => Some(format!(
                                    "Showing the first {shown} of {total} characters; the rest was not kept."
                                )),
                                _ => None,
                            };
                            Loaded::Ready(ReviewContent::operation(diff_view::parse(&text), limit))
                        }
                        None => Loaded::Failed("This call recorded no file change.".to_string()),
                    };
                    return;
                }
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
        self.submit_when_ready = false;
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
            Some(Overlay::Detail(_) | Overlay::Receipt(_) | Overlay::Models(_) | Overlay::Connect(_) | Overlay::Review(_))
        ) {
            self.overlay = None;
        }
        // Evidence ids are numbered per sidecar process; the new one would answer for other calls.
        for entry in &mut self.transcript {
            match entry {
                Entry::Tool { evidence, diff, .. } => {
                    evidence.clear();
                    if let Some(card) = diff {
                        card.evidence.clear();
                    }
                }
                Entry::Diff { card, .. } => card.evidence.clear(),
                _ => {}
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
            // A paste never answers an approval, and counts as typing into it.
            Some(Overlay::Approval(_)) => return self.note_input_ignored_by_approval(Instant::now()),
            _ => {}
        }
        if !matches!(self.link, Link::Crashed { .. }) && self.overlay.is_none() {
            self.slash_pick = 0;
            self.slash_dismissed = false;
            self.composer.paste(text);
        }
    }

    /// Id of the approval waiting for a decision, if any.
    pub fn approval_id(&self) -> Option<&str> {
        match &self.overlay {
            Some(Overlay::Approval(approval)) => Some(approval.id.as_str()),
            _ => None,
        }
    }

    /// The approval panel is on screen now: its grace period starts here, not when the request arrived.
    pub fn note_approval_shown(&mut self, now: Instant) {
        let typing_recently = self.last_typed.is_some_and(|at| now.saturating_duration_since(at) < APPROVAL_TYPING_RECENT);
        // A draft in the composer means the operator is composing: letters are text, not answers.
        let composing = !self.composer.is_empty();
        if let Some(Overlay::Approval(approval)) = &mut self.overlay
            && !approval.shown
        {
            approval.shown = true;
            approval.opened = now;
            approval.letters = !approval.typed_into && !typing_recently && !composing;
            approval.focus = None;
            approval.focus_at = None;
            approval.confirm_all_at = None;
        }
    }

    /// Records what the frame measured and clamps scrolling to it.
    pub fn note_layout(&mut self, layout: LiveLayout) {
        // Shown only when the frame drew the panel with its change visible (not on a too-small screen).
        if layout.approval_drawn {
            self.note_approval_shown(Instant::now());
        } else if let Some(Overlay::Approval(approval)) = &mut self.overlay {
            // Not on screen this frame (too small a terminal): no decision until it is drawn again, timed afresh.
            approval.shown = false;
        }
        if let Some(back) = layout.followed {
            self.scroll_back = back;
            self.follow = false;
        }
        if let Some(back) = layout.anchored {
            self.scroll_back = back;
        }
        self.scroll_back = self.scroll_back.min(layout.scroll_limit);
        self.anchor = if self.scroll_back > 0 { layout.top } else { None };
        if self.scroll_back == 0 {
            self.unseen = false;
        }
        if let Some(Overlay::Review(review)) = &mut self.overlay {
            review.top = review.top.min(layout.overlay_limit);
            review.left = review.left.min(layout.overlay_hlimit);
        }
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
        self.pending_approvals.clear();
        if matches!(self.overlay, Some(Overlay::Approval(_))) {
            self.overlay = None;
        }
    }

    /// An approval waiting behind a panel opens once no panel is open. It starts unshown: its grace and quiet
    /// periods begin when it is first drawn.
    fn promote_pending_approval(&mut self) {
        if self.overlay.is_none()
            && let Some(mut approval) = self.pending_approvals.pop_front()
        {
            approval.shown = false;
            approval.opened = Instant::now();
            self.overlay = Some(Overlay::Approval(approval));
        }
    }

    /// Input the approval panel dropped (a paste, a burst of keys) was typing: its letters stop answering it and the
    /// quiet period restarts.
    pub fn note_input_ignored_by_approval(&mut self, now: Instant) {
        if let Some(Overlay::Approval(approval)) = &mut self.overlay {
            approval.letters = false;
            approval.typed_into = true;
            approval.focus = None;
            approval.focus_at = None;
            approval.confirm_all_at = None;
            self.last_typed = Some(now);
        }
    }

    /// An approval is waiting behind the open panel.
    pub fn approval_waiting(&self) -> bool {
        !self.pending_approvals.is_empty()
    }

    fn page(rows: usize) -> usize {
        rows.saturating_sub(1).max(1)
    }

    fn on_approval_key(&mut self, key: KeyEvent, now: Instant) -> Option<Action> {
        const ORDER: [Verdict; 3] = [Verdict::Approved, Verdict::ApprovedForSession, Verdict::Denied];
        // Scrolling the change keeps any choice made.
        if matches!(key.code, KeyCode::Up | KeyCode::Down | KeyCode::PageUp | KeyCode::PageDown | KeyCode::Home | KeyCode::End) && key.modifiers.is_empty() {
            self.scroll_overlay(key.code);
            return None;
        }
        let last_typed = self.last_typed;
        let Some(Overlay::Approval(approval)) = &mut self.overlay else {
            return None;
        };
        // Settled: the panel has been on screen for the grace period, and nothing has been typed for the quiet period
        // counted from when it appeared or the last key, whichever is later. Only then does any key decide.
        let since = last_typed.map_or(approval.opened, |at| at.max(approval.opened));
        let settled = approval.shown
            && now.saturating_duration_since(approval.opened) >= APPROVAL_GRACE
            && now.saturating_duration_since(since) >= APPROVAL_QUIET;
        // The choice counts only for the key right after the one that made it, once it has been visible a moment.
        let chosen_at = approval.focus_at.take();
        let confirmed_all = approval.confirm_all_at.take();
        let shown_long_enough = |at: Option<Instant>| at.is_some_and(|at| now.saturating_duration_since(at) >= APPROVAL_CHOICE_SHOWN);
        // Ctrl/Alt chords are editing commands, never letter answers.
        let plain = !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        // A key that is typing, not a decision: letters stop answering this panel for good and any choice is dropped.
        let typed = |approval: &mut Approval| {
            approval.letters = false;
            approval.typed_into = true;
            approval.focus = None;
        };
        let verdict = match key.code {
            // ←/→ move a choice that never wraps; "approve all later actions" then still needs Enter twice.
            KeyCode::Left | KeyCode::Right if plain => {
                if settled {
                    let at = approval.focus.and_then(|focus| ORDER.iter().position(|v| *v == focus));
                    let next = match (at, key.code == KeyCode::Left) {
                        (None, false) => 0,
                        (None, true) => ORDER.len() - 1,
                        (Some(i), false) => (i + 1).min(ORDER.len() - 1),
                        (Some(i), true) => i.saturating_sub(1),
                    };
                    approval.focus = Some(ORDER[next]);
                    approval.focus_at = Some(now);
                } else {
                    approval.focus = None;
                }
                return None;
            }
            // Approving every later action is session-wide: `a` only selects it, then Enter twice confirms.
            KeyCode::Char('a' | 'A') if plain && settled && approval.letters => {
                approval.focus = Some(Verdict::ApprovedForSession);
                approval.focus_at = Some(now);
                return None;
            }
            KeyCode::Enter if plain && settled && shown_long_enough(chosen_at) => match approval.focus {
                // The first Enter on "approve all later actions" asks for a second; that one decides.
                Some(Verdict::ApprovedForSession) if !shown_long_enough(confirmed_all) => {
                    approval.confirm_all_at = Some(now);
                    approval.focus_at = Some(now);
                    return None;
                }
                Some(focus) => focus,
                None => {
                    typed(approval);
                    return None;
                }
            },
            KeyCode::Char('y' | 'Y') if plain && settled && approval.letters => Verdict::Approved,
            KeyCode::Char('n' | 'N') if plain && settled && approval.letters => Verdict::Denied,
            KeyCode::Esc => Verdict::Denied,
            _ => {
                typed(approval);
                return None;
            }
        };
        // Esc never occurs in typed text and denies (the safe direction): it needs only the display grace, and on a
        // terminal too small to draw the panel it is the way out.
        if key.code == KeyCode::Esc && approval.shown && now.saturating_duration_since(approval.opened) < APPROVAL_GRACE {
            return None;
        }
        let Some(Overlay::Approval(approval)) = self.overlay.take() else {
            return None;
        };
        let insert_idx = self.transcript.iter().rposition(|e| match e {
            Entry::Tool { tool, status: ToolStatus::Running, .. } => *tool == approval.tool,
            _ => false,
        });
        let decision_entry = Entry::Decision {
            tool: approval.tool,
            subject: approval.subject,
            verdict,
        };
        match insert_idx {
            Some(idx) => self.transcript.insert(idx, decision_entry),
            None => self.transcript.push(decision_entry),
        };
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

    pub fn on_key_at(&mut self, key: KeyEvent, now: Instant) -> Option<Action> {
        let before = self.scroll_back;
        let action = self.handle_key(key, now);
        // Typing keys (characters, Enter, Backspace) start the quiet period a decision needs; navigation does not, nor
        // does a key that completed something (the Enter that sent a prompt, steering or command, the key that
        // answered an approval): that ends the typing rather than continuing it.
        let completed = matches!(
            action,
            Some(Action::Send(Command::PromptSubmit { .. } | Command::Steer { .. } | Command::Slash { .. } | Command::Approve { .. } | Command::Deny { .. }))
        ) || matches!(&self.overlay, Some(Overlay::Approval(approval)) if approval.confirm_all_at.is_some());
        if !completed && matches!(key.code, KeyCode::Char(_) | KeyCode::Enter | KeyCode::Backspace) {
            self.last_typed = Some(now);
        }
        self.promote_pending_approval();
        // The operator moved the window: the next frame keeps their position instead of the previous anchor.
        if self.scroll_back != before {
            self.anchor = None;
        }
        action
    }

    fn handle_key(&mut self, mut key: KeyEvent, now: Instant) -> Option<Action> {
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
            Some(Overlay::Review(_)) => return self.on_review_key(key),
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
        if key.code == KeyCode::Char('d') && ctrl {
            return self.open_review(None);
        }
        if key.code == KeyCode::End && ctrl {
            self.scroll_back = 0;
            self.follow = false;
            self.unseen = false;
            return None;
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
                | Overlay::Paste { .. }
                | Overlay::Review(_),
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
        if self.composer.expand(self.composer.text()).trim().is_empty() {
            return None;
        }
        if matches!(self.link, Link::Crashed { .. }) {
            return None;
        }
        // The agent is still starting (first launch or a restart): the message is sent as soon as it is ready,
        // instead of the Enter being silently dropped.
        if self.link != Link::Ready || self.connecting() {
            self.submit_when_ready = true;
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
        let pasted = display != text;
        self.transcript.push(Entry::User(display));
        if pasted {
            self.transcript.push(Entry::Pasted(text.clone()));
        }
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
            .filter(|(_, entry)| matches!(entry, Entry::Tool { .. } | Entry::Diff { .. }) || entry.reviewable())
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

    /// The tool, subject and evidence id of the call at transcript `index`.
    fn call_record(&self, index: usize) -> Option<(String, String, String)> {
        match self.transcript.get(index) {
            Some(Entry::Tool { tool, subject, evidence, .. }) => Some((tool.clone(), subject.clone(), evidence.clone())),
            Some(Entry::Diff { card, .. }) => Some(("edit_file".to_string(), card.path.clone(), card.evidence.clone())),
            _ => None,
        }
    }

    /// Shows a file change on its call's tool row (or as its own entry when that row is not in the transcript).
    /// The same call reported again replaces its earlier card rather than adding another.
    fn attach_diff(&mut self, call_id: String, card: Box<DiffCard>) {
        let found = self.transcript.iter().rposition(|entry| match entry {
            Entry::Tool { call_id: id, status, .. } => *id == call_id && *status != ToolStatus::Failed,
            Entry::Diff { call_id: id, .. } => *id == call_id,
            _ => false,
        });
        match found.map(|index| (index, &mut self.transcript[index])) {
            Some((index, Entry::Tool { diff, .. })) => {
                *diff = Some(card);
                self.last_reviewable = Some(self.last_reviewable.map_or(index, |last| last.max(index)));
            }
            Some((_, Entry::Diff { card: slot, .. })) => *slot = card,
            _ => {
                self.transcript.push(Entry::Diff { call_id, card });
                self.last_reviewable = Some(self.transcript.len() - 1);
            }
        }
    }

    /// Opens the diff review at transcript `index`; without one, at the selected reviewable entry, else the newest.
    fn open_review(&mut self, index: Option<usize>) -> Option<Action> {
        let selected = self.selected.filter(|&i| self.focus == Focus::Transcript && self.transcript.get(i).is_some_and(Entry::reviewable));
        let Some(index) = index.or(selected).or(self.last_reviewable).filter(|&i| self.transcript.get(i).is_some_and(Entry::reviewable)) else {
            self.transcript.push(Entry::Info("No file changes to review yet. Diffs appear here as edits succeed; /diff shows the whole workspace.".into()));
            return None;
        };
        self.review_entry(index, false)
    }

    fn review_entry(&mut self, index: usize, wrap: bool) -> Option<Action> {
        match &self.transcript[index] {
            Entry::Output { text, .. } => {
                let patch = diff_view::parse(text);
                let limit = patch.truncated.as_ref().map(|_| {
                    "Output limit reached: this is the beginning of the diff. Run `git diff` in the workspace for all of it.".to_string()
                });
                self.overlay = Some(Overlay::Review(DiffReview {
                    request: String::new(),
                    scope: ReviewScope::Workspace { entry: index },
                    content: Loaded::Ready(ReviewContent::new(patch, limit)),
                    top: 0,
                    left: 0,
                    wrap,
                }));
                None
            }
            entry => {
                let card = entry.card()?;
                let (path, evidence) = (card.path.clone(), card.evidence.clone());
                self.panel_seq += 1;
                let request = format!("d{}", self.panel_seq);
                let unavailable = evidence.is_empty() || self.link != Link::Ready;
                self.overlay = Some(Overlay::Review(DiffReview {
                    request: request.clone(),
                    scope: ReviewScope::Operation { entry: index, path },
                    content: if unavailable {
                        Loaded::Failed("This edit's record belongs to an earlier agent process; the preview in the transcript is what remains.".into())
                    } else {
                        Loaded::Waiting
                    },
                    top: 0,
                    left: 0,
                    wrap,
                }));
                (!unavailable).then_some(Action::Send(Command::ToolDetail { id: request, evidence }))
            }
        }
    }

    fn on_review_key(&mut self, key: KeyEvent) -> Option<Action> {
        let page = Self::page(self.layout.overlay_rows);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let Some(Overlay::Review(review)) = &mut self.overlay else {
            return None;
        };
        let rows = match &review.content {
            Loaded::Ready(content) => content.rows.as_slice(),
            _ => &[],
        };
        let starts = |pick: fn(&diff_view::Row) -> bool| -> Vec<usize> {
            rows.iter().enumerate().filter(|(_, row)| pick(row)).map(|(i, _)| i).collect()
        };
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.overlay = None,
            KeyCode::Char('d') if ctrl => self.overlay = None,
            KeyCode::Up | KeyCode::Char('k') => review.top = review.top.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => review.top = review.top.saturating_add(1),
            KeyCode::PageUp => review.top = review.top.saturating_sub(page),
            KeyCode::PageDown | KeyCode::Char(' ') => review.top = review.top.saturating_add(page),
            KeyCode::Home | KeyCode::Char('g') => review.top = 0,
            KeyCode::End | KeyCode::Char('G') => review.top = usize::MAX,
            KeyCode::Left | KeyCode::Char('h') if !review.wrap => review.left = review.left.saturating_sub(8),
            KeyCode::Right | KeyCode::Char('l') if !review.wrap => review.left = review.left.saturating_add(8),
            KeyCode::Char('0') => review.left = 0,
            KeyCode::Char('w') => {
                review.wrap = !review.wrap;
                review.left = 0;
            }
            KeyCode::Char('n' | 'p') => {
                let hunks = starts(|row| matches!(row, diff_view::Row::Gap(..)));
                let next = if key.code == KeyCode::Char('n') {
                    hunks.iter().copied().find(|&i| i > review.top)
                } else {
                    hunks.iter().rev().copied().find(|&i| i < review.top)
                };
                if let Some(next) = next {
                    review.top = next;
                }
            }
            KeyCode::Char(c @ ('[' | ']')) => match review.scope {
                ReviewScope::Workspace { .. } => {
                    let files = starts(|row| matches!(row, diff_view::Row::File(_)));
                    let next = if c == ']' {
                        files.iter().copied().find(|&i| i > review.top)
                    } else {
                        files.iter().rev().copied().find(|&i| i < review.top)
                    };
                    if let Some(next) = next {
                        review.top = next;
                    }
                }
                ReviewScope::Operation { entry, .. } => {
                    let wrap = review.wrap;
                    let next = if c == ']' {
                        (entry + 1..self.transcript.len()).find(|&i| self.transcript[i].card().is_some())
                    } else {
                        (0..entry).rev().find(|&i| self.transcript[i].card().is_some())
                    };
                    if let Some(next) = next {
                        return self.review_entry(next, wrap);
                    }
                }
            },
            KeyCode::Char('i') => {
                if let ReviewScope::Operation { entry, .. } = review.scope
                    && let Some((tool, subject, evidence)) = self.call_record(entry)
                    && !evidence.is_empty()
                {
                    self.panel_seq += 1;
                    let request = format!("d{}", self.panel_seq);
                    self.overlay = Some(Overlay::Detail(Detail { request: request.clone(), tool, subject, record: Loaded::Waiting, scroll: 0 }));
                    return Some(Action::Send(Command::ToolDetail { id: request, evidence }));
                }
            }
            _ => {}
        }
        None
    }

    fn open_detail(&mut self) -> Option<Action> {
        if self.link != Link::Ready {
            return None;
        }
        if let Some(index) = self.selected
            && self.transcript.get(index).is_some_and(Entry::reviewable)
        {
            return self.open_review(Some(index));
        }
        let found = self
            .selected
            .and_then(|index| self.call_record(index));
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
            | Some(Overlay::Review(DiffReview {
                request,
                content: Loaded::Waiting,
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

/// The outcome in words, from the reported execution, outcome and reason only. Raw fields stay in the receipt.
pub fn outcome_for(turn: &Value) -> Outcome {
    let execution = turn["execution"].as_str().unwrap_or("");
    let outcome = turn["outcome"].as_str().unwrap_or("");
    let reason = turn["reason"].as_str().unwrap_or("");
    let detail = turn["detail"].as_str().filter(|d| !d.is_empty()).map(str::to_string);
    let verifier = turn["verification"]["command"].as_str().map(str::to_string);
    let text = |s: &str| Some(s.to_string()).filter(|s| !s.is_empty());
    let mut items = Vec::new();
    let objective = &turn["objective"];
    let open_objective = objective["status"].as_str().is_some_and(|status| status != "completed")
        && objective["remaining"].as_array().is_some_and(|remaining| !remaining.is_empty());
    let inference_failed = turn["inferenceFailure"].is_object();
    let reason = if reason.is_empty() && open_objective && execution == "COMPLETED" {
        "REQUIREMENTS_INCOMPLETE"
    } else if reason.is_empty() && inference_failed {
        "INFERENCE_FAILED"
    } else {
        reason
    };
    let (title, cause, next) = match (execution, outcome, reason) {
        ("COMPLETED", "VERIFIED", _) => ("Done · verified".to_string(), verifier.map(|c| format!("{c} passed")), None),
        // The suite passed but nothing shows it tested the change: nothing else broke, the change itself is unproven.
        ("COMPLETED", "REGRESSION_FREE", _) => (
            "Done · tests passed, change not covered".to_string(),
            Some(format!("{} passed, but none of the tests it ran covers the changed files.", verifier.unwrap_or_else(|| "The test command".into()))),
            text("add a test for the change (or run one that names it), or check it yourself with /diff"),
        ),
        ("COMPLETED", "NOT_REQUIRED", _) => ("Done".to_string(), text("No files changed, so there was nothing to verify."), None),
        ("COMPLETED", "UNVERIFIED", "NO_APPLICABLE_VERIFIER") => (
            "Done · not verified".to_string(),
            text("Files changed, and no test command was found for this workspace."),
            text("check the changes yourself (/diff), or run /test <command>"),
        ),
        ("COMPLETED", "UNVERIFIED", _) => (
            "Done · not verified".to_string(),
            text("Files changed, but no verifier ran before the agent finished."),
            text("run /test, or ask Nexus to verify the change"),
        ),
        ("COMPLETED", "NOT_ESTABLISHED", "VERIFIER_FAILED") => (
            "Verification failed".to_string(),
            Some(format!("{} failed", detail.clone().or(verifier).unwrap_or_else(|| "the verifier".into()))),
            text("v shows the failing check; ask Nexus to fix it"),
        ),
        ("COMPLETED", "NOT_ESTABLISHED", "VERIFIER_TIMED_OUT") => (
            "Verification timed out".to_string(),
            detail.clone(),
            text("raise NEXUS_VERIFIER_TIMEOUT_SECS, or run the tests yourself"),
        ),
        ("COMPLETED", "NOT_ESTABLISHED", "REQUIREMENTS_INCOMPLETE") => {
            if let Some(remaining) = turn["objective"]["remaining"].as_array() {
                items = remaining.iter().filter_map(Value::as_str).map(str::to_string).collect();
            }
            let open = items.len();
            let mut cause = format!("The agent finished with {open} requirement{} not done.", if open == 1 { "" } else { "s" });
            if let Some(check) = objective["failedCheck"].as_str() {
                cause.push_str(&format!(" Failed check: {check}."));
            }
            (
                "Requirements still open".to_string(),
                Some(cause),
                objective["nextAction"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| text("reply to continue, or /requirements to review or accept a reduced scope")),
            )
        }
        ("COMPLETED", _, _) => ("Done · result not established".to_string(), detail.clone().or_else(|| text(reason)), text("v shows the receipt")),
        ("INTERRUPTED", _, _) => {
            let phase = turn["interruption"]["phase"].as_str().unwrap_or("work").replace('_', " ");
            let skipped = turn["interruption"]["undispatchedToolCalls"].as_u64().unwrap_or(0);
            let mut cause = format!("You stopped the turn during {phase}.");
            if skipped > 0 {
                cause.push_str(&format!(" {skipped} planned tool call{} did not run.", if skipped == 1 { "" } else { "s" }));
            }
            ("Cancelled".to_string(), Some(cause), None)
        }
        ("FAILED", _, "INFERENCE_FAILED") => ("Model request failed".to_string(), if inference_failed { None } else { detail.clone() }, text("send again, or choose another model with /model")),
        ("FAILED", _, _) => ("Turn failed".to_string(), detail.clone().or_else(|| text(reason)), text("v shows the receipt")),
        ("BLOCKED", _, "CONTEXT_CAPACITY_EXCEEDED") => (
            "Context is full".to_string(),
            detail.clone().map(|d| format!("The request would exceed the model's context ({d} tokens).")),
            text("/compact, then send again"),
        ),
        ("BLOCKED", _, _) => ("Blocked".to_string(), detail.clone().or_else(|| text(reason)), text("v shows the receipt")),
        ("LIMIT_REACHED", _, _) => {
            let what = match reason {
                "STEP_BUDGET_EXHAUSTED" | "STEP_LIMIT_REACHED" => "the step budget",
                "TIME_BUDGET_EXHAUSTED" => "the time budget",
                "STAGNATION_DETECTED" => "too many steps without progress",
                _ => "a limit",
            };
            (format!("Stopped at {what}"), detail.clone(), text("reply to continue from here, or raise the budget"))
        }
        _ => ("Turn ended".to_string(), detail.clone().or_else(|| text(reason)), text("v shows the receipt")),
    };
    Outcome { title, cause, next, items }
}

/// Same projection as `TerminalUI.turnSummary` in `cli/src/ui.ts`: a failing or timed-out verifier is a failure;
/// an operator's cancel or a budget stop is not.
pub fn tone_for(turn: &Value) -> Tone {
    match (turn["execution"].as_str(), turn["outcome"].as_str(), turn["reason"].as_str()) {
        (Some("COMPLETED"), Some("VERIFIED" | "NOT_REQUIRED"), _) => Tone::Good,
        (Some("COMPLETED"), _, Some("VERIFIER_FAILED" | "VERIFIER_TIMED_OUT")) => Tone::Bad,
        (Some("COMPLETED"), _, _) => Tone::Caution,
        (Some("INTERRUPTED" | "LIMIT_REACHED"), _, _) => Tone::Caution,
        _ => Tone::Bad,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Review;

    #[test]
    fn a_suite_that_did_not_cover_the_change_reads_as_unproven_not_verified() {
        let turn: Value = serde_json::from_str(r#"{"execution":"COMPLETED","outcome":"REGRESSION_FREE","reason":"REGRESSION_FREE","verification":{"status":"PASSED","command":"npm test"}}"#).unwrap();
        let outcome = outcome_for(&turn);
        assert_eq!(outcome.title, "Done · tests passed, change not covered");
        assert_eq!(outcome.cause.as_deref(), Some("npm test passed, but none of the tests it ran covers the changed files."));
        assert!(matches!(tone_for(&turn), Tone::Caution));
    }
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
        // The prompt line keeps the paste label; the text that was sent follows it, bounded in the view.
        let n = state.transcript.len();
        assert_eq!(state.transcript[n - 2], Entry::User("[Pasted text #1: 2 lines]".into()));
        assert_eq!(state.transcript[n - 1], Entry::Pasted("/exit\nand then fix the bug".into()));
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
        // The change is shown on the call's own tool row, not as a second entry.
        let tools: Vec<&Entry> = state.transcript.iter().filter(|e| matches!(e, Entry::Tool { .. } | Entry::Diff { .. })).collect();
        assert_eq!(tools.len(), 1);
        let card = tools[0].card().expect("the edit row carries its diff");
        assert_eq!((card.added, card.removed, card.truncated), (1, 1, true));
        state.on_key(key(KeyCode::Tab));
        state.on_key(key(KeyCode::Char('[')));
        assert!(matches!(state.on_key(key(KeyCode::Enter)), Some(Action::Send(Command::ToolDetail { ref evidence, .. })) if evidence == "e1"));
        assert!(matches!(state.overlay, Some(Overlay::Review(_))), "enter on an edit opens its complete diff");
    }

    #[test]
    fn open_requirements_from_the_turn_are_reported_under_the_banner() {
        let mut state = busy();
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - REQUIREMENTS OPEN","line":"L","turn":{"execution":"COMPLETED","outcome":"NOT_ESTABLISHED","objective":{"status":"incomplete","remaining":["R2 [open] Reject negatives"],"failedCheck":"not ok 3","nextAction":"Fix R2"}},"model_summary":null}"#));
        let Some(Entry::Banner { outcome, .. }) = state.transcript.last() else { panic!("{:?}", state.transcript) };
        assert_eq!(outcome.title, "Requirements still open");
        assert_eq!(outcome.items, vec!["R2 [open] Reject negatives".to_string()]);
        assert_eq!(outcome.cause.as_deref(), Some("The agent finished with 1 requirement not done. Failed check: not ok 3."));
        assert_eq!(outcome.next.as_deref(), Some("Fix R2"));
        assert!(!state.transcript.iter().any(|e| matches!(e, Entry::Info(_))), "the requirements are reported once, in the outcome");
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
                session_id: None,
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
                    diff: None,
                    run: Box::default(),
                },
                Entry::Tool {
                    call_id: "b".into(),
                    tool: "read_file".into(),
                    subject: "b.ts".into(),
                    status: ToolStatus::Failed,
                    summary: "No such file".into(),
                    evidence: String::new(),
                    diff: None,
                    run: Box::default(),
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
                diff: None,
                run: Box::default(),
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
                diff: None,
                run: Box::default(),
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
                outcome: Box::new(Outcome { title: "Cancelled".into(), cause: Some("You stopped the turn during work.".into()), next: None, items: vec![] }),
                tone: Tone::Caution,
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
                outcome: Box::new(Outcome { title: "Done · verified".into(), cause: None, next: None, items: vec![] }),
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
            ("LIMIT_REACHED", "UNVERIFIED", Tone::Caution),
            ("INTERRUPTED", "NOT_ESTABLISHED", Tone::Caution),
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
                    outcome: Box::new(Outcome { title: "Model request failed".into(), cause: None, next: Some("send again, or choose another model with /model".into()), items: vec![] }),
                    tone: Tone::Bad,
                    failure: Some("upstream timed out after 60s".into()),
                    summary: None,
                    notes: None,
                },
                Entry::Banner {
                    heading: "TURN FAILED".into(),
                    line: "Stopped".into(),
                    outcome: Box::new(Outcome { title: "Turn failed".into(), cause: None, next: Some("v shows the receipt".into()), items: vec![] }),
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
        let opened = opened_at(&mut state);
        assert_eq!(
            state.overlay,
            Some(Overlay::Approval(Approval {
                id: "approval-1".into(),
                tool: "write_file".into(),
                subject: "x.txt".into(),
                lines: review_lines(&Review::Unknown),
                patch: None,
                focus: None,
                scroll: 0,
                opened,
                shown: true,
                // Shown a while after the prompt was typed: `y`/`n`/`a` may answer it.
                letters: true,
                focus_at: None,
                confirm_all_at: None,
                typed_into: false,
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

    /// The approval panel's display time (the panel is marked shown, as the first frame would).
    /// Shows the panel as it usually appears: a while after the operator finished typing the prompt (letters armed).
    fn opened_at(state: &mut LiveState) -> Instant {
        state.note_approval_shown(Instant::now() + APPROVAL_TYPING_RECENT);
        let Some(Overlay::Approval(approval)) = &state.overlay else {
            panic!("expected the approval modal");
        };
        approval.opened
    }

    /// A key after both the display grace and a pause in typing (the prompt was typed just before the panel opened).
    fn past_grace(state: &mut LiveState, code: KeyCode) -> Option<Action> {
        let now = opened_at(state) + APPROVAL_GRACE + APPROVAL_QUIET;
        state.on_key_at(key(code), now)
    }

    #[test]
    fn a_decision_key_right_after_the_modal_opens_is_ignored() {
        let mut state = ready();
        type_text(&mut state, "make x");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        type_text(&mut state, "dra");
        state.apply(ev(APPROVAL));
        let opened = opened_at(&mut state);
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
        let opened = opened_at(&mut state);
        let transcript = state.transcript.clone();
        assert_eq!(state.on_key_at(key(KeyCode::Char('a')), opened), None);
        assert_eq!(state.transcript, transcript);
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
        assert_eq!(state.composer, "");
        // That early `a` was typing: letters no longer answer this panel, even after a pause.
        assert_eq!(past_grace(&mut state, KeyCode::Char('a')), None);
        assert!(matches!(&state.overlay, Some(Overlay::Approval(a)) if a.focus.is_none() && !a.letters));
        // A deliberate choice still decides: → → selects "approve all later actions"; Enter, then Enter again, confirms.
        let later = opened_at(&mut state) + APPROVAL_GRACE + APPROVAL_QUIET * 3;
        assert_eq!(state.on_key_at(key(KeyCode::Right), later), None);
        assert_eq!(state.on_key_at(key(KeyCode::Right), later), None);
        assert_eq!(state.on_key_at(key(KeyCode::Enter), later + APPROVAL_CHOICE_SHOWN), None, "the first Enter asks for a second");
        assert_eq!(
            state.on_key_at(key(KeyCode::Enter), later + APPROVAL_CHOICE_SHOWN * 2),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: true
            }))
        );
    }

    #[test]
    fn ctrl_c_right_after_the_modal_opens_still_cancels() {
        let mut state = busy_with_approval();
        let opened = opened_at(&mut state);
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
        let opened = opened_at(&mut state);
        assert_eq!(state.on_key_at(key(KeyCode::Char('x')), opened + Duration::from_millis(100)), None);
        assert_eq!(state.composer, "", "keys go to the modal, not the composer");
        // A key typed into the panel disarms its letters: `y` is text now; → then Enter decides.
        assert_eq!(state.on_key_at(key(KeyCode::Char('y')), opened + Duration::from_secs(3)), None);
        let later = opened + Duration::from_secs(5);
        assert_eq!(state.on_key_at(key(KeyCode::Right), later), None);
        assert_eq!(
            state.on_key_at(key(KeyCode::Enter), later + APPROVAL_CHOICE_SHOWN),
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
        // The next panel appears a while after the last key above.
        state.note_approval_shown(later + APPROVAL_TYPING_RECENT);
        let base = later + Duration::from_secs(10);
        assert_eq!(state.on_key_at(key(KeyCode::Char('a')), base), None, "`a` only selects the session-wide approval");
        assert_eq!(state.on_key_at(key(KeyCode::Enter), base + Duration::from_secs(1)), None, "the first Enter asks for a second");
        assert_eq!(
            state.on_key_at(key(KeyCode::Enter), base + Duration::from_secs(2)),
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
        for code in [KeyCode::Down, KeyCode::Down, KeyCode::PageDown] {
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
            matches!(state.overlay, Some(Overlay::Help { .. })) && state.approval_waiting(),
            "an approval waits behind help instead of replacing it"
        );
        // The key meant for help (Enter closes it) does not answer the approval; the approval then opens.
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
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
        // The receipt panel stays; the approval waits behind it and opens when it closes.
        assert!(matches!(state.overlay, Some(Overlay::Receipt(_))) && state.approval_waiting());
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))) && !state.approval_waiting());
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
