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
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, Event as TermEvent, KeyCode, KeyEvent,
        KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
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
        restore_input_modes_unlocked();
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

/// The input modes this process switched on, so every exit path undoes exactly those (and only once).
static MOUSE_ON: AtomicBool = AtomicBool::new(false);
static KEYBOARD_ON: AtomicBool = AtomicBool::new(false);
static PASTE_ON: AtomicBool = AtomicBool::new(false);

/// Whether mouse capture is wanted: on unless `NEXUS_TUI_MOUSE` is `off` (also `0`, `false`, `no`, `none`).
pub(crate) fn mouse_enabled(value: Option<&str>) -> bool {
    !value.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no" | "none"))
}

/// Asks the terminal for button presses and the wheel in SGR form (modes 1000 and 1006), and nothing else: no drag or
/// motion reports, so the loop is not flooded and Shift-drag still selects text in the terminal's own way.
#[cfg(unix)]
pub(crate) struct WheelAndClick;

#[cfg(unix)]
impl crossterm::Command for WheelAndClick {
    fn write_ansi(&self, f: &mut impl std::fmt::Write) -> std::fmt::Result {
        f.write_str("\x1b[?1000h\x1b[?1006h")
    }
}

#[cfg(unix)]
fn enable_mouse() -> io::Result<()> {
    execute!(io::stdout(), WheelAndClick)
}

/// Windows consoles report mouse input through their own API, which crossterm's capture command drives.
#[cfg(not(unix))]
fn enable_mouse() -> io::Result<()> {
    execute!(io::stdout(), crossterm::event::EnableMouseCapture)
}

/// Undoes the input modes (mouse, then keyboard protocol, then bracketed paste). Safe to call from any exit path any number of times: the
/// panic hook runs it before the message is printed, the guard on every return and during unwinding.
fn restore_input_modes() {
    let mut out = io::stdout();
    if MOUSE_ON.swap(false, Ordering::SeqCst) {
        let _ = execute!(out, DisableMouseCapture);
    }
    if KEYBOARD_ON.swap(false, Ordering::SeqCst) {
        let _ = execute!(out, PopKeyboardEnhancementFlags);
    }
    if PASTE_ON.swap(false, Ordering::SeqCst) {
        let _ = execute!(out, DisableBracketedPaste);
    }
}

/// The same restore for the stop watchdog, which cannot risk waiting on the stdout lock a stuck loop may hold: raw
/// bytes straight to the terminal.
#[cfg(unix)]
fn restore_input_modes_unlocked() {
    let write = |bytes: &[u8]| {
        // SAFETY: write(2) on a valid fd with a valid buffer; the result is ignored on purpose.
        unsafe {
            libc::write(libc::STDOUT_FILENO, bytes.as_ptr().cast(), bytes.len());
        }
    };
    if MOUSE_ON.swap(false, Ordering::SeqCst) {
        write(b"\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
    }
    if KEYBOARD_ON.swap(false, Ordering::SeqCst) {
        write(b"\x1b[<1u");
    }
    if PASTE_ON.swap(false, Ordering::SeqCst) {
        write(b"\x1b[?2004l");
    }
}

#[cfg(not(unix))]
fn restore_input_modes_unlocked() {}

/// Restores the terminal on every exit path. ratatui's panic hook restores raw mode and the alternate screen
/// but not the input modes (mouse, bracketed paste, keyboard protocol), so those are undone here, during unwinding as
/// well, and by a panic hook installed after ratatui's so they are off before the panic message is printed.
struct TerminalGuard;

/// Reads and drops input until nothing arrives for `quiet` (at most `limit` events); returns how many were dropped.
fn drain_input(mut next: impl FnMut(Duration) -> io::Result<Option<TermEvent>>, quiet: Duration, limit: usize) -> usize {
    let mut dropped = 0;
    while dropped < limit && matches!(next(quiet), Ok(Some(_))) {
        dropped += 1;
    }
    dropped
}

/// Drops what the terminal sent that nothing will read (mouse reports still in flight when capture was turned off).
fn drain_terminal_input() {
    drain_input(|wait| Ok(if event::poll(wait)? { Some(event::read()?) } else { None }), Duration::from_millis(30), 4096);
}

/// Discards unread bytes in the tty input queue, so none reaches the shell as typed text once cooked mode is back.
fn flush_stdin() {
    #[cfg(unix)]
    // SAFETY: tcflush on the stdin descriptor has no memory effects; a failure (not a tty) is ignored.
    unsafe {
        libc::tcflush(libc::STDIN_FILENO, libc::TCIFLUSH);
    }
}

/// The order that keeps input bytes from the shell: stop the terminal reporting, drop what already arrived, run the
/// slow shutdown (during which reports still in flight keep arriving), then drop those too.
fn end_session(modes_off: impl FnOnce(), mut drain: impl FnMut(), shutdown: impl FnOnce()) {
    modes_off();
    drain();
    shutdown();
    drain();
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_input_modes();
        flush_stdin();
        ratatui::restore();
    }
}

pub fn run_live(spec: SidecarSpec) -> Result<(), Box<dyn std::error::Error>> {
    install_stop_signals();
    spawn_stop_watchdog();
    let guard = TerminalGuard;
    let depth = crate::theme::Depth::from_env();
    crate::theme::apply_backend_policy(depth);
    let mut terminal = ratatui::try_init()?;
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().name() == Some("main") {
            restore_input_modes();
        }
        previous_hook(info);
    }));
    // Each flag is set before its sequence is written, so a write that fails halfway is still undone.
    PASTE_ON.store(true, Ordering::SeqCst);
    execute!(io::stdout(), EnableBracketedPaste)?;
    // Lets Shift+Enter arrive as its own key on terminals that speak the kitty keyboard protocol. Terminals that do
    // not answer the query (tmux without extended keys, most others) send it as a plain Enter, so it is not advertised.
    let shift_enter = terminal::supports_keyboard_enhancement().unwrap_or(false);
    if shift_enter {
        KEYBOARD_ON.store(true, Ordering::SeqCst);
        execute!(
            io::stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
    }
    let mouse = mouse_enabled(std::env::var("NEXUS_TUI_MOUSE").ok().as_deref());
    if mouse {
        MOUSE_ON.store(true, Ordering::SeqCst);
        enable_mouse()?;
    }
    let mut app = LiveApp::start(spec);
    app.state.depth = depth;
    app.state.shift_enter = shift_enter;
    app.state.mouse = mouse;
    let result = event_loop(&mut terminal, &mut app);
    // The sidecar shutdown can take seconds: reports arriving meanwhile would reach the shell as text.
    end_session(restore_input_modes, drain_terminal_input, || {
        app.handle(Action::Quit);
    });
    drop(terminal);
    drop(guard);
    if let Some(breadcrumb) = maybe_format_exit_breadcrumb(&app.state) {
        println!("{breadcrumb}");
    }
    result
}

pub fn maybe_format_exit_breadcrumb(state: &LiveState) -> Option<String> {
    if state.session_saved {
        state.session.session_id.as_deref().map(format_exit_breadcrumb)
    } else {
        None
    }
}

pub fn format_exit_breadcrumb(session_id: &str) -> String {
    format!("Nexus session {session_id} saved. Resume with: nexus --resume {session_id}")
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
/// discarded, and the panel says a key was ignored. Returns whether the screen changed and whether an approval opened.
fn pump_guarding_approvals(app: &mut LiveApp, pending: &mut Option<TermEvent>) -> (bool, bool) {
    let before = app.state.approval_id().map(str::to_string);
    let mut changed = app.pump();
    let opened = app.state.approval_id().is_some_and(|id| before.as_deref() != Some(id));
    if opened {
        let mut typed = false;
        if pending.as_ref().is_some_and(|event| !matches!(event, TermEvent::Resize(..))) {
            typed = pending.as_ref().is_some_and(is_typing);
            *pending = None;
        }
        let queued = std::iter::from_fn(|| match event::poll(Duration::ZERO) {
            Ok(true) => event::read().ok(),
            _ => None,
        });
        let (resized, queued_typing) = discard_queued_input(queued);
        changed |= resized;
        if typed || queued_typing {
            app.state.note_approval_input_ignored();
        }
    }
    (changed, opened)
}

/// Input that was already queued when an approval opened was typed before the operator could see the panel: it is
/// discarded (keys and pastes), never read as a decision. Returns whether a resize was among it (the frame redraws)
/// and whether keys or a paste were (the panel says a key was ignored).
// `fold`, not `any`: every queued event must be read and dropped; `any` would stop at a resize and leave keys queued.
fn discard_queued_input(queued: impl Iterator<Item = TermEvent>) -> (bool, bool) {
    queued.fold((false, false), |(resized, typed), event| (resized || matches!(event, TermEvent::Resize(..)), typed || is_typing(&event)))
}

/// A key press or a paste (input the operator typed), as opposed to a resize, mouse or focus event.
fn is_typing(event: &TermEvent) -> bool {
    matches!(event, TermEvent::Key(key) if key.kind == KeyEventKind::Press) || matches!(event, TermEvent::Paste(_))
}

/// The key presses queued behind `first`, read until something else arrives (kept in `pending`). Several presses of
/// any kind arriving together are typed faster than anyone decides, or pasted by a terminal without bracketed paste.
fn drain_key_presses(first: KeyEvent, mut next: impl FnMut() -> io::Result<Option<TermEvent>>, pending: &mut Option<TermEvent>) -> io::Result<Vec<KeyEvent>> {
    let mut keys = vec![first];
    while let Some(event) = next()? {
        match event {
            TermEvent::Key(key) if key.kind == KeyEventKind::Press => keys.push(key),
            TermEvent::Key(_) | TermEvent::Mouse(_) => {}
            other => {
                *pending = Some(other);
                break;
            }
        }
    }
    Ok(keys)
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

fn is_wheel(mouse: &MouseEvent) -> bool {
    matches!(mouse.kind, MouseEventKind::ScrollUp | MouseEventKind::ScrollDown)
}

/// A wheel notch and the wheel notches queued right behind it: every one scrolls, but the screen is drawn once (a
/// trackpad flings hundreds). The first other event is kept in `pending`.
fn apply_wheel_run(state: &mut LiveState, first: MouseEvent, mut next: impl FnMut() -> io::Result<Option<TermEvent>>, pending: &mut Option<TermEvent>) -> io::Result<Option<Action>> {
    let action = state.on_mouse(first);
    for _ in 0..512 {
        match next()? {
            None => break,
            Some(TermEvent::Mouse(mouse)) if is_wheel(&mouse) => {
                state.on_mouse(mouse);
            }
            Some(other) => {
                *pending = Some(other);
                break;
            }
        }
    }
    Ok(action)
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
                    if is_typing(&event) {
                        app.state.note_approval_input_ignored();
                    }
                    continue;
                }
                event
            }
        };
        let action = match event {
            // Several presses at an open approval (a `Left` then a `y` at machine speed included) never answer it.
            TermEvent::Key(key) if key.kind == KeyEventKind::Press && app.state.approval_id().is_some() && event::poll(Duration::ZERO)? => {
                let keys = drain_key_presses(key, || Ok(if event::poll(Duration::ZERO)? { Some(event::read()?) } else { None }), &mut pending)?;
                app.state.on_key_burst(keys)
            }
            TermEvent::Key(key) if pasteable(&key) && event::poll(Duration::ZERO)? => {
                let mut keys = vec![key];
                while event::poll(Duration::ZERO)? {
                    match event::read()? {
                        TermEvent::Key(next) if pasteable(&next) => keys.push(next),
                        TermEvent::Key(next) if next.kind != KeyEventKind::Press => {}
                        // A wheel notch or click inside a burst does not end it (that would split a paste, or turn
                        // a burst into a lone key press): it is dropped.
                        TermEvent::Mouse(_) => {}
                        other => {
                            pending = Some(other);
                            break;
                        }
                    }
                }
                match burst_text(&keys) {
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
            // Wheel and left button only: releases and anything else neither act nor redraw.
            TermEvent::Mouse(mouse) if is_wheel(&mouse) => apply_wheel_run(&mut app.state, mouse, || Ok(if event::poll(Duration::ZERO)? { Some(event::read()?) } else { None }), &mut pending)?,
            TermEvent::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => app.state.on_mouse(mouse),
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
    fn mouse_capture_is_on_unless_the_operator_turns_it_off() {
        for on in [None, Some(""), Some("on"), Some("1"), Some("true"), Some("auto"), Some("garbage")] {
            assert!(mouse_enabled(on), "{on:?}");
        }
        for off in ["off", "OFF", "Off", "0", "false", "no", "none", " off "] {
            assert!(!mouse_enabled(Some(off)), "{off:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn capture_asks_for_buttons_and_wheel_in_sgr_form_and_no_motion() {
        let mut out = String::new();
        crossterm::Command::write_ansi(&WheelAndClick, &mut out).unwrap();
        assert_eq!(out, "\x1b[?1000h\x1b[?1006h", "press/release and wheel only: no drag or motion floods");
        let mut off = String::new();
        crossterm::Command::write_ansi(&DisableMouseCapture, &mut off).unwrap();
        for mode in ["1000", "1002", "1003", "1006"] {
            assert!(off.contains(&format!("?{mode}l")), "the restore turns {mode} off: {off:?}");
        }
    }

    #[test]
    fn input_queued_when_an_approval_opens_is_discarded() {
        use crossterm::event::{Event as TermEvent, KeyCode, KeyEvent, KeyModifiers};
        let queued = vec![
            TermEvent::Key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)),
            TermEvent::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            TermEvent::Paste("y\n".into()),
        ];
        let mut source = queued.into_iter();
        assert_eq!(discard_queued_input(&mut source), (false, true), "no resize among the queued input; keys were");
        assert!(source.next().is_none(), "everything queued was consumed, none of it handled");
        let with_resize = vec![TermEvent::Key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)), TermEvent::Resize(80, 24)];
        assert_eq!(discard_queued_input(with_resize.into_iter()), (true, true), "a queued resize still redraws");
        assert_eq!(discard_queued_input(std::iter::once(TermEvent::Resize(80, 24))), (true, false), "a resize alone is not typing");
    }

    fn wheel(kind: MouseEventKind) -> MouseEvent {
        MouseEvent { kind, column: 3, row: 3, modifiers: KeyModifiers::NONE }
    }

    #[test]
    fn a_run_of_wheel_notches_scrolls_each_and_is_drawn_once() {
        let mut state = LiveState::new();
        let mut queue = vec![TermEvent::Mouse(wheel(MouseEventKind::ScrollUp)); 4].into_iter();
        let mut pending = None;
        let action = apply_wheel_run(&mut state, wheel(MouseEventKind::ScrollUp), || Ok(queue.next()), &mut pending).unwrap();
        assert_eq!((action, state.scroll_back), (None, 15), "five notches of three rows, in one call");
        assert!(pending.is_none() && queue.next().is_none());
        // Another kind of event ends the run and is kept for the loop.
        let mut queue = vec![TermEvent::Mouse(wheel(MouseEventKind::ScrollDown)), TermEvent::Resize(80, 24), TermEvent::Mouse(wheel(MouseEventKind::ScrollDown))].into_iter();
        apply_wheel_run(&mut state, wheel(MouseEventKind::ScrollDown), || Ok(queue.next()), &mut pending).unwrap();
        assert_eq!(state.scroll_back, 9);
        assert!(matches!(pending, Some(TermEvent::Resize(80, 24))));
        assert_eq!(queue.len(), 1, "the notch behind the resize was not read");
    }

    #[test]
    fn input_in_flight_is_drained_until_quiet_and_never_forever() {
        let mut left = 5;
        let dropped = drain_input(|_| Ok((left > 0).then(|| { left -= 1; TermEvent::Resize(1, 1) })), Duration::from_millis(1), 100);
        assert_eq!((dropped, left), (5, 0));
        assert_eq!(drain_input(|_| Ok(Some(TermEvent::Resize(1, 1))), Duration::from_millis(1), 100), 100, "a flood is bounded");
        assert_eq!(drain_input(|_| Err(io::Error::other("gone")), Duration::from_millis(1), 100), 0, "an error stops it");
    }

    #[test]
    fn the_session_ends_modes_off_then_drain_then_shutdown_then_drain_again() {
        use std::cell::RefCell;
        let log = RefCell::new(Vec::new());
        end_session(|| log.borrow_mut().push("modes off"), || log.borrow_mut().push("drain"), || log.borrow_mut().push("shutdown"));
        assert_eq!(*log.borrow(), ["modes off", "drain", "shutdown", "drain"]);
    }

    #[test]
    fn a_mouse_event_is_not_typing_and_does_not_split_a_burst() {
        use crossterm::event::{Event as TermEvent, KeyCode, KeyEvent, KeyModifiers, MouseEvent};
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        let wheel = TermEvent::Mouse(MouseEvent { kind: MouseEventKind::ScrollUp, column: 3, row: 3, modifiers: KeyModifiers::NONE });
        let click = TermEvent::Mouse(MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: 3, row: 3, modifiers: KeyModifiers::NONE });
        assert!(!is_typing(&wheel) && !is_typing(&click), "a mouse event is never typing");
        // Input queued as an approval opens: mouse events are dropped with it and do not make the panel say a key was ignored.
        assert_eq!(discard_queued_input(vec![wheel.clone(), click.clone()].into_iter()), (false, false));
        // `y`, a wheel notch, then Enter at an approval is still one burst of two key presses.
        let mut queue = vec![wheel, TermEvent::Key(press(KeyCode::Enter))].into_iter();
        let mut pending = None;
        let keys = drain_key_presses(press(KeyCode::Char('y')), || Ok(queue.next()), &mut pending).unwrap();
        assert_eq!(keys, vec![press(KeyCode::Char('y')), press(KeyCode::Enter)]);
        assert!(pending.is_none());
    }

    #[test]
    fn every_press_queued_at_an_open_approval_counts_toward_the_burst() {
        use crossterm::event::{Event as TermEvent, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
        let press = |code| KeyEvent::new(code, KeyModifiers::NONE);
        let release = KeyEvent { kind: KeyEventKind::Release, state: KeyEventState::NONE, ..press(KeyCode::Char('y')) };
        // `Left` was read first and `y` is queued behind it: both count, and the `y` is text, not an answer.
        let mut queue = vec![TermEvent::Key(press(KeyCode::Char('y'))), TermEvent::Key(release), TermEvent::Resize(80, 24), TermEvent::Key(press(KeyCode::Char('n')))].into_iter();
        let mut pending = None;
        let keys = drain_key_presses(press(KeyCode::Left), || Ok(queue.next()), &mut pending).unwrap();
        assert_eq!(keys, vec![press(KeyCode::Left), press(KeyCode::Char('y'))], "a release is skipped; the drain stops at the resize");
        assert!(matches!(pending, Some(TermEvent::Resize(80, 24))));
    }

    use super::*;
    use crate::live_state::{Detail, Entry, Loaded, Overlay, Verdict};
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
        // No decision before the panel is on screen: the first frame marks it shown.
        assert_eq!(app.state.on_key_at(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE), Instant::now()), None);
        // Drawn a moment after the operator last typed: one `y` approves.
        let shown = Instant::now() + crate::live_state::APPROVAL_IN_FLIGHT;
        app.state.note_approval_shown_and_read(shown);
        let approve = app.state.on_key_at(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE), shown).unwrap();
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
    fn exit_breadcrumb_formats_session_id_and_resume_hint() {
        assert_eq!(
            format_exit_breadcrumb("sess-1234"),
            "Nexus session sess-1234 saved. Resume with: nexus --resume sess-1234"
        );
    }

    #[test]
    fn exit_breadcrumb_only_shown_when_session_was_saved() {
        let mut state = LiveState::new();
        state.session.session_id = Some("sess-1234".into());
        assert_eq!(
            maybe_format_exit_breadcrumb(&state),
            None,
            "fresh session without turns or history must not print breadcrumb"
        );

        state.session_saved = true;
        assert_eq!(
            maybe_format_exit_breadcrumb(&state),
            Some("Nexus session sess-1234 saved. Resume with: nexus --resume sess-1234".into())
        );
    }

    #[test]
    fn a_restarted_sidecar_has_saved_nothing_so_the_breadcrumb_stays_silent_until_it_does() {
        let ev = |line: &str| crate::protocol::parse_event(line).unwrap();
        let session = |id: &str| format!(r#"{{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false,"session":"{id}"}}"#);
        let mut state = LiveState::new();
        state.apply(ev(&session("sess-1")));
        state.apply(ev(r#"{"v":1,"type":"turn.result","id":"t1","heading":"Done","line":"ok","turn":{}}"#));
        assert!(maybe_format_exit_breadcrumb(&state).is_some());
        // `r` after a crash: the new sidecar generates a fresh id and has persisted nothing under it.
        state.restarted();
        state.apply(ev(&session("sess-2")));
        assert_eq!(maybe_format_exit_breadcrumb(&state), None, "sess-2 was never saved");
        // Its first completed turn saves it, and then the breadcrumb names the new id.
        state.apply(ev(r#"{"v":1,"type":"turn.result","id":"t2","heading":"Done","line":"ok","turn":{}}"#));
        assert_eq!(maybe_format_exit_breadcrumb(&state), Some(format_exit_breadcrumb("sess-2")));
    }

    #[test]
    fn a_turn_whose_record_could_not_be_written_does_not_advertise_a_session_to_resume() {
        let ev = |line: &str| crate::protocol::parse_event(line).unwrap();
        let mut state = LiveState::new();
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false,"session":"sess-1"}"#));
        state.apply(ev(r#"{"v":1,"type":"turn.result","id":"t1","heading":"Done","line":"ok","turn":{},"saved":false}"#));
        assert_eq!(maybe_format_exit_breadcrumb(&state), None);
        state.apply(ev(r#"{"v":1,"type":"turn.result","id":"t2","heading":"Done","line":"ok","turn":{},"saved":true}"#));
        assert!(maybe_format_exit_breadcrumb(&state).is_some());
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
