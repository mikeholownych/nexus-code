const assert = require("node:assert");
const { add } = require("../math.js");
assert.equal(add(2, 3), 5);
assert.equal(add(-1, 1), 0);
console.log("hidden: add ok");
