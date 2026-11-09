import type { ToolDefinition } from "../types.js";

/** True when the declared schema accepts an explicit null (type list, nullable, enum, or anyOf/oneOf branch). */
function schemaAllowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  if (s.type === "null" || (Array.isArray(s.type) && s.type.includes("null"))) return true;
  if (s.nullable === true) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  // An unresolved reference cannot be judged here: keep the null (fail safe) and let the tool validate it.
  if (typeof s.$ref === "string") return true;
  if (Array.isArray(s.allOf) && s.allOf.length > 0) return s.allOf.every(schemaAllowsNull);
  return [s.anyOf, s.oneOf].some((branches) => Array.isArray(branches) && branches.some(schemaAllowsNull));
}

/**
 * Remove nulls from optional top-level arguments using the tool schema the agent originally declared. The agent applies
 * it where a model response is parsed (native, repaired and text-mode calls alike), so every later reader sees one
 * form; dispatch repeats it as an idempotent backstop. An explicit null survives where the declared schema allows it;
 * a required argument is never touched.
 */
export function normalizeNullableOptionalToolArguments(toolName: string, rawArgs: unknown, tools: readonly ToolDefinition[]): unknown {
  const tool = tools.find((candidate) => candidate.type === "function" && candidate.function.name === toolName);
  if (!tool || !tool.function.parameters || !rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;

  const required = new Set(tool.function.parameters.required ?? []);
  const properties = tool.function.parameters.properties ?? {};
  let normalized: Record<string, unknown> | undefined;
  for (const name of Object.keys(properties)) {
    if (required.has(name) || (rawArgs as Record<string, unknown>)[name] !== null || schemaAllowsNull(properties[name])) continue;
    normalized ??= { ...(rawArgs as Record<string, unknown>) };
    delete normalized[name];
  }
  return normalized ?? rawArgs;
}

/** The keys a model may wrap a call's real arguments in: {"input": {...}}, {"parameters": {...}}, {"args": {...}}. */
const WRAPPER_KEYS = ["input", "parameters", "args"] as const;

/**
 * The single shared wrapper rule (the parser and the agent both use it): an object with exactly one key, a wrapper key
 * holding a plain object, is replaced by that object. `declared` lists argument names the tool itself declares; a
 * wrapper key the tool declares as a real property is kept (a tool with an `input` parameter owns that name).
 */
export function unwrapSingleKeyWrapper(args: unknown, declared: ReadonlySet<string> = new Set()): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const keys = Object.keys(args);
  if (keys.length !== 1 || !(WRAPPER_KEYS as readonly string[]).includes(keys[0]) || declared.has(keys[0])) return args;
  const inner = (args as Record<string, unknown>)[keys[0]];
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : args;
}

/**
 * Null removal followed by wrapper unwrapping, as one pass: removing a null can leave a lone wrapper key
 * ({input:{...}, start_line:null}), which is then unwrapped and normalised again.
 */
export function normalizeToolArguments(toolName: string, rawArgs: unknown, tools: readonly ToolDefinition[]): unknown {
  const first = normalizeNullableOptionalToolArguments(toolName, rawArgs, tools);
  const declared = new Set(Object.keys(tools.find((t) => t.type === "function" && t.function.name === toolName)?.function.parameters?.properties ?? {}));
  const unwrapped = unwrapSingleKeyWrapper(first, declared);
  return unwrapped === first ? first : normalizeNullableOptionalToolArguments(toolName, unwrapped, tools);
}
