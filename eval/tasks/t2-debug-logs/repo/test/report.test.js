const test = require("node:test");
const assert = require("node:assert/strict");
const { dailySummary } = require("../src/report.js");

test("summary", () => {
  const commits = [{ author: "ana" }, { author: "bo" }, { author: "ana" }];
  assert.equal(dailySummary("core", commits), "core: 3 commits, top ana (2)");
});
