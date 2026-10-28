import type { CanonicalCapability } from "../capabilities.js";

export const manageKnowledgeCapability: CanonicalCapability = {
  "id": "knowledge_store",
  "modelToolName": "manage_knowledge",
  "category": "knowledge",
  "mutating": true,
  "effect": "write_workspace",
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
};
