import type { CanonicalCapability } from "../capabilities.js";

export const searchCodeCapability: CanonicalCapability = {
  "id": "code_search_lexical",
  "modelToolName": "search_code",
  "category": "code_search",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const searchSymbolsCapability: CanonicalCapability = {
  "id": "code_search_symbols",
  "modelToolName": "search_symbols",
  "category": "code_search",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const cstSymbolsCapability: CanonicalCapability = {
  "id": "code_search_cst",
  "modelToolName": "cst_symbols",
  "category": "code_search",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const outlineFileCapability: CanonicalCapability = {
  "id": "code_outline",
  "modelToolName": "outline_file",
  "category": "code_search",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const trigramSearchCapability: CanonicalCapability = {
  "id": "code_search_trigram",
  "modelToolName": "trigram_search",
  "category": "code_search",
  "mutating": false,
  "effect": "read_workspace",
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
};

export const hybridSearchCapability: CanonicalCapability = {
  "id": "code_search_hybrid",
  "modelToolName": "hybrid_search",
  "category": "code_search",
  "mutating": false,
  "effect": "read_workspace",
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
};
