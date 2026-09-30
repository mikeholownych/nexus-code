use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadFileArgs {
    pub path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EditFileResult {
    pub path: String,
    pub replacements: usize,
    pub diff: String,
}

/// Helper to verify a file is not binary
fn is_binary_file(path: &Path) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let mut buffer = [0u8; 1024];
    use std::io::Read;
    let bytes_read = file.read(&mut buffer)?;
    Ok(buffer[..bytes_read].contains(&0))
}

pub fn read_file(args: ReadFileArgs, base_dir: &Path) -> Result<ReadFileResult, String> {
    let target = base_dir.join(&args.path);
    if !target.exists() {
        return Err(format!("File does not exist: {}", args.path));
    }
    if target.is_dir() {
        return Err(format!("Target is a directory, not a file: {}", args.path));
    }

    if is_binary_file(&target).unwrap_or(false) {
        return Err(format!("File is binary, cannot display as text: {}", args.path));
    }

    let file = File::open(&target).map_err(|e| format!("Failed to open file: {e}"))?;
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

    Ok(ReadFileResult {
        path: args.path,
        total_lines: total,
        start_line: start,
        end_line: end,
        content: numbered_content,
    })
}

pub fn write_file(args: WriteFileArgs, base_dir: &Path) -> Result<WriteFileResult, String> {
    let target = base_dir.join(&args.path);

    if target.exists() && !args.overwrite {
        return Err(format!(
            "File already exists: {}. Specify overwrite: true to replace it.",
            args.path
        ));
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {e}"))?;
    }

    fs::write(&target, args.content.as_bytes())
        .map_err(|e| format!("Failed to write to file: {e}"))?;

    Ok(WriteFileResult {
        path: args.path,
        bytes_written: args.content.len(),
        status: if target.exists() { "overwritten".into() } else { "created".into() },
    })
}

/// Normalizes line endings (\r\n -> \n) for robust matching
fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n")
}

pub fn edit_file(args: EditFileArgs, base_dir: &Path) -> Result<EditFileResult, String> {
    let target = base_dir.join(&args.path);
    if !target.exists() {
        return Err(format!("File does not exist: {}", args.path));
    }

    let raw_original = fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    // Try exact replacement first
    let (new_file_content, count) = if raw_original.contains(&args.old_content) {
        let count = raw_original.matches(&args.old_content).count();
        (raw_original.replacen(&args.old_content, &args.new_content, 1), count)
    } else {
        // Fallback: newline-normalized matching
        let norm_orig = normalize_newlines(&raw_original);
        let norm_old = normalize_newlines(&args.old_content);
        let norm_new = normalize_newlines(&args.new_content);

        if norm_orig.contains(&norm_old) {
            let count = norm_orig.matches(&norm_old).count();
            (norm_orig.replacen(&norm_old, &norm_new, 1), count)
        } else {
            // Trim leading/trailing whitespace lines fallback (common local LLM artifact)
            let trimmed_old = norm_old.trim();
            if !trimmed_old.is_empty() && norm_orig.contains(trimmed_old) {
                let count = norm_orig.matches(trimmed_old).count();
                (norm_orig.replacen(trimmed_old, norm_new.trim(), 1), count)
            } else {
                return Err(format!(
                    "Could not find exact text match in {}. Ensure the snippet matches the existing file contents.",
                    args.path
                ));
            }
        }
    };

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

    // Write modified content
    fs::write(&target, new_file_content.as_bytes())
        .map_err(|e| format!("Failed to write edited content: {e}"))?;

    Ok(EditFileResult {
        path: args.path,
        replacements: count,
        diff: diff_str,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteFileArgs {
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteFileResult {
    pub path: String,
    pub status: String,
}

pub fn delete_file(args: DeleteFileArgs, base_dir: &Path) -> Result<DeleteFileResult, String> {
    let target = base_dir.join(&args.path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", args.path));
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to remove directory: {e}"))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to remove file: {e}"))?;
    }
    Ok(DeleteFileResult {
        path: args.path,
        status: "deleted".into(),
    })
}
