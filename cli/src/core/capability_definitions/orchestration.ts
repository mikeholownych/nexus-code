import type { CanonicalCapability } from "../capabilities.js";

export const taskCompletedCapability: CanonicalCapability = {
  "id": "orchestrate_exit",
  "modelToolName": "task_completed",
  "category": "orchestration",
  "mutating": false,
  "effect": "internal",
  "sideEffectContract": "Conclude task execution with final summary and verification check",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "task_completed",
      "description": "Signal that the overall task is finished and report a short final summary of the changes.",
      "parameters": {
        "type": "object",
        "properties": {
          "summary": {
            "type": "string",
            "description": "Short summary (2-4 sentences): what changed and how it was checked."
          },
          "notes": {
            "type": "string",
            "description": "Any instructions, follow-up recommendations, or verification steps."
          }
        },
        "required": [
          "summary"
        ]
      }
    }
  }
};

export const spawnSubagentCapability: CanonicalCapability = {
  "id": "orchestrate_sub",
  "modelToolName": "spawn_subagent",
  "category": "orchestration",
  "mutating": false,
  "effect": "delegate",
  "sideEffectContract": "Spawn isolated child agent to investigate or execute subtask",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "spawn_subagent",
      "description": "Spawn an isolated subagent with its own dedicated context to investigate code, search files, or verify implementations without cluttering the main conversation history.",
      "parameters": {
        "type": "object",
        "properties": {
          "prompt": {
            "type": "string",
            "description": "The specific objective or question for the subagent to solve."
          }
        },
        "required": [
          "prompt"
        ]
      }
    }
  }
};

export const updatePlanCapability: CanonicalCapability = {
  "id": "orchestrate_plan",
  "modelToolName": "update_plan",
  "category": "orchestration",
  "mutating": true,
  "effect": "internal",
  "changesWorkspace": false,
  "sideEffectContract": "Update task phases and execution roadmap",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "update_plan",
      "description": "Create or update the task's plan: a short checklist, one item per phase, each a few words.",
      "parameters": {
        "type": "object",
        "properties": {
          "phases": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "The item, in a few words."
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "pending",
                    "in_progress",
                    "completed"
                  ]
                }
              },
              "required": [
                "name",
                "status"
              ]
            },
            "description": "Checklist items in order."
          }
        },
        "required": [
          "phases"
        ]
      }
    }
  }
};
