# Sidecar protocol schema

The protocol reference for client authors is [`../PROTOCOL.md`](../PROTOCOL.md): transport, negotiation, every command and event, error codes and compatibility rules. This page is about the schema file and how it is kept current.

`sidecar-v1.schema.json` is the JSON Schema (draft 2020-12) of the Nexus sidecar protocol, version 1: the newline-delimited JSON a client exchanges with the Node sidecar. `$defs.SidecarEvent` is every message the sidecar sends, `$defs.SidecarCommand` every message a client sends. Each is a `oneOf` over the message variants, told apart by the constant `type`; every message also carries `v`, the protocol version.

The file is generated from the types in `cli/src/protocol.ts` by the TypeScript type checker. Do not edit it by hand: change the types, then regenerate.

```bash
cd cli
node scripts/gen_protocol_schema.mjs           # rewrite docs/protocol/sidecar-v1.schema.json
node scripts/gen_protocol_schema.mjs --check   # exit 1 when the schema or the ledger is stale
```

`cli/test/protocol_schema.test.ts` runs the same comparison, so CI fails when a protocol type changes and the schema does not.

## Recording a version decision

`VERSIONS.json` is the version ledger: entries `{ "protocol", "schemaSha256", "note" }`, newest last. The newest entry must carry the SHA-256 of the checked-in schema and the current `PROTOCOL_VERSION`. A type change therefore needs two things: a regenerated schema and a new ledger entry whose `note` states the decision, either the same version because the change is additive and compatible (a new optional field, a new message an older peer ignores), or a bumped `PROTOCOL_VERSION`. Append entries; leave earlier ones as they are.

## Extra properties are allowed

No object in the schema sets `additionalProperties: false`. A newer sidecar may add an optional field to an event, and an older client must ignore it, so a schema that forbade unknown fields would reject messages the protocol means to accept. Commands are open for the same reason in the other direction: `parseCommand` reads the fields it knows and drops the rest. The schema checks what is required and the type of every field it names. `additionalProperties` appears only where a type has an index signature, where it gives the type of every value.

A tuple (`ReceiptRow`) is the exception: its length is fixed, as in the type.

## What the generator does with each type

- An interface or type alias declared under `cli/src` is written once under `$defs` and referenced with `$ref`. An instantiated generic (`Pick<SlashSpec, ...>`) and an intersection that forms a message (`models.catalog`) are written out in place.
- A union of string literals is an `enum`; `T | null` is `anyOf` with `{"type": "null"}`; an optional property is left out of `required`.
- JSDoc comments on types and properties become `description`.
- Definitions, properties, `required` lists, enum values and variants are sorted, so the output is the same on every run.
- A type with no JSON form (a function, an enum, a tuple with optional elements) stops the generator with an error naming the property.

## Samples and recordings derived from the schema

- `cli/test/fixtures/protocol_v1_schema_samples.jsonl` holds a minimal and a full sample of every message, generated from the schema by `node cli/scripts/gen_protocol_samples.mjs` (`--check` exits 1 when it is stale). The Rust client's tests parse the event samples, so regenerate it after regenerating the schema.
- `cli/test/fixtures/protocol_v1_rust_commands.jsonl` holds the lines the Rust client serializes. A Rust test keeps it equal to the client's output (`NEXUS_UPDATE_PROTOCOL_FIXTURES=1 cargo test --bin nexus-tui rust_commands` rewrites it); `cli/test/protocol_parity.test.ts` validates it against the schema.
- `cli/test/fixtures/wire/*.json` are recorded sessions replayed against the real sidecar by `cli/test/protocol_wire.test.ts`. `NEXUS_WIRE_RECORD=1` on that test rewrites them from the sidecar's real output; `cli/test/helpers/wire_fixture.ts` documents the format.
