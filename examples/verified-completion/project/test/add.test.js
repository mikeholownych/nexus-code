const test = require("node:test");
const assert = require("node:assert");
const { add } = require("../add.js");

test("add adds", () => assert.strictEqual(add(2, 3), 5));
