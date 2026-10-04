//! `nexus-tui --live`: runs the agent sidecar and renders its protocol events in the terminal.
use std::{
    env,
    error::Error,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::mpsc,
    time::Duration,
};

use crossterm::{
    event::{self, DisableBracketedPaste, EnableBracketedPaste, Event as TermEvent, KeyEventKind},
    execute,
};

use crate::live_state::{Action, Link, LiveState};
use crate::live_view::render_live;
use crate::sidecar::{Sidecar, SidecarMsg, SidecarSpec};

const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const EXIT_GRACE: Duration = Duration::from_secs(2);
const INPUT_POLL: Duration = Duration::from_millis(30);

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
/// but not bracketed paste, so the paste mode is undone here, during unwinding as well.
struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), DisableBracketedPaste);
        ratatui::restore();
    }
}

pub fn run_live(spec: SidecarSpec) -> Result<(), Box<dyn std::error::Error>> {
    let _guard = TerminalGuard;
    let mut terminal = ratatui::try_init()?;
    execute!(io::stdout(), EnableBracketedPaste)?;
    let mut app = LiveApp::start(spec);
    let result = event_loop(&mut terminal, &mut app);
    app.handle(Action::Quit);
    result
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut LiveApp,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut redraw = true;
    loop {
        redraw |= app.pump();
        if redraw {
            terminal.draw(|frame| render_live(frame, &app.state))?;
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
        if let Some(action) = action
            && !app.handle(action)
        {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_state::Entry;
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
}
