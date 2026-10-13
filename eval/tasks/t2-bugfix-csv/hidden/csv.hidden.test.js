const assert = require("node:assert/strict");
const { parseLine } = require("../csv.js");
assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
assert.deepEqual(parseLine('x,"hello, world",y'), ["x", "hello, world", "y"]);
assert.deepEqual(parseLine('"say ""hi""",2'), ['say "hi"', "2"]);
assert.deepEqual(parseLine("a,,c"), ["a", "", "c"]);
assert.deepEqual(parseLine('"",x'), ["", "x"]);
assert.deepEqual(parseLine('"a,b,c"'), ["a,b,c"]);
console.log("hidden csv ok");
