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
};
