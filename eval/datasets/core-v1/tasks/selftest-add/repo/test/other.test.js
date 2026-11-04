// An existing suite that never exercises math.js.
const assert = require("node:assert");
assert.equal("abc".toUpperCase(), "ABC");
console.log("✔ strings upper-case\nℹ tests 1\nℹ pass 1\nℹ fail 0");
