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
    #[serde(default)]
    pub argv: Option<Vec<String>>,
    #[serde(default)]
    pub background: bool,
    #[serde(default)]
    pub service_name: Option<String>,
}

impl Default for RunCommandArgs {
    fn default() -> Self {
        Self {
            command: String::new(),
            cwd: None,
            timeout_secs: default_timeout(),
            shell: default_shell(),
            pty: false,
            argv: None,
            background: false,
            service_name: None,
        }
    }
}

pub fn max_tool_timeout_secs() -> u64 {
    std::env::var("NEXUS_MAX_TOOL_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1800)
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
    /// The operator's cancel (or the engine's shutdown) ended the command.
    #[serde(default)]
    pub cancelled: bool,
}

const MAX_OUTPUT_CHARS: usize = 32_000;

/// Output kept per stream: the first and last halves of MAX_OUTPUT_CHARS bytes plus a count of everything. Memory stays
/// bounded however much a command prints (400 MB of output used to be buffered whole before truncation).
struct BoundedCapture {
    head: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    total: u64,
}

impl BoundedCapture {
    const HALF: usize = MAX_OUTPUT_CHARS / 2;

    fn new() -> Self {
        Self { head: Vec::new(), tail: std::collections::VecDeque::new(), total: 0 }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        let mut rest = bytes;
        if self.head.len() < Self::HALF {
            let take = rest.len().min(Self::HALF - self.head.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.len() >= Self::HALF {
            self.tail.clear();
            self.tail.extend(&rest[rest.len() - Self::HALF..]);
        } else {
            let overflow = (self.tail.len() + rest.len()).saturating_sub(Self::HALF);
            self.tail.drain(..overflow);
            self.tail.extend(rest);
        }
    }

    /// The captured text: whole when it fit, otherwise head and tail around a count of the bytes left out.
    fn render(&self) -> String {
        let (tail, _) = self.tail.as_slices();
        let mut tail_bytes = tail.to_vec();
        tail_bytes.extend_from_slice(self.tail.as_slices().1);
        let kept = (self.head.len() + tail_bytes.len()) as u64;
        let head = String::from_utf8_lossy(&self.head);
        let tail = String::from_utf8_lossy(&tail_bytes);
        if kept >= self.total {
            format!("{head}{tail}")
        } else {
            format!("{head}\n\n... [TRUNCATED {} BYTES] ...\n\n{tail}", self.total - kept)
        }
    }
}

/// Process groups of commands started over RPC, so a cancel request or the engine's shutdown can end them (and
/// everything they started) instead of leaving them running: REQ-AGT-109 / REQ-SEC-106.
#[cfg(unix)]
mod registry {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    #[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
    pub struct ServiceInfo {
        pub name: String,
        pub pgid: libc::pid_t,
        pub command: String,
    }

    struct Running {
        pgid: libc::pid_t,
        cancelled: Arc<AtomicBool>,
    }

    #[derive(Default)]
    struct State {
        running: HashMap<String, Running>,
        /// Groups still alive after their command returned (a `server &` the command started).
        lingering: HashSet<libc::pid_t>,
        /// Registered long-lived background services that survive turn cancellation.
        services: HashMap<String, ServiceInfo>,
    }

    fn state() -> &'static Mutex<State> {
        static STATE: OnceLock<Mutex<State>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(State::default()))
    }

    fn alive(pgid: libc::pid_t) -> bool {
        // This is a liveness probe for a numeric PGID, not an identity handle. A group can exit
        // and the number can be reused between this probe and a later killpg call.
        unsafe { libc::killpg(pgid, 0) == 0 }
    }

    /// Best-effort TERM, a grace period, then KILL for whatever is still in the numeric group.
    /// The liveness checks reduce stale-PGID signals but cannot make the check-and-signal atomic or
    /// prove that a group found by the numeric ID is the original command's group.
    pub fn end_groups(pgids: &[libc::pid_t], grace: Duration) {
        for &pgid in pgids {
            unsafe { libc::killpg(pgid, libc::SIGTERM) };
        }
        let start = Instant::now();
        while start.elapsed() < grace && pgids.iter().any(|&p| alive(p)) {
            std::thread::sleep(Duration::from_millis(20));
        }
        for &pgid in pgids {
            if alive(pgid) {
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
            }
        }
    }

    pub fn start(key: &str, pgid: libc::pid_t) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut st = state().lock().unwrap();
        st.lingering.retain(|&p| alive(p));
        st.running.insert(key.to_string(), Running { pgid, cancelled: Arc::clone(&cancelled) });
        cancelled
    }

    pub fn finish(key: &str) {
        let mut st = state().lock().unwrap();
        if let Some(run) = st.running.remove(key) {
            if alive(run.pgid) {
                if !st.services.values().any(|s| s.pgid == run.pgid) {
                    st.lingering.insert(run.pgid);
                }
            }
        }
    }

    pub fn register_service(name: &str, pgid: libc::pid_t, command: &str) {
        let mut st = state().lock().unwrap();
        if let Some(old) = st.services.remove(name) {
            if alive(old.pgid) && old.pgid != pgid {
                end_groups(&[old.pgid], Duration::from_millis(500));
            }
        }
        st.services.insert(name.to_string(), ServiceInfo {
            name: name.to_string(),
            pgid,
            command: command.to_string(),
        });
    }

    /// Forgets a service only when the recorded process group is still the one being removed.
    pub fn unregister_service(name: &str, pgid: libc::pid_t) {
        let mut st = state().lock().unwrap();
        if st.services.get(name).map_or(false, |s| s.pgid == pgid) {
            st.services.remove(name);
        }
    }

    /// Whether the service group still has a live process (the shell may exit while `cmd &` survives).
    pub fn pgid_alive(pgid: libc::pid_t) -> bool {
        alive(pgid)
    }

    /// Test-only view of the map, including entries whose process already exited.
    #[cfg(test)]
    pub fn service_count_including_dead() -> usize {
        state().lock().unwrap().services.len()
    }

    pub fn list_services() -> Vec<ServiceInfo> {
        let mut st = state().lock().unwrap();
        st.services.retain(|_, s| alive(s.pgid));
        let mut list: Vec<ServiceInfo> = st.services.values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    /// Ends the command started by request `key`. Returns whether such a command was running.
    pub fn cancel(key: &str, grace: Duration) -> bool {
        let pgid = {
            let st = state().lock().unwrap();
            match st.running.get(key) {
                Some(run) => {
                    run.cancelled.store(true, Ordering::SeqCst);
                    run.pgid
                }
                None => return false,
            }
        };
        end_groups(&[pgid], grace);
        true
    }

    /// Ends background processes that finished commands left running. Returns how many groups were ended.
    pub fn end_lingering(grace: Duration) -> usize {
        let pgids: Vec<libc::pid_t> = {
            let mut st = state().lock().unwrap();
            st.lingering.retain(|&p| alive(p));
            st.lingering.drain().collect()
        };
        end_groups(&pgids, grace);
        pgids.len()
    }

    /// Ends every running command, lingering background group, and registered service (engine shutdown).
    pub fn end_all(grace: Duration) -> usize {
        let pgids: Vec<libc::pid_t> = {
            let mut st = state().lock().unwrap();
            for run in st.running.values() {
                run.cancelled.store(true, Ordering::SeqCst);
            }
            let mut all: Vec<libc::pid_t> = st.running.values().map(|r| r.pgid).collect();
            all.extend(st.lingering.drain());
            for svc in st.services.drain().map(|(_, s)| s.pgid) {
                if !all.contains(&svc) {
                    all.push(svc);
                }
            }
            // A service can die after the startup grace. This snapshot drops groups already gone,
            // reducing stale-PGID signals; numeric PGIDs do not preserve identity across the gap
            // between this check and the later killpg call.
            all.retain(|&p| alive(p));
            all
        };
        end_groups(&pgids, grace);
        pgids.len()
    }
}

#[cfg(unix)]
#[allow(unused_imports)]
pub use registry::{cancel as cancel_command, end_all as end_all_commands, end_lingering as end_background_commands, list_services, pgid_alive, register_service, unregister_service, ServiceInfo};

#[cfg(not(unix))]
#[allow(unused_imports)]
pub use registry_stub::{list_services, pgid_alive, register_service, unregister_service, ServiceInfo};

#[cfg(not(unix))]
mod registry_stub {
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct ServiceInfo {
        pub name: String,
        pub pgid: u32,
        pub command: String,
    }

    pub fn list_services() -> Vec<ServiceInfo> {
        Vec::new()
    }

    pub fn register_service(_name: &str, _pgid: u32, _command: &str) {}

    pub fn unregister_service(_name: &str, _pgid: u32) {}

    pub fn pgid_alive(_pgid: u32) -> bool {
        false
    }
}

fn tokenize_and_split_subcommands(cmd: &str) -> Vec<Vec<String>> {
    let tokens = match shell_words::split(cmd) {
        Ok(toks) => toks,
        Err(_) => cmd.split_whitespace().map(|s| s.to_string()).collect(),
    };

    let mut subcommands = Vec::new();
    let mut current = Vec::new();

    for token in tokens {
        if token == ";" || token == "&&" || token == "||" || token == "|" || token == "&" {
            if !current.is_empty() {
                subcommands.push(std::mem::take(&mut current));
            }
        } else if token.contains(';') || token.contains('&') || token.contains('|') {
            let mut buf = String::new();
            for ch in token.chars() {
                if ch == ';' || ch == '&' || ch == '|' {
                    if !buf.is_empty() {
                        current.push(std::mem::take(&mut buf));
                    }
                    if !current.is_empty() {
                        subcommands.push(std::mem::take(&mut current));
                    }
                } else {
                    buf.push(ch);
                }
            }
            if !buf.is_empty() {
                current.push(buf);
            }
        } else {
            current.push(token);
        }
    }
    if !current.is_empty() {
        subcommands.push(current);
    }
    subcommands
}

pub fn is_dangerous_command(cmd: &str) -> Option<&'static str> {
    let normalized = cmd.trim();

    // Fork bombs
    if normalized.contains(":(){ :|:& };:")
        || normalized.contains(":(){:|:&};:")
        || (normalized.contains(":(){") && normalized.contains(":|:"))
    {
        return Some("Fork bomb denial-of-service");
    }

    // Raw disk device redirection
    if normalized.contains("> /dev/sd")
        || normalized.contains(">/dev/sd")
        || normalized.contains("> /dev/nvme")
        || normalized.contains(">/dev/nvme")
        || normalized.contains("> /dev/vd")
        || normalized.contains(">/dev/vd")
    {
        return Some("Raw disk device redirection");
    }

    let subcommands = tokenize_and_split_subcommands(cmd);
    for sub in &subcommands {
        if sub.is_empty() {
            continue;
        }

        let mut idx = 0;
        while idx < sub.len() {
            let word = sub[idx].as_str();
            if word == "sudo" || word == "doas" || word == "nohup" {
                idx += 1;
                while idx < sub.len() && sub[idx].starts_with('-') {
                    if (sub[idx] == "-u" || sub[idx] == "-g") && idx + 1 < sub.len() {
                        idx += 2;
                    } else {
                        idx += 1;
                    }
                }
            } else if word == "env" {
                idx += 1;
                while idx < sub.len() && (sub[idx].starts_with('-') || sub[idx].contains('=')) {
                    idx += 1;
                }
            } else {
                break;
            }
        }
        if idx >= sub.len() {
            continue;
        }

        let exe_full = &sub[idx];
        let exe = exe_full.rsplit('/').next().unwrap_or(exe_full.as_str());
        let args = &sub[idx + 1..];

        // System shutdown or reboot commands
        if exe == "shutdown" || exe == "reboot" || exe == "poweroff" || exe == "halt" {
            return Some("System shutdown or reboot command");
        }
        if exe == "init" && args.iter().any(|a| a == "0" || a == "6") {
            return Some("System shutdown or reboot command (init 0/6)");
        }

        // Filesystem destruction command (mkfs)
        if exe == "mkfs" || exe.starts_with("mkfs.") {
            return Some("Filesystem destruction command (mkfs)");
        }

        // Raw disk block overwrite (dd of=/dev/...)
        if exe == "dd" {
            let has_dangerous_of = args.iter().any(|a| {
                if let Some(target) = a.strip_prefix("of=") {
                    let t = target.trim_matches('"').trim_matches('\'');
                    t.starts_with("/dev/sd")
                        || t.starts_with("/dev/nvme")
                        || t.starts_with("/dev/vd")
                        || (t.starts_with("/dev/")
                            && t != "/dev/null"
                            && t != "/dev/zero"
                            && t != "/dev/urandom"
                            && t != "/dev/random")
                } else {
                    false
                }
            });
            if has_dangerous_of {
                return Some("Raw disk block overwrite (dd of=/dev/...)");
            }
        }

        // Destructive root permissions or ownership
        if exe == "chmod" || exe == "chown" {
            let is_recursive = args.iter().any(|a| {
                if a.starts_with('-') && !a.starts_with("--") {
                    a.contains('R') || a.contains('r')
                } else {
                    a == "--recursive"
                }
            });
            if is_recursive {
                let targets_root = args.iter().any(|a| a == "/" || a == "/*");
                if targets_root {
                    if exe == "chmod" {
                        if args.iter().any(|a| a == "777" || a == "0777") {
                            return Some("Recursive root permission alteration");
                        }
                    } else {
                        return Some("Recursive root permission alteration");
                    }
                }
            }
        }

        // Destructive rm
        if exe_full == "rm" {
            let has_rf = args.iter().any(|a| a == "-rf" || a == "-fr");
            let has_dash_dash = args.iter().any(|a| a == "--");
            if has_rf && !has_dash_dash {
                for a in args {
                    if a.starts_with('-') {
                        continue;
                    }
                    let t = a.trim();
                    if t == "/"
                        || t == "/*"
                        || t == "."
                        || t == ".."
                        || t == "~"
                        || t.eq_ignore_ascii_case("$home")
                        || t.eq_ignore_ascii_case("${home}")
                    {
                        return Some("Destructive recursive deletion of root, home, or current directory (rm -rf)");
                    }
                }
            }
        }

        // Shell wrapper inspection: bash -c "..."
        if (exe == "bash" || exe == "sh" || exe == "zsh") && args.len() >= 2 {
            for (i, a) in args.iter().enumerate() {
                if a == "-c" && i + 1 < args.len() {
                    if let Some(r) = is_dangerous_command(&args[i + 1]) {
                        return Some(r);
                    }
                }
            }
        }
    }

    None
}

#[allow(dead_code)]
pub fn run_command(args: RunCommandArgs, base_dir: &Path) -> Result<RunCommandResult, String> {
    run_command_tracked(args, base_dir, None)
}

/// Runs a command; with `key` (the RPC request id) its process group is registered so `cancel_command(key)` and the
/// engine's shutdown can end it.
pub fn run_command_tracked(args: RunCommandArgs, base_dir: &Path, key: Option<&str>) -> Result<RunCommandResult, String> {
    if let Some(reason) = is_dangerous_command(&args.command) {
        return Err(format!("Destructive-command tripwire: Command blocked by safety guard ({reason}): '{}'", args.command));
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

    let max_timeout = max_tool_timeout_secs();
    let (effective_timeout, clamped) = if args.timeout_secs > max_timeout {
        (max_timeout, true)
    } else {
        (args.timeout_secs, false)
    };
    let clamp_notice = if clamped {
        Some(format!("[Notice: timeout_secs clamped from {} to {} (NEXUS_MAX_TOOL_TIMEOUT_SECS)]\n", args.timeout_secs, effective_timeout))
    } else {
        None
    };

    if args.pty {
        return run_command_pty(&args.command, &working_dir, effective_timeout, &shell_name, args.argv.as_deref(), key);
    }

    let start = Instant::now();

    // Cross-platform process execution: direct argv if provided, else via shell (REQ-SEC-108)
    let mut cmd = if let Some(ref argv) = args.argv {
        if let Some((exe, rest)) = argv.split_first() {
            let mut c = Command::new(exe);
            c.args(rest);
            c
        } else {
            let mut c = Command::new(&shell_name);
            #[cfg(windows)]
            if shell_name.contains("powershell") {
                c.args(["-NoProfile", "-Command", &args.command]);
            } else {
                c.args(["/C", &args.command]);
            }
            #[cfg(not(windows))]
            c.args(["-c", &args.command]);
            c
        }
    } else {
        let mut c = Command::new(&shell_name);
        #[cfg(windows)]
        if shell_name.contains("powershell") {
            c.args(["-NoProfile", "-Command", &args.command]);
        } else {
            c.args(["/C", &args.command]);
        }
        #[cfg(not(windows))]
        c.args(["-c", &args.command]);
        c
    };

    cmd.current_dir(&working_dir)
        .stdin(Stdio::null())
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

    // Readers append to shared buffers, so output already read is kept even if a pipe stays open past the drain.
    let reader = |pipe: Box<dyn std::io::Read + Send>| {
        let collected = std::sync::Arc::new(std::sync::Mutex::new(BoundedCapture::new()));
        let sink = std::sync::Arc::clone(&collected);
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink.lock().unwrap().push(&chunk[..n]),
                }
            }
            let _ = done_tx.send(());
        });
        (collected, done_rx)
    };
    let (stdout_buf, stdout_done) = reader(Box::new(stdout));
    let (stderr_buf, stderr_done) = reader(Box::new(stderr));

    #[cfg(unix)]
    let pgid = child.id() as libc::pid_t;

    #[cfg(unix)]
    if args.background {
        if let Some(ref sname) = args.service_name {
            registry::register_service(sname, pgid, &args.command);
        }
    }

    #[cfg(unix)]
    let cancelled = key.map(|k| registry::start(k, pgid));

    if args.background {
        let startup_grace = Duration::from_millis(150);
        let poll_step = Duration::from_millis(20);
        let start_wait = Instant::now();
        let mut early_exit = None;
        while start_wait.elapsed() < startup_grace {
            match child.try_wait() {
                Ok(Some(status)) => {
                    early_exit = Some(status);
                    break;
                }
                Ok(None) => std::thread::sleep(poll_step),
                Err(e) => return Err(format!("Error checking background process: {e}")),
            }
        }

        #[cfg(unix)]
        if let Some(k) = key {
            registry::finish(k);
        }

        if let Some(status) = early_exit {
            let _ = stdout_done.recv_timeout(Duration::from_millis(100));
            let _ = stderr_done.recv_timeout(Duration::from_millis(100));
            let mut out = stdout_buf.lock().unwrap().render();
            let err = stderr_buf.lock().unwrap().render();
            if let Some(ref notice) = clamp_notice {
                out = format!("{notice}{out}");
            }
            let code = status.code().unwrap_or(0);
            // The group was registered before the startup grace to cover shutdown during startup.
            // The shell can exit while `cmd &` keeps the group alive: keep that registration. If
            // the numeric PGID is gone now, unregister it. This is a point-in-time liveness check;
            // it does not prevent reuse between the check and a later signal.
            #[cfg(unix)]
            if let Some(ref sname) = args.service_name {
                if registry::pgid_alive(pgid) {
                    out = format!("Background service '{sname}' started (pgid {pgid})\n{out}");
                } else {
                    registry::unregister_service(sname, pgid);
                    out = format!("Background service '{sname}' exited during startup (pgid {pgid})\n{out}");
                }
            }
            return Ok(RunCommandResult {
                command: args.command,
                shell: shell_name,
                exit_code: Some(code),
                stdout: out,
                stderr: err,
                duration_ms: start.elapsed().as_millis(),
                timed_out: false,
                cancelled: false,
            });
        }

        let sname = args.service_name.as_deref().unwrap_or("unnamed");
        let mut out = format!("Background service '{sname}' started (pgid {pgid})\n");
        if let Some(ref notice) = clamp_notice {
            out = format!("{notice}{out}");
        }
        return Ok(RunCommandResult {
            command: args.command,
            shell: shell_name,
            exit_code: Some(0),
            stdout: out,
            stderr: String::new(),
            duration_ms: start.elapsed().as_millis(),
            timed_out: false,
            cancelled: false,
        });
    }

    let timeout = Duration::from_secs(effective_timeout);
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

    // How long to wait for the pipes to close after the shell ended. A process the command left running in the
    // background (`server &`) can hold them open: what was read so far is returned and that process is left alone.
    let drain = if timed_out { Duration::from_millis(100) } else { Duration::from_millis(500) };
    let drain_deadline = Instant::now() + drain;
    let _ = stdout_done.recv_timeout(drain_deadline.saturating_duration_since(Instant::now()));
    let _ = stderr_done.recv_timeout(drain_deadline.saturating_duration_since(Instant::now()));
    let mut stdout_text = stdout_buf.lock().unwrap().render();
    if let Some(ref notice) = clamp_notice {
        stdout_text = format!("{notice}{stdout_text}");
    }
    let stderr_text = stderr_buf.lock().unwrap().render();
    let duration_ms = start.elapsed().as_millis();

    #[cfg(unix)]
    let was_cancelled = match (key, cancelled) {
        (Some(k), Some(flag)) => {
            registry::finish(k);
            flag.load(std::sync::atomic::Ordering::SeqCst)
        }
        _ => false,
    };
    #[cfg(not(unix))]
    let was_cancelled = false;

    Ok(RunCommandResult {
        command: args.command,
        shell: shell_name,
        exit_code: exit_status.and_then(|s| s.code()),
        stdout: stdout_text,
        stderr: stderr_text,
        duration_ms,
        timed_out,
        cancelled: was_cancelled,
    })
}

/// Best-effort process-group cleanup: SIGTERM first, then SIGKILL after a grace period. A numeric
/// PGID identifies the original group only while that group exists; if it becomes empty and the ID
/// is reused between signals, a later signal could target a different group. This is cleanup, not
/// an identity-preserving isolation boundary. Always reaps the shell.
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
    argv: Option<&[String]>,
    key: Option<&str>,
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

    let mut cmd = if let Some(argv) = argv {
        if let Some((exe, rest)) = argv.split_first() {
            let mut c = CommandBuilder::new(exe);
            c.args(rest);
            c
        } else {
            let mut c = CommandBuilder::new(shell_name);
            #[cfg(windows)]
            if shell_name.contains("powershell") {
                c.args(["-NoProfile", "-Command", command_str]);
            } else {
                c.args(["/C", command_str]);
            }
            #[cfg(not(windows))]
            c.args(["-c", command_str]);
            c
        }
    } else {
        let mut c = CommandBuilder::new(shell_name);
        #[cfg(windows)]
        if shell_name.contains("powershell") {
            c.args(["-NoProfile", "-Command", command_str]);
        } else {
            c.args(["/C", command_str]);
        }
        #[cfg(not(windows))]
        c.args(["-c", command_str]);
        c
    };

    cmd.cwd(working_dir);

    let mut child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn PTY child: {e}"))?;
    drop(pair.slave); // Required to ensure EOF when command terminates

    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY master reader: {e}"))?;

    let output_handle = std::thread::spawn(move || {
        let mut capture = BoundedCapture::new();
        let mut chunk = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => capture.push(&chunk[..n]),
            }
        }
        capture
    });

    // The PTY child leads its own session, so its pid is its process group: a timeout or cancel ends the group.
    #[cfg(unix)]
    let pty_pgid = child.process_id().map(|p| p as libc::pid_t);
    #[cfg(unix)]
    let cancelled = match (key, pty_pgid) {
        (Some(k), Some(pgid)) => Some(registry::start(k, pgid)),
        _ => None,
    };

    let max_timeout = max_tool_timeout_secs();
    let (effective_timeout, clamped) = if timeout_secs > max_timeout {
        (max_timeout, true)
    } else {
        (timeout_secs, false)
    };

    let timeout = Duration::from_secs(effective_timeout);
    let poll_interval = Duration::from_millis(50);
    let mut timed_out = false;

    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() > timeout {
                    #[cfg(unix)]
                    if let Some(pgid) = pty_pgid {
                        registry::end_groups(&[pgid], Duration::from_millis(500));
                    }
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
    let mut text = output_handle.join().map(|c| c.render()).unwrap_or_default();
    if clamped {
        text = format!("[Notice: timeout_secs clamped from {} to {} (NEXUS_MAX_TOOL_TIMEOUT_SECS)]\n{}", timeout_secs, effective_timeout, text);
    }

    #[cfg(unix)]
    let was_cancelled = match (key, cancelled) {
        (Some(k), Some(flag)) => {
            registry::finish(k);
            flag.load(std::sync::atomic::Ordering::SeqCst)
        }
        _ => false,
    };
    #[cfg(not(unix))]
    let was_cancelled = false;

    Ok(RunCommandResult {
        command: command_str.to_string(),
        shell: shell_name.to_string(),
        exit_code: exit_status.and_then(|s| if s.success() { Some(0) } else { Some(1) }),
        stdout: text,
        stderr: String::new(),
        duration_ms: start.elapsed().as_millis(),
        timed_out,
        cancelled: was_cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    #[cfg(unix)]
    fn output_is_kept_when_a_background_process_holds_the_pipe() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir();
        let started = Instant::now();
        let result = run_command(
            RunCommandArgs { command: "echo before; sleep 3 & echo after".into(), cwd: None, timeout_secs: 30, shell: default_shell(), pty: false, argv: None, ..Default::default() },
            &dir,
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "returned after the drain, not when the background job ended");
        assert!(result.stdout.contains("before") && result.stdout.contains("after"), "{:?}", result.stdout);
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
    }

    #[test]
    fn test_dangerous_command_detection() {
        // Destructive commands that must trigger the tripwire
        assert!(is_dangerous_command("rm -rf /").is_some());
        assert!(is_dangerous_command("sudo rm -rf /*").is_some());
        assert!(is_dangerous_command("rm -rf ~").is_some());
        assert!(is_dangerous_command("rm -rf $HOME").is_some());
        assert!(is_dangerous_command("rm -rf .").is_some());
        assert!(is_dangerous_command("rm -rf ..").is_some());
        assert!(is_dangerous_command("mkfs.ext4 /dev/sda1").is_some());
        assert!(is_dangerous_command("dd if=/dev/zero of=/dev/sda bs=1M").is_some());
        assert!(is_dangerous_command(":(){ :|:& };:").is_some());
        assert!(is_dangerous_command("chmod -R 777 /").is_some());
        assert!(is_dangerous_command("shutdown -h now").is_some());
        assert!(is_dangerous_command("reboot").is_some());

        // Safe commands that must not be blocked
        assert!(is_dangerous_command("cargo test").is_none());
        assert!(is_dangerous_command("ls -la /").is_none());
        assert!(is_dangerous_command("git status").is_none());
        assert!(is_dangerous_command("cat /etc/hosts").is_none());
        assert!(is_dangerous_command("npm run build").is_none());

        // False positives that must pass (ACC-SAFE-07 / SEC-02)
        assert!(is_dangerous_command("rm -rf ./build").is_none());
        assert!(is_dangerous_command("rm -rf ./x").is_none());
        assert!(is_dangerous_command("rm -rf /tmp/x").is_none());
        assert!(is_dangerous_command("grep -rn reboot src").is_none());
        assert!(is_dangerous_command("grep reboot").is_none());
        assert!(is_dangerous_command("echo shutdown").is_none());
        assert!(is_dangerous_command("chown -R me /srv").is_none());

        // Documented non-goals (bypasses asserted as not blocked by design per SPEC-01 §5.5)
        assert!(is_dangerous_command("find / -delete").is_none());
        assert!(is_dangerous_command("/bin/rm -rf /").is_none());
        assert!(is_dangerous_command("python3 -c 'import shutil; shutil.rmtree(\"/\")'").is_none());
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
            argv: None,
            ..Default::default()
        }, &cwd).unwrap();

        assert_eq!(res.exit_code, Some(0));
        assert!(res.stdout.contains("PTY terminal test"));
    }

    #[test]
    fn test_run_command_direct_argv() {
        let cwd = std::env::current_dir().unwrap();
        let res = run_command(RunCommandArgs {
            command: "fallback command".into(),
            cwd: None,
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
            argv: Some(vec!["echo".into(), "direct argv output /tmp/a b/'q".into()]),
            ..Default::default()
        }, &cwd).unwrap();

        assert_eq!(res.exit_code, Some(0));
        assert!(res.stdout.contains("direct argv output /tmp/a b/'q"));
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
            argv: None,
            ..Default::default()
        }, &workspace);
        assert!(res_none.is_ok());

        // 2. In-workspace relative subdir cwd is permitted
        let res_sub = run_command(RunCommandArgs {
            command: "pwd".into(),
            cwd: Some("subdir".into()),
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
            argv: None,
            ..Default::default()
        }, &workspace);
        assert!(res_sub.is_ok());

        // 3. Absolute path outside workspace is rejected
        let res_ext = run_command(RunCommandArgs {
            command: "pwd".into(),
            cwd: Some(external.to_string_lossy().to_string()),
            timeout_secs: 5,
            shell: default_shell(),
            pty: false,
            argv: None,
            ..Default::default()
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
            argv: None,
            ..Default::default()
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
                argv: None,
                ..Default::default()
            }, &workspace);
            assert!(res_sym.is_err());
            assert!(res_sym.unwrap_err().contains("cwd escapes workspace jail"));
        }

        let _ = std::fs::remove_dir_all(&temp_base);
    }

    #[test]
    fn bounded_capture_keeps_head_tail_and_an_exact_count() {
        let mut cap = BoundedCapture::new();
        let data: Vec<u8> = (0..100_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        for chunk in data.chunks(777) {
            cap.push(chunk);
        }
        let half = MAX_OUTPUT_CHARS / 2;
        let out = cap.render();
        assert!(out.starts_with(std::str::from_utf8(&data[..half]).unwrap()));
        assert!(out.ends_with(std::str::from_utf8(&data[data.len() - half..]).unwrap()));
        assert!(out.contains(&format!("[TRUNCATED {} BYTES]", data.len() - 2 * half)), "{}", &out[half..half + 80]);

        let mut small = BoundedCapture::new();
        small.push(b"hello ");
        small.push(b"world");
        assert_eq!(small.render(), "hello world");
    }

    #[cfg(unix)]
    #[test]
    fn large_output_is_bounded_and_counted() {
        let cwd = std::env::current_dir().unwrap();
        let res = run_command(RunCommandArgs {
            command: "head -c 5000000 /dev/zero | tr '\\0' a".to_string(),
            cwd: None,
            timeout_secs: 30,
            shell: default_shell(),
            pty: false,
            argv: None,
            ..Default::default()
        }, &cwd).unwrap();
        assert!(res.stdout.len() < MAX_OUTPUT_CHARS + 200, "{}", res.stdout.len());
        assert!(res.stdout.contains(&format!("[TRUNCATED {} BYTES]", 5_000_000 - MAX_OUTPUT_CHARS)));
    }

    /// REQ-AGT-109: cancelling a request ends its whole process group (background children included), promptly.
    #[cfg(unix)]
    #[test]
    fn cancel_ends_the_command_group() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let cwd = std::env::current_dir().unwrap();
        let marker = "sleep 30.123";
        let handle = std::thread::spawn({
            let cwd = cwd.clone();
            move || run_command_tracked(RunCommandArgs {
                command: format!("({marker} &); {marker}"),
                cwd: None,
                timeout_secs: 120,
                shell: default_shell(),
                pty: false,
                argv: None,
                ..Default::default()
            }, &cwd, Some("cancel-test"))
        });
        let started = Instant::now();
        while count_exact(marker) < 2 && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(cancel_command("cancel-test", Duration::from_secs(2)));
        let res = handle.join().unwrap().unwrap();
        assert!(res.cancelled, "the result says the command was cancelled");
        assert!(!res.timed_out);
        assert!(started.elapsed() < Duration::from_secs(8));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(count_exact(marker), 0, "processes survived the cancel");
        assert!(!cancel_command("cancel-test", Duration::from_secs(1)), "nothing left to cancel");
    }

    /// REQ-SEC-106: background processes a finished command left running are ended on request and at shutdown.
    #[cfg(unix)]
    #[test]
    fn background_processes_left_by_a_command_are_ended() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let cwd = std::env::current_dir().unwrap();
        let marker = "sleep 30.456";
        let res = run_command_tracked(RunCommandArgs {
            command: format!("{marker} & echo started"),
            cwd: None,
            timeout_secs: 30,
            shell: default_shell(),
            pty: false,
            argv: None,
            ..Default::default()
        }, &cwd, Some("background-test")).unwrap();
        assert!(res.stdout.contains("started"));
        assert_eq!(count_exact(marker), 1, "the background process outlives the call by design");
        assert!(end_background_commands(Duration::from_secs(2)) >= 1);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(count_exact(marker), 0, "background process survived");
    }

    /// Processes whose whole command line is exactly `command` (not the shells that started them).
    #[cfg(unix)]
    fn count_exact(command: &str) -> usize {
        let out = Command::new("pgrep").args(["-x", "-f", &regex::escape(command)]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).lines().count()
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
            argv: None,
            ..Default::default()
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
            argv: None,
            ..Default::default()
        }, &cwd).unwrap();
        assert!(!res.timed_out);
        assert_eq!(res.exit_code, Some(3));
        assert!(res.stdout.contains("failing"));
    }

    #[test]
    fn test_timeout_clamp_and_notice() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("NEXUS_MAX_TOOL_TIMEOUT_SECS", "5") };
        let cwd = std::env::current_dir().unwrap();
        let res = run_command(RunCommandArgs {
            command: "echo clamped test".to_string(),
            cwd: None,
            timeout_secs: 3600,
            ..Default::default()
        }, &cwd).unwrap();
        unsafe { std::env::remove_var("NEXUS_MAX_TOOL_TIMEOUT_SECS") };

        assert!(res.stdout.contains("[Notice: timeout_secs clamped from 3600 to 5 (NEXUS_MAX_TOOL_TIMEOUT_SECS)]"), "stdout was: {}", res.stdout);
        assert!(res.stdout.contains("clamped test"));
    }

    #[cfg(unix)]
    #[test]
    fn test_background_service_registration_and_lifecycle() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let cwd = std::env::current_dir().unwrap();
        let marker = "sleep 33.777";
        let res = run_command_tracked(RunCommandArgs {
            command: format!("{marker}"),
            cwd: None,
            background: true,
            service_name: Some("my_service".into()),
            ..Default::default()
        }, &cwd, Some("svc_req_1")).unwrap();

        assert!(res.stdout.contains("Background service 'my_service' started") || res.stdout.contains("Background service 'my_service' registered"));
        assert_eq!(count_exact(marker), 1, "service is running");

        // Service is listed in list_services()
        let services = list_services();
        assert!(services.iter().any(|s| s.name == "my_service"), "services: {:?}", services);

        // Turn cancellation (end_background_commands) does NOT kill registered services
        assert_eq!(end_background_commands(Duration::from_millis(500)), 0);
        assert_eq!(count_exact(marker), 1, "registered service survived turn cancel");

        // Shutdown sweep (end_all_commands) DOES kill registered services
        assert!(end_all_commands(Duration::from_millis(500)) >= 1);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(count_exact(marker), 0, "registered service was killed on shutdown");
        assert_eq!(list_services().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn test_background_service_that_exits_during_startup_is_not_registered() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let cwd = std::env::current_dir().unwrap();
        let res = run_command_tracked(RunCommandArgs {
            command: "true".into(),
            cwd: None,
            background: true,
            service_name: Some("gone_service".into()),
            ..Default::default()
        }, &cwd, Some("svc_req_gone")).unwrap();

        assert!(res.stdout.contains("exited during startup"), "stdout: {}", res.stdout);
        assert!(
            !res.stdout.contains("registered"),
            "a service that already exited must not be reported registered: {}",
            res.stdout
        );
        // Run the sweep before list_services(): list_services prunes dead entries itself.
        assert_eq!(registry::service_count_including_dead(), 0, "dead service must not remain registered");
        assert_eq!(end_all_commands(Duration::from_millis(500)), 0, "no stale service group remains");
        assert!(!list_services().iter().any(|s| s.name == "gone_service"));
    }

    #[cfg(unix)]
    #[test]
    fn test_background_service_with_live_descendant_stays_registered() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let cwd = std::env::current_dir().unwrap();
        let marker = "sleep 34.123";
        // The shell exits during the grace while the backgrounded child keeps the group alive.
        let res = run_command_tracked(RunCommandArgs {
            command: format!("{marker} &"),
            cwd: None,
            background: true,
            service_name: Some("desc_service".into()),
            ..Default::default()
        }, &cwd, Some("svc_req_desc")).unwrap();

        assert!(
            res.stdout.contains("started") || res.stdout.contains("registered"),
            "a live descendant keeps the service: {}",
            res.stdout
        );
        assert!(list_services().iter().any(|s| s.name == "desc_service"));
        assert_eq!(count_exact(marker), 1, "descendant is running");
        assert!(end_all_commands(Duration::from_millis(500)) >= 1);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(count_exact(marker), 0, "shutdown sweep kills the registered group");
        assert_eq!(list_services().len(), 0);
    }
}

