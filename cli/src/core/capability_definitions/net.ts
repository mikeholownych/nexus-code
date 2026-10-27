import type { CanonicalCapability } from "../capabilities.js";

export const fetchWebCapability: CanonicalCapability = {
  "id": "net_fetch",
  "modelToolName": "fetch_web",
  "category": "net",
  "mutating": false,
  "effect": "egress",
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
};

export const searchWebCapability: CanonicalCapability = {
  "id": "net_search",
  "modelToolName": "search_web",
  "category": "net",
  "mutating": false,
  "effect": "egress",
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
};
