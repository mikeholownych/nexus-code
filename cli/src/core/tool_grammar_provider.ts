import type { ServerKind } from "./provider_capabilities.js";
import { GBNF_TOOL_ALLOWLIST } from "./tool_grammar.js";
import type { ToolDefinition } from "../types.js";

const constrainedToolNames: ReadonlySet<string> = new Set(GBNF_TOOL_ALLOWLIST);

/** Enable only vLLM's documented strict function-schema path for the bounded tool grammar pilot. */
export function adaptToolDefinitionsForServer(serverKind: ServerKind, tools: ToolDefinition[]): ToolDefinition[] {
  if (serverKind !== "vllm" || tools.length === 0) return tools;

  let changed = false;
  const adapted = tools.map((tool) => {
    if (tool.type !== "function" || !constrainedToolNames.has(tool.function.name)) return tool;
    changed = true;
    return {
      ...tool,
      function: {
        ...tool.function,
        strict: true,
        parameters: strictCompatibleParameters(tool.function.parameters) as ToolDefinition["function"]["parameters"],
      },
    };
  });
  return changed ? adapted : tools;
}

/** vLLM strict schemas require a closed object and represent optional fields as required nullable values. */
function strictCompatibleParameters(parameters: ToolDefinition["function"]["parameters"]): unknown {
  const properties = Object.fromEntries(Object.entries(parameters.properties).map(([name, property]) => {
    const optional = !(parameters.required ?? []).includes(name);
    if (!optional) return [name, { ...property }];
    if (!["string", "number", "boolean"].includes(property.type)) {
      throw new TypeError(`vLLM strict mode does not support optional ${property.type} parameter ${name}`);
    }
    return [name, { ...property, type: [property.type, "null"] }];
  }));
  return {
    ...parameters,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
