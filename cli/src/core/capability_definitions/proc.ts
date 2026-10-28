import type { CanonicalCapability } from "../capabilities.js";

export const runCommandCapability: CanonicalCapability = {
  "id": "proc_exec",
  "modelToolName": "run_command",
  "category": "proc",
  "mutating": true,
  "effect": "exec",
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
            "description": "Execution timeout in seconds (default: 60; clamped to NEXUS_MAX_TOOL_TIMEOUT_SECS, default 1800)."
          },
          "shell": {
            "type": "string",
            "description": "Linux shell to use: 'bash', 'zsh', or 'sh' (default: 'bash')."
          },
          "background": {
            "type": "boolean",
            "description": "Run command in background as a managed service without blocking the turn."
          },
          "service_name": {
            "type": "string",
            "description": "Unique name for the background service (required if background is true)."
          }
        },
        "required": [
          "command"
        ]
      }
    }
  }
};

export const runTestsCapability: CanonicalCapability = {
  "id": "test_discover_run",
  "modelToolName": "run_tests",
  "category": "proc",
  "mutating": true,
  "effect": "exec",
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
};
