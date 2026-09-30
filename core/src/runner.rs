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

pub fn is_dangerous_command(cmd: &str) -> Option<&'static str> {
    let normalized = cmd.trim().to_lowercase();

    // Check destructive rm patterns
    if normalized.contains("rm ") && (
        normalized.contains("-rf /") || 
        normalized.contains("-fr /") || 
        normalized.contains("-rf /*") || 
        normalized.contains("-fr /*") ||
        normalized.contains("-rf ~") ||
        normalized.contains("-rf $home") ||
        normalized.contains("-rf .") ||
        normalized.contains("-fr .")
    ) {
        return Some("Destructive recursive deletion of root, home, or current directory (rm -rf)");
    }

    // Format / filesystem destroyers
    if normalized.starts_with("mkfs") || normalized.contains(" mkfs") {
        return Some("Filesystem destruction command (mkfs)");
    }

    // Raw disk writes
    if normalized.contains("dd if=") && (
        normalized.contains("of=/dev/sd") || 
        normalized.contains("of=/dev/nvme") || 
        normalized.contains("of=/dev/vd") || 
        (!normalized.contains("of=/dev/null") && !normalized.contains("of=/dev/zero") && normalized.contains("of=/dev/"))
    ) {
        return Some("Raw disk block overwrite (dd of=/dev/...)");
    }

    // Fork bombs
    if normalized.contains(":(){ :|:& };:") || normalized.contains(":(){:|:&};:") {
        return Some("Fork bomb denial-of-service");
    }

    // Destructive root permissions
    if (normalized.contains("chmod -r 777 /") || (normalized.contains("chown -r") && normalized.contains(" /"))) && !normalized.contains(" ./") {
        return Some("Recursive root permission alteration");
    }

    None
}

pub fn run_command(args: RunCommandArgs, base_dir: &Path) -> Result<RunCommandResult, String> {
    if let Some(reason) = is_dangerous_command(&args.command) {
        return Err(format!("Security Violation: Dangerous command blocked by safety guard ({reason}): '{}'", args.command));
    }

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

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_handle = std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut reader, &mut buf);
        buf
    });

    let stderr_handle = std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut reader, &mut buf);
        buf
    });

    let timeout = Duration::from_secs(args.timeout_secs);
    let poll_interval = Duration::from_millis(50);
    let mut timed_out = false;

    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    timed_out = true;
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(poll_interval);
            }
            Err(e) => {
                return Err(format!("Error waiting for process: {e}"));
            }
        }
    };

    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();
    let duration_ms = start.elapsed().as_millis();

    let raw_stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let raw_stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    Ok(RunCommandResult {
        command: args.command,
        shell: shell_name,
        exit_code: exit_status.and_then(|s| s.code()),
        stdout: truncate_output(&raw_stdout),
        stderr: truncate_output(&raw_stderr),
        duration_ms,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dangerous_command_detection() {
        assert!(is_dangerous_command("rm -rf /").is_some());
        assert!(is_dangerous_command("sudo rm -rf /*").is_some());
        assert!(is_dangerous_command("rm -rf ~").is_some());
        assert!(is_dangerous_command("mkfs.ext4 /dev/sda1").is_some());
        assert!(is_dangerous_command("dd if=/dev/zero of=/dev/sda bs=1M").is_some());
        assert!(is_dangerous_command(":(){ :|:& };:").is_some());
        assert!(is_dangerous_command("chmod -R 777 /").is_some());

        // Safe commands
        assert!(is_dangerous_command("cargo test").is_none());
        assert!(is_dangerous_command("ls -la /").is_none());
        assert!(is_dangerous_command("git status").is_none());
        assert!(is_dangerous_command("cat /etc/hosts").is_none());
        assert!(is_dangerous_command("npm run build").is_none());
    }
}

