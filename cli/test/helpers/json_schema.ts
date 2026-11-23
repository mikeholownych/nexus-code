// A small JSON Schema validator for the subset scripts/gen_protocol_schema.mjs emits (draft 2020-12 keywords: type,
// const, enum, properties, required, additionalProperties, items, prefixItems, minItems, maxItems, anyOf, oneOf and a
// local $ref). It is a test helper, not a general validator: a keyword outside that subset throws, so a generator that
// starts emitting a new keyword cannot pass unvalidated.
import { isDeepStrictEqual } from "node:util";

export type Schema = Record<string, any>;

const ANNOTATIONS = new Set(["$schema", "$defs", "title", "description"]);
const KEYWORDS = new Set(["$ref", "type", "const", "enum", "properties", "required", "additionalProperties", "items", "prefixItems", "minItems", "maxItems", "anyOf", "oneOf"]);

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let node: any = root;
  for (const part of ref.slice(2).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (!node || typeof node !== "object") throw new Error(`unresolved $ref: ${ref}`);
  return node;
}

/** Every way `value` fails `schema`, as `path: reason` lines; empty when it is valid. `root` resolves `$ref`. */
export function validate(value: unknown, schema: Schema, root: Schema = schema, at = "$"): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) throw new Error(`unsupported schema keyword at ${at}: ${keyword}`);
  }
  const errors: string[] = [];
  if (schema.$ref) errors.push(...validate(value, resolve(root, schema.$ref), root, at));
  const actual = typeName(value);
  if (schema.type !== undefined && actual !== schema.type) errors.push(`${at}: expected ${schema.type}, got ${actual}`);
  if ("const" in schema && !isDeepStrictEqual(value, schema.const)) errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((allowed: unknown) => isDeepStrictEqual(value, allowed))) errors.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);

  if (actual === "object") {
    const object = value as Record<string, unknown>;
    const properties: Record<string, Schema> = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(object, name)) errors.push(`${at}: missing required ${name}`);
    }
    for (const [name, member] of Object.entries(object)) {
      if (Object.hasOwn(properties, name)) errors.push(...validate(member, properties[name], root, `${at}.${name}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${name}`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(member, schema.additionalProperties, root, `${at}.${name}`));
    }
  }

  if (actual === "array") {
    const array = value as unknown[];
    const prefix: Schema[] = schema.prefixItems ?? [];
    if (schema.minItems !== undefined && array.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && array.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    array.forEach((item, i) => {
      if (i < prefix.length) errors.push(...validate(item, prefix[i], root, `${at}[${i}]`));
      else if (schema.items) errors.push(...validate(item, schema.items, root, `${at}[${i}]`));
    });
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!schema[keyword]) continue;
    const results: string[][] = schema[keyword].map((option: Schema) => validate(value, option, root, at));
    const matches = results.filter((result) => result.length === 0).length;
    if (matches === 1 || (matches > 1 && keyword === "anyOf")) continue;
    if (matches > 1) {
      errors.push(`${at}: matches ${matches} oneOf alternatives`);
      continue;
    }
    // Explain with the alternative that came closest. For a message union that is the variant whose `type` matched;
    // when no variant's did, the type is unknown and there is nothing more to say.
    const candidates = results.filter((result) => !result.some((error) => error.startsWith(`${at}.type:`)));
    const closest = candidates.reduce<string[]>((best, result) => (best.length === 0 || result.length < best.length ? result : best), []);
    errors.push(`${at}: matches no ${keyword} alternative`, ...closest);
  }
  return errors;
}
