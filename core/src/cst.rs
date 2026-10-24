use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use walkdir::WalkDir;

use crate::file_ops::MAX_READ_BYTES;

/// Reads a source file for symbol parsing, bounded like the file tools: a huge file must not allocate unbounded
/// memory here. The cap also covers growth after the size check.
fn read_source_file(file_path: &Path) -> Result<String, String> {
    let file = File::open(file_path).map_err(|e| format!("Failed to open file: {e}"))?;
    let size = file.metadata().map_err(|e| format!("Failed to get metadata: {e}"))?.len();
    if size > MAX_READ_BYTES as u64 {
        return Err(format!(
            "File is too large to parse: {size} bytes exceeds the 8 MB limit ({MAX_READ_BYTES} bytes)"
        ));
    }
    let mut content = String::new();
    BufReader::new(file)
        .take(MAX_READ_BYTES as u64 + 1)
        .read_to_string(&mut content)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    if content.len() > MAX_READ_BYTES {
        return Err(format!(
            "File is too large to parse: it grew beyond the 8 MB limit ({MAX_READ_BYTES} bytes)"
        ));
    }
    Ok(content)
}

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
    let content = read_source_file(file_path)?;
    let ext = file_path.extension().and_then(|s| s.to_str()).unwrap_or("");
    Ok(parse_cst_content(&content, rel_path, query_filter, ext))
}

/// Parses already-bounded source text, so a caller that has the content (an outline) does not read the file again.
fn parse_cst_content(content: &str, rel_path: &str, query_filter: Option<&str>, ext: &str) -> Vec<CstSymbol> {
    let lines: Vec<String> = content.lines().map(|line| line.to_string()).collect();
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

    symbols
}

/**
 * Scan workspace files and parse CST symbols
 */
pub fn scan_workspace_cst(base_dir: &Path, args: CstParseArgs) -> Result<CstParseResult, String> {
    let target = crate::file_ops::resolve_safe_path(base_dir, &args.path)?;
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

#[derive(Debug, Serialize, Deserialize)]
pub struct OutlineFileArgs {
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OutlineFileResult {
    pub path: String,
    pub total_lines: usize,
    pub symbol_count: usize,
    pub outline: String,
}

/// Generates a compact AST symbol outline for a source file to conserve local LLM context
pub fn generate_file_outline(base_dir: &Path, args: OutlineFileArgs) -> Result<OutlineFileResult, String> {
    let target = crate::file_ops::resolve_safe_path(base_dir, &args.path)?;
    if !target.is_file() {
        return Err(format!("File does not exist or is not a file: {}", args.path));
    }

    let rel_path = target.strip_prefix(base_dir).unwrap_or(&target).to_string_lossy().to_string();
    let content = read_source_file(&target)?;
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("");
    let symbols = parse_cst_content(&content, &rel_path, None, ext);
    let total_lines = content.lines().count();

    let mut outline_str = format!("File: {} ({} lines, {} symbols)\n", rel_path, total_lines, symbols.len());
    if symbols.is_empty() {
        outline_str.push_str("No top-level declarations or exported symbols detected.\n");
    } else {
        for s in &symbols {
            let doc_hint = s.doc_comment.as_ref()
                .and_then(|d| d.lines().next())
                .map(|line| format!(" - \"{}\"", line.trim()))
                .unwrap_or_default();
            outline_str.push_str(&format!(
                "- [{}] {} (lines {}-{}) [{}]{}\n",
                s.kind, s.name, s.start_line, s.end_line, s.visibility, doc_hint
            ));
        }
    }

    Ok(OutlineFileResult {
        path: args.path,
        total_lines,
        symbol_count: symbols.len(),
        outline: outline_str,
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

        let outline_res = generate_file_outline(&std::env::temp_dir(), OutlineFileArgs {
            path: "nexus_cst_test.rs".into(),
        }).unwrap();
        assert_eq!(outline_res.symbol_count, 1);
        assert!(outline_res.outline.contains("- [fn] execute_task"));
        assert!(outline_res.outline.contains("lines"));

        let _ = std::fs::remove_file(tmp);
    }

    struct TempSource(std::path::PathBuf);

    impl TempSource {
        fn new(name: &str) -> Self {
            Self(std::env::temp_dir().join(name))
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file_name(&self) -> String {
            self.0.file_name().unwrap().to_string_lossy().to_string()
        }
    }

    impl Drop for TempSource {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn oversized_source(name: &str) -> TempSource {
        let tmp = TempSource::new(name);
        let mut code = String::from("pub fn first() {}\n");
        while code.len() <= MAX_READ_BYTES {
            code.push_str("// filler comment line\n");
        }
        std::fs::write(tmp.path(), &code).unwrap();
        tmp
    }

    #[test]
    fn test_cst_refuses_files_above_the_read_limit() {
        let tmp = oversized_source(&format!("nexus_cst_big_{}.rs", std::process::id()));
        let parsed = parse_cst_symbols(tmp.path(), &tmp.file_name(), None);
        assert!(parsed.is_err(), "parse_cst_symbols must refuse a file above the read limit");
        assert!(parsed.unwrap_err().contains("8 MB"));
    }

    #[test]
    fn test_cst_outline_refuses_files_above_the_read_limit() {
        let tmp = oversized_source(&format!("nexus_cst_big_outline_{}.rs", std::process::id()));
        // generate_file_outline must enforce the limit itself, not rely on the parser's refusal.
        let outline = generate_file_outline(&std::env::temp_dir(), OutlineFileArgs { path: tmp.file_name() });
        assert!(outline.is_err(), "generate_file_outline must refuse a file above the read limit");
        assert!(outline.unwrap_err().contains("8 MB"));
    }

    #[test]
    fn test_cst_accepts_the_read_limit_and_empty_files() {
        let at_limit = TempSource::new(&format!("nexus_cst_at_limit_{}.rs", std::process::id()));
        let first = "pub fn first() {}\n";
        let mut code = String::from(first);
        code.push_str(&"x".repeat(MAX_READ_BYTES - first.len()));
        std::fs::write(at_limit.path(), &code).unwrap();
        let parsed = parse_cst_symbols(at_limit.path(), &at_limit.file_name(), None).unwrap();
        assert_eq!(parsed.len(), 1);
        let outline = generate_file_outline(&std::env::temp_dir(), OutlineFileArgs { path: at_limit.file_name() }).unwrap();
        assert_eq!(outline.total_lines, 2);
        assert_eq!(outline.symbol_count, 1);

        let empty = TempSource::new(&format!("nexus_cst_empty_{}.rs", std::process::id()));
        std::fs::write(empty.path(), "").unwrap();
        assert!(parse_cst_symbols(empty.path(), &empty.file_name(), None).unwrap().is_empty());
        let empty_outline = generate_file_outline(&std::env::temp_dir(), OutlineFileArgs { path: empty.file_name() }).unwrap();
        assert_eq!(empty_outline.total_lines, 0);
        assert_eq!(empty_outline.symbol_count, 0);
    }
}
