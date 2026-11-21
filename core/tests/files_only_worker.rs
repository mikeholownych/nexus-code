//! CS-10 phase 2: a `--files-only` worker serves file tools and refuses every method that starts or controls a command.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn exchange(extra: &[&str], workspace: &std::path::Path, requests: &[&str]) -> Vec<serde_json::Value> {
    let mut args = vec!["--workspace", workspace.to_str().unwrap()];
    args.extend_from_slice(extra);
    args.push("rpc");
    let mut engine = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = engine.stdin.take().unwrap();
    let mut out = BufReader::new(engine.stdout.take().unwrap());
    let mut replies = Vec::new();
    // One request at a time, so replies are read in order (the engine answers concurrently).
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
        let mut line = String::new();
        out.read_line(&mut line).unwrap();
        replies.push(serde_json::from_str(&line).unwrap());
    }
    drop(stdin);
    engine.wait().unwrap();
    replies
}

/// A throwaway workspace, removed when dropped (no temp-dir crate is a dependency of the core).
struct Workspace(std::path::PathBuf);

impl Workspace {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn workspace() -> Workspace {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("nexus-files-only-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(dir).unwrap();
    std::fs::write(dir.join("a.txt"), "alpha\n").unwrap();
    Workspace(dir)
}

#[test]
fn files_only_worker_refuses_every_command_method_and_still_serves_files() {
    let ws = workspace();
    let marker = ws.path().join("ran.txt");
    let run = format!(r#"{{"id":2,"method":"run_command","params":{{"command":"echo ran > {}"}}}}"#, marker.display());
    let replies = exchange(
        &["--files-only"],
        ws.path(),
        &[
            r#"{"id":1,"method":"hello","params":{}}"#,
            &run,
            r#"{"id":3,"method":"cancel","params":{"request_id":2}}"#,
            r#"{"id":4,"method":"end_background","params":{}}"#,
            r#"{"id":5,"method":"list_services","params":{}}"#,
            r#"{"id":6,"method":"read_file","params":{"path":"a.txt"}}"#,
            r#"{"id":7,"method":"write_file","params":{"path":"b.txt","content":"beta\n"}}"#,
        ],
    );
    assert_eq!(replies[0]["result"]["files_only"], true, "hello states the mode: {}", replies[0]);
    for (i, method) in ["run_command", "cancel", "end_background", "list_services"].iter().enumerate() {
        let error = replies[i + 1]["error"].as_str().unwrap_or_default();
        assert!(error.contains("file tools only"), "{method}: {}", replies[i + 1]);
        assert!(replies[i + 1]["result"].is_null(), "{method} returned a result");
    }
    assert!(!marker.exists(), "the refused command did not run");
    assert!(replies[5]["result"]["content"].as_str().unwrap().contains("alpha"), "{}", replies[5]);
    assert!(replies[6]["error"].is_null(), "{}", replies[6]);
    assert_eq!(std::fs::read_to_string(ws.path().join("b.txt")).unwrap(), "beta\n");
}

/// The baseline that makes the refusal test meaningful: without the flag the same command runs.
#[test]
fn a_normal_worker_runs_the_same_command_and_reports_files_only_false() {
    let ws = workspace();
    let marker = ws.path().join("ran.txt");
    let run = format!(r#"{{"id":2,"method":"run_command","params":{{"command":"echo ran > {}"}}}}"#, marker.display());
    let replies = exchange(&[], ws.path(), &[r#"{"id":1,"method":"hello","params":{}}"#, &run]);
    assert_eq!(replies[0]["result"]["files_only"], false);
    assert_eq!(replies[1]["result"]["exit_code"], 0, "{}", replies[1]);
    assert!(marker.exists());
}

#[test]
fn the_one_shot_call_path_honours_files_only_too() {
    let ws = workspace();
    let out = Command::new(env!("CARGO_BIN_EXE_harness-core"))
        .args(["--workspace", ws.path().to_str().unwrap(), "--files-only", "call", "--tool", "run_command", "--args", r#"{"command":"echo x"}"#])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("file tools only"));
}
