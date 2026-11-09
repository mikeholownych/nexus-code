import type { CanonicalCapability } from "../capabilities.js";

export const activateSkillCapability: CanonicalCapability = {
  "id": "skill_activate",
  "modelToolName": "activate_skill",
  "category": "skill",
  "mutating": false,
  "effect": "context_inject",
  "sideEffectContract": "Load specialized instructions and guidelines from skill repository",
  "backend": "ts_native",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "activate_skill",
      "description": "Load the complete instructions, workflow, and guidelines of a specialized agent skill into active context.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The skill to activate (e.g. 'graphify'). If no skill has exactly this name, it is used as a search and the best matching skills are listed."
          }
        },
        "required": [
          "name"
        ]
      }
    }
  }
};
