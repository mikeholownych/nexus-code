/**
 * Canonical Capabilities & Model-Visible Tool Registry
 * Nexus Issue #12 — WP-01 (INC-01, CAP-001..007, DEDUP-001..004)
 */

import { ToolDefinition, ExecutionResult } from "../types.js";

export type CapabilityBackend = "rust_rpc" | "ts_native" | "extension";

export interface CanonicalCapability {
  /** Canonical capability identifier (e.g., 'fs_read', 'proc_exec') */
  id: string;
  /** Model-visible tool name matching LLM schemas (e.g., 'read_file', 'run_command') */
  modelToolName: string;
  /** Category of capability */
  category:
    | "fs"
    | "code_search"
    | "proc"
    | "vcs"
    | "net"
    | "lsp"
    | "browser"
    | "knowledge"
    | "skill"
    | "orchestration"
    | "extension"
    | string;
  /** Whether the capability performs side effects (read-only mode refuses it; review mode asks before it runs) */
  mutating: boolean;
  /**
   * Whether a successful call changes the workspace content (makes a verifier result stale, counts as a change to
   * verify). Defaults to `mutating`; false for side effects outside the workspace, such as running tests.
   */
  changesWorkspace?: boolean;
  /** Human- and audit-readable side-effect contract */
  sideEffectContract: string;
  /** Backend execution engine type */
  backend: CapabilityBackend;
  /** Exact model tool definition (JSON schema) presented to LLMs */
  toolDefinition: ToolDefinition;
  /** Optional registered capability execution handler */
  handler?: CapabilityHandler;
}

export type CapabilityHandler = (
  args: Record<string, any>,
  context: any
) => Promise<ExecutionResult>;

export class CapabilityRegistry {
  private readonly capabilitiesByToolName = new Map<string, CanonicalCapability>();
  private readonly capabilitiesById = new Map<string, CanonicalCapability[]>();

  constructor(capabilities: CanonicalCapability[] = []) {
    for (const cap of capabilities) {
      this.register(cap);
    }
  }

  /**
   * Register a canonical capability.
   * Throws if a capability with the same modelToolName is already registered.
   */
  public register(capability: CanonicalCapability): void {
    if (!capability || !capability.id || !capability.modelToolName) {
      throw new Error("Invalid capability: id and modelToolName are required.");
    }
    if (this.capabilitiesByToolName.has(capability.modelToolName)) {
      throw new Error(`Duplicate capability registration: model tool '${capability.modelToolName}' is already registered.`);
    }

    this.capabilitiesByToolName.set(capability.modelToolName, capability);

    const list = this.capabilitiesById.get(capability.id) || [];
    list.push(capability);
    this.capabilitiesById.set(capability.id, list);
  }

  /**
   * Unregister a capability by its tool name or canonical ID.
   */
  public unregister(toolNameOrId: string): boolean {
    const cap = this.capabilitiesByToolName.get(toolNameOrId);
    if (cap) {
      this.capabilitiesByToolName.delete(cap.modelToolName);
      const list = this.capabilitiesById.get(cap.id);
      if (list) {
        const filtered = list.filter((c) => c.modelToolName !== cap.modelToolName);
        if (filtered.length > 0) {
          this.capabilitiesById.set(cap.id, filtered);
        } else {
          this.capabilitiesById.delete(cap.id);
        }
      }
      return true;
    }

    if (this.capabilitiesById.has(toolNameOrId)) {
      const caps = this.capabilitiesById.get(toolNameOrId)!;
      for (const c of caps) {
        this.capabilitiesByToolName.delete(c.modelToolName);
      }
      this.capabilitiesById.delete(toolNameOrId);
      return true;
    }

    return false;
  }

  /**
   * Retrieve capability by model tool name.
   */
  public getByToolName(toolName: string): CanonicalCapability | undefined {
    return this.capabilitiesByToolName.get(toolName);
  }

  /**
   * Retrieve capability by canonical capability ID (returns first registered).
   */
  public getById(id: string): CanonicalCapability | undefined {
    const list = this.capabilitiesById.get(id);
    return list && list.length > 0 ? list[0] : undefined;
  }

  /**
   * Retrieve all capabilities matching a canonical ID.
   */
  public getAllById(id: string): CanonicalCapability[] {
    return this.capabilitiesById.get(id) || [];
  }

  /**
   * Check if a model tool name is registered.
   */
  public hasTool(toolName: string): boolean {
    return this.capabilitiesByToolName.has(toolName);
  }

  /**
   * Check if a canonical ID is registered.
   */
  public hasCapability(id: string): boolean {
    return this.capabilitiesById.has(id);
  }

  /**
   * List all registered canonical capabilities.
   */
  public listCapabilities(): CanonicalCapability[] {
    return Array.from(this.capabilitiesByToolName.values());
  }

  /**
   * List all model-visible tool definitions (100% schema parity).
   */
  public listModelTools(): ToolDefinition[] {
    return Array.from(this.capabilitiesByToolName.values()).map((cap) => cap.toolDefinition);
  }

  /**
   * Attach an execution handler to a capability by model tool name or canonical ID.
   */
  public setHandler(toolNameOrId: string, handler: CapabilityHandler): void {
    const cap = this.capabilitiesByToolName.get(toolNameOrId);
    if (cap) {
      cap.handler = handler;
      return;
    }
    const caps = this.capabilitiesById.get(toolNameOrId);
    if (caps && caps.length > 0) {
      for (const c of caps) {
        c.handler = handler;
      }
      return;
    }
    throw new Error(`Cannot set handler: capability '${toolNameOrId}' not found.`);
  }

  /**
   * Get handler for a tool name or canonical ID.
   */
  public getHandler(toolNameOrId: string): CapabilityHandler | undefined {
    const cap = this.capabilitiesByToolName.get(toolNameOrId);
    if (cap && cap.handler) {
      return cap.handler;
    }
    const list = this.capabilitiesById.get(toolNameOrId);
    if (list && list.length > 0 && list[0].handler) {
      return list[0].handler;
    }
    return undefined;
  }
}

/** Whether a successful call of the capability changes workspace content. */
export function changesWorkspace(capability: Pick<CanonicalCapability, "mutating" | "changesWorkspace">): boolean {
  return capability.changesWorkspace ?? capability.mutating;
}

export const BASELINE_CAPABILITIES: CanonicalCapability[] = [
  {
    "id": "fs_read",
    "modelToolName": "read_file",
    "category": "fs",
    "mutating": false,
    "sideEffectContract": "Read file contents with line numbers from workspace",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read the contents of a file with line numbers. Use start_line and end_line for specific ranges.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to the file within the workspace."
            },
            "start_line": {
              "type": "number",
              "description": "1-indexed starting line number (optional)."
            },
            "end_line": {
              "type": "number",
              "description": "1-indexed ending line number (optional)."
            }
          },
          "required": [
            "path"
          ]
        }
      }
    }
  },
  {
    "id": "fs_write",
    "modelToolName": "write_file",
    "category": "fs",
    "mutating": true,
    "sideEffectContract": "Create a new file or completely overwrite an existing file",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "write_file",
        "description": "Create a new file or completely overwrite an existing file with the provided content.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to the file to create or overwrite."
            },
            "content": {
              "type": "string",
              "description": "Complete text content of the file."
            },
            "overwrite": {
              "type": "boolean",
              "description": "Must be true if replacing an existing file."
            }
          },
          "required": [
            "path",
            "content"
          ]
        }
      }
    }
  },
  {
    "id": "fs_edit",
    "modelToolName": "edit_file",
    "category": "fs",
    "mutating": true,
    "sideEffectContract": "Perform search-and-replace snippet edit on a file",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "edit_file",
        "description": "Perform a safe search-and-replace on a file. Replaces old_content with new_content and returns the diff.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to the file to edit."
            },
            "old_content": {
              "type": "string",
              "description": "Exact snippet of text in the file to be replaced."
            },
            "new_content": {
              "type": "string",
              "description": "The new replacement snippet."
            },
            "replace_all": {
              "type": "boolean",
              "description": "Replace every occurrence of old_content. Without it, old_content must occur exactly once."
            }
          },
          "required": [
            "path",
            "old_content",
            "new_content"
          ]
        }
      }
    }
  },
  {
    "id": "fs_discover_list",
    "modelToolName": "list_dir",
    "category": "fs",
    "mutating": false,
    "sideEffectContract": "List files and directories in the workspace",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "List files and directories in the workspace, respecting .gitignore and ignoring hidden files.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Subdirectory to list (defaults to workspace root '.')."
            },
            "max_depth": {
              "type": "number",
              "description": "Maximum directory traversal depth (default: 3)."
            }
          }
        }
      }
    }
  },
  {
    "id": "code_search_lexical",
    "modelToolName": "search_code",
    "category": "code_search",
    "mutating": false,
    "sideEffectContract": "Search code files using regex patterns via ripgrep",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "search_code",
        "description": "High-performance code search across the workspace (ripgrep speed). Respects .gitignore.",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Search string or regex pattern to search for."
            },
            "is_regex": {
              "type": "boolean",
              "description": "Whether query is a regular expression (default: false)."
            },
            "max_results": {
              "type": "number",
              "description": "Maximum number of matching lines to return (default: 50)."
            },
            "file_pattern": {
              "type": "string",
              "description": "Optional regex to filter filenames (e.g. '\\.rs$' or '\\.ts$')."
            }
          },
          "required": [
            "query"
          ]
        }
      }
    }
  },
  {
    "id": "proc_exec",
    "modelToolName": "run_command",
    "category": "proc",
    "mutating": true,
    "sideEffectContract": "Execute shell command within workspace environment",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "run_command",
        "description": "Execute a command in a Linux shell (bash, zsh, or sh) to run builds, tests, git, package managers, etc. Standard Unix commands only (ls, cat, grep, rm, etc.).",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {
              "type": "string",
              "description": "The bash/zsh shell command to execute."
            },
            "cwd": {
              "type": "string",
              "description": "Optional subdirectory to run the command in."
            },
            "timeout_secs": {
              "type": "number",
              "description": "Execution timeout in seconds (default: 60)."
            },
            "shell": {
              "type": "string",
              "description": "Linux shell to use: 'bash', 'zsh', or 'sh' (default: 'bash')."
            }
          },
          "required": [
            "command"
          ]
        }
      }
    }
  },
  {
    "id": "fs_discover_find",
    "modelToolName": "find_files",
    "category": "fs",
    "mutating": false,
    "sideEffectContract": "Find files matching glob pattern in workspace",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "find_files",
        "description": "Quickly locate files matching a glob or substring pattern (e.g. '*.rs', '**/*.ts', 'auth'). Respects .gitignore.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Glob or substring pattern to search for."
            },
            "max_results": {
              "type": "number",
              "description": "Maximum results to return (default: 50)."
            }
          },
          "required": [
            "pattern"
          ]
        }
      }
    }
  },
  {
    "id": "code_search_symbols",
    "modelToolName": "search_symbols",
    "category": "code_search",
    "mutating": false,
    "sideEffectContract": "Search code symbols across workspace files",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "search_symbols",
        "description": "Search for function, struct, class, interface, trait, or type declarations across the codebase (AST-level symbol search).",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Optional symbol name or substring to filter declarations."
            },
            "max_results": {
              "type": "number",
              "description": "Maximum number of symbols to return (default: 50)."
            }
          }
        }
      }
    }
  },
  {
    "id": "fs_delete",
    "modelToolName": "delete_file",
    "category": "fs",
    "mutating": true,
    "sideEffectContract": "Delete a file, or a directory with recursive: true, from the workspace",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "delete_file",
        "description": "Delete a file or directory inside the workspace. A directory needs recursive: true. The workspace root and .git cannot be deleted.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to file or directory to remove."
            },
            "recursive": {
              "type": "boolean",
              "description": "Required to delete a directory and everything in it."
            }
          },
          "required": [
            "path"
          ]
        }
      }
    }
  },
  {
    "id": "net_fetch",
    "modelToolName": "fetch_web",
    "category": "net",
    "mutating": false,
    "sideEffectContract": "Fetch and extract text content from remote HTTP/HTTPS URL",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "fetch_web",
        "description": "Fetch web content, documentation, or JSON API from an HTTP/HTTPS URL. Strips HTML markup.",
        "parameters": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "description": "The complete HTTP or HTTPS URL to fetch."
            },
            "max_length": {
              "type": "number",
              "description": "Maximum character length to return (default: 15000)."
            }
          },
          "required": [
            "url"
          ]
        }
      }
    }
  },
  {
    "id": "orchestrate_exit",
    "modelToolName": "task_completed",
    "category": "orchestration",
    "mutating": false,
    "sideEffectContract": "Conclude task execution with final summary and verification check",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "task_completed",
        "description": "Signal that the overall task is finished and report a short final summary of the changes.",
        "parameters": {
          "type": "object",
          "properties": {
            "summary": {
              "type": "string",
              "description": "Short summary (2-4 sentences): what changed and how it was checked."
            },
            "notes": {
              "type": "string",
              "description": "Any instructions, follow-up recommendations, or verification steps."
            }
          },
          "required": [
            "summary"
          ]
        }
      }
    }
  },
  {
    "id": "orchestrate_sub",
    "modelToolName": "spawn_subagent",
    "category": "orchestration",
    "mutating": false,
    "sideEffectContract": "Spawn isolated child agent to investigate or execute subtask",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "spawn_subagent",
        "description": "Spawn an isolated subagent with its own dedicated context to investigate code, search files, or verify implementations without cluttering the main conversation history.",
        "parameters": {
          "type": "object",
          "properties": {
            "prompt": {
              "type": "string",
              "description": "The specific objective or question for the subagent to solve."
            },
            "max_steps": {
              "type": "number",
              "description": "Maximum steps for the subagent to take (default: 8)."
            }
          },
          "required": [
            "prompt"
          ]
        }
      }
    }
  },
  {
    "id": "fs_metadata",
    "modelToolName": "file_info",
    "category": "fs",
    "mutating": false,
    "sideEffectContract": "Retrieve file size, modification time, line count and permissions",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "file_info",
        "description": "Inspect detailed metadata of a file or directory (size in bytes, permissions, line count, binary check, modified timestamp).",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to the file or directory."
            }
          },
          "required": [
            "path"
          ]
        }
      }
    }
  },
  {
    "id": "fs_read_batch",
    "modelToolName": "batch_read",
    "category": "fs",
    "mutating": false,
    "sideEffectContract": "Read contents of multiple files in a single invocation",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "batch_read",
        "description": "Read multiple files in parallel in a single turn to eliminate multi-turn round trips.",
        "parameters": {
          "type": "object",
          "properties": {
            "paths": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "List of relative paths to files to read."
            },
            "max_lines_per_file": {
              "type": "number",
              "description": "Maximum number of lines to read per file (default: 500)."
            }
          },
          "required": [
            "paths"
          ]
        }
      }
    }
  },
  {
    "id": "fs_discover_tree",
    "modelToolName": "file_tree",
    "category": "fs",
    "mutating": false,
    "sideEffectContract": "Generate visual directory tree of workspace files",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "file_tree",
        "description": "Render a hierarchical Unicode directory tree of the workspace, respecting .gitignore and ignoring hidden files.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Subdirectory to render tree from (default: '.')."
            },
            "max_depth": {
              "type": "number",
              "description": "Maximum tree depth to traverse (default: 3)."
            }
          }
        }
      }
    }
  },
  {
    "id": "fs_patch",
    "modelToolName": "patch_file",
    "category": "fs",
    "mutating": true,
    "sideEffectContract": "Apply unified diff patch to a file in workspace",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "patch_file",
        "description": "Apply a standard unified diff patch or hunk to a file.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to the file to patch."
            },
            "patch": {
              "type": "string",
              "description": "Unified diff or hunk content (including @@ headers or -/+ lines)."
            }
          },
          "required": [
            "path",
            "patch"
          ]
        }
      }
    }
  },
  {
    "id": "orchestrate_plan",
    "modelToolName": "update_plan",
    "category": "orchestration",
    "mutating": true,
    "sideEffectContract": "Update task phases and execution roadmap",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "update_plan",
        "description": "Create or update the structured multi-phase execution plan for the active task. Keeps user and agent aligned on milestones.",
        "parameters": {
          "type": "object",
          "properties": {
            "phases": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string",
                    "description": "Name or title of this execution phase."
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "pending",
                      "in_progress",
                      "completed"
                    ],
                    "description": "Current status of the phase."
                  },
                  "detail": {
                    "type": "string",
                    "description": "Optional details or sub-steps for this phase."
                  }
                },
                "required": [
                  "name",
                  "status"
                ]
              },
              "description": "List of plan phases in chronological order."
            }
          },
          "required": [
            "phases"
          ]
        }
      }
    }
  },
  {
    "id": "skill_activate",
    "modelToolName": "activate_skill",
    "category": "skill",
    "mutating": false,
    "sideEffectContract": "Load specialized instructions and guidelines from skill repository",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "activate_skill",
        "description": "Load the complete instructions, workflow, and guidelines of a specialized agent skill into active context.",
        "parameters": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "description": "The name of the skill to activate (e.g. 'graphify')."
            }
          },
          "required": [
            "name"
          ]
        }
      }
    }
  },
  {
    "id": "test_discover_run",
    "modelToolName": "run_tests",
    "category": "proc",
    "mutating": true,
    "changesWorkspace": false,
    "sideEffectContract": "Discover and execute workspace test suite",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "run_tests",
        "description": "Auto-detect and run the project test suite (cargo test, npm test, pytest, make test) with parsed failures and compiler diagnostics.",
        "parameters": {
          "type": "object",
          "properties": {
            "filter": {
              "type": "string",
              "description": "Optional test name filter or pattern to isolate specific unit tests."
            }
          }
        }
      }
    }
  },
  {
    "id": "net_search",
    "modelToolName": "search_web",
    "category": "net",
    "mutating": false,
    "sideEffectContract": "Query external search provider for web results",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "search_web",
        "description": "Search the web for programming documentation, error messages, library APIs, and technical solutions.",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "The technical search query (e.g. 'rust axum json extraction example')."
            },
            "max_results": {
              "type": "number",
              "description": "Maximum number of search results to return (default: 5)."
            }
          },
          "required": [
            "query"
          ]
        }
      }
    }
  },
  {
    "id": "lsp_query_hover",
    "modelToolName": "lsp_hover",
    "category": "lsp",
    "mutating": false,
    "sideEffectContract": "Query LSP server for hover type/doc information",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "lsp_hover",
        "description": "Query Language Server Protocol (LSP) hover documentation and type signatures for a symbol at a given line and character.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "The source file path to inspect."
            },
            "line": {
              "type": "number",
              "description": "The 1-indexed line number."
            },
            "character": {
              "type": "number",
              "description": "The 1-indexed character offset on the line."
            }
          },
          "required": [
            "path",
            "line",
            "character"
          ]
        }
      }
    }
  },
  {
    "id": "lsp_query_def",
    "modelToolName": "lsp_definition",
    "category": "lsp",
    "mutating": false,
    "sideEffectContract": "Query LSP server for symbol definition location",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "lsp_definition",
        "description": "Query Language Server Protocol (LSP) definition location for a symbol at a given line and character.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "The source file path containing the symbol reference."
            },
            "line": {
              "type": "number",
              "description": "The 1-indexed line number."
            },
            "character": {
              "type": "number",
              "description": "The 1-indexed character offset on the line."
            }
          },
          "required": [
            "path",
            "line",
            "character"
          ]
        }
      }
    }
  },
  {
    "id": "lsp_query_diag",
    "modelToolName": "lsp_diagnostics",
    "category": "lsp",
    "mutating": false,
    "sideEffectContract": "Query LSP server for workspace compilation diagnostics",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "lsp_diagnostics",
        "description": "Retrieve active Language Server Protocol (LSP) semantic compiler diagnostics for a source file.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "The source file path to query diagnostics for."
            }
          },
          "required": [
            "path"
          ]
        }
      }
    }
  },
  {
    "id": "vcs_status",
    "modelToolName": "git_status",
    "category": "vcs",
    "mutating": false,
    "sideEffectContract": "Query git repository working tree status and branch",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "git_status",
        "description": "Inspect native repository branch and staged/modified/untracked files via Rust libgit2 engine.",
        "parameters": {
          "type": "object",
          "properties": {}
        }
      }
    }
  },
  {
    "id": "vcs_diff",
    "modelToolName": "git_diff",
    "category": "vcs",
    "mutating": false,
    "sideEffectContract": "Query git unified diff of working tree or staged changes",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "git_diff",
        "description": "Generate unified diff of repository changes natively via Rust libgit2 engine.",
        "parameters": {
          "type": "object",
          "properties": {
            "staged": {
              "type": "boolean",
              "description": "If true, diff staged changes against HEAD. Otherwise diff working directory."
            },
            "path_filter": {
              "type": "string",
              "description": "Optional file path pattern to restrict diff to."
            }
          }
        }
      }
    }
  },
  {
    "id": "vcs_log",
    "modelToolName": "git_log",
    "category": "vcs",
    "mutating": false,
    "sideEffectContract": "Query git commit history log",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "git_log",
        "description": "Inspect recent commit history (author, hash, summary, timestamp) natively via Rust libgit2 engine.",
        "parameters": {
          "type": "object",
          "properties": {
            "max_commits": {
              "type": "number",
              "description": "Maximum number of commits to retrieve (default: 10)."
            }
          }
        }
      }
    }
  },
  {
    "id": "code_search_cst",
    "modelToolName": "cst_symbols",
    "category": "code_search",
    "mutating": false,
    "sideEffectContract": "Scan AST/CST concrete syntax tree symbols",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "cst_symbols",
        "description": "Parse symbols, multiline signatures, doc comments, visibility, and scopes using the Rust CST parser.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "File or directory path to parse."
            },
            "query": {
              "type": "string",
              "description": "Optional symbol name filter."
            }
          },
          "required": [
            "path"
          ]
        }
      }
    }
  },
  {
    "id": "code_outline",
    "modelToolName": "outline_file",
    "category": "code_search",
    "mutating": false,
    "sideEffectContract": "Generate structured outline of functions/classes in a file",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "outline_file",
        "description": "Generate a compact AST skeleton outline of a source file (functions, classes, interfaces, signatures, and line numbers) to conserve context before reading specific line ranges.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Relative path to the source file to outline."
            }
          },
          "required": [
            "path"
          ]
        }
      }
    }
  },
  {
    "id": "code_search_trigram",
    "modelToolName": "trigram_search",
    "category": "code_search",
    "mutating": false,
    "sideEffectContract": "Search code using trigram inverted index",
    "backend": "rust_rpc",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "trigram_search",
        "description": "Ultra-fast code search accelerated by Rust inverted trigram index.",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Substring or token to search for across the codebase."
            },
            "path": {
              "type": "string",
              "description": "Optional subdirectory to restrict search to."
            },
            "max_results": {
              "type": "number",
              "description": "Maximum matches to return (default: 50)."
            }
          },
          "required": [
            "query"
          ]
        }
      }
    }
  },
  {
    "id": "code_search_hybrid",
    "modelToolName": "hybrid_search",
    "category": "code_search",
    "mutating": false,
    "sideEffectContract": "Perform hybrid BM25 lexical and vector semantic search",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "hybrid_search",
        "description": "Perform hybrid code search blending dense semantic embeddings, sparse Okapi BM25, and Reciprocal Rank Fusion (RRF). Ideal for discovering code by intent or meaning when exact keyword tokens are unknown.",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Natural language query or code concept to search for."
            },
            "path": {
              "type": "string",
              "description": "Optional relative directory path to scope search."
            },
            "mode": {
              "type": "string",
              "enum": [
                "hybrid",
                "semantic",
                "lexical"
              ],
              "description": "Search mode: 'hybrid' (blended RRF, default), 'semantic' (vector embeddings), or 'lexical' (BM25 keyword)."
            },
            "limit": {
              "type": "number",
              "description": "Maximum matches to return (default: 10)."
            }
          },
          "required": [
            "query"
          ]
        }
      }
    }
  },
  {
    "id": "browser_nav",
    "modelToolName": "browser_navigate",
    "category": "browser",
    "mutating": false,
    "sideEffectContract": "Navigate simulated browser to URL",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "browser_navigate",
        "description": "Navigate the headless browser to a local development server URL (e.g. http://localhost:3000), web page, or HTML file for runtime verification.",
        "parameters": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "description": "The complete HTTP/HTTPS URL or local HTML file path to load."
            }
          },
          "required": [
            "url"
          ]
        }
      }
    }
  },
  {
    "id": "browser_shot",
    "modelToolName": "browser_screenshot",
    "category": "browser",
    "mutating": false,
    "sideEffectContract": "Capture simulated browser viewport screenshot",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "browser_screenshot",
        "description": "Capture a viewport screenshot of the active browser page to verify frontend layout or UI state.",
        "parameters": {
          "type": "object",
          "properties": {
            "output_path": {
              "type": "string",
              "description": "Optional destination file path for screenshot PNG (defaults to .nexus/screenshots/)."
            }
          }
        }
      }
    }
  },
  {
    "id": "browser_interact",
    "modelToolName": "browser_click",
    "category": "browser",
    "mutating": false,
    "sideEffectContract": "Simulate mouse click on DOM selector element",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "browser_click",
        "description": "Click an interactive DOM element on the active browser page by CSS selector or element ID.",
        "parameters": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "CSS selector of the element to click (e.g. '#submit-btn' or 'button.login')."
            }
          },
          "required": [
            "selector"
          ]
        }
      }
    }
  },
  {
    "id": "browser_interact",
    "modelToolName": "browser_type",
    "category": "browser",
    "mutating": true,
    "changesWorkspace": false,
    "sideEffectContract": "Simulate keyboard text typing into DOM selector element",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "browser_type",
        "description": "Type text into an input field or textarea on the active browser page.",
        "parameters": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "CSS selector of target input element."
            },
            "text": {
              "type": "string",
              "description": "Text to enter into the target field."
            }
          },
          "required": [
            "selector",
            "text"
          ]
        }
      }
    }
  },
  {
    "id": "browser_logs",
    "modelToolName": "browser_console_logs",
    "category": "browser",
    "mutating": false,
    "sideEffectContract": "Retrieve captured simulated browser console log messages",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "browser_console_logs",
        "description": "Inspect browser console logs, warnings, and uncaught exceptions for frontend diagnostics.",
        "parameters": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum recent log entries to return (default: 50)."
            }
          }
        }
      }
    }
  },
  {
    "id": "knowledge_store",
    "modelToolName": "manage_knowledge",
    "category": "knowledge",
    "mutating": true,
    "sideEffectContract": "Store, retrieve, query or delete persistent knowledge entries",
    "backend": "ts_native",
    "toolDefinition": {
      "type": "function",
      "function": {
        "name": "manage_knowledge",
        "description": "Query or record persistent project idioms, rules, dependencies, and architectural decisions.",
        "parameters": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "get",
                "set",
                "list",
                "delete",
                "query"
              ],
              "description": "The knowledge operation to execute."
            },
            "key": {
              "type": "string",
              "description": "Knowledge entry key identifier (e.g. 'preferred-package-manager')."
            },
            "value": {
              "type": "string",
              "description": "Value or rule description to persist."
            },
            "category": {
              "type": "string",
              "enum": [
                "idiom",
                "architecture",
                "dependency",
                "troubleshooting",
                "rule"
              ],
              "description": "Classification category for the knowledge entry."
            }
          },
          "required": [
            "action"
          ]
        }
      }
    }
  }
];

export function createDefaultRegistry(): CapabilityRegistry {
  return new CapabilityRegistry(BASELINE_CAPABILITIES.map((c) => ({ ...c })));
}

export const defaultRegistry = createDefaultRegistry();
export const HARNESS_TOOLS: ToolDefinition[] = defaultRegistry.listModelTools();
