//! Live session state. Pure: protocol events and keys go in, actions come out. Outcomes are projected exactly as
//! the sidecar reports them.
use crate::composer::Composer;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;

use crate::protocol::{Command, Event, PROTOCOL_VERSION, Review};
use crate::review::{ReviewLine, review_lines};

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
    /// The operator's answer to an approval request.
    Decision {
        tool: String,
        subject: String,
        verdict: Verdict,
    },
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
}

/// Modal panels. While one is open it receives every key except Ctrl-C.
#[derive(Clone, Debug, PartialEq)]
pub enum Overlay {
    Approval(Approval),
    Help { scroll: usize },
}

/// What the last frame measured. Key handling uses it for page sizes, and it clamps scrolling at the top.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LiveLayout {
    pub transcript_rows: usize,
    /// Largest useful `scroll_back`; `usize::MAX` when the frame did not reach the top of the transcript.
    pub scroll_limit: usize,
    pub overlay_rows: usize,
    pub overlay_limit: usize,
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
        }
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
            Event::Hello { protocol } if protocol == PROTOCOL_VERSION => self.link = Link::Ready,
            Event::Hello { protocol } => self.fail(
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
            }
            Event::AssistantDelta { turn_id, text } => match self.transcript.last_mut() {
                Some(Entry::Assistant { turn_id: last, text: body }) if *last == turn_id => body.push_str(&text),
                _ => self.transcript.push(Entry::Assistant { turn_id, text }),
            },
            Event::ToolStart { call_id, tool, subject } => {
                if !HIDDEN_TOOLS.contains(&tool.as_str()) {
                    self.transcript.push(Entry::Tool {
                        call_id,
                        tool,
                        subject,
                        status: ToolStatus::Running,
                        summary: String::new(),
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
                }));
            }
            Event::TurnResult { heading, line, turn, model_summary } => {
                self.pending = None;
                self.cancel_requested = false;
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
            Event::Unknown => {}
        }
    }

    /// The sidecar stopped or broke protocol; nothing still running can finish.
    pub fn fail(&mut self, reason: String, code: Option<i32>, stderr: Vec<String>) {
        self.close_approval();
        self.interrupt_running_tools();
        self.session.busy = false;
        self.cancel_requested = false;
        self.link = Link::Crashed {
            code,
            reason,
            stderr,
        };
    }

    pub fn restarted(&mut self) {
        self.close_approval();
        self.link = Link::Connecting;
        self.session.busy = false;
        self.cancel_requested = false;
        self.transcript.push(Entry::Notice(
            "Started a new agent sidecar. It does not remember the conversation above.".to_string(),
        ));
    }

    pub fn on_paste(&mut self, text: &str) {
        if !matches!(self.link, Link::Crashed { .. }) {
            self.composer.insert(text);
        }
    }

    /// Records what the frame measured and clamps scrolling to it.
    pub fn note_layout(&mut self, layout: LiveLayout) {
        self.scroll_back = self.scroll_back.min(layout.scroll_limit);
        if let Some(Overlay::Approval(Approval { scroll, .. }) | Overlay::Help { scroll }) =
            &mut self.overlay
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

    fn on_approval_key(&mut self, key: KeyEvent) -> Option<Action> {
        let verdict = match key.code {
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => Verdict::Approved,
            KeyCode::Char('a' | 'A') => Verdict::ApprovedForSession,
            KeyCode::Char('n' | 'N') | KeyCode::Esc => Verdict::Denied,
            code => {
                self.scroll_overlay(code);
                return None;
            }
        };
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
        if let Some(Overlay::Approval(Approval { scroll, .. }) | Overlay::Help { scroll }) =
            &mut self.overlay
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
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll_back = self.scroll_back.saturating_add(1)
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.scroll_back = self.scroll_back.saturating_sub(1)
            }
            KeyCode::Home | KeyCode::Char('g') => self.scroll_back = usize::MAX,
            KeyCode::End | KeyCode::Char('G') => self.scroll_back = 0,
            KeyCode::Enter => self.focus = Focus::Composer,
            KeyCode::Char(_)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.focus = Focus::Composer;
                return self.on_composer_key(key);
            }
            _ => {}
        }
        None
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Option<Action> {
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
            Some(Overlay::Approval(_)) => return self.on_approval_key(key),
            Some(Overlay::Help { .. }) => {
                self.on_help_key(key);
                return None;
            }
            None => {}
        }
        let page = Self::page(self.layout.transcript_rows);
        match key.code {
            KeyCode::Tab => {
                self.focus = match self.focus {
                    Focus::Composer => Focus::Transcript,
                    Focus::Transcript => Focus::Composer,
                };
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
                self.focus = Focus::Composer;
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
        match self.overlay {
            Some(Overlay::Help { .. }) => {
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
            KeyCode::Char('b') if alt => composer.word_left(),
            KeyCode::Char('f') if alt => composer.word_right(),
            KeyCode::Char(c) if !ctrl && !alt => composer.insert(c.encode_utf8(&mut [0; 4])),
            _ => {}
        }
        None
    }

    fn submit(&mut self) -> Option<Action> {
        if self.link != Link::Ready
            || self.connecting()
            || self.session.busy
            || self.composer.text().trim().is_empty()
        {
            return None;
        }
        self.turn_seq += 1;
        let text = self.composer.take();
        self.scroll_back = 0;
        self.focus = Focus::Composer;
        self.transcript.push(Entry::User(text.clone()));
        self.session.busy = true;
        let id = format!("t{}", self.turn_seq);
        self.pending = Some(id.clone());
        Some(Action::Send(Command::PromptSubmit { id, text }))
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
        assert_eq!(state.composer, "aX\nYb");
        state.session.busy = true;
        type_text(&mut state, "!");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "aX\nY!b");
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
    fn enter_does_nothing_while_connecting_busy_or_empty() {
        let mut connecting = LiveState::new();
        type_text(&mut connecting, "x");
        assert_eq!(connecting.on_key(key(KeyCode::Enter)), None);
        let mut state = ready();
        type_text(&mut state, "   ");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        state.composer = "work".into();
        state.session.busy = true;
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "work");
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
        type_text(&mut state, "again");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Notice(
                "BUSY: A turn is already running; cancel it or wait for its result.".into()
            ))
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
                },
                Entry::Tool {
                    call_id: "b".into(),
                    tool: "read_file".into(),
                    subject: "b.ts".into(),
                    status: ToolStatus::Failed,
                    summary: "No such file".into(),
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
        assert_eq!(
            state.overlay,
            Some(Overlay::Approval(Approval {
                id: "approval-1".into(),
                tool: "write_file".into(),
                subject: "x.txt".into(),
                lines: review_lines(&Review::Unknown),
                scroll: 0,
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
            state.on_key(key(KeyCode::Char('y'))),
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
            state.on_key(key(KeyCode::Char('a'))),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: true
            }))
        );
        state.apply(ev(APPROVAL));
        assert_eq!(
            state.on_key(key(KeyCode::Esc)),
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
        state.apply(Event::Hello { protocol: 2 });
        assert!(
            matches!(&state.link, Link::Crashed { reason, .. } if reason.contains("protocol 2"))
        );
    }
}
