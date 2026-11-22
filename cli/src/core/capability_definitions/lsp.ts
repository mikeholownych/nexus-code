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
      "description": "LSP hover: type signature and docs of the symbol at a position. \"Still indexing\" is not an answer: ask again.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Source file path."
          },
          "line": {
            "type": "number",
            "description": "1-based line."
          },
          "character": {
            "type": "number",
            "description": "1-based character."
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
      "description": "LSP definition of the symbol at a position: JSON [{file, line, column, endLine, endColumn}], 1-based; file is workspace-relative (external: true outside it).",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Source file path."
          },
          "line": {
            "type": "number",
            "description": "1-based line."
          },
          "character": {
            "type": "number",
            "description": "1-based character."
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
      "description": "LSP diagnostics for a source file's current content. \"unavailable\" means no answer, not a clean file.",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Source file path."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  }
};
