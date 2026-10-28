import type { CanonicalCapability } from "../capabilities.js";

export const readFileCapability: CanonicalCapability = {
  "id": "fs_read",
  "modelToolName": "read_file",
  "category": "fs",
  "mutating": false,
  "effect": "read_workspace",
  "sideEffectContract": "Read file contents with line numbers from workspace",
  "backend": "rust_rpc",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read the contents of a file with line numbers. Use start_line and end_line for specific ranges, or offset and length to page through large files (>8 MB limit).",
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
          },
          "offset": {
            "type": "number",
            "description": "Byte offset from the start of the file to begin reading (optional; required if file exceeds 8 MB)."
          },
          "length": {
            "type": "number",
            "description": "Maximum number of bytes to read (optional; maximum 8 MB)."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  }
};

export const writeFileCapability: CanonicalCapability = {
  "id": "fs_write",
  "modelToolName": "write_file",
  "category": "fs",
  "mutating": true,
  "effect": "write_workspace",
  "sideEffectContract": "Create a new file or completely overwrite an existing file",
  "backend": "rust_rpc",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "write_file",
      "description": "Create a new file or completely overwrite an existing file with the provided content. One reply can hold only a limited amount of output: write a long file (more than a few hundred lines) in parts, a first part here and the rest with edit_file, or as several smaller files.",
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
};

export const editFileCapability: CanonicalCapability = {
  "id": "fs_edit",
  "modelToolName": "edit_file",
  "category": "fs",
  "mutating": true,
  "effect": "write_workspace",
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
};

export const listDirCapability: CanonicalCapability = {
  "id": "fs_discover_list",
  "modelToolName": "list_dir",
  "category": "fs",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const findFilesCapability: CanonicalCapability = {
  "id": "fs_discover_find",
  "modelToolName": "find_files",
  "category": "fs",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const deleteFileCapability: CanonicalCapability = {
  "id": "fs_delete",
  "modelToolName": "delete_file",
  "category": "fs",
  "mutating": true,
  "effect": "write_workspace",
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
};

export const fileInfoCapability: CanonicalCapability = {
  "id": "fs_metadata",
  "modelToolName": "file_info",
  "category": "fs",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const batchReadCapability: CanonicalCapability = {
  "id": "fs_read_batch",
  "modelToolName": "batch_read",
  "category": "fs",
  "mutating": false,
  "effect": "read_workspace",
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
          },
          "offset": {
            "type": "number",
            "description": "Byte offset to begin reading each file (optional; required if file exceeds 8 MB)."
          },
          "length": {
            "type": "number",
            "description": "Maximum number of bytes to read per file (optional; maximum 8 MB)."
          }
        },
        "required": [
          "paths"
        ]
      }
    }
  }
};

export const fileTreeCapability: CanonicalCapability = {
  "id": "fs_discover_tree",
  "modelToolName": "file_tree",
  "category": "fs",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const patchFileCapability: CanonicalCapability = {
  "id": "fs_patch",
  "modelToolName": "patch_file",
  "category": "fs",
  "mutating": true,
  "effect": "write_workspace",
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
};
