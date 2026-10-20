/** Host qualification must protect the account home even when the harness isolates HOME. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE = path.join(ROOT, "eval/host/operator_home.mjs");

test("operator protection selects the account home despite an isolated HOME", () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-operator-home-"));
  try {
    const expected = fs.realpathSync(os.userInfo().homedir);
    assert.notEqual(expected, isolated);
    const script = `import { operatorAccountHome } from ${JSON.stringify(pathToFileURL(MODULE).href)}; console.log(operatorAccountHome());`;
    const actual = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: isolated, XDG_CONFIG_HOME: path.join(isolated, ".config") },
      encoding: "utf8", timeout: 10_000,
    }).trim();
    assert.equal(actual, expected, "a private temporary HOME must not replace the protected account home");
  } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
});

test("invalid account identity or home fails closed", async () => {
  const { operatorAccountHome } = await import(pathToFileURL(MODULE).href);
  for (const account of [null, {}, { uid: process.getuid(), homedir: "relative" },
    { uid: process.getuid(), homedir: "/" }, { uid: process.getuid() + 1, homedir: os.tmpdir() },
    { uid: process.getuid(), homedir: "/bad\0home" }]) {
    assert.throws(() => operatorAccountHome(account));
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-invalid-account-home-"));
  try {
    const file = path.join(scratch, "file"); fs.writeFileSync(file, "fixture");
    assert.throws(() => operatorAccountHome({ uid: process.getuid(), homedir: file }));
    assert.throws(() => operatorAccountHome({ uid: process.getuid(), homedir: path.join(scratch, "missing") }));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
