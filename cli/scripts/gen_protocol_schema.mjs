// Generates the JSON Schema (draft 2020-12) of the sidecar wire protocol from the types in src/protocol.ts, using the
// TypeScript 7 type checker (`typescript/unstable/sync`, which drives the bundled tsgo binary). The output is
// deterministic: definitions, properties, required lists, enum members and message variants are sorted, and nothing
// from the host (paths, time) is written, so the checked-in copy can be compared byte for byte.
//
//   node scripts/gen_protocol_schema.mjs           write docs/protocol/sidecar-v<N>.schema.json
//   node scripts/gen_protocol_schema.mjs --check   exit 1 when the checked-in schema or the version ledger is stale
//
// A type this file cannot express (a function-typed property, a tuple with optional or rest elements, a template literal, ...) is an error, never a
// silent `{}`: extend the generator deliberately. Only `any` and `unknown` become the open schema `{}`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, ElementFlags, SignatureKind, SymbolFlags, TypeFlags } from "typescript/unstable/sync";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(cli, "..");
const sourceDir = path.join(cli, "src") + path.sep;
const protocolSource = path.join(cli, "src", "protocol.ts");

export const LEDGER_FILE = path.join(repo, "docs", "protocol", "VERSIONS.json");
export const schemaFile = (version) => path.join(repo, "docs", "protocol", `sidecar-v${version}.schema.json`);
export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

class SchemaBuilder {
  constructor(checker) {
    this.checker = checker;
    this.defs = {};
    this.defOwners = new Map();
  }

  fail(type, where, why) {
    throw new Error(`gen_protocol_schema: ${where}: ${why} (${this.checker.typeToString(type)})`);
  }

  /** The symbol that names `type` when it is an alias, interface or class declared under cli/src; otherwise it is inlined. */
  nameOf(type) {
    const alias = type.getAliasSymbol();
    let symbol;
    if (alias) {
      // An instantiated generic alias (Pick<...>, Record<...>) has no single shape to publish under its name.
      if (type.getAliasTypeArguments().length) return undefined;
      symbol = alias;
    } else if (type.isClassOrInterface()) {
      if (type.getTypeParameters().length) return undefined;
      symbol = type.getSymbol();
    }
    const declared = symbol?.declarations[0]?.path;
    return declared && declared.startsWith(sourceDir) ? symbol : undefined;
  }

  schemaOf(type, where) {
    const symbol = this.nameOf(type);
    if (!symbol) return this.structureOf(type, where);
    const name = symbol.name;
    const owner = this.defOwners.get(name);
    if (owner === undefined) {
      this.defOwners.set(name, symbol.id);
      this.defs[name] = {}; // reserved first, so a self-referencing type terminates
      const description = symbol.getDocumentationComment(this.checker);
      this.defs[name] = { ...(description ? { description } : {}), ...this.structureOf(type, name) };
    } else if (owner !== symbol.id) {
      this.fail(type, where, `two different types are both named ${name}`);
    }
    return { $ref: `#/$defs/${name}` };
  }

  structureOf(type, where) {
    const flags = type.flags;
    if (flags & TypeFlags.AnyOrUnknown) return {};
    if (flags & TypeFlags.Boolean) return { type: "boolean" };
    if (flags & TypeFlags.String) return { type: "string" };
    if (flags & TypeFlags.Number) return { type: "number" };
    if (flags & TypeFlags.Null) return { type: "null" };
    if (flags & TypeFlags.EnumLike) this.fail(type, where, "enum types are not supported");
    if (flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BooleanLiteral)) return { const: type.value };
    if (type.isUnionType()) return this.unionOf(type, where);
    if (flags & (TypeFlags.Object | TypeFlags.Intersection)) return this.objectOf(type, where);
    return this.fail(type, where, "no JSON Schema form for this type");
  }

  unionOf(type, where) {
    const members = type.getTypes().filter((member) => !(member.flags & TypeFlags.Undefined));
    if (members.some((member) => member.flags & TypeFlags.Null)) {
      // getNonNullableType gives back the named type (`TurnReason`, not its members) that `| null | undefined` hid.
      const rest = this.checker.getNonNullableType(type);
      if (!rest || rest.flags & TypeFlags.Never) return { type: "null" };
      return { anyOf: [this.schemaOf(rest, where), { type: "null" }] };
    }
    if (members.length < type.getTypes().length) {
      const rest = this.checker.getNonNullableType(type);
      if (!rest || rest.flags & TypeFlags.Never) this.fail(type, where, "a property that is only ever undefined");
      return this.schemaOf(rest, where);
    }
    const literal = TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BooleanLiteral;
    const values = members.filter((member) => member.flags & literal).map((member) => member.value);
    const others = members.filter((member) => !(member.flags & literal)).map((member) => this.schemaOf(member, where));
    const alternatives = [];
    if (values.includes(true) && values.includes(false)) alternatives.push({ type: "boolean" });
    const constants = values.filter((value) => typeof value !== "boolean" || !(values.includes(true) && values.includes(false)));
    constants.sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b)));
    if (constants.length === 1) alternatives.push({ const: constants[0] });
    if (constants.length > 1) alternatives.push({ enum: constants });
    alternatives.push(...others);
    alternatives.sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b)));
    return alternatives.length === 1 ? alternatives[0] : { anyOf: alternatives };
  }

  objectOf(type, where) {
    const checker = this.checker;
    if (checker.isArrayType(type)) return { type: "array", items: this.schemaOf(checker.getTypeArguments(type)[0], `${where}[]`) };
    if (checker.isTupleType(type)) {
      const flags = type.getTarget().elementFlags;
      if (flags.some((flag) => flag !== ElementFlags.Required)) this.fail(type, where, "only tuples of required elements are supported");
      const prefixItems = checker.getTypeArguments(type).slice(0, flags.length).map((element, i) => this.schemaOf(element, `${where}[${i}]`));
      return { type: "array", prefixItems, minItems: flags.length, maxItems: flags.length };
    }
    if (checker.getSignaturesOfType(type, SignatureKind.Call).length || checker.getSignaturesOfType(type, SignatureKind.Construct).length) {
      this.fail(type, where, "a function cannot be sent on the wire");
    }
    const properties = {};
    const required = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const at = `${where}.${property.name}`;
      const propertyType = checker.getTypeOfSymbol(property);
      if (!propertyType) this.fail(type, at, "the checker returned no type for this property");
      const parts = propertyType.isUnionType() ? propertyType.getTypes() : [propertyType];
      const optional = Boolean(property.flags & SymbolFlags.Optional) || parts.some((part) => part.flags & TypeFlags.Undefined);
      const description = property.getDocumentationComment(checker);
      properties[property.name] = { ...(description ? { description } : {}), ...this.schemaOf(propertyType, at) };
      if (!optional) required.push(property.name);
    }
    const schema = { type: "object" };
    if (Object.keys(properties).length) schema.properties = sortKeys(properties);
    if (required.length) schema.required = required.sort(byText);
    const index = checker.getIndexInfosOfType(type);
    if (index.length > 1 || (index.length === 1 && !(index[0].keyType.flags & TypeFlags.String))) this.fail(type, where, "only a single string index signature is supported");
    // `additionalProperties` is written only for an index signature (the type of every other key). It is never `false`:
    // see docs/protocol/README.md.
    if (index.length === 1) schema.additionalProperties = this.schemaOf(index[0].valueType, `${where}[key]`);
    return schema;
  }

  /** One direction of the protocol: a `oneOf` over the message variants, each told apart by its constant `type`. */
  messageUnion(name, version, sourceAt) {
    const checker = this.checker;
    const symbol = checker.resolveName(name, SymbolFlags.TypeAlias, sourceAt);
    if (!symbol) throw new Error(`gen_protocol_schema: ${name} is not declared in src/protocol.ts`);
    const union = checker.getDeclaredTypeOfSymbol(symbol);
    if (union.isErrorType() || !union.isUnionType()) throw new Error(`gen_protocol_schema: ${name} is not a union of message types`);
    const variants = new Map();
    for (const member of union.getTypes()) {
      const tag = checker.getPropertyOfType(member, "type");
      const tagType = tag && checker.getTypeOfSymbol(tag);
      if (!tagType || !(tagType.flags & TypeFlags.StringLiteral)) this.fail(member, name, "a message variant needs a string-literal `type`");
      const type = tagType.value;
      if (variants.has(type)) this.fail(member, name, `two variants share the type ${type}`);
      const body = this.objectOf(member, `${name}<${type}>`);
      if ("v" in body.properties) this.fail(member, name, "`v` is the wire version field and cannot be a message field");
      body.properties = sortKeys({ ...body.properties, v: { const: version } });
      body.required = [...body.required, "v"].sort(byText);
      variants.set(type, { title: type, ...body });
    }
    const description = symbol.getDocumentationComment(checker);
    return { ...(description ? { description } : {}), oneOf: [...variants.keys()].sort(byText).map((type) => variants.get(type)) };
  }
}

function sortKeys(object) {
  return Object.fromEntries(Object.keys(object).sort(byText).map((key) => [key, object[key]]));
}

/** The schema text for the protocol as src/protocol.ts declares it now, and that protocol's version. */
export function generateProtocolSchema() {
  const api = new API({ cwd: cli });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [path.join(cli, "tsconfig.json")] });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error("gen_protocol_schema: cli/tsconfig.json did not load as a project");
    const checker = project.checker;
    const sourceAt = { document: protocolSource, position: 0 };
    const versionSymbol = checker.resolveName("PROTOCOL_VERSION", SymbolFlags.Value, sourceAt);
    const version = versionSymbol && checker.getTypeOfSymbol(versionSymbol)?.value;
    if (!Number.isInteger(version)) throw new Error("gen_protocol_schema: PROTOCOL_VERSION is not an integer literal in src/protocol.ts");

    const builder = new SchemaBuilder(checker);
    const messages = {
      SidecarCommand: { description: "Client to sidecar. One JSON object per line.", ...builder.messageUnion("SidecarCommand", version, sourceAt) },
      SidecarEvent: { description: "Sidecar to client. One JSON object per line.", ...builder.messageUnion("SidecarEvent", version, sourceAt) },
    };
    for (const name of Object.keys(messages)) {
      if (builder.defs[name]) throw new Error(`gen_protocol_schema: a protocol type is also named ${name}`);
    }
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `Nexus sidecar protocol v${version}`,
      description:
        "Generated from cli/src/protocol.ts by cli/scripts/gen_protocol_schema.mjs. Do not edit by hand. Every message is one line of JSON carrying `v`, the protocol version.",
      anyOf: [{ $ref: "#/$defs/SidecarEvent" }, { $ref: "#/$defs/SidecarCommand" }],
      $defs: sortKeys({ ...builder.defs, ...messages }),
    };
    return { version, text: `${JSON.stringify(schema, null, 2)}\n` };
  } finally {
    api.close();
  }
}

/**
 * The version-decision rule: the newest ledger entry must name the current protocol version and the hash of the
 * checked-in schema. Returns what is wrong, or undefined.
 */
export function ledgerProblem(schemaText, ledger, version) {
  if (!Array.isArray(ledger) || ledger.length === 0) return "the ledger has no entries";
  const last = ledger[ledger.length - 1];
  if (last.protocol !== version) return `the newest ledger entry is for protocol ${last.protocol}, but PROTOCOL_VERSION is ${version}`;
  const hash = sha256(schemaText);
  if (last.schemaSha256 !== hash) return `the newest ledger entry records schema ${last.schemaSha256}, but the schema is ${hash}: add an entry that records the version decision`;
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, text } = generateProtocolSchema();
  const file = schemaFile(version);
  const shown = path.relative(repo, file).split(path.sep).join("/");
  const ledgerShown = path.relative(repo, LEDGER_FILE).split(path.sep).join("/");
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (current !== text) {
      console.error(`${shown} is ${current === undefined ? "missing" : "out of date"}: run \`node cli/scripts/gen_protocol_schema.mjs\`, then record the version decision in ${ledgerShown}`);
      process.exit(1);
    }
    const problem = ledgerProblem(current, fs.existsSync(LEDGER_FILE) ? JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) : [], version);
    if (problem) {
      console.error(`${ledgerShown}: ${problem}`);
      process.exit(1);
    }
    console.log(`${shown} is current`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${shown} (sha256 ${sha256(text)})`);
  }
}
