import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ToolDefinition, ExecutionResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HARNESS_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file with line numbers. Use start_line and end_line for specific ranges.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file within the workspace.",
          },
          start_line: {
            type: "number",
            description: "1-indexed starting line number (optional).",
          },
          end_line: {
            type: "number",
            description: "1-indexed ending line number (optional).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or completely overwrite an existing file with the provided content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file to create or overwrite.",
          },
          content: {
            type: "string",
            description: "Complete text content of the file.",
          },
          overwrite: {
            type: "boolean",
            description: "Must be true if replacing an existing file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Perform a safe search-and-replace on a file. Replaces old_content with new_content and returns the diff.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file to edit.",
          },
          old_content: {
            type: "string",
            description: "Exact snippet of text in the file to be replaced.",
          },
          new_content: {
            type: "string",
            description: "The new replacement snippet.",
          },
        },
        required: ["path", "old_content", "new_content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories in the workspace, respecting .gitignore and ignoring hidden files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Subdirectory to list (defaults to workspace root '.').",
          },
          max_depth: {
            type: "number",
            description: "Maximum directory traversal depth (default: 3).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "High-performance code search across the workspace (ripgrep speed). Respects .gitignore.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search string or regex pattern to search for.",
          },
          is_regex: {
            type: "boolean",
            description: "Whether query is a regular expression (default: false).",
          },
          max_results: {
            type: "number",
            description: "Maximum number of matching lines to return (default: 50).",
          },
          file_pattern: {
            type: "string",
            description: "Optional regex to filter filenames (e.g. '\\.rs$' or '\\.ts$').",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a command in a Linux shell (bash, zsh, or sh) to run builds, tests, git, package managers, etc. Standard Unix commands only (ls, cat, grep, rm, etc.).",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash/zsh shell command to execute.",
          },
          cwd: {
            type: "string",
            description: "Optional subdirectory to run the command in.",
          },
          timeout_secs: {
            type: "number",
            description: "Execution timeout in seconds (default: 60).",
          },
          shell: {
            type: "string",
            description: "Linux shell to use: 'bash', 'zsh', or 'sh' (default: 'bash').",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Quickly locate files matching a glob or substring pattern (e.g. '*.rs', '**/*.ts', 'auth'). Respects .gitignore.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob or substring pattern to search for.",
          },
          max_results: {
            type: "number",
            description: "Maximum results to return (default: 50).",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_symbols",
      description: "Search for function, struct, class, interface, trait, or type declarations across the codebase (AST-level symbol search).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional symbol name or substring to filter declarations.",
          },
          max_results: {
            type: "number",
            description: "Maximum number of symbols to return (default: 50).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or directory inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to file or directory to remove.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web",
      description: "Fetch web content, documentation, or JSON API from an HTTP/HTTPS URL. Strips HTML markup.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The complete HTTP or HTTPS URL to fetch.",
          },
          max_length: {
            type: "number",
            description: "Maximum character length to return (default: 15000).",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_completed",
      description: "Signal that the overall task is finished and report a comprehensive final summary of changes.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Detailed summary of all changes made and outcomes achieved.",
          },
          notes: {
            type: "string",
            description: "Any instructions, follow-up recommendations, or verification steps.",
          },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Spawn an isolated subagent with its own dedicated context to investigate code, search files, or verify implementations without cluttering the main conversation history.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The specific objective or question for the subagent to solve.",
          },
          max_steps: {
            type: "number",
            description: "Maximum steps for the subagent to take (default: 8).",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_info",
      description: "Inspect detailed metadata of a file or directory (size in bytes, permissions, line count, binary check, modified timestamp).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file or directory.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_read",
      description: "Read multiple files in parallel in a single turn to eliminate multi-turn round trips.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "List of relative paths to files to read.",
          },
          max_lines_per_file: {
            type: "number",
            description: "Maximum number of lines to read per file (default: 500).",
          },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_tree",
      description: "Render a hierarchical Unicode directory tree of the workspace, respecting .gitignore and ignoring hidden files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Subdirectory to render tree from (default: '.').",
          },
          max_depth: {
            type: "number",
            description: "Maximum tree depth to traverse (default: 3).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_file",
      description: "Apply a standard unified diff patch or hunk to a file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file to patch.",
          },
          patch: {
            type: "string",
            description: "Unified diff or hunk content (including @@ headers or -/+ lines).",
          },
        },
        required: ["path", "patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description: "Create or update the structured multi-phase execution plan for the active task. Keeps user and agent aligned on milestones.",
      parameters: {
        type: "object",
        properties: {
          phases: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Name or title of this execution phase.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current status of the phase.",
                },
                detail: {
                  type: "string",
                  description: "Optional details or sub-steps for this phase.",
                },
              },
              required: ["name", "status"],
            },
            description: "List of plan phases in chronological order.",
          },
        },
        required: ["phases"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_skill",
      description: "Load the complete instructions, workflow, and guidelines of a specialized agent skill into active context.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the skill to activate (e.g. 'graphify').",
          },
        },
        required: ["name"],
      },
    },
  },
];

export class RustCoreBridge {
  private workspace: string;
  private defaultShell: string;
  private coreBinaryPath: string | null = null;
  private cargoManifestPath: string;

  constructor(workspace: string, defaultShell: string = "bash", customBinaryPath?: string) {
    this.workspace = path.resolve(workspace);
    this.defaultShell = defaultShell;
    this.cargoManifestPath = path.resolve(__dirname, "../../core/Cargo.toml");

    if (customBinaryPath && fs.existsSync(customBinaryPath)) {
      this.coreBinaryPath = customBinaryPath;
    } else {
      this.resolveBinary();
    }
  }

  private resolveBinary(): void {
    const candidates = [
      path.resolve(__dirname, "../../core/target/release/harness-core"),
      path.resolve(__dirname, "../../core/target/debug/harness-core"),
      path.resolve(__dirname, "../../core/target/release/harness-core.exe"),
      path.resolve(__dirname, "../../core/target/debug/harness-core.exe"),
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        this.coreBinaryPath = cand;
        return;
      }
    }
  }

  /**
   * Execute tool using either the compiled harness-core binary or cargo run
   */
  async executeTool(toolName: string, args: Record<string, any>): Promise<ExecutionResult> {
    if (toolName === "task_completed") {
      return {
        success: true,
        output: JSON.stringify({
          status: "completed",
          summary: args.summary || "Task marked as completed.",
          notes: args.notes || "",
        }),
      };
    }

    if (toolName === "update_plan") {
      return {
        success: true,
        output: JSON.stringify({
          status: "plan_updated",
          phases: args.phases || [],
        }),
      };
    }

    if (toolName === "fetch_web") {
      try {
        const url = args.url;
        if (!url || typeof url !== "string") {
          return { success: false, output: "", error: "Missing required parameter 'url'" };
        }
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; NexusCode/1.0)",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          return { success: false, output: "", error: `HTTP ${res.status}: ${res.statusText}` };
        }
        const text = await res.text();
        const clean = text
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const maxLen = args.max_length || 15000;
        const truncated = clean.length > maxLen ? clean.substring(0, maxLen) + "\n... [TRUNCATED]" : clean;
        return { success: true, output: truncated };
      } catch (err: any) {
        return { success: false, output: "", error: `Fetch failed: ${err.message}` };
      }
    }

    // Default the shell if not explicitly provided
    if (toolName === "run_command" && !args.shell) {
      args.shell = this.defaultShell;
    }

    const argsJson = JSON.stringify(args);

    let command: string;
    let spawnArgs: string[];

    if (this.coreBinaryPath && fs.existsSync(this.coreBinaryPath)) {
      command = this.coreBinaryPath;
      spawnArgs = ["--workspace", this.workspace, "call", "--tool", toolName, "--args", argsJson];
    } else {
      // Fallback: cargo run
      command = "cargo";
      spawnArgs = [
        "run",
        "--manifest-path",
        this.cargoManifestPath,
        "--quiet",
        "--",
        "--workspace",
        this.workspace,
        "call",
        "--tool",
        toolName,
        "--args",
        argsJson,
      ];
    }

    try {
      const res = spawnSync(command, spawnArgs, {
        cwd: this.workspace,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      if (res.error) {
        return {
          success: false,
          output: "",
          error: `Failed to execute core engine: ${res.error.message}`,
        };
      }

      if (res.status !== 0) {
        return {
          success: false,
          output: res.stdout || "",
          error: res.stderr || `Tool exited with code ${res.status}`,
        };
      }

      return {
        success: true,
        output: res.stdout.trim(),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Unexpected error executing tool: ${err.message}`,
      };
    }
  }
}
