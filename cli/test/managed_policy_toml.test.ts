/**
 * GV-1: the strict TOML-subset parser of managed policy files (src/core/managed_policy_toml.ts): what it accepts, what
 * it rejects (with the line and a message), its bounds, a render-then-parse round trip over generated documents, and a
 * mutation loop showing that it throws nothing but `PolicyParseError` and always returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePolicyToml, PolicyParseError, POLICY_TOML_LIMITS, renderPolicyTomlString, type PolicyParseCode, type PolicyTomlDocument } from "../src/core/managed_policy_toml.js";
import { randomDocument, renderPolicyToml, seeded, type Loose } from "./helpers/policy_fixture.js";

/** The parsed document as plain data, with the line of each key. */
function plain(document: PolicyTomlDocument): { root: Record<string, [unknown, number]>; tables: Record<string, Record<string, [unknown, number]>> } {
  const entries = (map: PolicyTomlDocument["root"]) => Object.fromEntries([...map].map(([key, entry]) => [key, [entry.value, entry.line] as [unknown, number]]));
  return { root: entries(document.root), tables: Object.fromEntries([...document.tables].map(([name, table]) => [name, entries(table.entries)])) };
}

const ACCEPTED: { name: string; text: string; root?: Record<string, [unknown, number]>; tables?: Record<string, Record<string, [unknown, number]>> }[] = [
  { name: "an empty file", text: "" },
  { name: "only blank lines", text: "\n\n  \n\t\n" },
  { name: "only comments", text: "# one\n  # two\n#" },
  { name: "a root integer", text: "schema_version = 1\n", root: { schema_version: [1, 1] } },
  { name: "no final line end", text: "schema_version = 1", root: { schema_version: [1, 1] } },
  { name: "zero", text: "n = 0", root: { n: [0, 1] } },
  { name: "the largest safe integer", text: "n = 9007199254740991", root: { n: [9007199254740991, 1] } },
  { name: "CRLF line ends", text: "a = 1\r\nb = true\r\n", root: { a: [1, 1], b: [true, 2] } },
  { name: "booleans", text: "a = true\nb = false", root: { a: [true, 1], b: [false, 2] } },
  { name: "a string", text: 'a = "git push"', root: { a: ["git push", 1] } },
  { name: "an empty string", text: 'a = ""', root: { a: ["", 1] } },
  { name: "the two escapes", text: 'a = "say \\"hi\\" \\\\ there"', root: { a: ['say "hi" \\ there', 1] } },
  { name: "a # inside a string is not a comment", text: 'a = "x # y" # real comment', root: { a: ["x # y", 1] } },
  { name: "non-ASCII text in a string and a comment", text: 'a = "Zürich 東京 🚀" # naïve', root: { a: ["Zürich 東京 🚀", 1] } },
  { name: "a tab inside a string and around the equals sign", text: 'a\t=\t"x\ty"', root: { a: ["x\ty", 1] } },
  { name: "no spaces around the equals sign", text: "a=1", root: { a: [1, 1] } },
  { name: "indented keys", text: "   a = 1\n\tb = 2", root: { a: [1, 1], b: [2, 2] } },
  { name: "a trailing comment after each kind of value", text: 'a = 1 # x\nb = true# y\nc = "s"\t# z\nd = [] # w', root: { a: [1, 1], b: [true, 2], c: ["s", 3], d: [[], 4] } },
  { name: "an empty array", text: "a = []", root: { a: [[], 1] } },
  { name: "an array on one line", text: 'a = ["x", "y"]', root: { a: [["x", "y"], 1] } },
  { name: "an array with a trailing comma", text: 'a = ["x", "y",]', root: { a: [["x", "y"], 1] } },
  { name: "an array over several lines with comments", text: 'a = [ # start\n  "x", # first\n\n  # alone\n  "y"\n  ,\n]\nb = 1', root: { a: [["x", "y"], 1], b: [1, 8] } },
  { name: "a table", text: "[approval]\nstrict = true", tables: { approval: { strict: [true, 2] } } },
  { name: "a table header with spaces and a comment", text: "[ approval ]  # who\nstrict = true", tables: { approval: { strict: [true, 2] } } },
  { name: "an empty table", text: "[approval]\n", tables: { approval: {} } },
  { name: "root keys, then two tables", text: "v = 1\n\n[a]\nx = 1\n[b]\nx = 2\ny = [\"z\"]", root: { v: [1, 1] }, tables: { a: { x: [1, 4] }, b: { x: [2, 6], y: [["z"], 7] } } },
  { name: "the same key in two tables", text: "[a]\nk = 1\n[b]\nk = 1", tables: { a: { k: [1, 2] }, b: { k: [1, 4] } } },
  { name: "names that are object members elsewhere", text: "constructor = 1\n[to_string]\nvalue_of = 2", root: { constructor: [1, 1] }, tables: { to_string: { value_of: [2, 3] } } },
  { name: "keys with digits and underscores", text: "a1_b2 = 1", root: { a1_b2: [1, 1] } },
];

for (const { name, text, root, tables } of ACCEPTED) {
  test(`accepted: ${name}`, () => {
    assert.deepEqual(plain(parsePolicyToml(text)), { root: root ?? {}, tables: tables ?? {} });
  });
}

test("an array records the line of each item", () => {
  const entry = parsePolicyToml('a = [\n "x",\n\n "y", "z"\n]').root.get("a")!;
  assert.deepEqual([entry.line, entry.itemLines], [1, [2, 4, 4]]);
});

const REJECTED: { name: string; text: string; line: number; code: PolicyParseCode; message: RegExp }[] = [
  // strings
  { name: "a literal string", text: "a = 'x'", line: 1, code: "unsupported", message: /literal strings \('\.\.\.'\) are not supported; use a basic string/ },
  { name: "a multi-line basic string", text: 'a = """x\ny"""', line: 1, code: "unsupported", message: /multi-line strings \("""\) are not supported/ },
  { name: "a multi-line literal string", text: "a = '''x'''", line: 1, code: "unsupported", message: /literal strings/ },
  { name: "an unterminated string", text: 'x = 1\na = "abc', line: 2, code: "syntax", message: /unterminated string/ },
  { name: "a string broken over two lines", text: 'a = "abc\ndef"', line: 1, code: "syntax", message: /unterminated string/ },
  { name: "the escape \\n", text: 'a = "x\\ny"', line: 1, code: "unsupported", message: /unsupported escape '\\n' in a string; only \\" and \\\\ are accepted/ },
  { name: "the escape \\t", text: 'a = "x\\ty"', line: 1, code: "unsupported", message: /unsupported escape '\\t'/ },
  { name: "a unicode escape", text: 'a = "\\u00e9"', line: 1, code: "unsupported", message: /unsupported escape '\\u'/ },
  { name: "a backslash at the end of the line", text: 'a = "x\\', line: 1, code: "unsupported", message: /unsupported escape/ },
  { name: "text after a string", text: 'a = "x" "y"', line: 1, code: "syntax", message: /unexpected text after the value \('"y"'\); only a # comment may follow/ },
  // numbers
  { name: "a float", text: "\na = 1.5", line: 2, code: "unsupported", message: /floats are not supported \('1\.5'\)/ },
  { name: "an exponent", text: "a = 1e3", line: 1, code: "unsupported", message: /floats are not supported/ },
  { name: "inf", text: "a = inf", line: 1, code: "unsupported", message: /floats \(inf, nan\) are not supported/ },
  { name: "nan with a sign", text: "a = -nan", line: 1, code: "unsupported", message: /floats \(inf, nan\)/ },
  { name: "a plus sign", text: "a = +1", line: 1, code: "unsupported", message: /signed numbers are not supported \('\+1'\)/ },
  { name: "a negative number", text: "a = -1", line: 1, code: "unsupported", message: /signed numbers are not supported/ },
  { name: "hexadecimal", text: "a = 0x1F", line: 1, code: "unsupported", message: /hexadecimal, octal and binary numbers are not supported/ },
  { name: "octal", text: "a = 0o17", line: 1, code: "unsupported", message: /hexadecimal, octal and binary/ },
  { name: "binary", text: "a = 0b11", line: 1, code: "unsupported", message: /hexadecimal, octal and binary/ },
  { name: "a digit separator", text: "a = 1_000", line: 1, code: "unsupported", message: /digit separators are not supported/ },
  { name: "a leading zero", text: "a = 01", line: 1, code: "unsupported", message: /a number may not start with a zero/ },
  { name: "a number above the safe range", text: "a = 9007199254740992", line: 1, code: "unsupported", message: /is too large/ },
  { name: "a date", text: "a = 2026-11-22", line: 1, code: "unsupported", message: /dates and times are not supported/ },
  { name: "a date-time", text: "a = 2026-11-22T10:00:00Z", line: 1, code: "unsupported", message: /dates and times/ },
  { name: "a time", text: "a = 10:30:00", line: 1, code: "unsupported", message: /dates and times/ },
  // other values
  { name: "True", text: "a = True", line: 1, code: "syntax", message: /unsupported value 'True': expected a "string", true, false, a whole number or an array of strings/ },
  { name: "yes", text: "a = yes", line: 1, code: "syntax", message: /unsupported value 'yes'/ },
  { name: "a bare word", text: "a = block", line: 1, code: "syntax", message: /unsupported value 'block'/ },
  { name: "a missing value", text: "a =", line: 1, code: "syntax", message: /missing value after 'a ='/ },
  { name: "a missing value before a comment", text: "a = # nothing", line: 1, code: "syntax", message: /unsupported value starting with '#'/ },
  { name: "an inline table", text: "a = { b = 1 }", line: 1, code: "unsupported", message: /inline tables are not supported; use a \[table\] header/ },
  { name: "text after a number", text: "a = 1 2", line: 1, code: "syntax", message: /unexpected text after the value/ },
  { name: "text after a boolean", text: "a = true, false", line: 1, code: "syntax", message: /unexpected text after the value/ },
  { name: "two keys on one line", text: "a = 1 b = 2", line: 1, code: "syntax", message: /only a # comment may follow/ },
  // arrays
  { name: "an array of numbers", text: "a = [1, 2]", line: 1, code: "unsupported", message: /an array may hold only strings/ },
  { name: "an array of booleans", text: "a = [true]", line: 1, code: "unsupported", message: /an array may hold only strings/ },
  { name: "a mixed array", text: 'a = ["x", 1]', line: 1, code: "unsupported", message: /an array may hold only strings/ },
  { name: "a nested array", text: 'a = [["x"]]', line: 1, code: "unsupported", message: /nested arrays are not supported/ },
  { name: "an inline table in an array", text: "a = [{ b = 1 }]", line: 1, code: "unsupported", message: /inline tables are not supported/ },
  { name: "a literal string in an array", text: "a = [\n  'x'\n]", line: 2, code: "unsupported", message: /literal strings/ },
  { name: "a multi-line string in an array", text: 'a = ["""x"""]', line: 1, code: "unsupported", message: /multi-line strings/ },
  { name: "an unterminated array", text: 'x = 1\na = ["x",\n"y"\n', line: 4, code: "syntax", message: /unterminated array: no closing '\]' for the array opened on line 2/ },
  { name: "an array missing a comma", text: 'a = [\n"x"\n"y"]', line: 3, code: "syntax", message: /expected ',' or '\]' after an array item/ },
  { name: "an array starting with a comma", text: 'a = [, "x"]', line: 1, code: "syntax", message: /unexpected ',' in an array/ },
  { name: "an array with two commas", text: 'a = ["x",, "y"]', line: 1, code: "syntax", message: /unexpected ',' in an array/ },
  { name: "text after an array", text: 'a = ["x"] "y"', line: 1, code: "syntax", message: /unexpected text after the value/ },
  // keys
  { name: "a duplicate root key", text: "a = 1\nb = 2\na = 3", line: 3, code: "duplicate_key", message: /duplicate key 'a' \(first set on line 1\)/ },
  { name: "a duplicate key in a table", text: "[approval]\nstrict = true\n\nstrict = false", line: 4, code: "duplicate_key", message: /duplicate key 'approval\.strict' \(first set on line 2\); a key may be set once/ },
  { name: "a dotted key", text: "approval.strict = true", line: 1, code: "unsupported", message: /dotted keys are not supported; put the key under a \[table\] header/ },
  { name: "a quoted key", text: '"strict" = true', line: 1, code: "unsupported", message: /quoted keys are not supported/ },
  { name: "a literal-quoted key", text: "'strict' = true", line: 1, code: "unsupported", message: /quoted keys are not supported/ },
  { name: "an uppercase key", text: "Strict = true", line: 1, code: "syntax", message: /invalid key 'Strict': use lowercase letters, digits and '_', starting with a letter/ },
  { name: "a key with a dash", text: "disable-auto = true", line: 1, code: "syntax", message: /invalid key 'disable-auto'/ },
  { name: "a key starting with a digit", text: "1a = true", line: 1, code: "syntax", message: /invalid key '1a'/ },
  { name: "a key starting with an underscore", text: "__proto__ = 1", line: 1, code: "syntax", message: /invalid key '__proto__'/ },
  { name: "a key without a value", text: "strict", line: 1, code: "syntax", message: /expected '=' after the key 'strict'/ },
  { name: "a colon instead of the equals sign", text: "strict: true", line: 1, code: "syntax", message: /expected '=' after the key 'strict'/ },
  { name: "a line starting with the equals sign", text: "= 1", line: 1, code: "syntax", message: /expected a key, found '='/ },
  { name: "JSON", text: '{ "schema_version": 1 }', line: 1, code: "syntax", message: /expected a key, found '\{'/ },
  // tables
  { name: "a duplicate table", text: "[a]\nx = 1\n[b]\n[a]", line: 4, code: "duplicate_table", message: /duplicate table '\[a\]' \(first defined on line 1\); merge the two into one/ },
  { name: "a table named like a root key", text: "a = 1\n[a]", line: 2, code: "duplicate_table", message: /table '\[a\]' has the name of a key set on line 1/ },
  { name: "an array of tables", text: "[[servers]]", line: 1, code: "unsupported", message: /arrays of tables \(\[\[\.\.\.\]\]\) are not supported/ },
  { name: "a dotted table", text: "[approval.rules]", line: 1, code: "unsupported", message: /dotted table names \(nested tables\) are not supported/ },
  { name: "a quoted table name", text: '["approval"]', line: 1, code: "unsupported", message: /quoted table names are not supported/ },
  { name: "an unclosed table header", text: "\n\n[approval\nstrict = true", line: 3, code: "syntax", message: /expected '\]' to close the table header '\[approval'/ },
  { name: "an empty table header", text: "[]", line: 1, code: "syntax", message: /expected a table name, found '\]'/ },
  { name: "an uppercase table name", text: "[Approval]", line: 1, code: "syntax", message: /invalid table name 'Approval'/ },
  { name: "text after a table header", text: "[approval] strict = true", line: 1, code: "syntax", message: /unexpected text after the table header/ },
  // characters
  { name: "a byte-order mark", text: "\ufeffa = 1", line: 1, code: "bom", message: /byte-order mark; save it as UTF-8 without a BOM/ },
  { name: "a NUL character", text: "a = 1\nb = \u0000", line: 2, code: "control_character", message: /control character U\+0000; only tab is allowed/ },
  { name: "a control character in a string", text: 'a = "x\u0007y"', line: 1, code: "control_character", message: /control character U\+0007/ },
  { name: "a control character in a comment", text: "# bell \u0007", line: 1, code: "control_character", message: /U\+0007/ },
  { name: "a form feed", text: "a = 1\n\n\f", line: 3, code: "control_character", message: /U\+000C/ },
  { name: "DEL", text: "a = 1 \u007f", line: 1, code: "control_character", message: /U\+007F/ },
  { name: "a bare carriage return", text: "a = 1\rb = 2", line: 1, code: "control_character", message: /a carriage return that is not part of a CRLF line end/ },
  { name: "an unpaired surrogate", text: 'a = 1\na = "\ud800"', line: 2, code: "invalid_unicode", message: /not valid Unicode/ },
];

for (const { name, text, line, code, message } of REJECTED) {
  test(`rejected: ${name}`, () => {
    assert.throws(
      () => parsePolicyToml(text),
      (error: unknown) => {
        assert.ok(error instanceof PolicyParseError, `threw ${String(error)}`);
        assert.equal(error.code, code);
        assert.equal(error.line, line);
        assert.match(error.detail, message);
        assert.equal(error.message, `line ${line}: ${error.detail}`);
        assert.ok(!error.detail.endsWith("."), "the caller adds the full stop");
        return true;
      },
    );
  });
}

test("the corpora are the size the plan asks for", () => {
  assert.ok(ACCEPTED.length >= 25, `${ACCEPTED.length} accepted documents`);
  assert.ok(REJECTED.length >= 60, `${REJECTED.length} rejected documents`);
});

test("each bound has its own error, and the largest allowed size is accepted", () => {
  const code = (text: string): PolicyParseCode | undefined => {
    try {
      parsePolicyToml(text);
      return undefined;
    } catch (error) {
      assert.ok(error instanceof PolicyParseError);
      return error.code;
    }
  };
  const string = (n: number): string => `a = "${"x".repeat(n)}"`;
  assert.equal(code(string(POLICY_TOML_LIMITS.stringChars)), undefined);
  assert.equal(code(string(POLICY_TOML_LIMITS.stringChars + 1)), "string_too_long");
  assert.equal(code(`a = ["ok", "${"x".repeat(POLICY_TOML_LIMITS.stringChars + 1)}"]`), "string_too_long");

  const array = (n: number): string => `a = [${Array.from({ length: n }, () => '"x"').join(",")}]`;
  assert.equal(code(array(POLICY_TOML_LIMITS.arrayItems)), undefined);
  assert.equal(code(array(POLICY_TOML_LIMITS.arrayItems + 1)), "array_too_long");

  const file = (bytes: number): string => `# ${"c".repeat(bytes - 2)}`;
  assert.equal(code(file(POLICY_TOML_LIMITS.fileBytes)), undefined);
  assert.equal(code(file(POLICY_TOML_LIMITS.fileBytes + 1)), "file_too_large");
  // The bound is in bytes: 30,000 three-byte characters are fewer than 64 KiB of code units and more than 64 KiB of UTF-8.
  assert.equal(code(`# ${"東".repeat(30_000)}`), "file_too_large");
  assert.equal(code(`# ${"東".repeat(20_000)}`), undefined);

  assert.throws(() => parsePolicyToml(undefined as unknown as string), PolicyParseError);
  assert.throws(() => parsePolicyToml(Buffer.from("a = 1") as unknown as string), PolicyParseError);
});

test("a long token is shortened in the message", () => {
  assert.throws(() => parsePolicyToml(`a = ${"z".repeat(5000)}`), (error: unknown) => error instanceof PolicyParseError && error.detail.length < 200);
});

const ROUND_TRIPS = 400;

test(`render then parse gives back the document, for ${ROUND_TRIPS} generated documents in varying layouts`, () => {
  const random = seeded(0x51ce);
  const tricky = ['say "hi"', "back\\slash", "# not a comment", "tab\there", "ünï 東京 🚀", "", " spaced ", "]", "[", ",", "'single'", 'ends with \\', '\\"'];
  for (let i = 0; i < ROUND_TRIPS; i++) {
    const document = randomDocument(random) as Loose;
    // Strings the schema would not accept, which the parser must still carry exactly.
    if (random() < 0.5) document.extra = { text: tricky[Math.floor(random() * tricky.length)], list: tricky.filter(() => random() < 0.3) };
    const text = renderPolicyToml(document, { random });
    const parsed = plain(parsePolicyToml(text));
    assert.deepEqual(parsed.root, { schema_version: [1, parsed.root.schema_version[1]] }, text);
    const values = Object.fromEntries(Object.entries(parsed.tables).map(([name, keys]) => [name, Object.fromEntries(Object.entries(keys).map(([key, [value]]) => [key, value]))]));
    assert.deepEqual(values, document, text);
  }
  for (const value of tricky) assert.equal(parsePolicyToml(`a = ${renderPolicyTomlString(value)}`).root.get("a")!.value, value);
});

const MUTATIONS = 6000;

test(`${MUTATIONS} mutated inputs: the parser returns a document or throws PolicyParseError, nothing else`, () => {
  const random = seeded(0xf022);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const seeds = [...ACCEPTED.map((c) => c.text), ...REJECTED.map((c) => c.text), ...Array.from({ length: 20 }, () => renderPolicyToml(randomDocument(random), { random }))];
  const fragments = ['"', "'", "[", "]", "[[", "]]", "{", "}", "=", ",", ".", "#", "\n", "\r", "\r\n", "\\", '"""', "\t", " ", "\u0000", "\ufeff", "\ud800", "true", "1e9", "-", "é", "[a]\n", 'k = "v"\n', "\\u0041"];
  let parsed = 0;
  let refused = 0;
  for (let i = 0; i < MUTATIONS; i++) {
    let text = pick(seeds);
    for (let edits = 1 + Math.floor(random() * 4); edits > 0; edits--) {
      const at = Math.floor(random() * (text.length + 1));
      const kind = random();
      if (kind < 0.35) text = text.slice(0, at) + pick(fragments) + text.slice(at);
      else if (kind < 0.6) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(random() * 3));
      else if (kind < 0.75) text = text.slice(0, at) + String.fromCharCode(Math.floor(random() * 0x250)) + text.slice(at + 1);
      else if (kind < 0.9) text = text.slice(0, at);
      else text = text + pick(seeds);
    }
    try {
      const document = parsePolicyToml(text);
      assert.ok(document.root instanceof Map && document.tables instanceof Map);
      parsed++;
    } catch (error) {
      if (!(error instanceof PolicyParseError)) assert.fail(`threw ${String(error)} for ${JSON.stringify(text)}`);
      assert.ok(Number.isInteger(error.line) && error.line >= 1 && error.line <= text.split("\n").length, `line ${error.line} for ${JSON.stringify(text)}`);
      refused++;
    }
  }
  // Both outcomes occur, so the loop is not vacuous.
  assert.ok(parsed > 100 && refused > 100, `${parsed} parsed, ${refused} refused`);
});
