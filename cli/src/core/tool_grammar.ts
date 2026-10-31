import { HARNESS_TOOLS } from "./capabilities.js";
import type { ToolDefinition } from "../types.js";

/** The v1.1.0 GBNF pilot is intentionally limited to these registered tools. */
export const GBNF_TOOL_ALLOWLIST = ["read_file", "write_file", "edit_file", "run_command"] as const;
export type GbnfToolName = (typeof GBNF_TOOL_ALLOWLIST)[number];

const ALLOWED_NAMES: ReadonlySet<string> = new Set(GBNF_TOOL_ALLOWLIST);
const MAX_PROPERTIES = 8;

/** Compile the exact parameter schema registered for one allowlisted tool. Unknown JSON Schema forms fail closed. */
export function generateToolArgumentsGbnf(
  toolName: GbnfToolName,
  registeredTools: readonly ToolDefinition[] = HARNESS_TOOLS,
): string {
  if (!ALLOWED_NAMES.has(toolName)) throw new Error(`GBNF is not enabled for tool ${String(toolName)}`);
  if (!Array.isArray(registeredTools)) throw new Error("registered tool definitions must be an array");

  const matches = registeredTools.filter((tool) => (tool as ToolDefinition | undefined)?.function?.name === toolName);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one registered schema for ${toolName}; found ${matches.length}`);
  }
  const definition = matches[0] as ToolDefinition;
  if (definition.type !== "function" || !definition.function || definition.function.name !== toolName) {
    throw new Error(`registered schema for ${toolName} is not a function tool`);
  }
  const parameters = definition.function.parameters as unknown;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error(`registered schema for ${toolName} must define an object parameter schema`);
  }

  const schema = parameters as Record<string, unknown>;
  rejectUnknownKeys(schema, new Set(["type", "properties", "required"]), `${toolName} parameter schema`);
  if (schema.type !== "object") throw new Error(`registered schema for ${toolName} must have type object`);
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    throw new Error(`registered schema for ${toolName} must define flat properties`);
  }

  const propertyMap = schema.properties as Record<string, unknown>;
  const propertyNames = Object.keys(propertyMap);
  if (propertyNames.length > MAX_PROPERTIES) throw new Error(`${toolName} schema exceeds the ${MAX_PROPERTIES}-property GBNF bound`);
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    throw new Error(`registered schema for ${toolName} has an invalid required list`);
  }
  if (new Set(required).size !== required.length) throw new Error(`registered schema for ${toolName} repeats a required property`);
  for (const name of required) {
    if (!Object.hasOwn(propertyMap, name)) throw new Error(`registered schema for ${toolName} requires undeclared property ${name}`);
  }

  const properties = propertyNames.map((name, index) => {
    const raw = propertyMap[name];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`registered property ${toolName}.${name} must be a flat schema object`);
    }
    const property = raw as Record<string, unknown>;
    rejectUnknownKeys(property, new Set(["type", "description"]), `${toolName}.${name} schema`);
    if (typeof property.description !== "undefined" && typeof property.description !== "string") {
      throw new Error(`registered property ${toolName}.${name} has an invalid description`);
    }
    const valueRule = property.type === "string" ? "json-string"
      : property.type === "number" ? "json-number"
        : property.type === "boolean" ? "json-boolean"
          : undefined;
    if (!valueRule) throw new Error(`unsupported JSON Schema type for ${toolName}.${name}`);
    return { name, index, valueRule };
  });

  const propertyIndex = new Map(properties.map(({ name, index }) => [name, index]));
  const requiredMask = required.reduce((mask: number, name: string) => mask | (1 << propertyIndex.get(name)!), 0);
  const stateCount = 1 << properties.length;
  const rules = [
    "root ::= ws \"{\" ws object-fields ws \"}\" ws",
    "json-string ::= \"\\\"\" json-char* \"\\\"\"",
    String.raw`json-char ::= [^"\\\x00-\x1f] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})`,
    String.raw`json-number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?`,
    "json-boolean ::= \"true\" | \"false\"",
    "ws ::= [ \\t\\n\\r]*",
    ...properties.map(({ name, index, valueRule }) => `member_${index} ::= ${JSON.stringify(name)} ws ":" ws ${valueRule}`),
  ];

  const firstChoices = properties.map(({ index }) => `member_${index} fields_tail_${1 << index}`);
  rules.push(`object-fields ::= ${requiredMask === 0 ? '"" | ' : ""}${firstChoices.length ? firstChoices.join(" | ") : '""'}`);
  for (let mask = 0; mask < stateCount; mask++) {
    const choices: string[] = [];
    if ((mask & requiredMask) === requiredMask) choices.push('""');
    for (const { index } of properties) {
      const bit = 1 << index;
      if ((mask & bit) === 0) choices.push(`"," ws member_${index} fields_tail_${mask | bit}`);
    }
    // Only reachable states need a rule, but emitting all bounded masks keeps output deterministic and simple.
    rules.push(`fields_tail_${mask} ::= ${choices.join(" | ") || '""'}`);
  }
  return rules.join("\n");
}

/** Compile each registered schema from the allowlist; unrelated registered tools are intentionally ignored. */
export function generateRegisteredToolArgumentGrammars(
  registeredTools: readonly ToolDefinition[] = HARNESS_TOOLS,
): Readonly<Record<GbnfToolName, string>> {
  const result = {} as Record<GbnfToolName, string>;
  for (const toolName of GBNF_TOOL_ALLOWLIST) result[toolName] = generateToolArgumentsGbnf(toolName, registeredTools);
  return result;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unsupported schema keyword ${unknown}`);
}
