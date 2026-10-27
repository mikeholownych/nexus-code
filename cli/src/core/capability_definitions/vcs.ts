import type { CanonicalCapability } from "../capabilities.js";

export const gitStatusCapability: CanonicalCapability = {
  "id": "vcs_status",
  "modelToolName": "git_status",
  "category": "vcs",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const gitDiffCapability: CanonicalCapability = {
  "id": "vcs_diff",
  "modelToolName": "git_diff",
  "category": "vcs",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const gitLogCapability: CanonicalCapability = {
  "id": "vcs_log",
  "modelToolName": "git_log",
  "category": "vcs",
  "mutating": false,
  "effect": "read_workspace",
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
};
