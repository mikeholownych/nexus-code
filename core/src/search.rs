use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct ListDirArgs {
    #[serde(default = "default_dot")]
    pub path: String,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

fn default_dot() -> String {
    ".".to_string()
}

fn default_max_depth() -> usize {
    3
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListDirResult {
    pub base_path: String,
    pub total_entries: usize,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchCodeArgs {
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
    pub file_pattern: Option<String>,
}

fn default_max_results() -> usize {
    50
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchMatch {
    pub file: String,
    pub line_number: usize,
    pub line_text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchCodeResult {
    pub query: String,
    pub total_matches: usize,
    pub matches: Vec<SearchMatch>,
}

pub fn list_dir(args: ListDirArgs, base_dir: &Path) -> Result<ListDirResult, String> {
    let target = base_dir.join(&args.path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", args.path));
    }

    let walker = WalkBuilder::new(&target)
        .max_depth(Some(args.max_depth))
        .hidden(true)
        .git_ignore(true)
        .build();

    let mut entries = Vec::new();

    for result in walker {
        match result {
            Ok(entry) => {
                let path = entry.path();
                if path == target {
                    continue;
                }

                let rel_path = path
                    .strip_prefix(base_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");

                let metadata = entry.metadata().ok();
                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = metadata.as_ref().map(|m| m.len());

                entries.push(FileEntry {
                    path: rel_path,
                    is_dir,
                    size_bytes: if is_dir { None } else { size },
                });
            }
            Err(_) => {
                // Ignore unreadable files
                continue;
            }
        }
    }

    Ok(ListDirResult {
        base_path: args.path,
        total_entries: entries.len(),
        entries,
    })
}

pub fn search_code(args: SearchCodeArgs, base_dir: &Path) -> Result<SearchCodeResult, String> {
    let pattern = if args.is_regex {
        Regex::new(&args.query).map_err(|e| format!("Invalid regex pattern: {e}"))?
    } else {
        Regex::new(&regex::escape(&args.query)).map_err(|e| format!("Regex escape error: {e}"))?
    };

    let file_filter = if let Some(ref fp) = args.file_pattern {
        Some(Regex::new(fp).map_err(|e| format!("Invalid file pattern regex: {e}"))?)
    } else {
        None
    };

    let walker = WalkBuilder::new(base_dir)
        .hidden(true)
        .git_ignore(true)
        .build();

    let mut matches = Vec::new();

    for result in walker {
        if matches.len() >= args.max_results {
            break;
        }

        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            let path = entry.path();

            let rel_path = path
                .strip_prefix(base_dir)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            if let Some(ref filter) = file_filter {
                if !filter.is_match(&rel_path) {
                    continue;
                }
            }

            // Read lines if text file
            if let Ok(file) = File::open(path) {
                let reader = BufReader::new(file);
                for (idx, line_res) in reader.lines().enumerate() {
                    if matches.len() >= args.max_results {
                        break;
                    }
                    if let Ok(line) = line_res {
                        if pattern.is_match(&line) {
                            matches.push(SearchMatch {
                                file: rel_path.clone(),
                                line_number: idx + 1,
                                line_text: line.trim().to_string(),
                            });
                        }
                    } else {
                        // Probably binary, break out of this file
                        break;
                    }
                }
            }
        }
    }

    Ok(SearchCodeResult {
        query: args.query,
        total_matches: matches.len(),
        matches,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FindFilesArgs {
    pub pattern: String,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FindFilesResult {
    pub pattern: String,
    pub total_matches: usize,
    pub files: Vec<String>,
}

pub fn find_files(args: FindFilesArgs, base_dir: &Path) -> Result<FindFilesResult, String> {
    let raw_pattern = args.pattern.trim();
    // Support simple glob or regex
    let regex_pattern = if raw_pattern.contains('*') || raw_pattern.contains('?') {
        let mut regex_str = String::from("^");
        for ch in raw_pattern.chars() {
            match ch {
                '*' => regex_str.push_str(".*"),
                '?' => regex_str.push('.'),
                '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                    regex_str.push('\\');
                    regex_str.push(ch);
                }
                _ => regex_str.push(ch),
            }
        }
        regex_str.push('$');
        Regex::new(&format!("(?i){regex_str}")).map_err(|e| format!("Invalid glob pattern: {e}"))?
    } else {
        Regex::new(&format!("(?i){}", regex::escape(raw_pattern)))
            .map_err(|e| format!("Invalid pattern: {e}"))?
    };

    let walker = WalkBuilder::new(base_dir)
        .hidden(true)
        .git_ignore(true)
        .build();

    let mut matches = Vec::new();

    for result in walker {
        if matches.len() >= args.max_results {
            break;
        }

        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            let path = entry.path();
            let rel_path = path
                .strip_prefix(base_dir)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            if regex_pattern.is_match(&rel_path) {
                matches.push(rel_path);
            }
        }
    }

    Ok(FindFilesResult {
        pattern: args.pattern,
        total_matches: matches.len(),
        files: matches,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchSymbolsArgs {
    pub query: Option<String>,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SymbolEntry {
    pub file: String,
    pub line_number: usize,
    pub kind: String,
    pub symbol: String,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchSymbolsResult {
    pub total_matches: usize,
    pub symbols: Vec<SymbolEntry>,
}

pub fn search_symbols(args: SearchSymbolsArgs, base_dir: &Path) -> Result<SearchSymbolsResult, String> {
    // Regex matching function, struct, class, interface, enum, def across major languages
    let symbol_regex = Regex::new(
        r"(?m)^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(fn|function|def|class|struct|interface|trait|type|enum|func)\s+([A-Za-z0-9_]+)"
    ).map_err(|e| format!("Symbol regex error: {e}"))?;

    let filter_pattern = args.query.as_ref().map(|q| q.to_lowercase());

    let walker = WalkBuilder::new(base_dir)
        .hidden(true)
        .git_ignore(true)
        .build();

    let mut matches = Vec::new();

    for result in walker {
        if matches.len() >= args.max_results {
            break;
        }

        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            let path = entry.path();
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if !matches!(ext, "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "c" | "cpp" | "h" | "hpp") {
                continue;
            }

            let rel_path = path
                .strip_prefix(base_dir)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            if let Ok(file) = File::open(path) {
                let reader = BufReader::new(file);
                for (idx, line_res) in reader.lines().enumerate() {
                    if matches.len() >= args.max_results {
                        break;
                    }
                    if let Ok(line) = line_res {
                        if let Some(caps) = symbol_regex.captures(&line) {
                            let kind = caps.get(1).map_or("", |m| m.as_str()).to_string();
                            let name = caps.get(2).map_or("", |m| m.as_str()).to_string();

                            if let Some(ref filter) = filter_pattern {
                                if !name.to_lowercase().contains(filter) {
                                    continue;
                                }
                            }

                            matches.push(SymbolEntry {
                                file: rel_path.clone(),
                                line_number: idx + 1,
                                kind,
                                symbol: name,
                                signature: line.trim().to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(SearchSymbolsResult {
        total_matches: matches.len(),
        symbols: matches,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileTreeArgs {
    #[serde(default = "default_dot")]
    pub path: String,
    #[serde(default = "default_tree_depth")]
    pub max_depth: usize,
}

fn default_tree_depth() -> usize {
    3
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileTreeResult {
    pub root: String,
    pub total_directories: usize,
    pub total_files: usize,
    pub tree: String,
}

pub fn file_tree(args: FileTreeArgs, base_dir: &Path) -> Result<FileTreeResult, String> {
    let target = base_dir.join(&args.path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", args.path));
    }

    let mut total_dirs = 0;
    let mut total_files = 0;
    let mut output = format!("{}\n", args.path);

    fn build_tree(
        dir: &Path,
        prefix: &str,
        depth: usize,
        max_depth: usize,
        out: &mut String,
        total_dirs: &mut usize,
        total_files: &mut usize,
    ) {
        if depth >= max_depth {
            return;
        }

        let walker = match WalkBuilder::new(dir)
            .max_depth(Some(1))
            .hidden(true)
            .git_ignore(true)
            .build()
            .collect::<Result<Vec<_>, _>>() {
                Ok(w) => w,
                Err(_) => return,
            };

        let mut entries: Vec<_> = walker
            .into_iter()
            .filter(|e| e.path() != dir)
            .collect();

        entries.sort_by_key(|e| e.path().to_path_buf());
        let count = entries.len();

        for (i, entry) in entries.iter().enumerate() {
            let is_last = i == count - 1;
            let branch = if is_last { "└── " } else { "├── " };
            let child_prefix = if is_last { "    " } else { "│   " };

            let file_name = entry.file_name().to_string_lossy();
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

            if is_dir {
                *total_dirs += 1;
                out.push_str(&format!("{}{}{}/\n", prefix, branch, file_name));
                let next_prefix = format!("{}{}", prefix, child_prefix);
                build_tree(entry.path(), &next_prefix, depth + 1, max_depth, out, total_dirs, total_files);
            } else {
                *total_files += 1;
                out.push_str(&format!("{}{}{}\n", prefix, branch, file_name));
            }
        }
    }

    build_tree(&target, "", 0, args.max_depth, &mut output, &mut total_dirs, &mut total_files);

    Ok(FileTreeResult {
        root: args.path,
        total_directories: total_dirs,
        total_files,
        tree: output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    #[test]
    fn test_file_tree_and_find_files() {
        let dir = std::env::temp_dir().join(format!("test_search_{}", std::process::id()));
        let sub = dir.join("src");
        fs::create_dir_all(&sub).unwrap();

        let mut f1 = File::create(sub.join("main.rs")).unwrap();
        writeln!(f1, "fn main() {{\n    println!(\"Hello\");\n}}").unwrap();

        let mut f2 = File::create(dir.join("README.md")).unwrap();
        writeln!(f2, "# Test Readme").unwrap();

        let tree_res = file_tree(FileTreeArgs {
            path: ".".into(),
            max_depth: 3,
        }, &dir).unwrap();

        assert!(tree_res.total_files >= 2);
        assert!(tree_res.tree.contains("main.rs"));
        assert!(tree_res.tree.contains("README.md"));

        let found = find_files(FindFilesArgs {
            pattern: "*.rs".into(),
            max_results: 10,
        }, &dir).unwrap();

        assert_eq!(found.files.len(), 1);
        assert!(found.files[0].ends_with("main.rs"));

        let _ = fs::remove_dir_all(&dir);
    }
}


