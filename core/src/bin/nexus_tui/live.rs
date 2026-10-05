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
    time::Duration,
};

use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event as TermEvent, KeyEventKind,
        KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute, terminal,
};

use crate::live_state::{Action, Link, LiveLayout, LiveState};
use crate::live_view::render_live;
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
    "usage: nexus-tui --live [--sidecar PATH] [--node BIN] [-- SIDECAR_ARGS...]";

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
    let spec = resolve_spec(
        args,
        env::var("NEXUS_SIDECAR").ok(),
        env::var("NEXUS_NODE").ok(),
        env::current_exe().ok(),
    )?;
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("interactive Nexus TUI requires a terminal".into());
    }
    run_live(spec)
}

/// Resolves the sidecar command line. Precedence: flags, then `NEXUS_SIDECAR` / `NEXUS_NODE`, then the
/// `cli/dist/sidecar.js` of the checkout whose `core/target/<profile>/` holds this binary.
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
            "--sidecar" => sidecar = Some(PathBuf::from(args.next().ok_or(LIVE_USAGE)?)),
            "--node" => node = args.next().ok_or(LIVE_USAGE)?,
            "--" => {
                passthrough.extend(args.by_ref());
                break;
            }
            other => return Err(format!("unknown option {other}\n{LIVE_USAGE}")),
        }
    }
    let sidecar = sidecar
        .or_else(|| {
            exe.and_then(|exe| {
                exe.ancestors()
                    .nth(4)
                    .map(|root| root.join("cli/dist/sidecar.js"))
            })
        })
        .ok_or("cannot locate cli/dist/sidecar.js; pass --sidecar PATH")?;
    if !sidecar.is_file() {
        return Err(format!(
            "sidecar not found at {}; run `make build` or pass --sidecar PATH",
            sidecar.display()
        ));
    }
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
                    self.state.apply(event);
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
            self.state
                .fail(reason.to_string(), code, sidecar.stderr_tail());
        }
    }

    /// Carries out an operator action. Returns false when the app should exit.
    pub fn handle(&mut self, action: Action) -> bool {
        match action {
            Action::Send(command) => {
                if let Some(sidecar) = self.sidecar.as_mut() {
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
    let result = event_loop(&mut terminal, &mut app);
    app.handle(Action::Quit);
    result
}

fn draw(terminal: &mut ratatui::DefaultTerminal, app: &mut LiveApp) -> io::Result<()> {
    let mut layout = LiveLayout::default();
    terminal.draw(|frame| layout = render_live(frame, &app.state))?;
    app.state.note_layout(layout);
    Ok(())
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut LiveApp,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut redraw = true;
    loop {
        if stop_requested() {
            app.state.closing = true;
            draw(terminal, app)?;
            return Ok(());
        }
        redraw |= app.pump();
        if redraw {
            draw(terminal, app)?;
            redraw = false;
        }
        if !event::poll(INPUT_POLL)? {
            continue;
        }
        let action = match event::read()? {
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
        let Some(Overlay::Approval(approval)) = &app.state.overlay else {
            unreachable!("pump_until waited for the approval modal");
        };
        let past_grace = approval.opened + APPROVAL_GRACE;
        let approve = app
            .state
            .on_key_at(
                KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE),
                past_grace,
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
