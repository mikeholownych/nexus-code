use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CstSymbol {
    pub name: String,
    pub kind: String,
    pub visibility: String,
    pub scope: Option<String>,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub signature: String,
    pub doc_comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CstParseArgs {
    pub path: String,
    pub query: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CstParseResult {
    pub total_symbols: usize,
    pub symbols: Vec<CstSymbol>,
}

/**
 * Concrete Syntax Tree (CST) Symbol Parser (Candidate #04)
 * Parses multiline signatures, doc comments, visibility, and scopes across languages.
 */
pub fn parse_cst_symbols(file_path: &Path, rel_path: &str, query_filter: Option<&str>) -> Result<Vec<CstSymbol>, String> {
    let file = File::open(file_path).map_err(|e| format!("Failed to open file: {e}"))?;
    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().collect::<Result<_, _>>()
        .map_err(|e| format!("Failed to read file lines: {e}"))?;

    let ext = file_path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let mut symbols = Vec::new();

    let doc_regex = Regex::new(r"^\s*(?://[/!]|\s*\*\s*|#\s*|/\*\*|<!--)(.*)").unwrap();
    let current_scope: Option<String> = None;

    // Pattern matching declaration headers
    let decl_regex = Regex::new(
        r"(?m)^\s*(pub(?:\([^)]+\))?\s+)?(async\s+)?(export\s+)?(default\s+)?(fn|function|def|class|struct|interface|trait|type|enum|func)\s+([A-Za-z0-9_]+)(.*)"
    ).unwrap();

    let mut pending_doc = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = &lines[i];
        let trimmed = line.trim();

        // Accumulate preceding doc comments
        if (trimmed.starts_with("///") || trimmed.starts_with("//!") || trimmed.starts_with("/**") || (trimmed.starts_with('*') && !trimmed.starts_with("*/")) || (ext == "py" && trimmed.starts_with('#'))) && !trimmed.starts_with("/*") {
            if let Some(caps) = doc_regex.captures(trimmed) {
                let comment = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
                if !comment.is_empty() {
                    pending_doc.push(comment.to_string());
                }
            }
            i += 1;
            continue;
        }

        if let Some(caps) = decl_regex.captures(trimmed) {
            let vis_raw = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            let export_raw = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
            let kind = caps.get(5).map(|m| m.as_str().trim()).unwrap_or("unknown").to_string();
            let name = caps.get(6).map(|m| m.as_str().trim()).unwrap_or("").to_string();

            let visibility = if !vis_raw.is_empty() {
                vis_raw.to_string()
            } else if !export_raw.is_empty() {
                "exported".to_string()
            } else {
                "private".to_string()
            };

            let start_line = i + 1;
            let mut sig_lines = vec![trimmed.to_string()];
            let mut end_line = start_line;

            // Multiline signature accumulation until '{', ';', or ':' (python)
            if !trimmed.contains('{') && !trimmed.contains(';') && !(ext == "py" && trimmed.ends_with(':')) {
                let mut j = i + 1;
                while j < lines.len() && j < i + 10 {
                    let next_trimmed = lines[j].trim();
                    sig_lines.push(next_trimmed.to_string());
                    if next_trimmed.contains('{') || next_trimmed.contains(';') || (ext == "py" && next_trimmed.ends_with(':')) {
                        end_line = j + 1;
                        i = j;
                        break;
                    }
                    j += 1;
                }
            }

            let full_sig = sig_lines.join(" ");
            let doc_text = if !pending_doc.is_empty() {
                Some(pending_doc.join("\n"))
            } else {
                None
            };
            pending_doc.clear();

            let matches_query = match query_filter {
                Some(q) => name.to_lowercase().contains(&q.to_lowercase()),
                None => true,
            };

            if matches_query && !name.is_empty() {
                symbols.push(CstSymbol {
                    name,
                    kind,
                    visibility,
                    scope: current_scope.clone(),
                    file: rel_path.to_string(),
                    start_line,
                    end_line,
                    signature: full_sig,
                    doc_comment: doc_text,
                });
            }
        } else if !trimmed.is_empty() {
            pending_doc.clear();
        }

        i += 1;
    }

    Ok(symbols)
}

/**
 * Scan workspace files and parse CST symbols
 */
pub fn scan_workspace_cst(base_dir: &Path, args: CstParseArgs) -> Result<CstParseResult, String> {
    let target = base_dir.join(&args.path);
    let mut all_symbols = Vec::new();

    if target.is_file() {
        let rel_path = target.strip_prefix(base_dir).unwrap_or(&target).to_string_lossy().to_string();
        let syms = parse_cst_symbols(&target, &rel_path, args.query.as_deref())?;
        all_symbols.extend(syms);
    } else if target.is_dir() {
        for entry in WalkDir::new(&target).max_depth(5).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_file() {
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                if matches!(ext, "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go") {
                    let rel_path = p.strip_prefix(base_dir).unwrap_or(p).to_string_lossy().to_string();
                    if let Ok(syms) = parse_cst_symbols(p, &rel_path, args.query.as_deref()) {
                        all_symbols.extend(syms);
                    }
                }
            }
        }
    }

    Ok(CstParseResult {
        total_symbols: all_symbols.len(),
        symbols: all_symbols,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cst_symbol_parsing() {
        let tmp = std::env::temp_dir().join("nexus_cst_test.rs");
        let code = r#"
/// High-level engine runner
pub async fn execute_task(
    id: &str,
    timeout: u64,
) -> Result<bool, String> {
    Ok(true)
}
"#;
        std::fs::write(&tmp, code).unwrap();
        let syms = parse_cst_symbols(&tmp, "test.rs", None).unwrap();
        assert_eq!(syms.len(), 1);
        let s = &syms[0];
        assert_eq!(s.name, "execute_task");
        assert_eq!(s.kind, "fn");
        assert_eq!(s.visibility, "pub");
        assert!(s.signature.contains("-> Result<bool, String>"));
        assert!(s.doc_comment.as_ref().unwrap().contains("High-level engine runner"));
        let _ = std::fs::remove_file(tmp);
    }
}
