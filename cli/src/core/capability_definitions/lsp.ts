import type { CanonicalCapability } from "../capabilities.js";

export const lspHoverCapability: CanonicalCapability = {
  "id": "lsp_query_hover",
  "modelToolName": "lsp_hover",
  "category": "lsp",
  "mutating": false,
  "effect": "exec",
  "sideEffectContract": "Query LSP server for hover type/doc information",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "lsp_hover",
      "description": "Type signature and documentation of the symbol at a position, from the language server (LSP). The text comes back fenced as untrusted tool output. \"Nothing at this position\" is an answer; \"still indexing\" is not: ask again.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Source file inside the workspace."
          },
          "line": {
            "type": "number",
            "description": "Line, a positive integer (the first line is 1)."
          },
          "character": {
            "type": "number",
            "description": "Character on the line, a positive integer (the first is 1)."
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
};

export const lspDefinitionCapability: CanonicalCapability = {
  "id": "lsp_query_def",
  "modelToolName": "lsp_definition",
  "category": "lsp",
  "mutating": false,
  "effect": "exec",
  "sideEffectContract": "Query LSP server for symbol definition location",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "lsp_definition",
      "description": "Where the symbol at a position is defined, from the language server (LSP). Returns a JSON list of {file, line, column, endLine, endColumn}, 1-based like the inputs; file is workspace-relative, or absolute with external: true outside the workspace (uri replaces file for a non-file target). \"Nothing to go to\" is an answer; \"still indexing\" is not: ask again.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Source file inside the workspace."
          },
          "line": {
            "type": "number",
            "description": "Line, a positive integer (the first line is 1)."
          },
          "character": {
            "type": "number",
            "description": "Character on the line, a positive integer (the first is 1)."
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
};

export const lspDiagnosticsCapability: CanonicalCapability = {
  "id": "lsp_query_diag",
  "modelToolName": "lsp_diagnostics",
  "category": "lsp",
  "mutating": false,
  "effect": "exec",
  "sideEffectContract": "Query LSP server for workspace compilation diagnostics",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "lsp_diagnostics",
      "description": "Language server (LSP) diagnostics for a source file's current content: JSON records fenced as untrusted tool output. An empty list means no findings; \"unavailable\" means no answer, not a clean file.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Source file inside the workspace."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  }
};
