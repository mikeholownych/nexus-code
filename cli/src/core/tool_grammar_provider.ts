import type { ServerKind } from "./provider_capabilities.js";
import { GBNF_TOOL_ALLOWLIST, generateToolCallBlockGbnf } from "./tool_grammar.js";
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

/** NEXUS_TOOL_GRAMMAR=off|0|false|no|disabled is the kill switch for every server-side tool-call constraint added by Nexus. */
export function toolGrammarEnabled(setting: string | undefined): boolean {
  return !/^(off|0|false|no|disabled)$/i.test((setting ?? "").trim());
}

/**
 * Constrain a TEXT-MODE tool call on a verified llama.cpp server. llama-server rejects a caller `grammar` beside native
 * `tools` (it builds the tool grammar itself from their schemas, reasoning included), so this applies only to a request
 * that carries no `tools` field and still offers tools. The grammar is LAZY: it starts at the `<tool_call>` trigger, so
 * a plain-text answer and `<think>…</think>` reasoning stay unconstrained and a turn that wants text is never broken.
 * Any other server kind (including every unknown or unverified one) is left untouched. Returns whether it applied.
 */
export function constrainTextModeToolCall(
  serverKind: ServerKind,
  body: Record<string, unknown>,
  offeredTools: readonly ToolDefinition[],
  enabled: boolean,
): boolean {
  if (!enabled || serverKind !== "llamacpp" || offeredTools.length === 0) return false;
  if ("tools" in body || "grammar" in body || "response_format" in body) return false;
  let grammar: string | undefined;
  try { grammar = generateToolCallBlockGbnf(offeredTools); } catch { return false; }
  if (!grammar) return false;
  body.grammar = grammar;
  body.grammar_lazy = true;
  body.grammar_triggers = [{ type: 1, value: "<tool_call>" }]; // COMMON_GRAMMAR_TRIGGER_TYPE_WORD
  return true;
}
