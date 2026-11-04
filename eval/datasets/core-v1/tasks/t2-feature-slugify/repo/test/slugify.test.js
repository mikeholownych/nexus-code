const test = require("node:test");
const assert = require("node:assert/strict");
const { slugify } = require("../slugify.js");

test("basic", () => assert.equal(slugify("Hello, World!"), "hello-world"));
test("accents", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"));
