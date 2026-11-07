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

/**
 * Default for the llama.cpp text-mode tool-call grammar. OFF until a live llama.cpp matrix has passed (G1.1-4); flipping
 * this one constant to true turns the feature on by default. NEXUS_TOOL_GRAMMAR=on|off overrides it either way.
 */
export const toolGrammarDefault = false;

/**
 * NEXUS_TOOL_GRAMMAR=on|off for the llama.cpp text-mode tool-call grammar added here (it does not govern the separate
 * vLLM strict-schema adaptation). on/1/true/yes/enabled enables it, off/0/false/no/disabled disables it, anything else
 * (including unset) uses `toolGrammarDefault`.
 */
export function toolGrammarEnabled(setting: string | undefined, fallback: boolean = toolGrammarDefault): boolean {
  const value = (setting ?? "").trim();
  if (/^(off|0|false|no|disabled)$/i.test(value)) return false;
  if (/^(on|1|true|yes|enabled)$/i.test(value)) return true;
  return fallback;
}

/** Whether a 400 body says the server could not take the grammar (as opposed to, say, a context overflow). */
export function isGrammarRejection(message: string): boolean {
  return /grammar|gbnf/i.test(message);
}

/**
 * Constrain a TEXT-MODE tool call on a verified llama.cpp server. llama-server rejects a caller `grammar` beside native
 * `tools` (it builds the tool grammar itself from their schemas), so this applies only to a request that carries no
 * `tools` field and still offers tools. The grammar is the whole-reply grammar of generateToolCallBlockGbnf: free text,
 * `<think>…</think>` reasoning and well-formed `<tool_call>` blocks all parse, so it is correct when applied from the
 * first token. No lazy-trigger fields are sent: llama.cpp's chat endpoint discards `grammar_lazy` and `grammar_triggers`,
 * so correctness must not depend on them. Any other server kind (every unknown or unverified one) is left untouched.
 * Returns whether it applied.
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
  return true;
}
