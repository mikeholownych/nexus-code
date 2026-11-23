import type { CanonicalCapability } from "../capabilities.js";

export const manageKnowledgeCapability: CanonicalCapability = {
  "id": "knowledge_store",
  "modelToolName": "manage_knowledge",
  "category": "knowledge",
  "mutating": true,
  "effect": "write_workspace",
  "sideEffectContract": "Retrieve, query or delete persistent knowledge entries; durable promotion is operator-only",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "manage_knowledge",
      "description": "Retrieve or delete existing project knowledge. Durable knowledge promotion is available only through an explicit operator command.",
      "parameters": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "get",
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
