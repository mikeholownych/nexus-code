use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn count_processes(pattern: &str) -> usize {
    // Exact command lines only, so the `bash -c` that started a command is not counted.
    let escaped = pattern.replace('.', "\\.");
    let out = Command::new("pgrep").args(["-x", "-f", &escaped]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().count()
}

fn wait_for(pattern: &str, n: usize) {
    let started = Instant::now();
    while count_processes(pattern) < n && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// REQ-SEC-106: when the client goes away (stdin closes), the engine ends the commands it started before exiting.
#[test]
#[cfg(unix)]
fn closing_stdin_ends_running_commands() {
    let marker = "sleep 41.789";
    let mut engine = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .args(["--workspace", ".", "rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = engine.stdin.take().unwrap();
    writeln!(stdin, r#"{{"id":1,"method":"run_command","params":{{"command":"({marker} &); {marker}","timeout_secs":120}}}}"#).unwrap();
    wait_for(marker, 2);
    assert_eq!(count_processes(marker), 2, "one background and one foreground sleep are running");
    drop(stdin);
    let started = Instant::now();
    let status = engine.wait().unwrap();
    assert!(status.success(), "{status:?}");
    assert!(started.elapsed() < Duration::from_secs(6));
    assert_eq!(count_processes(marker), 0, "commands survived the engine's shutdown");
}

/// REQ-SEC-106: SIGTERM to the engine ends its commands too.
#[test]
#[cfg(unix)]
fn sigterm_ends_running_commands() {
    let marker = "sleep 41.987";
    let mut engine = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .args(["--workspace", ".", "rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = engine.stdin.take().unwrap();
    writeln!(stdin, r#"{{"id":"a","method":"run_command","params":{{"command":"{marker}","timeout_secs":120}}}}"#).unwrap();
    wait_for(marker, 1);
    unsafe { libc_kill(engine.id() as i32, 15) };
    let _ = engine.wait().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(count_processes(marker), 0, "commands survived SIGTERM to the engine");
    drop(stdin);
}

/// REQ-AGT-109: a `cancel` request ends the command another request started; that request answers `cancelled`.
#[test]
#[cfg(unix)]
fn cancel_request_ends_the_named_command() {
    let marker = "sleep 41.555";
    let mut engine = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .args(["--workspace", ".", "rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = engine.stdin.take().unwrap();
    let mut out = BufReader::new(engine.stdout.take().unwrap());
    writeln!(stdin, r#"{{"id":7,"method":"run_command","params":{{"command":"{marker}","timeout_secs":120}}}}"#).unwrap();
    wait_for(marker, 1);
    writeln!(stdin, r#"{{"id":8,"method":"cancel","params":{{"request_id":7}}}}"#).unwrap();
    let mut lines = Vec::new();
    for _ in 0..2 {
        let mut line = String::new();
        out.read_line(&mut line).unwrap();
        lines.push(line);
    }
    let joined = lines.join("");
    assert!(joined.contains(r#""cancelled":true"#), "{joined}");
    assert_eq!(count_processes(marker), 0);
    drop(stdin);
    let _ = engine.wait();
}

/// REQ-REL-103: `hello` RPC returns core version and protocol version.
#[test]
fn hello_rpc_returns_version_and_protocol() {
    let mut engine = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .args(["--workspace", ".", "rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = engine.stdin.take().unwrap();
    let mut out = BufReader::new(engine.stdout.take().unwrap());
    writeln!(stdin, r#"{{"id":100,"method":"hello","params":{{}}}}"#).unwrap();
    let mut response = String::new();
    out.read_line(&mut response).unwrap();
    let v: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert_eq!(v["id"], 100);
    assert_eq!(v["result"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["result"]["protocol"], 1);
    drop(stdin);
    let _ = engine.wait();
}

unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}
