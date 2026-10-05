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
    #[serde(default)]
    pub pty: bool,
}

fn default_timeout() -> u64 {
    60
}

fn default_shell() -> String {
    #[cfg(windows)]
    return "powershell.exe".to_string();
    #[cfg(not(windows))]
    return "bash".to_string();
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

    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;

    let working_dir = match args.cwd {
        Some(ref d) => {
            let p = Path::new(d);
            let target_path = if p.is_absolute() {
                p.to_path_buf()
            } else {
                base_dir.join(p)
            };
            if !target_path.exists() {
                return Err(format!("Working directory does not exist: {}", target_path.display()));
            }
            let canon = target_path.canonicalize().map_err(|e| format!("Invalid cwd: {e}"))?;
            if !canon.starts_with(&base_canon) {
                return Err(format!("Security Violation: cwd escapes workspace jail: {d}"));
            }
            canon
        }
        None => base_canon.clone(),
    };

    let shell_name = if args.shell.trim().is_empty() {
        default_shell()
    } else {
        args.shell.trim().to_string()
    };

    if args.pty {
        return run_command_pty(&args.command, &working_dir, args.timeout_secs, &shell_name);
    }

    let start = Instant::now();

    // Cross-platform shell process execution (Candidate #50)
    let mut cmd = Command::new(&shell_name);
    #[cfg(windows)]
    if shell_name.contains("powershell") {
        cmd.args(["-NoProfile", "-Command", &args.command]);
    } else {
        cmd.args(["/C", &args.command]);
    }
    #[cfg(not(windows))]
    cmd.args(["-c", &args.command]);

    cmd.current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Own process group, so a timeout can end the shell AND everything it started. Killing only the shell leaves
    // descendants alive holding the output pipes (the call then blocks until they exit, and they outlive it).
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);

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
                    terminate_process_tree(&mut child);
                    timed_out = true;
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

/// Ends the command's whole process group: SIGTERM first so well-behaved tools can clean up, then SIGKILL for
/// anything still alive (the group id stays valid while any member lives, so descendants are covered even after
/// the shell has exited). Always reaps the shell.
fn terminate_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pgid = child.id() as libc::pid_t;
        unsafe { libc::killpg(pgid, libc::SIGTERM) };
        let grace = Instant::now();
        while grace.elapsed() < Duration::from_millis(500) {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/**
 * Execute command inside a Pseudo-Terminal (PTY) master/slave pair (Candidate #03)
 */
pub fn run_command_pty(
    command_str: &str,
    working_dir: &Path,
    timeout_secs: u64,
    shell_name: &str,
) -> Result<RunCommandResult, String> {
    use portable_pty::{native_pty_system, PtySize, CommandBuilder};
    let start = Instant::now();

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| format!("Failed to allocate PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(shell_name);
    #[cfg(windows)]
    if shell_name.contains("powershell") {
        cmd.args(["-NoProfile", "-Command", command_str]);
    } else {
        cmd.args(["/C", command_str]);
    }
    #[cfg(not(windows))]
    cmd.args(["-c", command_str]);

    cmd.cwd(working_dir);

    let mut child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn PTY child: {e}"))?;
    drop(pair.slave); // Required to ensure EOF when command terminates

    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY master reader: {e}"))?;

    let output_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut reader, &mut buf);
        buf
    });

    let timeout = Duration::from_secs(timeout_secs);
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
            Err(_) => break None,
        }
    };

    drop(pair.master);
    let raw_out = output_handle.join().unwrap_or_default();
    let text = String::from_utf8_lossy(&raw_out).to_string();

    Ok(RunCommandResult {
        command: command_str.to_string(),
        shell: shell_name.to_string(),
        exit_code: exit_status.and_then(|s| if s.success() { Some(0) } else { Some(1) }),
        stdout: truncate_output(&text),
        stderr: String::new(),
        duration_ms: start.elapsed().as_millis(),
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

    #[test]
    fn test_run_command_pty() {
        let cwd = std::env::current_dir().unwrap();
        let res = run_command(RunCommandArgs {
            command: "echo 'PTY terminal test'".to_string(),
            cwd: None,
            timeout_secs: 5,
            shell: default_shell(),
            pty: true,
        }, &cwd).unwrap();

        assert_eq!(res.exit_code, Some(0));
        assert!(res.stdout.contains("PTY terminal test"));
    }

    #[test]
    fn test_cwd_workspace_confinement() {
        let temp_base = std::env::temp_dir().join(format!("nexus_test_cwd_{}", std::process::id()));
        let workspace = temp_base.join("workspace");
        let sub = workspace.join("subdir");
        let external = temp_base.join("external");

        let _ = std::fs::remove_dir_all(&temp_base);
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&external).unwrap();

        // 1. None cwd defaults to base_dir
        let res_none = run_command(RunCommandArgs {
            command: "pwd".into(),
            cwd: None,
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
        }, &workspace);
        assert!(res_none.is_ok());

        // 2. In-workspace relative subdir cwd is permitted
        let res_sub = run_command(RunCommandArgs {
            command: "pwd".into(),
            cwd: Some("subdir".into()),
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
        }, &workspace);
        assert!(res_sub.is_ok());

        // 3. Absolute path outside workspace is rejected
        let res_ext = run_command(RunCommandArgs {
            command: "pwd".into(),
            cwd: Some(external.to_string_lossy().to_string()),
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
        }, &workspace);
        assert!(res_ext.is_err());
        assert!(res_ext.unwrap_err().contains("cwd escapes workspace jail"));

        // 4. Traversal ../../ outside workspace is rejected
        let res_traversal = run_command(RunCommandArgs {
            command: "pwd".into(),
            cwd: Some("../../".into()),
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
        }, &workspace);
        assert!(res_traversal.is_err());
        assert!(res_traversal.unwrap_err().contains("cwd escapes workspace jail"));

        // 5. Escaping symlink cwd is rejected
        #[cfg(unix)]
        {
            let sym_cwd = workspace.join("sym_ext_cwd");
            let _ = std::os::unix::fs::symlink(&external, &sym_cwd);
            let res_sym = run_command(RunCommandArgs {
                command: "pwd".into(),
                cwd: Some("sym_ext_cwd".into()),
                timeout_secs: 5,
                shell: default_shell(),
                pty: false,
            }, &workspace);
            assert!(res_sym.is_err());
            assert!(res_sym.unwrap_err().contains("cwd escapes workspace jail"));
        }

        let _ = std::fs::remove_dir_all(&temp_base);
    }

    #[cfg(unix)]
    fn count_processes(pattern: &str) -> usize {
        let out = Command::new("pgrep").args(["-f", pattern]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).lines().count()
    }

    /// D3: a timeout must end the whole process group, not only the shell; a descendant that inherited the
    /// output pipes must neither keep the call blocked nor survive it.
    #[cfg(unix)]
    #[test]
    fn test_timeout_terminates_descendants_and_returns_promptly() {
        let cwd = std::env::current_dir().unwrap();
        let marker = "sleep 31.417";
        let started = Instant::now();
        let res = run_command(RunCommandArgs {
            command: format!("echo before-timeout; (bash -c '{marker}' &) ; {marker}"),
            cwd: None,
            timeout_secs: 1,
            shell: default_shell(),
            pty: false,
        }, &cwd).unwrap();
        let elapsed = started.elapsed();

        assert!(res.timed_out, "timeout must be reported as such");
        assert_eq!(res.exit_code, None);
        assert!(res.stdout.contains("before-timeout"), "partial output must survive: {:?}", res.stdout);
        assert!(elapsed < Duration::from_secs(6), "returned after {elapsed:?}: a descendant holding the pipe kept the call blocked");
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(count_processes(marker), 0, "descendants survived the timeout");
    }

    #[cfg(unix)]
    #[test]
    fn test_ordinary_failure_is_not_a_timeout() {
        let cwd = std::env::current_dir().unwrap();
        let res = run_command(RunCommandArgs {
            command: "echo failing; exit 3".to_string(),
            cwd: None,
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
        }, &cwd).unwrap();
        assert!(!res.timed_out);
        assert_eq!(res.exit_code, Some(3));
        assert!(res.stdout.contains("failing"));
    }
}

