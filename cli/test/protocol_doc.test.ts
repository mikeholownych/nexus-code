import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_CLIENT_FIELD, MAX_PASTE, MAX_PROTOCOL_NUMBER, MAX_SLASH_OUTPUT, MAX_SUMMARY, MAX_TEXT_FIELD, PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION, SIDECAR_CAPABILITIES } from "../src/protocol.js";
import { schemaFile } from "../scripts/gen_protocol_samples.mjs";
import { loadRecording } from "./helpers/wire_fixture.js";
import type { Schema } from "./helpers/json_schema.js";

// docs/PROTOCOL.md is the reference a client author reads. Its tables are checked against the schema and the code, so
// a message, error code or capability cannot be added, removed or change its required fields without the page.
const doc = fs.readFileSync(fileURLToPath(new URL("../../docs/PROTOCOL.md", import.meta.url)), "utf8");
const schema: Schema = JSON.parse(fs.readFileSync(schemaFile(PROTOCOL_VERSION), "utf8"));

/** The rows of the table under `## <heading>`: the first cell's name (written as code), and the other cells. */
function table(heading: string): Array<{ name: string; cells: string[] }> {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `docs/PROTOCOL.md has a "## ${heading}" section`);
  const end = doc.indexOf("\n## ", start + 1);
  const rows = doc.slice(start, end < 0 ? undefined : end).split("\n").filter((line) => line.startsWith("| `"));
  return rows.map((row) => {
    const [first, ...cells] = row.slice(1, -1).split(" | ").map((cell) => cell.trim());
    const name = /^`([^`]+)`$/.exec(first)?.[1];
    assert.ok(name, `the first cell is one name written as code: ${row}`);
    return { name, cells };
  });
}

const codeNames = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

for (const [heading, def] of [["Commands", "SidecarCommand"], ["Events", "SidecarEvent"]] as const) {
  test(`the ${heading} table lists exactly the schema's message types, each with its required fields`, () => {
    const rows = table(heading);
    const variants: Schema[] = schema.$defs[def].oneOf;
    assert.deepEqual(rows.map((row) => row.name).sort(), variants.map((variant) => variant.properties.type.const).sort());
    for (const variant of variants) {
      const row = rows.find((candidate) => candidate.name === variant.properties.type.const)!;
      const required = variant.required.filter((field: string) => field !== "v" && field !== "type");
      assert.deepEqual(row.cells[0] === "none" ? [] : codeNames(row.cells[0]), required, `${heading}: required fields of ${row.name}`);
      assert.ok(row.cells[1].length > 20, `${heading}: ${row.name} has a meaning`);
      // Fields a row names after "Optional:" are fields of the message, and not required ones.
      const optional = /\bOptional(?: \([^)]*\))?: (.*)$/.exec(row.cells[1])?.[1];
      for (const field of optional ? codeNames(optional) : []) {
        assert.ok(Object.hasOwn(variant.properties, field) && !required.includes(field), `${heading}: ${row.name} has no optional field ${field}`);
      }
    }
  });
}

test("the error-code and capability tables list exactly what the code defines", () => {
  assert.deepEqual(table("Error codes").map((row) => row.name).sort(), [...schema.$defs.ErrorCode.enum].sort());
  assert.deepEqual(table("Capabilities").map((row) => row.name), [...SIDECAR_CAPABILITIES]);
});

test("the numbers the page states are the constants in the code", () => {
  const grouped = (value: number) => value.toLocaleString("en-US");
  assert.ok(doc.includes(`The protocol is version ${PROTOCOL_VERSION}.`));
  assert.ok(doc.includes(`\`PROTOCOL_VERSION\` (${PROTOCOL_VERSION})`));
  assert.ok(doc.includes(`Today the range is ${PROTOCOL_MIN} to ${PROTOCOL_MAX}.`));
  assert.ok(doc.includes(`protocol/sidecar-v${PROTOCOL_VERSION}.schema.json`));
  assert.ok(doc.includes(`| ${grouped(MAX_TEXT_FIELD)} (\`MAX_TEXT_FIELD\`) |`));
  assert.ok(doc.includes(`| ${grouped(MAX_SLASH_OUTPUT)} (\`MAX_SLASH_OUTPUT\`) |`));
  assert.ok(doc.includes(`| ${grouped(MAX_PASTE)} (\`MAX_PASTE\`) |`));
  assert.ok(doc.includes(`| ${grouped(MAX_SUMMARY)} (\`MAX_SUMMARY\`) |`));
  assert.ok(doc.includes(`of at most ${grouped(MAX_CLIENT_FIELD)} characters and version bounds from 1 to ${grouped(MAX_PROTOCOL_NUMBER)}`));
});

test("the worked example is the recorded session, line for line", () => {
  const marker = "<!-- example: turn -->\n```text\n";
  const start = doc.indexOf(marker);
  assert.ok(start >= 0, "the example block follows its marker");
  const shown = doc.slice(start + marker.length, doc.indexOf("\n```", start + marker.length));
  // The connect step and the prompt step of the recording that test/protocol_wire.test.ts replays.
  const expected = loadRecording("turn").steps.slice(0, 2).flatMap((step) => [
    ...(step.send ? [`C: ${JSON.stringify(step.send)}`] : []),
    ...step.expect.map((event) => `S: ${JSON.stringify(event)}`),
  ]);
  assert.equal(shown, expected.join("\n"), "docs/PROTOCOL.md: replace the example block with the lines of cli/test/fixtures/wire/turn.json (steps 1 and 2)");
});

test("the page states the limits of what exists and is linked from the schema README", () => {
  for (const absent of ["No socket or network transport", "No library entry point", "No Agent Client Protocol"]) assert.ok(doc.includes(absent), absent);
  const readme = fs.readFileSync(fileURLToPath(new URL("../../docs/protocol/README.md", import.meta.url)), "utf8");
  assert.ok(readme.includes("(../PROTOCOL.md)"));
  // Every relative link on the page resolves.
  for (const [, target] of doc.matchAll(/\]\(([^)#]+)\)/g)) {
    if (/^[a-z]+:/.test(target)) continue;
    assert.ok(fs.existsSync(fileURLToPath(new URL(`../../docs/${target}`, import.meta.url))), `link target ${target}`);
  }
});
