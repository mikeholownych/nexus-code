const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLine } = require("../csv.js");

test("plain fields", () => assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]));
test("quoted field with a comma", () => assert.deepEqual(parseLine('x,"hello, world",y'), ["x", "hello, world", "y"]));
