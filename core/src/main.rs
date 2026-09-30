mod file_ops;
mod runner;
mod search;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(author, version, about = "High-performance Core Engine for Coding Harness", long_about = None)]
struct Cli {
    #[arg(short, long, default_value = ".")]
    workspace: PathBuf,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Execute a single tool directly from CLI arguments
    Call {
        #[arg(short, long)]
        tool: String,
        #[arg(short, long)]
        args: String,
    },
    /// Start interactive JSON-RPC stdio server for TypeScript integration
    Rpc,
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: Option<Value>,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn execute_tool(tool_name: &str, params: Value, base_dir: &Path) -> Result<Value, String> {
    match tool_name {
        "read_file" => {
            let args: file_ops::ReadFileArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid read_file arguments: {e}"))?;
            let res = file_ops::read_file(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "write_file" => {
            let args: file_ops::WriteFileArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid write_file arguments: {e}"))?;
            let res = file_ops::write_file(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "edit_file" => {
            let args: file_ops::EditFileArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid edit_file arguments: {e}"))?;
            let res = file_ops::edit_file(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "list_dir" => {
            let args: search::ListDirArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid list_dir arguments: {e}"))?;
            let res = search::list_dir(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "search_code" => {
            let args: search::SearchCodeArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid search_code arguments: {e}"))?;
            let res = search::search_code(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "delete_file" => {
            let args: file_ops::DeleteFileArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid delete_file arguments: {e}"))?;
            let res = file_ops::delete_file(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "find_files" => {
            let args: search::FindFilesArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid find_files arguments: {e}"))?;
            let res = search::find_files(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "search_symbols" => {
            let args: search::SearchSymbolsArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid search_symbols arguments: {e}"))?;
            let res = search::search_symbols(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "run_command" => {
            let args: runner::RunCommandArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid run_command arguments: {e}"))?;
            let res = runner::run_command(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown tool: {tool_name}")),
    }
}

fn run_rpc(workspace: &Path) {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut handle = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<RpcRequest>(trimmed) {
            Ok(req) => match execute_tool(&req.method, req.params, workspace) {
                Ok(result) => RpcResponse {
                    id: req.id,
                    result: Some(result),
                    error: None,
                },
                Err(err) => RpcResponse {
                    id: req.id,
                    result: None,
                    error: Some(err),
                },
            },
            Err(e) => RpcResponse {
                id: None,
                result: None,
                error: Some(format!("Invalid JSON-RPC request: {e}")),
            },
        };

        if let Ok(json) = serde_json::to_string(&response) {
            let _ = writeln!(handle, "{json}");
            let _ = handle.flush();
        }
    }
}

fn parse_flexible_json(input: &str) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str::<Value>(input) {
        if let Value::String(ref s) = v {
            if let Ok(nested) = serde_json::from_str::<Value>(s) {
                return Ok(nested);
            }
        }
        return Ok(v);
    }
    let unescaped = input.replace(r#"\""#, "\"");
    if let Ok(v) = serde_json::from_str::<Value>(&unescaped) {
        return Ok(v);
    }
    let trimmed = input.trim_matches(|c| c == '\'' || c == '"');
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    Err(format!("Could not parse JSON arguments: {input}"))
}

fn main() {
    let cli = Cli::parse();
    let workspace = std::fs::canonicalize(&cli.workspace).unwrap_or(cli.workspace);

    match cli.command {
        Commands::Call { tool, args } => {
            let params = match parse_flexible_json(&args) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            };
            match execute_tool(&tool, params, &workspace) {
                Ok(res) => {
                    println!("{}", serde_json::to_string_pretty(&res).unwrap());
                }
                Err(e) => {
                    eprintln!("Error executing {tool}: {e}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Rpc => {
            run_rpc(&workspace);
        }
    }
}
