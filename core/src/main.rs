mod cst;
mod file_ops;
mod git_ops;
mod runner;
mod search;
mod trigram;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

/// How long a cancelled or shut-down command group gets between SIGTERM and SIGKILL.
const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

fn execute_tool(tool_name: &str, params: Value, base_dir: &Path) -> Result<Value, String> {
    execute_request(tool_name, params, base_dir, None)
}

/// `key` identifies the RPC request, so a later `cancel` can end the command it started.
fn execute_request(tool_name: &str, params: Value, base_dir: &Path, key: Option<String>) -> Result<Value, String> {
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
            let res = runner::run_command_tracked(args, base_dir, key.as_deref())?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        // Ends the command started by request `request_id` (TERM, then KILL after a grace period).
        #[cfg(unix)]
        "cancel" => {
            let target = params.get("request_id").cloned().unwrap_or(Value::Null).to_string();
            let found = runner::cancel_command(&target, CANCEL_GRACE);
            Ok(serde_json::json!({ "cancelled": found }))
        }
        // Ends background processes that earlier commands left running (`server &`).
        #[cfg(unix)]
        "end_background" => {
            let ended = runner::end_background_commands(CANCEL_GRACE);
            Ok(serde_json::json!({ "ended": ended }))
        }
        "file_info" => {
            let args: file_ops::FileInfoArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid file_info arguments: {e}"))?;
            let res = file_ops::file_info(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "batch_read" => {
            let args: file_ops::BatchReadArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid batch_read arguments: {e}"))?;
            let res = file_ops::batch_read(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "file_tree" => {
            let args: search::FileTreeArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid file_tree arguments: {e}"))?;
            let res = search::file_tree(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "patch_file" => {
            let args: file_ops::PatchFileArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid patch_file arguments: {e}"))?;
            let res = file_ops::patch_file(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git_status" => {
            let res = git_ops::git_status(base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git_diff" => {
            let args: git_ops::GitDiffArgs = serde_json::from_value(params)
                .unwrap_or(git_ops::GitDiffArgs { staged: false, path_filter: None });
            let res = git_ops::git_diff(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "git_log" => {
            let args: git_ops::GitLogArgs = serde_json::from_value(params)
                .unwrap_or(git_ops::GitLogArgs { max_commits: 10 });
            let res = git_ops::git_log(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "cst_symbols" => {
            let args: cst::CstParseArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid cst_symbols arguments: {e}"))?;
            let res = cst::scan_workspace_cst(base_dir, args)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "outline_file" => {
            let args: cst::OutlineFileArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid outline_file arguments: {e}"))?;
            let res = cst::generate_file_outline(base_dir, args)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "trigram_search" => {
            let args: trigram::TrigramSearchArgs = serde_json::from_value(params)
                .map_err(|e| format!("Invalid trigram_search arguments: {e}"))?;
            let res = trigram::execute_trigram_search(args, base_dir)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown tool: {tool_name}")),
    }
}

/**
 * Asynchronous Non-Blocking JSON-RPC Stdio Server using Tokio (Candidate #05)
 */
async fn run_rpc_async(workspace: &Path) {
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    let stdout = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let ws = Arc::new(workspace.to_path_buf());

    // The engine owns the commands it started: when its client goes away (stdin closes), or it is told to stop, every
    // command group still running (and every background process they left) is ended before it exits (REQ-SEC-106).
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        for kind in [SignalKind::terminate(), SignalKind::hangup(), SignalKind::interrupt()] {
            if let Ok(mut stream) = signal(kind) {
                tokio::spawn(async move {
                    if stream.recv().await.is_some() {
                        shutdown_and_exit(143).await;
                    }
                });
            }
        }
    }

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }

        let stdout_clone = Arc::clone(&stdout);
        let ws_clone = Arc::clone(&ws);

        tokio::spawn(async move {
            let response = match serde_json::from_str::<RpcRequest>(&trimmed) {
                Ok(req) => {
                    let method = req.method;
                    let params = req.params;
                    let id = req.id;
                    let key = id.as_ref().map(|v| v.to_string());
                    let exec_res = tokio::task::spawn_blocking(move || {
                        execute_request(&method, params, &ws_clone, key)
                    })
                    .await;

                    match exec_res {
                        Ok(Ok(result)) => RpcResponse {
                            id,
                            result: Some(result),
                            error: None,
                        },
                        Ok(Err(err)) => RpcResponse {
                            id,
                            result: None,
                            error: Some(err),
                        },
                        Err(join_err) => RpcResponse {
                            id,
                            result: None,
                            error: Some(format!("Task execution failed: {join_err}")),
                        },
                    }
                }
                Err(e) => RpcResponse {
                    id: None,
                    result: None,
                    error: Some(format!("Invalid JSON-RPC request: {e}")),
                },
            };

            if let Ok(json) = serde_json::to_string(&response) {
                let mut out = stdout_clone.lock().await;
                let _ = out.write_all(format!("{json}\n").as_bytes()).await;
                let _ = out.flush().await;
            }
        });
    }
    shutdown_and_exit(0).await;
}

/// Ends every command group the engine started, then exits.
async fn shutdown_and_exit(code: i32) {
    #[cfg(unix)]
    {
        let _ = tokio::task::spawn_blocking(|| runner::end_all_commands(CANCEL_GRACE)).await;
    }
    std::process::exit(code);
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

#[tokio::main]
async fn main() {
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
            // If the client dies without closing stdin, the kernel delivers SIGTERM, which runs the same shutdown.
            #[cfg(target_os = "linux")]
            unsafe {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            }
            run_rpc_async(&workspace).await;
        }
    }
}
