//! `nexus-tui --live`: runs the agent sidecar and renders its protocol events in the terminal.
use std::{
    env,
    error::Error,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event as TermEvent, KeyCode, KeyEvent,
        KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
        PushKeyboardEnhancementFlags,
    },
    execute, terminal,
};

use crate::live_state::{Action, Link, LiveLayout, LiveState};
use crate::live_view::{FRAME, render_live};
use crate::protocol::{Command, Event};
use crate::sidecar::{Sidecar, SidecarMsg, SidecarSpec};

const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const EXIT_GRACE: Duration = Duration::from_secs(2);
const INPUT_POLL: Duration = Duration::from_millis(30);
/// Must outlast the graceful shutdown (SHUTDOWN_GRACE plus the sidecar's group and stderr waits).
const STOP_WATCHDOG_GRACE: Duration = Duration::from_secs(6);

static STOP: AtomicBool = AtomicBool::new(false);
/// Set with STOP but never cleared, so the watchdog sees a stop even after the event loop consumed it.
static STOP_SIGNALLED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn request_stop(_signal: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
    STOP_SIGNALLED.store(true, Ordering::SeqCst);
}

/// SIGTERM and SIGHUP (terminal closed) end the session like `q`: the sidecar is shut down and the terminal
/// restored by the normal exit path.
#[cfg(unix)]
fn install_stop_signals() {
    for signal in [libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        unsafe {
            libc::signal(signal, request_stop as *const () as libc::sighandler_t);
        }
    }
}

#[cfg(not(unix))]
fn install_stop_signals() {}

fn stop_requested() -> bool {
    STOP.swap(false, Ordering::SeqCst)
}

/// Exits the process when a stop signal has not ended the session within STOP_WATCHDOG_GRACE. crossterm's
/// input poll can spin forever on a hung-up terminal, so the event loop may never see the stop. Exiting closes
/// the sidecar's stdin, and the sidecar shuts itself down.
fn spawn_stop_watchdog() {
    std::thread::spawn(|| {
        while !STOP_SIGNALLED.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(STOP_WATCHDOG_GRACE);
        std::process::exit(1);
    });
}

pub const LIVE_USAGE: &str =
    "usage: nexus-tui --live [--check] [--sidecar PATH] [--node BIN] [-- SIDECAR_ARGS...]";

/// Runs `nexus-tui --live ARGS...`. A launch error is written to `stderr` as plain text. Returns the exit status.
pub fn main(args: Vec<String>, stderr: &mut dyn Write) -> i32 {
    match launch(args) {
        Ok(()) => 0,
        Err(err) => {
            let _ = writeln!(stderr, "nexus-tui: {err}");
            1
        }
    }
}

fn launch(args: Vec<String>) -> Result<(), Box<dyn Error>> {
    let check = args.iter().any(|a| a == "--check");
    let spec = resolve_spec(
        args,
        env::var("NEXUS_SIDECAR").ok(),
        env::var("NEXUS_NODE").ok(),
        env::current_exe().ok(),
    )?;
    if check {
        return Ok(());
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("interactive Nexus TUI requires a terminal".into());
    }
    run_live(spec)
}

/// Resolves the sidecar command line. Precedence: flags, then `NEXUS_SIDECAR` / `NEXUS_NODE`, then
/// `$NEXUS_HOME/lib/cli/dist/sidecar.js`, then the `cli/dist/sidecar.js` of the checkout layout.
pub fn resolve_spec(
    args: Vec<String>,
    env_sidecar: Option<String>,
    env_node: Option<String>,
    exe: Option<PathBuf>,
) -> Result<SidecarSpec, String> {
    let mut sidecar = env_sidecar.map(PathBuf::from);
    let mut node = env_node.unwrap_or_else(|| "node".to_string());
    let mut passthrough = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--check" => {}
            "--sidecar" => sidecar = Some(PathBuf::from(args.next().ok_or(LIVE_USAGE)?)),
            "--node" => node = args.next().ok_or(LIVE_USAGE)?,
            "--" => {
                passthrough.extend(args.by_ref());
                break;
            }
            other => return Err(format!("unknown option {other}\n{LIVE_USAGE}")),
        }
    }
    let sidecar = if let Some(explicit) = sidecar {
        if !explicit.is_file() {
            return Err(format!(
                "sidecar not found at {}; run `make build` or pass --sidecar PATH",
                explicit.display()
            ));
        }
        explicit
    } else {
        let mut tried = Vec::new();
        let mut found = None;
        if let Ok(nexus_home) = env::var("NEXUS_HOME") {
            let p = PathBuf::from(nexus_home).join("lib/cli/dist/sidecar.js");
            if p.is_file() {
                found = Some(p);
            } else {
                tried.push(p);
            }
        }
        if found.is_none() {
            if let Some(ref exe) = exe {
                if let Some(root) = exe.ancestors().nth(4) {
                    let p = root.join("cli/dist/sidecar.js");
                    if p.is_file() {
                        found = Some(p);
                    } else {
                        tried.push(p);
                    }
                }
            }
        }
        match found {
            Some(p) => p,
            None => {
                if tried.len() > 1 {
                    return Err(format!(
                        "sidecar not found; tried: {}; run `make build` or pass --sidecar PATH",
                        tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
                    ));
                } else if let Some(single) = tried.first() {
                    return Err(format!(
                        "sidecar not found at {}; run `make build` or pass --sidecar PATH",
                        single.display()
                    ));
                } else {
                    return Err("cannot locate cli/dist/sidecar.js; pass --sidecar PATH".to_string());
                }
            }
        }
    };
    let mut spec_args = vec![sidecar.display().to_string()];
    spec_args.extend(passthrough);
    Ok(SidecarSpec {
        program: node,
        args: spec_args,
    })
}

/// The live session without the terminal: sidecar lifecycle plus state. The event loop feeds it keys.
pub struct LiveApp {
    pub state: LiveState,
    spec: SidecarSpec,
    sidecar: Option<Sidecar>,
    messages: mpsc::Receiver<SidecarMsg>,
}

impl LiveApp {
    pub fn start(spec: SidecarSpec) -> LiveApp {
        let (_, messages) = mpsc::channel();
        let mut app = LiveApp {
            state: LiveState::new(),
            spec,
            sidecar: None,
            messages,
        };
        app.spawn();
        app
    }

    fn spawn(&mut self) {
        let (sender, messages) = mpsc::channel();
        self.messages = messages;
        match Sidecar::spawn(&self.spec, sender) {
            Ok(sidecar) => self.sidecar = Some(sidecar),
            Err(err) => self.state.fail(
                format!(
                    "Could not start the agent sidecar with {}: {err}",
                    self.spec.program
                ),
                None,
                Vec::new(),
            ),
        }
    }

    /// Applies every pending sidecar message. Returns true when the screen needs a redraw.
    pub fn pump(&mut self) -> bool {
        let mut changed = false;
        while self.sidecar.is_some() {
            let Ok(message) = self.messages.try_recv() else {
                break;
            };
            changed = true;
            match message {
                SidecarMsg::Event(event) => {
                    let ended = matches!(*event, Event::TurnResult { .. });
                    self.state.apply(*event);
                    if ended && let Some(sidecar) = &self.sidecar {
                        sidecar.forget_stderr();
                    }
                    for action in self.state.take_outbox() {
                        self.handle(action);
                    }
                    if matches!(self.state.link, Link::Crashed { .. })
                        && let Some(mut sidecar) = self.sidecar.take()
                    {
                        sidecar.reap(Duration::ZERO);
                    }
                }
                SidecarMsg::Malformed => self.stop(
                    "The agent sidecar wrote output that is not part of the protocol.",
                    Duration::ZERO,
                ),
                SidecarMsg::Closed => {
                    self.stop("The agent sidecar exited unexpectedly.", EXIT_GRACE)
                }
            }
        }
        changed
    }

    fn stop(&mut self, reason: &str, grace: Duration) {
        if let Some(mut sidecar) = self.sidecar.take() {
            let code = sidecar.reap(grace);
            let reason = match (code, sidecar.signal()) {
                (None, Some(signal)) => format!("{reason} It was ended by signal {signal}{}.", match signal {
                    9 => " (SIGKILL)",
                    15 => " (SIGTERM)",
                    11 => " (SIGSEGV)",
                    6 => " (SIGABRT)",
                    _ => "",
                }),
                _ => reason.to_string(),
            };
            self.state.fail(reason, code, sidecar.stderr_tail());
        }
    }

    /// Carries out an operator action. Returns false when the app should exit.
    pub fn handle(&mut self, action: Action) -> bool {
        match action {
            Action::Send(command) => {
                if let Some(sidecar) = self.sidecar.as_mut() {
                    if matches!(command, Command::PromptSubmit { .. }) {
                        sidecar.forget_stderr();
                    }
                    // A failed write means the child is gone; its Closed message reports that.
                    let _ = sidecar.send(&command);
                }
                true
            }
            Action::Quit => {
                if let Some(sidecar) = self.sidecar.take() {
                    sidecar.shutdown(SHUTDOWN_GRACE);
                }
                false
            }
            Action::Restart => {
                if let Some(mut sidecar) = self.sidecar.take() {
                    sidecar.reap(Duration::ZERO);
                }
                self.state.restarted();
                self.spawn();
                true
            }
        }
    }
}

/// Restores the terminal on every exit path. ratatui's panic hook restores raw mode and the alternate screen
/// but not bracketed paste or the keyboard protocol, so those are undone here, during unwinding as well.
struct TerminalGuard {
    keyboard_protocol: bool,
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.keyboard_protocol {
            let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(io::stdout(), DisableBracketedPaste);
        ratatui::restore();
    }
}

pub fn run_live(spec: SidecarSpec) -> Result<(), Box<dyn std::error::Error>> {
    install_stop_signals();
    spawn_stop_watchdog();
    let mut guard = TerminalGuard {
        keyboard_protocol: false,
    };
    let depth = crate::theme::Depth::from_env();
    crate::theme::apply_backend_policy(depth);
    let mut terminal = ratatui::try_init()?;
    execute!(io::stdout(), EnableBracketedPaste)?;
    // Lets Shift+Enter arrive as its own key on terminals that speak the kitty keyboard protocol.
    if terminal::supports_keyboard_enhancement().unwrap_or(false) {
        execute!(
            io::stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
        guard.keyboard_protocol = true;
    }
    let mut app = LiveApp::start(spec);
    app.state.depth = depth;
    let result = event_loop(&mut terminal, &mut app);
    app.handle(Action::Quit);
    result
}

fn draw(terminal: &mut ratatui::DefaultTerminal, app: &mut LiveApp) -> io::Result<()> {
    app.state.set_now(Instant::now());
    let mut layout = LiveLayout::default();
    terminal.draw(|frame| layout = render_live(frame, &app.state))?;
    app.state.note_layout(layout);
    Ok(())
}

/// A key a terminal without bracketed paste would deliver as part of pasted text.
/// Applies pending sidecar messages. When they open an approval, input already queued (and a stashed event) is
/// discarded. Returns whether the screen changed and whether an approval opened.
fn pump_guarding_approvals(app: &mut LiveApp, pending: &mut Option<TermEvent>) -> (bool, bool) {
    let before = app.state.approval_id().map(str::to_string);
    let mut changed = app.pump();
    let opened = app.state.approval_id().is_some_and(|id| before.as_deref() != Some(id));
    if opened {
        if pending.as_ref().is_some_and(|event| !matches!(event, TermEvent::Resize(..))) {
            *pending = None;
        }
        let queued = std::iter::from_fn(|| match event::poll(Duration::ZERO) {
            Ok(true) => event::read().ok(),
            _ => None,
        });
        changed |= discard_queued_input(queued);
    }
    (changed, opened)
}

/// Input that was already queued when an approval opened was typed before the operator could see the panel: it is
/// discarded (keys and pastes), never read as a decision. Returns whether a resize was among it (the frame redraws).
// `fold`, not `any`: every queued event must be read and dropped; `any` would stop at a resize and leave keys queued.
#[allow(clippy::unnecessary_fold)]
fn discard_queued_input(queued: impl Iterator<Item = TermEvent>) -> bool {
    queued.fold(false, |resized, event| resized || matches!(event, TermEvent::Resize(..)))
}

/// Several keys arriving together (typed faster than anyone decides, or pasted by a terminal without bracketed
/// paste) never answer an approval; one deliberate key does.
fn burst_may_answer(approval_open: bool, keys: usize) -> bool {
    !approval_open || keys <= 1
}

fn pasteable(key: &KeyEvent) -> bool {
    key.kind == KeyEventKind::Press
        && !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char(_) | KeyCode::Enter | KeyCode::Tab)
}

/// Text of a burst of keys that arrived together. Without bracketed paste a paste is typed at machine speed, so its
/// keys are already queued when the first is read. A line break inside the burst (with more text after it) means
/// pasted lines, which must not send at the first newline; a trailing Enter is always a key, so a line typed or
/// sent quickly still submits.
fn burst_text(keys: &[KeyEvent]) -> Option<String> {
    let enter_inside = keys
        .iter()
        .position(|key| key.code == KeyCode::Enter)
        .is_some_and(|at| at + 1 < keys.len());
    if !enter_inside {
        return None;
    }
    Some(
        keys.iter()
            .map(|key| match key.code {
                KeyCode::Char(c) => c,
                KeyCode::Tab => '\t',
                _ => '\n',
            })
            .collect(),
    )
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut LiveApp,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut redraw = true;
    // Frame index of the activity animation last drawn; the loop redraws when the clock moves past it, so the
    // indicator advances during slow inference and tools without any sidecar event, and idles otherwise.
    let mut drawn_frame: Option<u128> = None;
    let mut pending: Option<TermEvent> = None;
    loop {
        if stop_requested() {
            app.state.closing = true;
            draw(terminal, app)?;
            return Ok(());
        }
        let (changed, _) = pump_guarding_approvals(app, &mut pending);
        redraw |= changed;
        let frame = app
            .state
            .animating()
            .then(|| app.state.turn_started.map(|t| t.elapsed().as_millis() / FRAME.as_millis()).unwrap_or(0));
        if frame.is_some() && frame != drawn_frame {
            redraw = true;
        }
        if redraw {
            draw(terminal, app)?;
            drawn_frame = frame;
            redraw = false;
        }
        let event = match pending.take() {
            Some(event) => event,
            None => {
                let wait = if frame.is_some() { INPUT_POLL.min(FRAME) } else { INPUT_POLL };
                if !event::poll(wait)? {
                    continue;
                }
                let event = event::read()?;
                // Sidecar messages that arrived while waiting are applied before this input: if they opened an
                // approval, the input was typed before the panel existed and is discarded with the rest.
                let (changed, opened) = pump_guarding_approvals(app, &mut pending);
                redraw |= changed;
                if opened && !matches!(event, TermEvent::Resize(..)) {
                    continue;
                }
                event
            }
        };
        let action = match event {
            TermEvent::Key(key) if pasteable(&key) && event::poll(Duration::ZERO)? => {
                let mut keys = vec![key];
                while event::poll(Duration::ZERO)? {
                    match event::read()? {
                        TermEvent::Key(next) if pasteable(&next) => keys.push(next),
                        TermEvent::Key(next) if next.kind != KeyEventKind::Press => {}
                        other => {
                            pending = Some(other);
                            break;
                        }
                    }
                }
                match burst_text(&keys) {
                    _ if !burst_may_answer(app.state.approval_id().is_some(), keys.len()) => {
                        app.state.note_input_ignored_by_approval(Instant::now());
                        None
                    }
                    Some(text) => {
                        app.state.on_paste(&text);
                        None
                    }
                    None => {
                        let mut last = None;
                        for key in keys {
                            if let Some(action) = app.state.on_key(key) {
                                last = Some(action);
                                break;
                            }
                        }
                        last
                    }
                }
            }
            TermEvent::Key(key) if key.kind == KeyEventKind::Press => app.state.on_key(key),
            TermEvent::Paste(text) => {
                app.state.on_paste(&text);
                None
            }
            TermEvent::Resize(_, _) => None,
            _ => continue,
        };
        redraw = true;
        let Some(action) = action else {
            continue;
        };
        if action == Action::Quit {
            app.state.closing = true;
            draw(terminal, app)?;
        }
        if !app.handle(action) {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn input_queued_when_an_approval_opens_is_discarded_and_bursts_never_decide() {
        use crossterm::event::{Event as TermEvent, KeyCode, KeyEvent, KeyModifiers};
        let queued = vec![
            TermEvent::Key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)),
            TermEvent::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            TermEvent::Paste("y\n".into()),
        ];
        let mut source = queued.into_iter();
        assert!(!discard_queued_input(&mut source), "no resize among the queued input");
        assert!(source.next().is_none(), "everything queued was consumed, none of it handled");
        let with_resize = vec![TermEvent::Key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)), TermEvent::Resize(80, 24)];
        assert!(discard_queued_input(with_resize.into_iter()), "a queued resize still redraws");
        assert!(!burst_may_answer(true, 3), "a burst never answers an approval");
        assert!(burst_may_answer(true, 1), "a single deliberate key may");
        assert!(burst_may_answer(false, 5), "bursts outside approvals are typing or paste as before");
    }

    use super::*;
    use crate::live_state::{APPROVAL_GRACE, Detail, Entry, Loaded, Overlay, Verdict};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::time::Instant;

    const HELLO: &str = r#"echo '{"v":1,"type":"hello","protocol":1,"pid":1}'; echo '{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":false}'"#;

    fn fake_sidecar(script: &str) -> SidecarSpec {
        SidecarSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
        }
    }

    fn pump_until(app: &mut LiveApp, done: impl Fn(&LiveState) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(&app.state) {
            assert!(
                Instant::now() < deadline,
                "timed out; link {:?}, transcript {:?}",
                app.state.link,
                app.state.transcript
            );
            app.pump();
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn drives_a_full_turn_and_quits_cleanly() {
        let script = format!(
            r#"{HELLO}
read prompt
case "$prompt" in *'"type":"prompt.submit"'*) ;; *) exit 9;; esac
case "$prompt" in *'"text":"hi"'*) ;; *) exit 9;; esac
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":true}}'
echo '{{"v":1,"type":"assistant.delta","turn_id":"t1","text":"Hello from the fake agent."}}'
echo '{{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - NO CHANGES TO VERIFY","line":"No files changed","turn":{{"execution":"COMPLETED","outcome":"NOT_REQUIRED"}},"model_summary":null}}'
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":false}}'
read shutdown
case "$shutdown" in *'"type":"shutdown"'*) exit 0;; *) exit 8;; esac"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| {
            s.link == Link::Ready && s.session.model == "m"
        });
        for code in [KeyCode::Char('h'), KeyCode::Char('i'), KeyCode::Enter] {
            if let Some(action) = app.state.on_key(KeyEvent::new(code, KeyModifiers::NONE)) {
                assert!(app.handle(action));
            }
        }
        pump_until(&mut app, |s| {
            !s.session.busy
                && s.transcript
                    .iter()
                    .any(|e| matches!(e, Entry::Banner { .. }))
        });
        assert!(app.state.transcript.iter().any(
            |e| matches!(e, Entry::Assistant { text, .. } if text == "Hello from the fake agent.")
        ));
        assert_eq!(
            app.state.link,
            Link::Ready,
            "the fake exits 9 on an unexpected prompt, which would crash the link"
        );
        let quit = app
            .state
            .on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(quit, Some(Action::Quit));
        assert!(!app.handle(quit.unwrap()));
    }

    #[test]
    fn an_approval_round_trips_through_the_sidecar() {
        let script = format!(
            r#"{HELLO}
read prompt
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"review","git":null,"busy":true}}'
echo '{{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{{}}","review":{{"kind":"change","path":"x.txt","before":null,"after":"hi","created":true,"truncated":false}}}}'
read answer
case "$answer" in *'"type":"approve"'*) ;; *) exit 7;; esac
case "$answer" in *'"id":"approval-1"'*) ;; *) exit 7;; esac
case "$answer" in *'"always":false'*) ;; *) exit 7;; esac
echo '{{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - UNVERIFIED","line":"x.txt written","turn":{{"execution":"COMPLETED","outcome":"UNVERIFIED"}},"model_summary":null}}'
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"review","git":null,"busy":false}}'
read shutdown
exit 0"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| {
            s.link == Link::Ready && s.session.model == "m"
        });
        for code in [KeyCode::Char('g'), KeyCode::Char('o'), KeyCode::Enter] {
            if let Some(action) = app.state.on_key(KeyEvent::new(code, KeyModifiers::NONE)) {
                assert!(app.handle(action));
            }
        }
        pump_until(&mut app, |s| {
            matches!(s.overlay, Some(Overlay::Approval(_)))
        });
        // No decision before the panel is on screen: the first frame marks it shown and starts the grace period.
        assert_eq!(app.state.on_key_at(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE), Instant::now()), None);
        // Drawn a moment after the operator last typed (so `y` may answer it).
        app.state.note_approval_shown(Instant::now() + crate::live_state::APPROVAL_TYPING_RECENT);
        let Some(Overlay::Approval(approval)) = &app.state.overlay else {
            unreachable!("pump_until waited for the approval modal");
        };
        // The `y` pressed before the panel was drawn went into it: its letters are not answers. After the display grace
        // and a pause, ← chooses Approve and Enter, once the choice has been on screen a moment, takes it.
        let past_grace = approval.opened + APPROVAL_GRACE + crate::live_state::APPROVAL_QUIET;
        assert_eq!(app.state.on_key_at(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE), past_grace), None);
        // Letters are off on this panel, so approving takes Enter twice.
        assert_eq!(app.state.on_key_at(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), past_grace + crate::live_state::APPROVAL_TYPING_RECENT), None);
        let approve = app
            .state
            .on_key_at(
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                past_grace + crate::live_state::APPROVAL_TYPING_RECENT + crate::live_state::APPROVAL_CHOICE_SHOWN,
            )
            .unwrap();
        assert!(app.handle(approve));
        pump_until(&mut app, |s| {
            !s.session.busy
                && s.transcript
                    .iter()
                    .any(|e| matches!(e, Entry::Banner { .. }))
        });
        assert_eq!(
            app.state.link,
            Link::Ready,
            "the fake exits 7 on a wrong answer"
        );
        assert!(app.state.transcript.iter().any(|e| matches!(
            e,
            Entry::Decision {
                verdict: Verdict::Approved,
                ..
            }
        )));
        assert!(!app.handle(Action::Quit));
    }

    #[test]
    fn a_slash_command_round_trips_through_the_sidecar() {
        let script = format!(
            r#"{HELLO}
read cmd
case "$cmd" in *'"type":"slash"'*) ;; *) exit 9;; esac
case "$cmd" in *'"command":"diff"'*) ;; *) exit 9;; esac
case "$cmd" in *'"id":"s1"'*) ;; *) exit 9;; esac
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":true}}'
echo '{{"v":1,"type":"slash.result","id":"s1","command":"diff","success":true,"output":"+added line","format":"diff"}}'
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"auto","git":null,"busy":false}}'
read shutdown
case "$shutdown" in *'"type":"shutdown"'*) exit 0;; *) exit 8;; esac"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| {
            s.link == Link::Ready && s.session.model == "m"
        });
        for c in "/diff".chars() {
            assert_eq!(
                app.state
                    .on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)),
                None
            );
        }
        let send = app
            .state
            .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .expect("enter sends the command");
        assert!(app.handle(send));
        pump_until(&mut app, |s| {
            !s.session.busy
                && s.transcript.iter().any(|e| {
                    matches!(e, Entry::Output { text, diff: true, .. } if text == "+added line")
                })
        });
        assert_eq!(app.state.link, Link::Ready);
        let quit = app
            .state
            .on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(quit, Some(Action::Quit));
        assert!(!app.handle(quit.unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn sigterm_requests_a_clean_stop_once() {
        install_stop_signals();
        assert!(!stop_requested());
        // SAFETY: the handler installed above only stores to an atomic.
        unsafe {
            libc::raise(libc::SIGTERM);
        }
        assert!(stop_requested());
        assert!(!stop_requested(), "the request is consumed");
    }

    #[test]
    fn an_exiting_sidecar_becomes_a_crash_screen_and_restart_starts_a_new_one() {
        let script = format!("{HELLO}; echo 'fatal: gateway exploded' >&2; exit 4");
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| matches!(s.link, Link::Crashed { .. }));
        let Link::Crashed {
            code,
            stderr,
            reason,
        } = app.state.link.clone()
        else {
            unreachable!()
        };
        assert_eq!(code, Some(4));
        assert_eq!(stderr, vec!["fatal: gateway exploded".to_string()]);
        assert!(reason.contains("exited unexpectedly"));
        assert!(app.handle(Action::Restart));
        assert_eq!(app.state.link, Link::Connecting);
        pump_until(&mut app, |s| matches!(s.link, Link::Crashed { .. }));
        assert!(
            app.state
                .transcript
                .iter()
                .any(|e| matches!(e, Entry::Notice(text) if text.contains("does not remember")))
        );
    }

    #[test]
    fn non_protocol_output_stops_the_sidecar_promptly() {
        let script = format!("{HELLO}; echo 'Compiling project...'; exec sleep 30");
        let started = Instant::now();
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(
            &mut app,
            |s| matches!(&s.link, Link::Crashed { reason, .. } if reason.contains("not part of the protocol")),
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_burst_with_a_line_break_inside_is_a_paste_but_quick_typing_is_not() {
        let k = |c: char| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
        let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(burst_text(&[k('a'), enter, k('b')]), Some("a\nb".into()));
        assert_eq!(burst_text(&[k('o'), k('k'), enter]), None, "a typed line then Enter still sends");
        assert_eq!(burst_text(&[k('x'), k('y')]), None);
        let mut typed: Vec<KeyEvent> = "a long line sent by a script".chars().map(k).collect();
        typed.push(enter);
        assert_eq!(burst_text(&typed), None, "a quickly sent line still submits on its trailing Enter");
        assert!(!pasteable(&KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)));
    }

    #[test]
    fn launch_errors_read_as_plain_text_with_exit_status_1() {
        let mut stderr = Vec::new();
        assert_eq!(main(vec!["--bogus".into()], &mut stderr), 1);
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            format!("nexus-tui: unknown option --bogus\n{LIVE_USAGE}\n")
        );
    }

    #[test]
    fn a_missing_program_is_reported_not_panicked() {
        let app = LiveApp::start(SidecarSpec {
            program: "/nonexistent/node".into(),
            args: vec![],
        });
        assert!(
            matches!(&app.state.link, Link::Crashed { reason, .. } if reason.contains("Could not start"))
        );
    }

    #[test]
    fn resolve_spec_prefers_flags_then_env_then_the_build_layout() {
        let root = std::env::temp_dir().join(format!("nexus-live-spec-{}", std::process::id()));
        let dist = root.join("cli/dist");
        std::fs::create_dir_all(&dist).unwrap();
        let bundled = dist.join("sidecar.js");
        std::fs::write(&bundled, "").unwrap();
        let custom = root.join("custom.js");
        std::fs::write(&custom, "").unwrap();
        let exe = root.join("core/target/release/nexus-tui");

        let from_layout = resolve_spec(
            vec!["--".into(), "-m".into(), "deep".into()],
            None,
            None,
            Some(exe.clone()),
        )
        .unwrap();
        assert_eq!(
            from_layout,
            SidecarSpec {
                program: "node".into(),
                args: vec![bundled.display().to_string(), "-m".into(), "deep".into()]
            }
        );
        let from_env = resolve_spec(
            vec![],
            Some(custom.display().to_string()),
            Some("/opt/node".into()),
            Some(exe.clone()),
        )
        .unwrap();
        assert_eq!(
            from_env,
            SidecarSpec {
                program: "/opt/node".into(),
                args: vec![custom.display().to_string()]
            }
        );
        let from_flags = resolve_spec(
            vec![
                "--sidecar".into(),
                bundled.display().to_string(),
                "--node".into(),
                "nodejs".into(),
            ],
            Some(custom.display().to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            from_flags,
            SidecarSpec {
                program: "nodejs".into(),
                args: vec![bundled.display().to_string()]
            }
        );
        assert!(
            resolve_spec(
                vec![],
                Some(root.join("missing.js").display().to_string()),
                None,
                None
            )
            .unwrap_err()
            .contains("make build")
        );
        assert!(
            resolve_spec(vec!["--bogus".into()], None, None, Some(exe))
                .unwrap_err()
                .contains("unknown option --bogus")
        );
        assert!(
            resolve_spec(vec!["--node".into()], None, None, None)
                .unwrap_err()
                .contains("usage")
        );

        // Test NEXUS_HOME resolution
        let pkg_root = root.join("packaged");
        let pkg_sidecar = pkg_root.join("lib/cli/dist/sidecar.js");
        std::fs::create_dir_all(pkg_sidecar.parent().unwrap()).unwrap();
        std::fs::write(&pkg_sidecar, "").unwrap();
        unsafe { std::env::set_var("NEXUS_HOME", &pkg_root) };
        let from_pkg = resolve_spec(vec![], None, None, None).unwrap();
        assert_eq!(
            from_pkg,
            SidecarSpec {
                program: "node".into(),
                args: vec![pkg_sidecar.display().to_string()]
            }
        );
        // --check option
        let check_spec = resolve_spec(vec!["--check".into()], None, None, None).unwrap();
        assert_eq!(check_spec.args, vec![pkg_sidecar.display().to_string()]);
        // Missing sidecar with NEXUS_HOME set and invalid exe lists tried paths
        let bogus_home = root.join("bogus_pkg");
        unsafe { std::env::set_var("NEXUS_HOME", &bogus_home) };
        let bogus_exe = root.join("bogus/core/target/release/nexus-tui");
        let err = resolve_spec(vec![], None, None, Some(bogus_exe)).unwrap_err();
        assert!(err.contains("tried:"));
        unsafe { std::env::remove_var("NEXUS_HOME") };

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_tool_detail_round_trips_through_the_sidecar() {
        let script = format!(
            r#"{HELLO}
echo '{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"a","tool":"read_file","subject":"a.ts","evidence":"e1"}}'
echo '{{"v":1,"type":"tool.end","turn_id":"t1","call_id":"a","tool":"read_file","success":true,"summary":"ok","lines":1,"evidence":"e1"}}'
read cmd
case "$cmd" in *'"type":"tool.detail"'*) ;; *) exit 9;; esac
case "$cmd" in *'"evidence":"e1"'*) ;; *) exit 9;; esac
case "$cmd" in *'"id":"d1"'*) ;; *) exit 9;; esac
echo '{{"v":1,"type":"tool.detail","id":"d1","evidence":"e1","tool":"read_file","subject":"a.ts","status":"succeeded","args":"{{}}","output":"const a = 1;","duration_ms":3}}'
read shutdown
case "$shutdown" in *'"type":"shutdown"'*) exit 0;; *) exit 8;; esac"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| {
            s.link == Link::Ready
                && s.transcript
                    .iter()
                    .any(|e| matches!(e, Entry::Tool { evidence, .. } if evidence == "e1"))
        });
        for code in [KeyCode::Tab, KeyCode::Char('[')] {
            assert_eq!(
                app.state.on_key(KeyEvent::new(code, KeyModifiers::NONE)),
                None
            );
        }
        let send = app
            .state
            .on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .expect("enter requests the detail");
        assert!(app.handle(send));
        pump_until(&mut app, |s| {
            matches!(&s.overlay, Some(Overlay::Detail(Detail { record: Loaded::Ready(record), .. }))
                if record.output == "const a = 1;")
        });
        assert_eq!(app.state.link, Link::Ready);
        assert_eq!(
            app.state
                .on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            None
        );
        let quit = app
            .state
            .on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(quit, Some(Action::Quit));
        assert!(!app.handle(quit.unwrap()));
    }
}
