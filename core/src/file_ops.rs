use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

pub const MAX_READ_BYTES: usize = 8 * 1024 * 1024; // 8 MB limit per REQ-SEC-107

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadFileArgs {
    pub path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub length: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadFileResult {
    pub path: String,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteFileArgs {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteFileResult {
    pub path: String,
    pub bytes_written: usize,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EditFileArgs {
    pub path: String,
    pub old_content: String,
    pub new_content: String,
    #[serde(default)]
    pub replace_all: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EditFileResult {
    pub path: String,
    pub replacements: usize,
    pub diff: String,
}

/// Verifies that an open file descriptor's target actually resides within the authorized workspace jail.
/// Implements Option C of DEC-01 (Descriptor-Level Verification).
pub fn verify_descriptor_confinement<F: AsRawFd>(file: &F, base_canon: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let fd = file.as_raw_fd();
        let proc_fd_path = format!("/proc/self/fd/{}", fd);
        match fs::read_link(&proc_fd_path) {
            Ok(resolved_path) => {
                if !resolved_path.starts_with(base_canon) {
                    return Err(format!(
                        "Security Violation: File descriptor points outside workspace jail: {}",
                        resolved_path.display()
                    ));
                }
            }
            Err(e) => {
                return Err(format!(
                    "Security Violation: Failed to verify descriptor confinement (/proc/self/fd/{}): {e}",
                    fd
                ));
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = file;
        let _ = base_canon;
    }
    Ok(())
}

static ATOMIC_WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Atomically writes content to target file via a temporary file in the same directory, syncing data to disk and
/// renaming it over the target path.
///
/// - The parent directory is checked against the workspace before any directory is created.
/// - An existing read-only file is refused (as an in-place write would be).
/// - An existing file's permission bits are kept; the temporary file is private (0600) until they are applied.
/// - A file with other hard links is written in place, so the links keep sharing the content.
/// - On any failure the temporary file is removed.
///
/// Ownership, ACLs and extended attributes of an existing file are not carried over to the new inode.
pub fn write_file_atomically(target: &Path, content: &[u8], base_canon: &Path) -> Result<(), String> {
    let effective_target = if target.is_symlink() {
        let canon = target.canonicalize().map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                format!("File does not exist: {e}")
            } else {
                format!("Security Violation: Failed to open symlink: {e}")
            }
        })?;
        if !canon.starts_with(base_canon) {
            return Err("Security Violation: Symlink points outside workspace jail".into());
        }
        canon
    } else {
        target.to_path_buf()
    };

    if let Some(parent) = effective_target.parent() {
        // The nearest existing ancestor must be inside the workspace before anything is created under it.
        let mut existing = parent;
        while !existing.exists() {
            existing = existing.parent().ok_or_else(|| format!("Invalid parent directory: {}", parent.display()))?;
        }
        let existing_canon = existing.canonicalize().map_err(|e| format!("Invalid parent directory: {e}"))?;
        if !existing_canon.starts_with(base_canon) {
            return Err(format!("Security Violation: Parent directory escapes workspace jail: {}", parent.display()));
        }
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {e}"))?;
        let parent_canon = parent.canonicalize().map_err(|e| format!("Invalid parent directory: {e}"))?;
        if !parent_canon.starts_with(base_canon) {
            return Err(format!("Security Violation: Parent directory escapes workspace jail: {}", parent.display()));
        }
    }

    let existing = effective_target.metadata().ok();
    if let Some(meta) = &existing {
        if meta.permissions().readonly() {
            return Err(format!("Permission denied: {} is read-only", effective_target.display()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() > 1 {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&effective_target)
                    .map_err(|e| format!("Failed to open file: {e}"))?;
                verify_descriptor_confinement(&file, base_canon)?;
                file.write_all(content).map_err(|e| format!("Failed to write file: {e}"))?;
                return file.sync_all().map_err(|e| format!("Failed to sync file: {e}"));
            }
        }
    }

    let temp_name = format!(
        ".{}.tmp_atomic.{}.{}",
        effective_target.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id(),
        ATOMIC_WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let temp_path = effective_target.parent().unwrap_or_else(|| Path::new(".")).join(temp_name);

    let written = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        // A new file gets the default mode under the umask (applied by the kernel). Replacing a file, the temporary
        // file stays private until the original's permission bits are applied, so its content is never more
        // widely readable than the original's.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if existing.is_some() { 0o600 } else { 0o666 });
        }
        let mut temp_file = options.open(&temp_path).map_err(|e| format!("Failed to open temp file: {e}"))?;
        verify_descriptor_confinement(&temp_file, base_canon)?;
        temp_file.write_all(content).map_err(|e| format!("Failed to write to temp file: {e}"))?;
        temp_file.sync_all().map_err(|e| format!("Failed to sync temp file: {e}"))?;
        if let Some(meta) = &existing {
            fs::set_permissions(&temp_path, meta.permissions()).map_err(|e| format!("Failed to set permissions: {e}"))?;
        }
        fs::rename(&temp_path, &effective_target).map_err(|e| format!("Security Violation: Failed to commit write: {e}"))?;
        // Fsync parent directory after rename (REQ-PER-107, Task 10)
        if let Some(parent) = effective_target.parent() {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    written
}

/// Helper to verify an open file descriptor is not binary
fn is_binary_file_descriptor(mut file: &File) -> io::Result<bool> {
    let mut buffer = [0u8; 1024];
    let bytes_read = file.read(&mut buffer)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(buffer[..bytes_read].contains(&0))
}

/// Helper to verify a file is not binary
#[allow(dead_code)]
fn is_binary_file(path: &Path) -> io::Result<bool> {
    let mut file = File::open(path)?;
    is_binary_file_descriptor(&mut file)
}

pub fn read_file(args: ReadFileArgs, base_dir: &Path) -> Result<ReadFileResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let target = resolve_safe_path(base_dir, &args.path)?;
    if !target.exists() {
        return Err(format!("File does not exist: {}", args.path));
    }
    if target.is_dir() {
        return Err(format!("Target is a directory, not a file: {}", args.path));
    }

    let mut file = File::open(&target).map_err(|e| format!("Failed to open file: {e}"))?;
    verify_descriptor_confinement(&file, &base_canon)?;

    let file_meta = file.metadata().map_err(|e| format!("Failed to get metadata: {e}"))?;
    let file_size = file_meta.len() as usize;

    if file_size > MAX_READ_BYTES && args.offset.is_none() && args.length.is_none() {
        return Err(format!(
            "File size ({} bytes) exceeds 8 MB limit ({} bytes). Use 'offset' and 'length' arguments to page through the file.",
            file_size, MAX_READ_BYTES
        ));
    }

    if is_binary_file_descriptor(&file).unwrap_or(false) {
        return Err(format!("File is binary, cannot display as text: {}", args.path));
    }

    if args.offset.is_some() || args.length.is_some() {
        let offset = args.offset.unwrap_or(0);
        if offset > file_size {
            return Err(format!("offset ({offset}) exceeds file size ({file_size})"));
        }
        let requested_len = args.length.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES);
        let actual_len = requested_len.min(file_size.saturating_sub(offset));

        file.seek(SeekFrom::Start(offset as u64))
            .map_err(|e| format!("Failed to seek file: {e}"))?;
        let mut buf = vec![0u8; actual_len];
        file.read_exact(&mut buf)
            .map_err(|e| format!("Failed to read file slice: {e}"))?;

        let text = String::from_utf8_lossy(&buf);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let mut numbered_content = String::new();
        for (idx, line) in lines.iter().enumerate() {
            let line_num = idx + 1;
            numbered_content.push_str(&format!("{line_num:>5} | {line}\n"));
        }
        return Ok(ReadFileResult {
            path: args.path,
            total_lines: total,
            start_line: if total > 0 { 1 } else { 0 },
            end_line: total,
            content: numbered_content,
        });
    }

    let (total, start, end, numbered_content) = if file_size > 0 {
        // High-performance Memory-Mapped I/O (Candidate #07)
        if let Ok(mmap) = unsafe { memmap2::Mmap::map(&file) } {
            let text = String::from_utf8_lossy(&mmap);
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();
            let start = args.start_line.unwrap_or(1).max(1);
            let end = args.end_line.unwrap_or(total).min(total);

            if start > total && total > 0 {
                return Err(format!("start_line ({start}) exceeds total lines ({total})"));
            }

            let mut numbered_content = String::new();
            if total > 0 && start <= end {
                for (idx, line) in lines[start - 1..end].iter().enumerate() {
                    let line_num = start + idx;
                    numbered_content.push_str(&format!("{line_num:>5} | {line}\n"));
                }
            }
            (total, start, end, numbered_content)
        } else {
            let reader = BufReader::new(file);
            let all_lines: Vec<String> = reader.lines().collect::<Result<_, _>>()
                .map_err(|e| format!("Failed to read lines: {e}"))?;
            let total = all_lines.len();
            let start = args.start_line.unwrap_or(1).max(1);
            let end = args.end_line.unwrap_or(total).min(total);

            if start > total && total > 0 {
                return Err(format!("start_line ({start}) exceeds total lines ({total})"));
            }

            let mut numbered_content = String::new();
            if total > 0 && start <= end {
                for (idx, line) in all_lines[start - 1..end].iter().enumerate() {
                    let line_num = start + idx;
                    numbered_content.push_str(&format!("{line_num:>5} | {line}\n"));
                }
            }
            (total, start, end, numbered_content)
        }
    } else {
        (0, 1, 0, String::new())
    };

    Ok(ReadFileResult {
        path: args.path,
        total_lines: total,
        start_line: start,
        end_line: end,
        content: numbered_content,
    })
}

pub fn write_file(args: WriteFileArgs, base_dir: &Path) -> Result<WriteFileResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let target = resolve_safe_path(base_dir, &args.path)?;

    let was_existing = target.exists();
    if was_existing && !args.overwrite {
        return Err(format!(
            "File already exists: {}. Specify overwrite: true to replace it.",
            args.path
        ));
    }

    // Pre-flight syntax validation to protect local workspace code integrity
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ext == "json" {
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&args.content) {
            return Err(format!(
                "Pre-flight syntax validation rejected write to {}: invalid JSON ({e}). The file was not modified.",
                args.path
            ));
        }
    } else if matches!(ext, "rs" | "ts" | "tsx" | "js" | "jsx" | "go" | "c" | "cpp") {
        if let Err(msg) = validate_syntax_delimiters(&args.content, ext) {
            return Err(format!(
                "Pre-flight syntax validation rejected write to {}: {msg}. The file was not modified.",
                args.path
            ));
        }
    }

    write_file_atomically(&target, args.content.as_bytes(), &base_canon)?;

    Ok(WriteFileResult {
        path: args.path,
        bytes_written: args.content.len(),
        status: if was_existing { "overwritten".into() } else { "created".into() },
    })
}

/// Normalizes line endings (\r\n -> \n) for robust matching
fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Where `old_content` matches the file only when indentation is ignored: the 1-based line of the single such
/// match and the file's exact lines there. Edits are never applied this way (the replacement would carry the model's
/// indentation); the caller reports the exact lines so the edit can be retried precisely.
fn indentation_only_match(original: &str, old_content: &str) -> Option<(usize, String)> {
    let norm_orig = normalize_newlines(original);
    let norm_old = normalize_newlines(old_content);
    let orig_lines: Vec<&str> = norm_orig.lines().collect();
    let old_lines: Vec<&str> = norm_old.lines().collect();
    let start = old_lines.iter().position(|l| !l.trim().is_empty())?;
    let end = old_lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
    let window = &old_lines[start..end];
    if orig_lines.len() < window.len() {
        return None;
    }
    let matches: Vec<usize> = (0..=(orig_lines.len() - window.len()))
        .filter(|&i| window.iter().enumerate().all(|(k, l)| orig_lines[i + k].trim() == l.trim()))
        .collect();
    match matches.as_slice() {
        [i] => Some((i + 1, orig_lines[*i..*i + window.len()].iter().take(20).copied().collect::<Vec<_>>().join("\n"))),
        _ => None,
    }
}

/// Replaces `old` with `new` in `hay`: once (an error when `old` occurs more than once without `replace_all`) or
/// everywhere. Only occurrences at positions `accept` allows count.
fn replace_occurrences(
    hay: &str,
    old: &str,
    new: &str,
    replace_all: bool,
    path: &str,
    accept: impl Fn(usize, usize) -> bool,
) -> Result<Option<(String, usize)>, String> {
    let positions: Vec<usize> = hay.match_indices(old).map(|(i, _)| i).filter(|&i| accept(i, i + old.len())).collect();
    if positions.is_empty() {
        return Ok(None);
    }
    if positions.len() > 1 && !replace_all {
        return Err(format!(
            "Ambiguous edit in {path}: found {} occurrences of target text. Provide more context to make the edit unique, or set replace_all: true.",
            positions.len()
        ));
    }
    let mut out = String::with_capacity(hay.len());
    let mut last = 0;
    for &i in positions.iter().take(if replace_all { usize::MAX } else { 1 }) {
        out.push_str(&hay[last..i]);
        out.push_str(new);
        last = i + old.len();
    }
    out.push_str(&hay[last..]);
    Ok(Some((out, positions.len())))
}

/// Pre-flight syntax delimiter validation for source files.
/// Verifies that braces {}, brackets [], and parentheses () are balanced and properly closed,
/// taking into account comments, quotes, template literals, and language nuances.
pub fn validate_syntax_delimiters(content: &str, ext: &str) -> Result<(), String> {
    if !matches!(ext, "rs" | "ts" | "tsx" | "js" | "jsx" | "c" | "cpp" | "go" | "java") {
        return Ok(());
    }

    let mut stack: Vec<(char, usize, usize)> = Vec::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_template_literal = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut is_escaped = false;

    let mut line = 1;
    let mut col = 0;
    let chars: Vec<char> = content.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];
        col += 1;

        if ch == '\n' {
            line += 1;
            col = 0;
            in_line_comment = false;
            if in_single_quote || in_double_quote {
                in_single_quote = false;
                in_double_quote = false;
            }
            i += 1;
            continue;
        }

        if in_line_comment {
            i += 1;
            continue;
        }

        if in_block_comment {
            if ch == '*' && i + 1 < len && chars[i + 1] == '/' {
                in_block_comment = false;
                i += 2;
                col += 1;
                continue;
            }
            i += 1;
            continue;
        }

        if in_single_quote {
            if is_escaped {
                is_escaped = false;
            } else if ch == '\\' {
                is_escaped = true;
            } else if ch == '\'' {
                in_single_quote = false;
            }
            i += 1;
            continue;
        }

        if in_double_quote {
            if is_escaped {
                is_escaped = false;
            } else if ch == '\\' {
                is_escaped = true;
            } else if ch == '"' {
                in_double_quote = false;
            }
            i += 1;
            continue;
        }

        if in_template_literal {
            if is_escaped {
                is_escaped = false;
            } else if ch == '\\' {
                is_escaped = true;
            } else if ch == '`' {
                in_template_literal = false;
            }
            i += 1;
            continue;
        }

        // Comment check
        if ch == '/' && i + 1 < len {
            if chars[i + 1] == '/' {
                in_line_comment = true;
                i += 2;
                col += 1;
                continue;
            } else if chars[i + 1] == '*' {
                in_block_comment = true;
                i += 2;
                col += 1;
                continue;
            }
        }

        // Quote start check
        if ch == '\'' {
            // In Rust, distinguish character literals ('c', '\n') from lifetime annotations (&'a str, 'loop:)
            if ext == "rs" {
                let is_char_lit = (i + 2 < len && chars[i + 2] == '\'')
                    || (i + 3 < len && chars[i + 1] == '\\' && chars[i + 3] == '\'');
                if is_char_lit {
                    in_single_quote = true;
                    is_escaped = false;
                    i += 1;
                    continue;
                }
            } else {
                in_single_quote = true;
                is_escaped = false;
                i += 1;
                continue;
            }
        }

        if ch == '"' {
            in_double_quote = true;
            is_escaped = false;
            i += 1;
            continue;
        }

        if ch == '`' && matches!(ext, "ts" | "tsx" | "js" | "jsx" | "go") {
            in_template_literal = true;
            is_escaped = false;
            i += 1;
            continue;
        }

        // Delimiter matching
        match ch {
            '{' | '(' | '[' => {
                stack.push((ch, line, col));
            }
            '}' => {
                match stack.pop() {
                    Some(('{', _, _)) => {}
                    Some((open_ch, open_line, open_col)) => {
                        return Err(format!(
                            "Mismatched delimiter: closing '}}' at line {line}:{col} does not match '{open_ch}' opened at line {open_line}:{open_col}"
                        ));
                    }
                    None => {
                        return Err(format!("Unmatched closing delimiter '}}' at line {line}:{col}"));
                    }
                }
            }
            ')' => {
                match stack.pop() {
                    Some(('(', _, _)) => {}
                    Some((open_ch, open_line, open_col)) => {
                        return Err(format!(
                            "Mismatched delimiter: closing ')' at line {line}:{col} does not match '{open_ch}' opened at line {open_line}:{open_col}"
                        ));
                    }
                    None => {
                        return Err(format!("Unmatched closing delimiter ')' at line {line}:{col}"));
                    }
                }
            }
            ']' => {
                match stack.pop() {
                    Some(('[', _, _)) => {}
                    Some((open_ch, open_line, open_col)) => {
                        return Err(format!(
                            "Mismatched delimiter: closing ']' at line {line}:{col} does not match '{open_ch}' opened at line {open_line}:{open_col}"
                        ));
                    }
                    None => {
                        return Err(format!("Unmatched closing delimiter ']' at line {line}:{col}"));
                    }
                }
            }
            _ => {}
        }

        i += 1;
    }

    if let Some((open_ch, open_line, open_col)) = stack.pop() {
        return Err(format!(
            "Unclosed delimiter: '{open_ch}' opened at line {open_line}:{open_col} was not closed"
        ));
    }

    Ok(())
}

pub fn edit_file(args: EditFileArgs, base_dir: &Path) -> Result<EditFileResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let target = resolve_safe_path(base_dir, &args.path)?;
    if !target.exists() {
        return Err(format!("File does not exist: {}", args.path));
    }

    let raw_original = {
        let file = File::open(&target).map_err(|e| format!("Failed to open file: {e}"))?;
        verify_descriptor_confinement(&file, &base_canon)?;
        // Editing needs the whole file in memory. Refuse the sizes the read tool would not load whole, and cap the
        // read so a file that grows after the check cannot allocate without bound.
        let size = file.metadata().map_err(|e| format!("Failed to get metadata: {e}"))?.len();
        if size > MAX_READ_BYTES as u64 {
            return Err(format!(
                "File is too large to edit safely: {size} bytes exceeds the 8 MB limit ({MAX_READ_BYTES} bytes)"
            ));
        }
        let mut reader = BufReader::new(file).take(MAX_READ_BYTES as u64 + 1);
        let mut content = String::new();
        reader.read_to_string(&mut content).map_err(|e| format!("Failed to read file: {e}"))?;
        if content.len() > MAX_READ_BYTES {
            return Err(format!(
                "File is too large to edit safely: it grew beyond the 8 MB limit ({MAX_READ_BYTES} bytes)"
            ));
        }
        content
    };

    let replace_all = args.replace_all.unwrap_or(false);
    // A file that uses CRLF throughout gets CRLF in the text the model sends; a file with mixed endings is matched
    // exactly as it is, and none of its other lines is rewritten.
    let crlf_file = raw_original.contains("\r\n") && !raw_original.replace("\r\n", "").contains('\n');
    let to_file_eol = |text: &str| if crlf_file { normalize_newlines(text).replace('\n', "\r\n") } else { text.to_string() };
    let anywhere = |_: usize, _: usize| true;

    let exact = replace_occurrences(&raw_original, &args.old_content, &to_file_eol(&args.new_content), replace_all, &args.path, anywhere)?;
    let eol = if exact.is_none() && crlf_file {
        replace_occurrences(&raw_original, &to_file_eol(&args.old_content), &to_file_eol(&args.new_content), replace_all, &args.path, anywhere)?
    } else {
        None
    };
    // Leading and trailing blank lines around the snippet (a common local-model artifact) are ignored, but what
    // remains must match whole lines: it starts at a line start and ends at a line end.
    let whole_lines = if exact.is_none() && eol.is_none() {
        let hay = if crlf_file { normalize_newlines(&raw_original) } else { raw_original.clone() };
        let strip = |text: &str| -> String {
            let text = normalize_newlines(text);
            let lines: Vec<&str> = text.lines().collect();
            match (lines.iter().position(|l| !l.trim().is_empty()), lines.iter().rposition(|l| !l.trim().is_empty())) {
                (Some(a), Some(b)) => lines[a..=b].join("\n").trim_end().to_string(),
                _ => String::new(),
            }
        };
        let old = strip(&args.old_content);
        let new = strip(&args.new_content);
        if old.is_empty() {
            None
        } else {
            let bytes = hay.as_bytes();
            let at_line_start = |i: usize| i == 0 || bytes[i - 1] == b'\n';
            let at_line_end = |j: usize| hay[j..].chars().take_while(|c| *c != '\n').all(|c| c == ' ' || c == '\t' || c == '\r');
            replace_occurrences(&hay, &old, &new, replace_all, &args.path, |i, j| at_line_start(i) && at_line_end(j))?
                .map(|(text, n)| (if crlf_file { text.replace('\n', "\r\n") } else { text }, n))
        }
    } else {
        None
    };
    let (new_file_content, count) = match exact.or(eol).or(whole_lines) {
        Some(found) => found,
        None => {
            return Err(match indentation_only_match(&raw_original, &args.old_content) {
                Some((line, actual)) => format!(
                    "No exact match in {}: the snippet matches line {line} only if indentation is ignored. Retry with the file's exact text:\n{actual}",
                    args.path
                ),
                None => format!(
                    "Could not find exact text match in {}. Ensure the snippet matches the existing file contents.",
                    args.path
                ),
            });
        }
    };

    // Pre-flight syntax validation to protect local workspace code integrity
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ext == "json" {
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&new_file_content) {
            return Err(format!(
                "Pre-flight syntax validation rejected edit on {}: invalid JSON ({e}). The file was not modified. Please adjust your edit.",
                args.path
            ));
        }
    } else if matches!(ext, "rs" | "ts" | "tsx" | "js" | "jsx" | "go" | "c" | "cpp") {
        if let Err(msg) = validate_syntax_delimiters(&new_file_content, ext) {
            return Err(format!(
                "Pre-flight syntax validation rejected edit on {}: {msg}. The file was not modified. Please adjust your edit to maintain valid syntax.",
                args.path
            ));
        }
    }

    // Generate unified diff
    let diff = TextDiff::from_lines(&raw_original, &new_file_content);
    let mut diff_str = String::new();
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Delete => "-",
            ChangeTag::Insert => "+",
            ChangeTag::Equal => " ",
        };
        diff_str.push_str(&format!("{sign}{change}"));
    }

    write_file_atomically(&target, new_file_content.as_bytes(), &base_canon)?;

    Ok(EditFileResult {
        path: args.path,
        replacements: count,
        diff: diff_str,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteFileArgs {
    pub path: String,
    #[serde(default)]
    pub recursive: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteFileResult {
    pub path: String,
    pub status: String,
}

pub fn delete_file(args: DeleteFileArgs, base_dir: &Path) -> Result<DeleteFileResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let target = resolve_safe_path(base_dir, &args.path)?;
    if !target.exists() {
        return Err(format!("Path does not exist: {}", args.path));
    }
    let canon = target.canonicalize().map_err(|e| format!("Invalid target: {e}"))?;
    if !canon.starts_with(&base_canon) {
        return Err(format!("Security Violation: Path escapes workspace jail: {}", args.path));
    }
    if canon == base_canon {
        return Err("Security Violation: Cannot delete workspace root directory".into());
    }
    // Nothing in the repository's own data: `.git` or anything under it (objects, HEAD, refs).
    let inside_git = |path: &Path| path.strip_prefix(&base_canon).is_ok_and(|rel| rel.components().any(|c| c.as_os_str() == ".git"));
    if inside_git(&canon) || target.strip_prefix(base_dir).is_ok_and(|rel| rel.components().any(|c| c.as_os_str() == ".git")) {
        return Err("Security Violation: Cannot delete .git or anything inside it".into());
    }
    if target.is_dir() {
        if !args.recursive.unwrap_or(false) {
            return Err(format!("Path is a directory: {}. Use recursive=true to delete directories", args.path));
        }
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to remove directory: {e}"))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to remove file: {e}"))?;
    }
    Ok(DeleteFileResult {
        path: args.path,
        status: "deleted".into(),
    })
}

pub fn resolve_safe_path(base_dir: &Path, rel_path: &str) -> Result<std::path::PathBuf, String> {
    // Cross-platform path normalization (Candidate #50)
    let clean_rel = rel_path.trim().replace('\\', "/");
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;

    let clean_path = std::path::Path::new(&clean_rel);
    if clean_path.is_absolute() {
        let path = std::path::PathBuf::from(&clean_rel);
        if let Ok(path_canon) = path.canonicalize() {
            if path_canon.starts_with(&base_canon) {
                return Ok(path_canon);
            }
        }
        return Err(format!("Security Violation: Path escapes workspace jail: {clean_rel}"));
    }

    let joined = base_dir.join(clean_rel);
    let mut normalized = std::path::PathBuf::new();
    for comp in joined.components() {
        match comp {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("Security Violation: Path escapes workspace root: {rel_path}"));
                }
            }
            std::path::Component::Normal(c) => normalized.push(c),
            std::path::Component::RootDir => normalized.push("/"),
            std::path::Component::Prefix(_) => {},
            std::path::Component::CurDir => {},
        }
    }

    // 1. If target exists or is a symlink, verify canonicalization stays under base_canon
    if normalized.exists() || normalized.is_symlink() {
        if let Ok(norm_canon) = normalized.canonicalize() {
            if !norm_canon.starts_with(&base_canon) {
                return Err(format!("Security Violation: Symlink/path escapes workspace jail: {rel_path}"));
            }
        } else if normalized.is_symlink() {
            return Err(format!("Security Violation: Broken or escaping symlink detected: {rel_path}"));
        }
    } else {
        // 2. If target does not exist yet (e.g. creating new file), check all existing ancestors
        let mut curr = normalized.as_path();
        while let Some(parent) = curr.parent() {
            if parent.exists() || parent.is_symlink() {
                if let Ok(parent_canon) = parent.canonicalize() {
                    if !parent_canon.starts_with(&base_canon) {
                        return Err(format!("Security Violation: Parent directory symlink escapes workspace jail: {rel_path}"));
                    }
                } else if parent.is_symlink() {
                    return Err(format!("Security Violation: Broken parent symlink detected: {rel_path}"));
                }
                break;
            }
            curr = parent;
        }
    }

    Ok(normalized)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfoArgs {
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfoResult {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size_bytes: u64,
    pub line_count: Option<usize>,
    pub is_binary: bool,
    pub permissions: Option<String>,
    pub modified_iso: Option<String>,
}

pub fn file_info(args: FileInfoArgs, base_dir: &Path) -> Result<FileInfoResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let target = resolve_safe_path(base_dir, &args.path)?;
    if !target.exists() {
        return Ok(FileInfoResult {
            path: args.path,
            exists: false,
            is_file: false,
            is_dir: false,
            is_symlink: false,
            size_bytes: 0,
            line_count: None,
            is_binary: false,
            permissions: None,
            modified_iso: None,
        });
    }

    if let Ok(canon) = target.canonicalize() {
        if !canon.starts_with(&base_canon) {
            return Err(format!("Security Violation: Path escapes workspace jail: {}", args.path));
        }
    }

    let sym_meta = fs::symlink_metadata(&target).map_err(|e| format!("Metadata error: {e}"))?;
    let is_symlink = sym_meta.file_type().is_symlink();
    let meta = fs::metadata(&target).map_err(|e| format!("Metadata error: {e}"))?;
    let is_file = meta.is_file();
    let is_dir = meta.is_dir();
    let size = meta.len();

    let mut line_count = None;
    let mut is_bin = false;

    if is_file {
        if let Ok(file) = File::open(&target) {
            if verify_descriptor_confinement(&file, &base_canon).is_ok() {
                // The binary probe reads only 1 KB and applies at every size; only line counting walks the file.
                is_bin = is_binary_file_descriptor(&file).unwrap_or(false);
                // Count lines only within the read tool's limit. Use the opened descriptor's size, not the path
                // metadata read earlier: the file may have grown or been replaced since.
                let opened_size = file.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
                if !is_bin && opened_size <= MAX_READ_BYTES as u64 {
                    if let Ok(mmap) = unsafe { memmap2::Mmap::map(&file) } {
                        let newlines = mmap.iter().filter(|&&b| b == b'\n').count();
                        let has_trailing = mmap.last().map(|&b| b != b'\n').unwrap_or(false);
                        line_count = Some(if has_trailing { newlines + 1 } else { newlines });
                    } else {
                        let reader = BufReader::new(file);
                        line_count = Some(reader.lines().count());
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    let perms = {
        use std::os::unix::fs::PermissionsExt;
        Some(format!("{:o}", meta.permissions().mode() & 0o777))
    };
    #[cfg(not(unix))]
    let perms = None;

    let modified = meta.modified().ok().and_then(|t| {
        let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
        Some(format!("epoch_secs:{}", dur.as_secs()))
    });

    Ok(FileInfoResult {
        path: args.path,
        exists: true,
        is_file,
        is_dir,
        is_symlink,
        size_bytes: size,
        line_count,
        is_binary: is_bin,
        permissions: perms,
        modified_iso: modified,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchReadArgs {
    pub paths: Vec<String>,
    pub max_lines_per_file: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub length: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchReadFileEntry {
    pub path: String,
    pub success: bool,
    pub total_lines: usize,
    pub content: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchReadResult {
    pub total_files: usize,
    pub files: Vec<BatchReadFileEntry>,
}

pub fn batch_read(args: BatchReadArgs, base_dir: &Path) -> Result<BatchReadResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let mut results = Vec::new();
    let max_lines = args.max_lines_per_file.unwrap_or(500);

    for path_str in &args.paths {
        match resolve_safe_path(base_dir, path_str) {
            Ok(target) => {
                if !target.exists() {
                    results.push(BatchReadFileEntry {
                        path: path_str.clone(),
                        success: false,
                        total_lines: 0,
                        content: String::new(),
                        error: Some("File does not exist".into()),
                    });
                    continue;
                }
                if target.is_dir() {
                    results.push(BatchReadFileEntry {
                        path: path_str.clone(),
                        success: false,
                        total_lines: 0,
                        content: String::new(),
                        error: Some("Target is a directory".into()),
                    });
                    continue;
                }

                match File::open(&target) {
                    Ok(mut file) => {
                        if let Err(e) = verify_descriptor_confinement(&file, &base_canon) {
                            results.push(BatchReadFileEntry {
                                path: path_str.clone(),
                                success: false,
                                total_lines: 0,
                                content: String::new(),
                                error: Some(e),
                            });
                            continue;
                        }
                        let file_size = match file.metadata() {
                            Ok(m) => m.len() as usize,
                            Err(e) => {
                                results.push(BatchReadFileEntry {
                                    path: path_str.clone(),
                                    success: false,
                                    total_lines: 0,
                                    content: String::new(),
                                    error: Some(format!("Failed to get metadata: {e}")),
                                });
                                continue;
                            }
                        };

                        if file_size > MAX_READ_BYTES && args.offset.is_none() && args.length.is_none() {
                            results.push(BatchReadFileEntry {
                                path: path_str.clone(),
                                success: false,
                                total_lines: 0,
                                content: String::new(),
                                error: Some(format!(
                                    "File size ({} bytes) exceeds 8 MB limit ({} bytes). Use 'offset' and 'length' arguments to page through the file.",
                                    file_size, MAX_READ_BYTES
                                )),
                            });
                            continue;
                        }

                        if is_binary_file_descriptor(&file).unwrap_or(false) {
                            results.push(BatchReadFileEntry {
                                path: path_str.clone(),
                                success: false,
                                total_lines: 0,
                                content: String::new(),
                                error: Some("File is binary".into()),
                            });
                            continue;
                        }

                        if args.offset.is_some() || args.length.is_some() {
                            let offset = args.offset.unwrap_or(0);
                            if offset > file_size {
                                results.push(BatchReadFileEntry {
                                    path: path_str.clone(),
                                    success: false,
                                    total_lines: 0,
                                    content: String::new(),
                                    error: Some(format!("offset ({offset}) exceeds file size ({file_size})")),
                                });
                                continue;
                            }
                            let requested_len = args.length.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES);
                            let actual_len = requested_len.min(file_size.saturating_sub(offset));
                            if let Err(e) = file.seek(SeekFrom::Start(offset as u64)) {
                                results.push(BatchReadFileEntry {
                                    path: path_str.clone(),
                                    success: false,
                                    total_lines: 0,
                                    content: String::new(),
                                    error: Some(format!("Failed to seek file: {e}")),
                                });
                                continue;
                            }
                            let mut buf = vec![0u8; actual_len];
                            if let Err(e) = file.read_exact(&mut buf) {
                                results.push(BatchReadFileEntry {
                                    path: path_str.clone(),
                                    success: false,
                                    total_lines: 0,
                                    content: String::new(),
                                    error: Some(format!("Failed to read file slice: {e}")),
                                });
                                continue;
                            }
                            let text = String::from_utf8_lossy(&buf);
                            let lines: Vec<&str> = text.lines().collect();
                            let total = lines.len();
                            let slice = &lines[..total.min(max_lines)];
                            let mut numbered = String::new();
                            for (idx, line) in slice.iter().enumerate() {
                                numbered.push_str(&format!("{:>5} | {}\n", idx + 1, line));
                            }
                            results.push(BatchReadFileEntry {
                                path: path_str.clone(),
                                success: true,
                                total_lines: total,
                                content: numbered,
                                error: None,
                            });
                            continue;
                        }

                        let reader = BufReader::new(file);
                        let all_lines: Vec<String> = reader.lines().filter_map(Result::ok).collect();
                        let total = all_lines.len();
                        let slice = &all_lines[..total.min(max_lines)];
                        let mut numbered = String::new();
                        for (idx, line) in slice.iter().enumerate() {
                            numbered.push_str(&format!("{:>5} | {}\n", idx + 1, line));
                        }
                        results.push(BatchReadFileEntry {
                            path: path_str.clone(),
                            success: true,
                            total_lines: total,
                            content: numbered,
                            error: None,
                        });
                    }
                    Err(e) => {
                        results.push(BatchReadFileEntry {
                            path: path_str.clone(),
                            success: false,
                            total_lines: 0,
                            content: String::new(),
                            error: Some(format!("Open error: {e}")),
                        });
                    }
                }
            }
            Err(e) => {
                results.push(BatchReadFileEntry {
                    path: path_str.clone(),
                    success: false,
                    total_lines: 0,
                    content: String::new(),
                    error: Some(e),
                });
            }
        }
    }

    Ok(BatchReadResult {
        total_files: results.len(),
        files: results,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatchFileArgs {
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PatchFileResult {
    pub path: String,
    pub applied_hunks: usize,
    pub total_hunks: usize,
    pub diff: String,
}

pub fn patch_file(args: PatchFileArgs, base_dir: &Path) -> Result<PatchFileResult, String> {
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;
    let target = resolve_safe_path(base_dir, &args.path)?;
    if !target.exists() {
        return Err(format!("File does not exist: {}", args.path));
    }

    let original_content = {
        let file = File::open(&target).map_err(|e| format!("Failed to open file: {e}"))?;
        verify_descriptor_confinement(&file, &base_canon)?;
        if is_binary_file_descriptor(&file).unwrap_or(false) {
            return Err(format!("Cannot patch binary file: {}", args.path));
        }
        let size = file.metadata().map_err(|e| format!("Failed to get metadata: {e}"))?.len();
        if size > MAX_READ_BYTES as u64 {
            return Err(format!(
                "File is too large to patch safely: {size} bytes exceeds the 8 MB limit ({MAX_READ_BYTES} bytes)"
            ));
        }
        let mut reader = BufReader::new(file).take(MAX_READ_BYTES as u64 + 1);
        let mut content = String::new();
        reader.read_to_string(&mut content).map_err(|e| format!("Failed to read file: {e}"))?;
        if content.len() > MAX_READ_BYTES {
            return Err(format!(
                "File is too large to patch safely: it grew beyond the 8 MB limit ({MAX_READ_BYTES} bytes)"
            ));
        }
        content
    };

    struct Hunk {
        old_lines: Vec<String>,
        new_lines: Vec<String>,
    }

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut current_old = Vec::new();
    let mut current_new = Vec::new();
    let mut in_hunk = false;

    for line in args.patch.lines() {
        if line.starts_with("@@") {
            if in_hunk && (!current_old.is_empty() || !current_new.is_empty()) {
                hunks.push(Hunk {
                    old_lines: current_old,
                    new_lines: current_new,
                });
                current_old = Vec::new();
                current_new = Vec::new();
            }
            in_hunk = true;
            continue;
        }

        if !in_hunk {
            if line.starts_with("---") || line.starts_with("+++") {
                continue;
            }
            in_hunk = true;
        }

        if line.starts_with('-') {
            current_old.push(line[1..].to_string());
        } else if line.starts_with('+') {
            current_new.push(line[1..].to_string());
        } else if line.starts_with(' ') {
            current_old.push(line[1..].to_string());
            current_new.push(line[1..].to_string());
        } else {
            current_old.push(line.to_string());
            current_new.push(line.to_string());
        }
    }

    if in_hunk && (!current_old.is_empty() || !current_new.is_empty()) {
        hunks.push(Hunk {
            old_lines: current_old,
            new_lines: current_new,
        });
    }

    if hunks.is_empty() {
        return Err("No valid patch hunks found in provided patch".to_string());
    }

    let mut file_lines: Vec<String> = original_content.lines().map(|s| s.to_string()).collect();
    let total_hunks = hunks.len();
    let mut applied_hunks = 0;

    for hunk in hunks {
        let old_block = hunk.old_lines;
        let new_block = hunk.new_lines;

        if old_block.is_empty() {
            continue;
        }

        let mut match_idx = None;
        for i in 0..=file_lines.len().saturating_sub(old_block.len()) {
            let slice = &file_lines[i..i + old_block.len()];
            if slice == old_block.as_slice() {
                match_idx = Some(i);
                break;
            }
        }

        if let Some(idx) = match_idx {
            file_lines.splice(idx..idx + old_block.len(), new_block);
            applied_hunks += 1;
        } else {
            return Err(format!(
                "Hunk failed to match context in {}. Target snippet not found.",
                args.path
            ));
        }
    }

    let mut new_content = file_lines.join("\n");
    if original_content.ends_with('\n') {
        new_content.push('\n');
    }

    let has_crlf = original_content.contains("\r\n");
    if has_crlf {
        new_content = new_content.replace("\r\n", "\n").replace('\n', "\r\n");
    }

    write_file_atomically(&target, new_content.as_bytes(), &base_canon)?;

    let diff = TextDiff::from_lines(&original_content, &new_content);
    let mut diff_str = String::new();
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Delete => "-",
            ChangeTag::Insert => "+",
            ChangeTag::Equal => " ",
        };
        diff_str.push_str(&format!("{}{}", sign, change));
    }

    Ok(PatchFileResult {
        path: args.path,
        applied_hunks,
        total_hunks,
        diff: diff_str,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_resolve_safe_path() {
        let temp_dir = std::env::temp_dir();
        let safe = resolve_safe_path(&temp_dir, "foo/bar.txt");
        assert!(safe.is_ok());

        let escaping = resolve_safe_path(&temp_dir, "../../etc/passwd");
        assert!(escaping.is_err());
    }

    #[test]
    #[cfg(unix)]
    fn test_symlink_boundary_confinement() {
        let root = std::env::temp_dir().join(format!("test_symlink_{}", std::process::id()));
        let workspace = root.join("workspace");
        let external = root.join("external");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&external).unwrap();

        let secret = external.join("secret.txt");
        fs::write(&secret, "super_secret_key").unwrap();

        // Symlink pointing to external file
        let sym_file = workspace.join("sym_secret.txt");
        let _ = std::os::unix::fs::symlink(&secret, &sym_file);

        let res = resolve_safe_path(&workspace, "sym_secret.txt");
        assert!(res.is_err(), "Expected escaping symlink to be rejected");

        // Symlink pointing to external directory
        let sym_dir = workspace.join("sym_ext_dir");
        let _ = std::os::unix::fs::symlink(&external, &sym_dir);

        let res_parent = resolve_safe_path(&workspace, "sym_ext_dir/new_file.txt");
        assert!(res_parent.is_err(), "Expected escaping symlink parent to be rejected");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_edit_file_refuses_files_above_the_read_limit() {
        let dir = std::env::temp_dir().join(format!("test_edit_limit_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let at_limit = dir.join("at-limit-edit.txt");
        let first_line = "needle unique\n";
        let mut exact = String::from(first_line);
        exact.push_str(&"x".repeat(MAX_READ_BYTES - first_line.len()));
        fs::write(&at_limit, &exact).unwrap();
        let boundary = edit_file(
            EditFileArgs {
                path: "at-limit-edit.txt".into(),
                old_content: "needle unique".into(),
                new_content: "changed".into(),
                replace_all: None,
            },
            &dir,
        );
        assert!(boundary.is_ok(), "a file exactly at the read limit stays editable: {boundary:?}");

        let target = dir.join("big-edit.txt");
        let mut content = String::from("needle unique\n");
        content.push_str(&"x".repeat(MAX_READ_BYTES));
        fs::write(&target, &content).unwrap();
        let before = fs::read(&target).unwrap();

        let result = edit_file(
            EditFileArgs {
                path: "big-edit.txt".into(),
                old_content: "needle unique".into(),
                new_content: "changed".into(),
                replace_all: None,
            },
            &dir,
        );
        assert!(result.is_err(), "edit_file must refuse a file above the read limit");
        assert!(result.unwrap_err().contains("8 MB"));
        assert_eq!(fs::read(&target).unwrap(), before, "the oversized file was modified");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_patch_file_refuses_files_above_the_read_limit() {
        let dir = std::env::temp_dir().join(format!("test_patch_limit_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("big-patch.txt");
        let mut content = String::from("needle unique\n");
        content.push_str(&"x".repeat(MAX_READ_BYTES));
        fs::write(&target, &content).unwrap();
        let before = fs::read(&target).unwrap();

        let result = patch_file(
            PatchFileArgs {
                path: "big-patch.txt".into(),
                patch: "@@\n-needle unique\n+changed\n".into(),
            },
            &dir,
        );
        assert!(result.is_err(), "patch_file must refuse a file above the read limit");
        assert!(result.unwrap_err().contains("8 MB"));
        assert_eq!(fs::read(&target).unwrap(), before, "the oversized file was modified");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_file_info_does_not_scan_files_above_the_read_limit() {
        let dir = std::env::temp_dir().join(format!("test_file_info_limit_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let small = dir.join("small.txt");
        fs::write(&small, "one\ntwo\n").unwrap();
        let big = dir.join("big.txt");
        let big_len = MAX_READ_BYTES + 1;
        let chunk = vec![b'\n'; 1024 * 1024];
        {
            let mut file = fs::File::create(&big).unwrap();
            let mut written = 0;
            while written < big_len {
                let n = (big_len - written).min(chunk.len());
                file.write_all(&chunk[..n]).unwrap();
                written += n;
            }
            file.sync_all().unwrap();
        }

        let empty = dir.join("empty.txt");
        fs::write(&empty, "").unwrap();
        let at_limit = dir.join("at-limit.txt");
        {
            let mut file = fs::File::create(&at_limit).unwrap();
            let mut written = 0;
            while written < MAX_READ_BYTES {
                let n = (MAX_READ_BYTES - written).min(chunk.len());
                file.write_all(&chunk[..n]).unwrap();
                written += n;
            }
        }
        let big_binary = dir.join("big.bin");
        fs::write(&big_binary, vec![0u8; MAX_READ_BYTES + 1]).unwrap();

        let small_info = file_info(FileInfoArgs { path: "small.txt".into() }, &dir).unwrap();
        assert_eq!(small_info.line_count, Some(2));
        let empty_info = file_info(FileInfoArgs { path: "empty.txt".into() }, &dir).unwrap();
        assert_eq!(empty_info.line_count, Some(0));
        assert_eq!(empty_info.is_binary, false);
        let limit_info = file_info(FileInfoArgs { path: "at-limit.txt".into() }, &dir).unwrap();
        assert_eq!(limit_info.size_bytes, MAX_READ_BYTES as u64);
        assert_eq!(limit_info.line_count, Some(MAX_READ_BYTES), "the exact read limit is still scanned");
        let big_info = file_info(FileInfoArgs { path: "big.txt".into() }, &dir).unwrap();
        assert_eq!(big_info.size_bytes, big_len as u64);
        assert_eq!(
            big_info.line_count, None,
            "a file above the read limit must not be scanned for its line count"
        );
        let big_binary_info = file_info(FileInfoArgs { path: "big.bin".into() }, &dir).unwrap();
        assert_eq!(big_binary_info.is_binary, true, "binary detection does not depend on the read limit");
        assert_eq!(big_binary_info.line_count, None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_file_info_and_batch_read() {
        let dir = std::env::temp_dir().join(format!("test_harness_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let f1 = dir.join("file1.txt");
        let mut file1 = File::create(&f1).unwrap();
        writeln!(file1, "Line 1\nLine 2\nLine 3").unwrap();

        let info = file_info(FileInfoArgs { path: "file1.txt".into() }, &dir).unwrap();
        assert!(info.exists);
        assert!(info.is_file);
        assert_eq!(info.line_count, Some(3));

        let batch = batch_read(BatchReadArgs {
            paths: vec!["file1.txt".into(), "nonexistent.txt".into()],
            max_lines_per_file: Some(10),
            offset: None,
            length: None,
        }, &dir).unwrap();

        assert_eq!(batch.total_files, 2);
        assert!(batch.files[0].success);
        assert!(!batch.files[1].success);

        // Test patch_file
        let patch_content = "@@ -1,3 +1,3 @@\n Line 1\n-Line 2\n+Line 2 Patched\n Line 3\n";
        let patch_res = patch_file(PatchFileArgs {
            path: "file1.txt".into(),
            patch: patch_content.into(),
        }, &dir).unwrap();

        assert_eq!(patch_res.applied_hunks, 1);
        let updated = fs::read_to_string(&f1).unwrap();
        assert!(updated.contains("Line 2 Patched"));

        // An indentation mismatch is reported with the file's exact lines, not applied.
        let code_file = dir.join("code.rs");
        fs::write(&code_file, "fn main() {\n    let val = 42;\n    println!(\"{}\", val);\n}\n").unwrap();

        // Model provides old_content with no indentation
        let err = edit_file(EditFileArgs {
            path: "code.rs".into(),
            old_content: "let val = 42;\nprintln!(\"{}\", val);".into(),
            new_content: "    let val = 100;\n    println!(\"Updated: {}\", val);".into(),
            replace_all: None,
        }, &dir).unwrap_err();
        assert!(err.contains("line 2 only if indentation is ignored") && err.contains("    let val = 42;"), "{err}");

        // Retried with the exact text it quoted, the edit applies.
        let edit_res = edit_file(EditFileArgs {
            path: "code.rs".into(),
            old_content: "    let val = 42;\n    println!(\"{}\", val);".into(),
            new_content: "    let val = 100;\n    println!(\"Updated: {}\", val);".into(),
            replace_all: None,
        }, &dir).unwrap();

        assert_eq!(edit_res.replacements, 1);
        let updated_code = fs::read_to_string(&code_file).unwrap();
        assert!(updated_code.contains("let val = 100;"));
        assert!(updated_code.contains("Updated: {}"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_preflight_syntax_validation() {
        let dir = std::env::temp_dir().join(format!("test_syntax_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // 1. Valid syntax should pass write_file
        let valid_ts = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
        let res1 = write_file(WriteFileArgs {
            path: "math.ts".into(),
            content: valid_ts.into(),
            overwrite: false,
        }, &dir);
        assert!(res1.is_ok());

        // 2. Unclosed brace should be rejected by write_file
        let invalid_ts = "export function broken() {\n  console.log('unclosed');\n";
        let res2 = write_file(WriteFileArgs {
            path: "broken.ts".into(),
            content: invalid_ts.into(),
            overwrite: false,
        }, &dir);
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("Unclosed delimiter"));

        // 3. Invalid JSON should be rejected
        let invalid_json = "{ \"name\": \"nexus\", \"count\": }";
        let res3 = write_file(WriteFileArgs {
            path: "config.json".into(),
            content: invalid_json.into(),
            overwrite: false,
        }, &dir);
        assert!(res3.is_err());
        assert!(res3.unwrap_err().contains("invalid JSON"));

        // 4. Broken edit should be rejected by edit_file without touching the file
        let edit_err = edit_file(EditFileArgs {
            path: "math.ts".into(),
            old_content: "return a + b;".into(),
            new_content: "return { a + b;".into(), // introduces unclosed brace
            replace_all: None,
        }, &dir);
        assert!(edit_err.is_err());
        assert!(edit_err.unwrap_err().contains("Pre-flight syntax validation rejected edit"));

        // Verify math.ts was NOT corrupted
        let content_after = fs::read_to_string(dir.join("math.ts")).unwrap();
        assert!(content_after.contains("return a + b;"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_dec01_descriptor_confinement() {
        let root = std::env::temp_dir().join(format!("test_dec01_{}", std::process::id()));
        let workspace = root.join("workspace");
        let external = root.join("external");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&external).unwrap();

        let ext_file = external.join("outside.txt");
        fs::write(&ext_file, "external secret").unwrap();

        let inside_file = workspace.join("inside.txt");
        fs::write(&inside_file, "inside content").unwrap();

        let sym_file = workspace.join("sym_link.txt");
        let _ = std::os::unix::fs::symlink(&ext_file, &sym_file);

        let ws_canon = workspace.canonicalize().unwrap();

        // 1. Direct descriptor verification on valid in-workspace file
        let valid_f = File::open(&inside_file).unwrap();
        assert!(verify_descriptor_confinement(&valid_f, &ws_canon).is_ok());

        // 2. Direct descriptor verification on escaping symlink descriptor
        let sym_f = File::open(&sym_file).unwrap();
        let res = verify_descriptor_confinement(&sym_f, &ws_canon);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("File descriptor points outside workspace jail"));

        // 3. Attempt read_file through escaping symlink
        let read_res = read_file(ReadFileArgs {
            path: "sym_link.txt".into(),
            start_line: None,
            end_line: None,
            offset: None,
            length: None,
        }, &workspace);
        assert!(read_res.is_err());

        // 4. Attempt write_file through escaping symlink
        let write_res = write_file(WriteFileArgs {
            path: "sym_link.txt".into(),
            content: "malicious overwrite".into(),
            overwrite: true,
        }, &workspace);
        assert!(write_res.is_err());
        // Verify external file was NOT overwritten
        assert_eq!(fs::read_to_string(&ext_file).unwrap(), "external secret");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn test_dec01_symlink_race_adversarial() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::thread;
        use std::time::Instant;

        let root = std::env::temp_dir().join(format!("test_dec01_race_{}", std::process::id()));
        let workspace = root.join("workspace");
        let external = root.join("external");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&external).unwrap();

        let secret_file = external.join("secret.txt");
        fs::write(&secret_file, "EXTERNAL_SECRET_DATA").unwrap();

        let valid_file = workspace.join("valid.txt");
        fs::write(&valid_file, "VALID_WORKSPACE_DATA").unwrap();

        let target_symlink = workspace.join("racy_link.txt");
        let _ = std::os::unix::fs::symlink(&valid_file, &target_symlink);

        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();
        let symlink_path = target_symlink.clone();
        let valid_target = valid_file.clone();
        let secret_target = secret_file.clone();

        // Attacker thread rapidly swaps symlink between internal valid file and external secret file
        let attacker = thread::spawn(move || {
            let mut flip = false;
            while running_clone.load(Ordering::Relaxed) {
                let _ = fs::remove_file(&symlink_path);
                if flip {
                    let _ = std::os::unix::fs::symlink(&valid_target, &symlink_path);
                } else {
                    let _ = std::os::unix::fs::symlink(&secret_target, &symlink_path);
                }
                flip = !flip;
                thread::yield_now();
            }
        });

        let mut read_attempts = 0;
        let mut read_rejections = 0;
        let mut read_successes = 0;
        let mut external_leak_count = 0;

        let start_time = Instant::now();
        for _ in 0..200 {
            read_attempts += 1;
            match read_file(ReadFileArgs {
                path: "racy_link.txt".into(),
                start_line: None,
                end_line: None,
                offset: None,
                length: None,
            }, &workspace) {
                Ok(res) => {
                    read_successes += 1;
                    if res.content.contains("EXTERNAL_SECRET_DATA") {
                        external_leak_count += 1;
                    }
                }
                Err(_) => {
                    read_rejections += 1;
                    // The attacker can unlink the entry between any two path operations, so
                    // race-dependent I/O errors are expected. The security properties are
                    // asserted below: no external bytes are returned and no external file is
                    // changed.
                }
            }
        }

        let mut write_attempts = 0;
        let mut write_rejections = 0;
        let mut write_successes = 0;

        for _ in 0..100 {
            write_attempts += 1;
            match write_file(WriteFileArgs {
                path: "racy_link.txt".into(),
                content: "VALID_WORKSPACE_DATA".into(),
                overwrite: true,
            }, &workspace) {
                Ok(_) => {
                    write_successes += 1;
                }
                Err(_) => {
                    write_rejections += 1;
                    // A concurrent unlink can produce platform-specific I/O errors. The
                    // external-file integrity assertion below is the relevant safety check.
                }
            }
        }

        let elapsed = start_time.elapsed();

        // Stop attacker thread
        running.store(false, Ordering::Relaxed);
        let _ = attacker.join();

        // 1. External file MUST NEVER have leaked into read results
        assert_eq!(external_leak_count, 0, "TOCTOU Symlink Race Escape: External secret data was read!");

        // 2. External file MUST NEVER have been mutated by write operations
        let secret_after = fs::read_to_string(&secret_file).unwrap();
        assert_eq!(secret_after, "EXTERNAL_SECRET_DATA", "TOCTOU Symlink Race Escape: External file was mutated!");

        println!(
            "DEC-01 Symlink Race Test: {} reads ({} ok, {} rejected), {} writes ({} ok, {} rejected), leaks: {}, elapsed: {:?}",
            read_attempts, read_successes, read_rejections, write_attempts, write_successes, write_rejections, external_leak_count, elapsed
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_exact_edits_fuzzy_rejected_t1() {
        let dir = std::env::temp_dir().join(format!("test_t1_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("f.rs");
        let orig = "fn f() {\n    let a = 1;\n    let b = 2;\n    audit_log(a);\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let g = 6;\n}\n";
        fs::write(&target, orig).unwrap();

        // 85% similar snippet with check_permissions instead of audit_log
        let old_content = "    let a = 1;\n    let b = 2;\n    check_permissions(a);\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let g = 6;";
        let new_content = "    let a = 1;\n    let b = 2;\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let g = 7;";

        let res = edit_file(EditFileArgs {
            path: "f.rs".into(),
            old_content: old_content.into(),
            new_content: new_content.into(),
            replace_all: None,
        }, &dir);

        assert!(res.is_err(), "Expected fuzzy match to be rejected");
        let content_after = fs::read_to_string(&target).unwrap();
        assert_eq!(content_after, orig, "File must remain byte-identical on rejected edit");

        let _ = fs::remove_dir_all(&dir);
    }

    fn edit_in(name: &str, file: &str, orig: &str, old: &str, new: &str) -> (Result<EditFileResult, String>, String) {
        let dir = std::env::temp_dir().join(format!("test_edit_{name}_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(file), orig).unwrap();
        let res = edit_file(EditFileArgs { path: file.into(), old_content: old.into(), new_content: new.into(), replace_all: None }, &dir);
        let after = fs::read_to_string(dir.join(file)).unwrap();
        let _ = fs::remove_dir_all(&dir);
        (res, after)
    }

    #[test]
    fn test_trimmed_snippet_matches_whole_lines_only() {
        // Blank lines and surrounding whitespace around the snippet are tolerated...
        let (res, after) = edit_in("trim_ok", "a.txt", "x = 1\ny = 2\n", "\n  \nx = 1\n\n", "x = 3\n");
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(after, "x = 3\ny = 2\n");
        // ...but the rest must be whole lines: `x = 1` is not inside `x = 10`.
        let (res, after) = edit_in("trim_token", "b.txt", "x = 10\n", "\nx = 1\n", "x = 2\n");
        assert!(res.is_err(), "{res:?}");
        assert_eq!(after, "x = 10\n");
    }

    #[test]
    fn test_indentation_only_match_is_reported_not_applied() {
        let orig = "fn f() {\n    let a = 1;\n}\n";
        let (res, after) = edit_in("indent", "f.rs", orig, "let a = 1;\n", "let a = 2;\n");
        // `let a = 1;` occurs exactly (inside the indented line) — whole-line matching would be wrong, exact is fine:
        assert!(res.is_ok());
        assert_eq!(after, "fn f() {\n    let a = 2;\n}\n");
        let (res, after) = edit_in("indent2", "g.rs", orig, "fn f() {\nlet a = 1;\n}", "fn f() {\nlet a = 2;\n}");
        let err = res.unwrap_err();
        assert!(err.contains("only if indentation is ignored") && err.contains("    let a = 1;"), "{err}");
        assert_eq!(after, orig, "nothing is written");
    }

    #[test]
    fn test_line_endings_follow_the_file() {
        // A CRLF file: an LF snippet matches and the replacement is written with CRLF.
        let (res, after) = edit_in("crlf", "c.txt", "a\r\nb\r\nc\r\n", "a\nb\n", "a\nB\nB2\n");
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(after, "a\r\nB\r\nB2\r\nc\r\n");
        // A mixed file: untouched LF lines stay LF.
        let (res, after) = edit_in("mixed", "m.txt", "a\r\nb\nc\n", "c", "C");
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(after, "a\r\nb\nC\n");
    }

    #[test]
    #[cfg(unix)]
    fn test_atomic_write_keeps_mode_links_and_refuses_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("test_atomic_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let base = dir.canonicalize().unwrap();

        let script = base.join("run.sh");
        fs::write(&script, "old").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o750)).unwrap();
        write_file_atomically(&script, b"new", &base).unwrap();
        assert_eq!(fs::read_to_string(&script).unwrap(), "new");
        assert_eq!(fs::metadata(&script).unwrap().permissions().mode() & 0o7777, 0o750, "the mode is kept");

        let locked = base.join("locked.txt");
        fs::write(&locked, "keep").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(write_file_atomically(&locked, b"x", &base).unwrap_err().contains("read-only"));
        assert_eq!(fs::read_to_string(&locked).unwrap(), "keep");

        let linked = base.join("a.txt");
        fs::write(&linked, "one").unwrap();
        fs::hard_link(&linked, base.join("b.txt")).unwrap();
        write_file_atomically(&linked, b"two", &base).unwrap();
        assert_eq!(fs::read_to_string(base.join("b.txt")).unwrap(), "two", "a hard link still shares the content");

        // An escape through the parent is refused before any directory is created.
        let outside = std::env::temp_dir().join(format!("test_atomic_outside_{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("out")).unwrap();
        assert!(write_file_atomically(&base.join("out/new_dir/f.txt"), b"x", &base).is_err());
        assert!(!outside.join("new_dir").exists(), "no directory was created outside the workspace");

        let leftovers: Vec<_> = fs::read_dir(&base).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("tmp_atomic")).collect();
        assert!(leftovers.is_empty(), "no temporary file is left behind");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn test_delete_refuses_git_and_anything_inside_it() {
        let dir = std::env::temp_dir().join(format!("test_delete_git_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git/objects")).unwrap();
        fs::write(dir.join(".git/HEAD"), "ref").unwrap();
        fs::write(dir.join(".gitignore"), "x").unwrap();
        for path in [".git", ".git/objects", ".git/HEAD", "./.git/HEAD"] {
            let res = delete_file(DeleteFileArgs { path: path.into(), recursive: Some(true) }, &dir);
            assert!(res.unwrap_err().contains(".git"), "{path}");
        }
        assert!(dir.join(".git/HEAD").exists() && dir.join(".git/objects").exists());
        assert!(delete_file(DeleteFileArgs { path: ".gitignore".into(), recursive: None }, &dir).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ambiguous_edit_rejected_t2() {
        let dir = std::env::temp_dir().join(format!("test_t2_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("dup.txt");
        let orig = "a = 1\nb = 2\na = 1\n";
        fs::write(&target, orig).unwrap();

        // 1. Without replace_all, ambiguous edit must fail
        let res_err = edit_file(EditFileArgs {
            path: "dup.txt".into(),
            old_content: "a = 1".into(),
            new_content: "a = 9".into(),
            replace_all: None,
        }, &dir);
        assert!(res_err.is_err());
        assert!(res_err.unwrap_err().contains("Ambiguous edit"));
        assert_eq!(fs::read_to_string(&target).unwrap(), orig);

        // 2. With replace_all: true, replaces both
        let res_ok = edit_file(EditFileArgs {
            path: "dup.txt".into(),
            old_content: "a = 1".into(),
            new_content: "a = 9".into(),
            replace_all: Some(true),
        }, &dir).unwrap();
        assert_eq!(res_ok.replacements, 2);
        assert_eq!(fs::read_to_string(&target).unwrap(), "a = 9\nb = 2\na = 9\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_crlf_preservation_and_status_t3() {
        let dir = std::env::temp_dir().join(format!("test_t3_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // 1. write_file created vs overwritten status
        let res_create = write_file(WriteFileArgs {
            path: "new.txt".into(),
            content: "hello\n".into(),
            overwrite: false,
        }, &dir).unwrap();
        assert_eq!(res_create.status, "created");

        let res_overwrite = write_file(WriteFileArgs {
            path: "new.txt".into(),
            content: "hello updated\n".into(),
            overwrite: true,
        }, &dir).unwrap();
        assert_eq!(res_overwrite.status, "overwritten");

        // 2. CRLF preservation in edit_file
        let crlf_file = dir.join("crlf.txt");
        fs::write(&crlf_file, "line1\r\nline2\r\nline3\r\n").unwrap();

        let edit_res = edit_file(EditFileArgs {
            path: "crlf.txt".into(),
            old_content: "line1\nline2".into(),
            new_content: "LINE1\nline2".into(),
            replace_all: None,
        }, &dir).unwrap();
        assert_eq!(edit_res.replacements, 1);

        let content_after = fs::read(&crlf_file).unwrap();
        assert_eq!(content_after, b"LINE1\r\nline2\r\nline3\r\n");

        // 3. CRLF preservation in patch_file
        let patch_res = patch_file(PatchFileArgs {
            path: "crlf.txt".into(),
            patch: "@@ -1,3 +1,3 @@\n LINE1\n-line2\n+LINE2\n line3\n".into(),
        }, &dir).unwrap();
        assert_eq!(patch_res.applied_hunks, 1);

        let patch_after = fs::read(&crlf_file).unwrap();
        assert_eq!(patch_after, b"LINE1\r\nLINE2\r\nline3\r\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_file_and_batch_read_8mb_cap_and_paging() {
        let dir = std::env::temp_dir().join(format!("test_cap_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let big_path = dir.join("big.txt");
        let mut f = File::create(&big_path).unwrap();
        // Create 9 MB sparse file with valid text in first 2KB so it is not treated as binary
        f.set_len(9 * 1024 * 1024).unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        let head_bytes = vec![b'x'; 2048];
        f.write_all(&head_bytes).unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        f.write_all(b"head content\n").unwrap();
        f.seek(SeekFrom::Start(1024 * 1024)).unwrap();
        f.write_all(b"middle content at 1MB\n").unwrap();
        f.sync_all().unwrap();

        // 1. read_file without offset/length on >8MB file returns error with paging hint
        let err = read_file(ReadFileArgs {
            path: "big.txt".into(),
            start_line: None,
            end_line: None,
            offset: None,
            length: None,
        }, &dir).unwrap_err();
        assert!(err.contains("exceeds 8 MB limit") && err.contains("offset") && err.contains("length"), "unexpected err: {err}");

        // 2. read_file with offset and length succeeds
        let res_head = read_file(ReadFileArgs {
            path: "big.txt".into(),
            start_line: None,
            end_line: None,
            offset: Some(0),
            length: Some(256),
        }, &dir).unwrap();
        assert!(res_head.content.contains("head content"));

        let res_mid = read_file(ReadFileArgs {
            path: "big.txt".into(),
            start_line: None,
            end_line: None,
            offset: Some(1024 * 1024),
            length: Some(256),
        }, &dir).unwrap();
        assert!(res_mid.content.contains("middle content at 1MB"));

        // 3. batch_read without offset/length reports error entry with paging hint
        let batch_err = batch_read(BatchReadArgs {
            paths: vec!["big.txt".into()],
            max_lines_per_file: Some(10),
            offset: None,
            length: None,
        }, &dir).unwrap();
        assert_eq!(batch_err.total_files, 1);
        assert!(!batch_err.files[0].success);
        let b_err_msg = batch_err.files[0].error.as_ref().unwrap();
        assert!(b_err_msg.contains("exceeds 8 MB limit") && b_err_msg.contains("offset") && b_err_msg.contains("length"));

        // 4. batch_read with offset and length succeeds
        let batch_ok = batch_read(BatchReadArgs {
            paths: vec!["big.txt".into()],
            max_lines_per_file: Some(10),
            offset: Some(1024 * 1024),
            length: Some(256),
        }, &dir).unwrap();
        assert_eq!(batch_ok.total_files, 1);
        assert!(batch_ok.files[0].success);
        assert!(batch_ok.files[0].content.contains("middle content at 1MB"));

        let _ = fs::remove_dir_all(&dir);
    }
}


