use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Deserialize)]
pub struct RunCommandArgs {
    pub command: String,
    pub cwd: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default = "default_shell")]
    pub shell: String,
}

fn default_timeout() -> u64 {
    60
}

fn default_shell() -> String {
    "bash".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RunCommandResult {
    pub command: String,
    pub shell: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub timed_out: bool,
}

const MAX_OUTPUT_CHARS: usize = 32_000;

fn truncate_output(s: &str) -> String {
    if s.len() > MAX_OUTPUT_CHARS {
        let half = MAX_OUTPUT_CHARS / 2;
        format!(
            "{}\n\n... [TRUNCATED {} BYTES] ...\n\n{}",
            &s[..half],
            s.len() - MAX_OUTPUT_CHARS,
            &s[s.len() - half..]
        )
    } else {
        s.to_string()
    }
}

pub fn run_command(args: RunCommandArgs, base_dir: &Path) -> Result<RunCommandResult, String> {
    let working_dir = match args.cwd {
        Some(ref d) => base_dir.join(d),
        None => base_dir.to_path_buf(),
    };

    if !working_dir.exists() {
        return Err(format!("Working directory does not exist: {}", working_dir.display()));
    }

    let start = Instant::now();
    let shell_name = if args.shell.trim().is_empty() {
        "bash".to_string()
    } else {
        args.shell.trim().to_string()
    };

    // Native Linux shell process execution
    let mut cmd = Command::new(&shell_name);
    cmd.args(["-c", &args.command])
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to execute '{}' via {shell_name}: {e}", args.command)
    })?;

    let timeout = Duration::from_secs(args.timeout_secs);
    let poll_interval = Duration::from_millis(50);
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                break;
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(poll_interval);
            }
            Err(e) => {
                return Err(format!("Error waiting for process: {e}"));
            }
        }
    }

    let output = child.wait_with_output().map_err(|e| format!("Failed to read process output: {e}"))?;
    let duration_ms = start.elapsed().as_millis();

    let raw_stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let raw_stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(RunCommandResult {
        command: args.command,
        shell: shell_name,
        exit_code: output.status.code(),
        stdout: truncate_output(&raw_stdout),
        stderr: truncate_output(&raw_stderr),
        duration_ms,
        timed_out,
    })
}
