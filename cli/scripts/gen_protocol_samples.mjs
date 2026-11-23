// Generates sample messages from the published protocol schema (docs/protocol/sidecar-v<N>.schema.json): for every
// event and every command, a MINIMAL sample (required fields only) and FULL samples (every optional field present).
// The Rust client's tests parse the event samples, so a message or field the TypeScript types gain and the Rust
// mirror lacks is a test failure, not something a reader has to notice (core/src/bin/nexus_tui/protocol.rs).
//
//   node scripts/gen_protocol_samples.mjs           write test/fixtures/protocol_v<N>_schema_samples.jsonl
//   node scripts/gen_protocol_samples.mjs --check   exit 1 when the checked-in samples are stale
//
// The input is the checked-in schema, so regenerate the schema first (scripts/gen_protocol_schema.mjs) after a type
// change. Values are fixed, never random: a string is "s", a number 1, a boolean true, an enum its first value, a
// constant itself, an array one element (none in a minimal sample), `T | null` is null in a minimal sample and T in a
// full one. Where a field is a union of several shapes (ApprovalReview), there is one full sample per shape.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(cli, "..");

export const schemaFile = (version) => path.join(repo, "docs", "protocol", `sidecar-v${version}.schema.json`);
export const samplesFile = (version) => path.join(cli, "test", "fixtures", `protocol_v${version}_schema_samples.jsonl`);

const DIRECTIONS = { event: "SidecarEvent", command: "SidecarCommand" };

class Sampler {
  /** `full`: include optional fields. `shape`: which alternative a union of several shapes takes (wraps round). */
  constructor(root, full, shape) {
    this.root = root;
    this.full = full;
    this.shape = shape;
    /** The most alternatives any union of shapes offered, so the caller knows how many full samples to make. */
    this.shapes = 1;
    this.open = [];
  }

  /** The sample for `schema`, or undefined when it is a type already being sampled (a self-referencing type). */
  sample(schema, where) {
    if (schema.$ref) {
      const name = schema.$ref.replace("#/$defs/", "");
      const target = this.root.$defs[name];
      if (!target) throw new Error(`gen_protocol_samples: ${where}: unresolved ${schema.$ref}`);
      if (this.open.includes(name)) return undefined;
      this.open.push(name);
      const value = this.sample(target, name);
      this.open.pop();
      return value;
    }
    if ("const" in schema) return schema.const;
    if (schema.enum) return schema.enum[0];
    if (schema.anyOf) {
      const shapes = schema.anyOf.filter((option) => option.type !== "null");
      if (shapes.length < schema.anyOf.length && !this.full) return null;
      this.shapes = Math.max(this.shapes, shapes.length);
      return this.sample(shapes[this.shape % shapes.length], where);
    }
    switch (schema.type) {
      case "string":
        return "s";
      case "number":
        return 1;
      case "boolean":
        return true;
      case "null":
        return null;
      case "array":
        return this.array(schema, where);
      case "object":
        return this.object(schema, where);
      case undefined:
        // The open schema (`any` / `unknown` in the types): any JSON value is valid.
        if (Object.keys(schema).every((key) => key === "description")) return {};
    }
    throw new Error(`gen_protocol_samples: ${where}: no sample rule for ${JSON.stringify(schema).slice(0, 120)}`);
  }

  required(schema, where) {
    const value = this.sample(schema, where);
    if (value === undefined) throw new Error(`gen_protocol_samples: ${where}: a required value refers back to its own type`);
    return value;
  }

  array(schema, where) {
    if (schema.prefixItems) return schema.prefixItems.map((item, i) => this.required(item, `${where}[${i}]`));
    if (!this.full || !schema.items) return [];
    const item = this.sample(schema.items, `${where}[]`);
    return item === undefined ? [] : [item];
  }

  object(schema, where) {
    const out = {};
    const required = new Set(schema.required ?? []);
    for (const [name, member] of Object.entries(schema.properties ?? {})) {
      if (required.has(name)) out[name] = this.required(member, `${where}.${name}`);
      else if (this.full) {
        const value = this.sample(member, `${where}.${name}`);
        if (value !== undefined) out[name] = value;
      }
    }
    if (this.full && typeof schema.additionalProperties === "object") {
      const value = this.sample(schema.additionalProperties, `${where}[key]`);
      if (value !== undefined) out.key = value;
    }
    return out;
  }
}

/** Every sample for the schema, in a fixed order: events then commands, each by type, minimal before full. */
export function generateSamples(schema) {
  const records = [];
  for (const [direction, def] of Object.entries(DIRECTIONS)) {
    for (const variant of schema.$defs[def].oneOf) {
      const name = variant.properties.type.const;
      const add = (shape, sampler) => {
        const json = JSON.stringify(sampler.object(variant, `${def}<${name}>`));
        records.push({ direction, name, shape, json });
        return sampler.shapes;
      };
      add("minimal", new Sampler(schema, false, 0));
      const shapes = add("full", new Sampler(schema, true, 0));
      for (let shape = 1; shape < shapes; shape += 1) add("full", new Sampler(schema, true, shape));
    }
  }
  return records;
}

export function samplesText(schema) {
  return generateSamples(schema).map((record) => `${JSON.stringify(record)}\n`).join("");
}

/** The protocol version, read from the schema's own `v` constant. */
export function schemaVersion(schema) {
  return schema.$defs.SidecarEvent.oneOf[0].properties.v.const;
}

/** The newest checked-in schema: the highest N of docs/protocol/sidecar-v<N>.schema.json. */
export function currentSchema() {
  const versions = fs.readdirSync(path.join(repo, "docs", "protocol")).map((file) => /^sidecar-v(\d+)\.schema\.json$/.exec(file)?.[1]).filter(Boolean).map(Number);
  if (!versions.length) throw new Error("gen_protocol_samples: no docs/protocol/sidecar-v<N>.schema.json; run scripts/gen_protocol_schema.mjs first");
  return JSON.parse(fs.readFileSync(schemaFile(Math.max(...versions)), "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const schema = currentSchema();
  const file = samplesFile(schemaVersion(schema));
  const shown = path.relative(repo, file).split(path.sep).join("/");
  const text = samplesText(schema);
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (current !== text) {
      console.error(`${shown} is ${current === undefined ? "missing" : "out of date"}: run \`node cli/scripts/gen_protocol_samples.mjs\``);
      process.exit(1);
    }
    console.log(`${shown} is current`);
  } else {
    fs.writeFileSync(file, text);
    console.log(`wrote ${shown} (${text.split("\n").length - 1} samples)`);
  }
}
