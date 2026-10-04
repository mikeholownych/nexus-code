//! Owns the sidecar child process. Stdout lines arrive as `SidecarMsg`s on a channel. Stderr is always drained
//! (a full pipe would block the child) into a bounded tail that is redacted on capture.
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{Command, Event, encode_command, parse_event};
use crate::redact::StderrRedactor;

pub const STDERR_TAIL_LINES: usize = 40;

#[derive(Debug)]
pub enum SidecarMsg {
    Event(Event),
    /// A stdout line that is not a protocol event. Its text is dropped: it bypassed the sidecar's redaction.
    Malformed,
    /// Stdout reached end of file; the child is exiting or has exited.
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SidecarSpec {
    pub program: String,
    pub args: Vec<String>,
}

pub struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_done: mpsc::Receiver<()>,
}

impl Sidecar {
    pub fn spawn(spec: &SidecarSpec, events: mpsc::Sender<SidecarMsg>) -> io::Result<Sidecar> {
        let mut process = Process::new(&spec.program);
        process
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Its own process group, so a kill also reaches the tools and shells it started.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut process, 0);
        let mut child = process.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let tail = Arc::clone(&stderr_tail);
        let (done, stderr_done) = mpsc::channel();
        thread::spawn(move || {
            let mut redactor = StderrRedactor::default();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(clean) = redactor.line(&line) {
                    let mut tail = tail.lock().unwrap();
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(clean);
                }
            }
            let _ = done.send(());
        });

        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let message = parse_event(&line).map_or(SidecarMsg::Malformed, SidecarMsg::Event);
                if events.send(message).is_err() {
                    return;
                }
            }
            let _ = events.send(SidecarMsg::Closed);
        });

        Ok(Sidecar {
            child,
            stdin,
            stderr_tail,
            stderr_done,
        })
    }

    pub fn send(&mut self, command: &Command) -> io::Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "sidecar stdin is closed"))?;
        stdin.write_all(encode_command(command).as_bytes())?;
        stdin.flush()
    }

    /// Waits up to `grace` for the child to exit, then kills it. Returns the exit code, or `None` when it was
    /// ended by a signal.
    pub fn reap(&mut self, grace: Duration) -> Option<i32> {
        let deadline = Instant::now() + grace;
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                _ => break self.kill(),
            }
        };
        let _ = self.stderr_done.recv_timeout(Duration::from_millis(500));
        status.and_then(|status| status.code())
    }

    /// Asks the sidecar to shut down, closes its stdin, and reaps it.
    pub fn shutdown(mut self, grace: Duration) -> Option<i32> {
        let _ = self.send(&Command::Shutdown);
        self.stdin = None;
        self.reap(grace)
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap().iter().cloned().collect()
    }

    /// Kills the child's process group, then the child itself, and waits for it. Only call this before the child
    /// has been reaped: until then its pid, which is also the group id, cannot be reused.
    fn kill(&mut self) -> Option<std::process::ExitStatus> {
        #[cfg(unix)]
        if let Ok(group) = libc::pid_t::try_from(self.child.id()) {
            // SAFETY: killpg only sends a signal; `group` is the group created for this child at spawn.
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        self.child.wait().ok()
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const WAIT: Duration = Duration::from_secs(5);

    fn sh(script: &str) -> SidecarSpec {
        SidecarSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
        }
    }

    #[test]
    fn forwards_events_flags_malformed_lines_and_reports_the_exit_code() {
        let (tx, rx) = mpsc::channel();
        let mut sidecar = Sidecar::spawn(
            &sh(r#"echo '{"v":1,"type":"hello","protocol":1,"pid":7}'; echo 'Compiling...'; read line; echo "got $line" >&2; exit 3"#),
            tx,
        )
        .unwrap();
        assert!(matches!(
            rx.recv_timeout(WAIT).unwrap(),
            SidecarMsg::Event(Event::Hello { protocol: 1 })
        ));
        assert!(matches!(
            rx.recv_timeout(WAIT).unwrap(),
            SidecarMsg::Malformed
        ));
        sidecar.send(&Command::Cancel).unwrap();
        assert!(matches!(rx.recv_timeout(WAIT).unwrap(), SidecarMsg::Closed));
        assert_eq!(sidecar.reap(WAIT), Some(3));
        let tail = sidecar.stderr_tail();
        assert_eq!(tail.len(), 1, "{tail:?}");
        assert!(tail[0].starts_with("got {"), "{tail:?}");
        assert!(
            tail[0].contains(r#""type":"cancel""#) && tail[0].contains(r#""v":1"#),
            "{tail:?}"
        );
    }

    #[test]
    fn a_stderr_flood_cannot_block_the_child_and_the_tail_stays_bounded_and_redacted() {
        let (tx, rx) = mpsc::channel();
        let mut sidecar = Sidecar::spawn(
            &sh(r#"i=0; while [ $i -lt 20000 ]; do echo "noise line $i Bearer abcdefghijklmnopqrstuvwxyz"; i=$((i+1)); done >&2; echo '{"v":1,"type":"hello","protocol":1,"pid":7}'"#),
            tx,
        )
        .unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(30)).unwrap(),
            SidecarMsg::Event(Event::Hello { .. })
        ));
        assert!(matches!(rx.recv_timeout(WAIT).unwrap(), SidecarMsg::Closed));
        assert_eq!(sidecar.reap(WAIT), Some(0));
        let tail = sidecar.stderr_tail();
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert!(
            tail.last().unwrap().starts_with("noise line 19999"),
            "{tail:?}"
        );
        assert!(tail.iter().all(|line| line.contains("[REDACTED_TOKEN]") && !line.contains("abcdefghijklmnop")));
    }

    #[test]
    fn shutdown_kills_a_child_that_ignores_it() {
        let (tx, _rx) = mpsc::channel();
        let sidecar = Sidecar::spawn(&sh("exec sleep 30"), tx).unwrap();
        let started = Instant::now();
        assert_eq!(sidecar.shutdown(Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    /// True once `pid` has exited (a zombie awaiting its new parent counts as exited).
    #[cfg(target_os = "linux")]
    fn exited_within(pid: &str, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(_) => return true,
                Ok(stat)
                    if stat
                        .rsplit(')')
                        .next()
                        .is_some_and(|rest| rest.trim_start().starts_with('Z')) =>
                {
                    return true;
                }
                Ok(_) if Instant::now() >= deadline => return false,
                Ok(_) => thread::sleep(Duration::from_millis(20)),
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn killing_the_sidecar_also_kills_its_children() {
        for (case, junk) in [("reap", true), ("drop", false)] {
            let pidfile = std::env::temp_dir().join(format!(
                "nexus-sidecar-grandchild-{}-{case}",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&pidfile);
            let script = format!(
                "sleep 30 & echo $! > '{}'; echo {}; exec sleep 30",
                pidfile.display(),
                if junk {
                    "not-protocol"
                } else {
                    r#"'{"v":1,"type":"hello","protocol":1,"pid":7}'"#
                }
            );
            let (tx, rx) = mpsc::channel();
            let mut sidecar = Sidecar::spawn(&sh(&script), tx).unwrap();
            assert!(
                rx.recv_timeout(WAIT).is_ok(),
                "{case}: the fake never wrote its line"
            );
            let grandchild = std::fs::read_to_string(&pidfile)
                .unwrap()
                .trim()
                .to_string();
            if junk {
                assert_eq!(sidecar.reap(Duration::ZERO), None, "{case}");
            } else {
                drop(sidecar);
            }
            let gone = exited_within(&grandchild, WAIT);
            if !gone {
                let _ = Process::new("kill").args(["-KILL", &grandchild]).status();
            }
            let _ = std::fs::remove_file(&pidfile);
            assert!(gone, "{case}: grandchild {grandchild} survived the sidecar");
        }
    }

    #[test]
    fn speaks_to_the_real_node_sidecar() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let script = repo.join("cli/dist/sidecar.js");
        if !script.is_file() || Process::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node or cli/dist/sidecar.js unavailable (run make build)");
            return;
        }
        let spec = SidecarSpec {
            program: "node".into(),
            args: vec![
                script.display().to_string(),
                "-w".into(),
                repo.display().to_string(),
                "-m".into(),
                "m".into(),
                "-e".into(),
                "http://127.0.0.1:9/v1".into(),
            ],
        };
        let (tx, rx) = mpsc::channel();
        let sidecar = Sidecar::spawn(&spec, tx).unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(20)).unwrap(),
            SidecarMsg::Event(Event::Hello { protocol: 1 })
        ));
        match rx.recv_timeout(Duration::from_secs(20)).unwrap() {
            SidecarMsg::Event(Event::SessionState { model, busy, .. }) => {
                assert_eq!(model, "m");
                assert!(!busy);
            }
            other => panic!("expected session.state, got {other:?}"),
        }
        assert_eq!(sidecar.shutdown(Duration::from_secs(10)), Some(0));
    }
}
