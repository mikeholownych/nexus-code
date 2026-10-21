import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReleaseCompatibility, generateCompatibilityMetadata } from "../src/compatibility.js";

for (const target of ["0.1.0-alpha.1", "v0.1.0-alpha.1", "0.1.0-alpha.2", "v0.1.0-alpha.2"]) {
  test(`explicit published legacy target ${target} stays eligible within original bounds`, () => {
    const result = checkReleaseCompatibility("1.0.0", 1, null, "linux-x86_64", 1, target);
    assert.equal(result.compatible, true);
    assert.equal(result.isLegacy, true);
    assert.match(result.reasons.join(" "), /Runtime and archive verification remain required/);
  });
}
for (const target of [undefined, "1.0.0", "v1.0.0-rc.1", "0.1.0-alpha.3", "0.1.0-alpha.2+other", "", "not-a-version"]) {
  test(`missing metadata fails closed for target ${String(target)}`, () => {
    const result = checkReleaseCompatibility("1.0.0", 1, null, "linux-x86_64", 1, target);
    assert.equal(result.compatible, false);
    assert.match(result.reasons.join(" "), /metadata is required/);
  });
}
for (const schema of [0, 2, 99, NaN]) {
  test(`legacy target cannot bypass state schema ${schema}`, () => {
    assert.equal(checkReleaseCompatibility("1.0.0", schema, null, "linux-x86_64", 1, "0.1.0-alpha.2").compatible, false);
  });
  test(`legacy target cannot bypass config schema ${schema}`, () => {
    assert.equal(checkReleaseCompatibility("1.0.0", 1, null, "linux-x86_64", schema, "0.1.0-alpha.2").compatible, false);
  });
}
test("legacy release cannot claim an unpublished platform", () => {
  assert.equal(checkReleaseCompatibility("1.0.0", 1, null, "darwin-arm64", 1, "0.1.0-alpha.2").compatible, false);
});
test("modern release remains eligible with validated compatibility metadata", () => {
  const metadata = generateCompatibilityMetadata("1.0.0", "abcdef0123456789");
  assert.equal(checkReleaseCompatibility("1.0.0", 1, metadata, "linux-x86_64", 1, "1.0.0").compatible, true);
});

test("embedded metadata binds to the requested target even without detached metadata", () => {
  const result = checkReleaseCompatibility("1.0.0", 1, generateCompatibilityMetadata("1.0.0", "deadbeef"), "linux-x86_64", 1, "v2.0.0");
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some(reason => reason.includes("does not match target release")));
});
