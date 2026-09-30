use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct TrigramSearchArgs {
    pub query: String,
    pub path: Option<String>,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_max_results() -> usize {
    50
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrigramMatch {
    pub file: String,
    pub line_number: usize,
    pub line: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrigramSearchResult {
    pub query: String,
    pub candidate_files_examined: usize,
    pub total_matches: usize,
    pub matches: Vec<TrigramMatch>,
}

/**
 * High-performance Inverted Trigram Index for Code Search Acceleration (Candidate #10)
 */
pub struct TrigramIndex {
    index: HashMap<[u8; 3], HashSet<PathBuf>>,
    indexed_files: HashSet<PathBuf>,
}

impl Default for TrigramIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl TrigramIndex {
    pub fn new() -> Self {
        Self {
            index: HashMap::new(),
            indexed_files: HashSet::new(),
        }
    }

    pub fn index_directory(&mut self, base_dir: &Path) {
        for entry in WalkDir::new(base_dir).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_file() {
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                if matches!(ext, "rs" | "ts" | "js" | "py" | "go" | "c" | "cpp" | "json" | "md" | "toml") {
                    if let Ok(mut f) = File::open(p) {
                        let mut buf = Vec::new();
                        if f.read_to_end(&mut buf).is_ok() {
                            self.index_file(p, &buf);
                        }
                    }
                }
            }
        }
    }

    pub fn index_file(&mut self, path: &Path, content: &[u8]) {
        self.indexed_files.insert(path.to_path_buf());
        if content.len() < 3 {
            return;
        }

        for window in content.windows(3) {
            let key = [
                window[0].to_ascii_lowercase(),
                window[1].to_ascii_lowercase(),
                window[2].to_ascii_lowercase(),
            ];
            self.index.entry(key).or_default().insert(path.to_path_buf());
        }
    }

    pub fn find_candidate_files(&self, query: &str) -> Option<HashSet<PathBuf>> {
        let q_bytes = query.as_bytes();
        if q_bytes.len() < 3 {
            return None;
        }

        let mut candidate_set: Option<HashSet<PathBuf>> = None;
        for window in q_bytes.windows(3) {
            let key = [
                window[0].to_ascii_lowercase(),
                window[1].to_ascii_lowercase(),
                window[2].to_ascii_lowercase(),
            ];
            if let Some(matches) = self.index.get(&key) {
                candidate_set = match candidate_set {
                    None => Some(matches.clone()),
                    Some(prev) => Some(prev.intersection(matches).cloned().collect()),
                };
            } else {
                return Some(HashSet::new());
            }
        }

        candidate_set
    }
}

/**
 * Execute accelerated trigram search over workspace
 */
pub fn execute_trigram_search(args: TrigramSearchArgs, base_dir: &Path) -> Result<TrigramSearchResult, String> {
    let mut index = TrigramIndex::new();
    let search_root = if let Some(ref rel) = args.path {
        base_dir.join(rel)
    } else {
        base_dir.to_path_buf()
    };

    index.index_directory(&search_root);

    let candidates = index.find_candidate_files(&args.query);
    let files_to_scan: Vec<PathBuf> = match candidates {
        Some(set) => set.into_iter().collect(),
        None => index.indexed_files.into_iter().collect(),
    };

    let candidate_count = files_to_scan.len();
    let mut matches = Vec::new();
    let lower_q = args.query.to_lowercase();

    for file_path in files_to_scan {
        if matches.len() >= args.max_results {
            break;
        }

        if let Ok(file) = File::open(&file_path) {
            let reader = std::io::BufReader::new(file);
            let rel = file_path.strip_prefix(base_dir).unwrap_or(&file_path).to_string_lossy().to_string();

            for (idx, line_res) in reader.lines().enumerate() {
                if matches.len() >= args.max_results {
                    break;
                }
                if let Ok(line) = line_res {
                    if line.to_lowercase().contains(&lower_q) {
                        matches.push(TrigramMatch {
                            file: rel.clone(),
                            line_number: idx + 1,
                            line: line.trim().to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(TrigramSearchResult {
        query: args.query,
        candidate_files_examined: candidate_count,
        total_matches: matches.len(),
        matches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trigram_indexing() {
        let mut index = TrigramIndex::new();
        let path1 = PathBuf::from("a.rs");
        let path2 = PathBuf::from("b.rs");

        index.index_file(&path1, b"fn calculate_tax() -> u64");
        index.index_file(&path2, b"fn format_invoice() -> String");

        let candidates = index.find_candidate_files("tax").unwrap();
        assert!(candidates.contains(&path1));
        assert!(!candidates.contains(&path2));

        let candidates_inv = index.find_candidate_files("invoice").unwrap();
        assert!(candidates_inv.contains(&path2));
        assert!(!candidates_inv.contains(&path1));
    }
}
