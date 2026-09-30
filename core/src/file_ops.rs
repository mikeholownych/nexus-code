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
    let target = resolve_safe_path(base_dir, &args.path)?;
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
    let target = resolve_safe_path(base_dir, &args.path)?;

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

/// Attempts fuzzy matching for `edit_file` when exact and normalized substring matches fail.
/// 1. Tries line-by-line trimmed matching (ignoring indentation / whitespace variations per line).
/// 2. Tries sliding window similarity using `similar::TextDiff` ratio (threshold >= 0.85).
fn fuzzy_find_and_replace(
    original: &str,
    old_content: &str,
    new_content: &str,
) -> Option<(String, usize)> {
    let norm_orig = normalize_newlines(original);
    let norm_old = normalize_newlines(old_content);
    let norm_new = normalize_newlines(new_content);

    let orig_lines: Vec<&str> = norm_orig.lines().collect();
    let old_lines: Vec<&str> = norm_old.lines().collect();

    // Strip leading and trailing empty lines from old_lines if needed
    let mut start = 0;
    while start < old_lines.len() && old_lines[start].trim().is_empty() {
        start += 1;
    }
    let mut end = old_lines.len();
    while end > start && old_lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    if start >= end {
        return None;
    }
    let trimmed_old_lines = &old_lines[start..end];
    let window_size = trimmed_old_lines.len();

    if window_size == 0 || orig_lines.len() < window_size {
        return None;
    }

    // Step 1: Check for exact line-by-line trimmed match (handles indentation differences)
    for i in 0..=(orig_lines.len() - window_size) {
        let mut matches = true;
        for k in 0..window_size {
            if orig_lines[i + k].trim() != trimmed_old_lines[k].trim() {
                matches = false;
                break;
            }
        }
        if matches {
            let mut result_lines = Vec::new();
            result_lines.extend_from_slice(&orig_lines[0..i]);
            result_lines.push(&norm_new);
            result_lines.extend_from_slice(&orig_lines[(i + window_size)..]);
            let mut reconstructed = result_lines.join("\n");
            if norm_orig.ends_with('\n') && !reconstructed.ends_with('\n') {
                reconstructed.push('\n');
            }
            return Some((reconstructed, 1));
        }
    }

    // Step 2: Sliding window TextDiff ratio match (>= 0.85 similarity)
    let old_joined = trimmed_old_lines.join("\n");
    let mut best_idx = None;
    let mut best_ratio = 0.85f32;

    for i in 0..=(orig_lines.len() - window_size) {
        let window_joined = orig_lines[i..(i + window_size)].join("\n");
        let diff = TextDiff::from_lines(&window_joined, &old_joined);
        let ratio = diff.ratio();
        if ratio > best_ratio {
            best_ratio = ratio;
            best_idx = Some(i);
        }
    }

    if let Some(i) = best_idx {
        let mut result_lines = Vec::new();
        result_lines.extend_from_slice(&orig_lines[0..i]);
        result_lines.push(&norm_new);
        result_lines.extend_from_slice(&orig_lines[(i + window_size)..]);
        let mut reconstructed = result_lines.join("\n");
        if norm_orig.ends_with('\n') && !reconstructed.ends_with('\n') {
            reconstructed.push('\n');
        }
        return Some((reconstructed, 1));
    }

    None
}

pub fn edit_file(args: EditFileArgs, base_dir: &Path) -> Result<EditFileResult, String> {
    let target = resolve_safe_path(base_dir, &args.path)?;
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
            } else if let Some((fuzzy_content, count)) = fuzzy_find_and_replace(&raw_original, &args.old_content, &args.new_content) {
                (fuzzy_content, count)
            } else {
                return Err(format!(
                    "Could not find exact or fuzzy text match in {}. Ensure the snippet matches the existing file contents.",
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
    let target = resolve_safe_path(base_dir, &args.path)?;
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

pub fn resolve_safe_path(base_dir: &Path, rel_path: &str) -> Result<std::path::PathBuf, String> {
    let clean_rel = rel_path.trim();
    let base_canon = base_dir.canonicalize().map_err(|e| format!("Invalid workspace directory: {e}"))?;

    if clean_rel.starts_with('/') {
        let path = std::path::PathBuf::from(clean_rel);
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

    let sym_meta = fs::symlink_metadata(&target).map_err(|e| format!("Metadata error: {e}"))?;
    let is_symlink = sym_meta.file_type().is_symlink();
    let meta = fs::metadata(&target).map_err(|e| format!("Metadata error: {e}"))?;
    let is_file = meta.is_file();
    let is_dir = meta.is_dir();
    let size = meta.len();

    let mut line_count = None;
    let mut is_bin = false;

    if is_file {
        is_bin = is_binary_file(&target).unwrap_or(false);
        if !is_bin {
            if let Ok(file) = File::open(&target) {
                let reader = BufReader::new(file);
                line_count = Some(reader.lines().count());
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
                if is_binary_file(&target).unwrap_or(false) {
                    results.push(BatchReadFileEntry {
                        path: path_str.clone(),
                        success: false,
                        total_lines: 0,
                        content: String::new(),
                        error: Some("File is binary".into()),
                    });
                    continue;
                }

                match File::open(&target) {
                    Ok(file) => {
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
    let target = resolve_safe_path(base_dir, &args.path)?;
    if !target.exists() {
        return Err(format!("File does not exist: {}", args.path));
    }
    if is_binary_file(&target).unwrap_or(false) {
        return Err(format!("Cannot patch binary file: {}", args.path));
    }

    let original_content = fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read file: {e}"))?;

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

    let temp_path = target.with_extension("tmp_patch");
    fs::write(&temp_path, &new_content)
        .map_err(|e| format!("Failed to write patched file: {e}"))?;
    fs::rename(&temp_path, &target)
        .map_err(|e| format!("Failed to commit patched file: {e}"))?;

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

        // Test edit_file with fuzzy indentation mismatch
        let code_file = dir.join("code.rs");
        fs::write(&code_file, "fn main() {\n    let val = 42;\n    println!(\"{}\", val);\n}\n").unwrap();

        // Model provides old_content with no indentation
        let edit_res = edit_file(EditFileArgs {
            path: "code.rs".into(),
            old_content: "let val = 42;\nprintln!(\"{}\", val);".into(),
            new_content: "    let val = 100;\n    println!(\"Updated: {}\", val);".into(),
        }, &dir).unwrap();

        assert_eq!(edit_res.replacements, 1);
        let updated_code = fs::read_to_string(&code_file).unwrap();
        assert!(updated_code.contains("let val = 100;"));
        assert!(updated_code.contains("Updated: {}"));

        let _ = fs::remove_dir_all(&dir);
    }
}


