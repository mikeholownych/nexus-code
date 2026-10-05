/**
 * D2: `harness run -j` must deliver its complete JSON document and the intended exit status however large the result is
 * and whatever stdout is attached to. Previously `console.log(json); process.exit(code)` dropped everything a pipe had not
 * yet accepted (65,536 bytes on Linux) while still exiting with the intended code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { gateway } from "./helpers/capacity_fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcIndex = path.resolve(here, "../src/index.ts");
const cliRoot = path.resolve(here, "..");

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-json-out-"));
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: dir, stdio: "ignore" });
  return dir;
}

interface Run { code: number | null; bytes: Buffer }

/** Runs `harness run -j` with stdout going to a file, or to a pipe read slowly (small reads with pauses). */
function runCli(gwUrl: string, ws: string, home: string, promptArgs: string[], dest: "file" | "slow-pipe"): Promise<Run> {
  return new Promise((resolve, reject) => {
    const outFile = path.join(home, "stdout.json");
    const args = ["--import", "tsx", srcIndex, "run", "-w", ws, "-e", gwUrl, "-m", "m", "-j", "-s", "2", ...promptArgs];
    const env = { ...process.env, HOME: home };
    if (dest === "file") {
      const fd = fs.openSync(outFile, "w");
      const child = spawn(process.execPath, args, { cwd: cliRoot, env, stdio: ["ignore", fd, "ignore"] });
      child.on("error", reject);
      child.on("close", (code) => { fs.closeSync(fd); resolve({ code, bytes: fs.readFileSync(outFile) }); });
      return;
    }
    const child = spawn(process.execPath, args, { cwd: cliRoot, env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    // Deliberately slow consumer: take one chunk, then stop reading for 20 ms so the child's writes back up in the pipe.
    child.stdout.on("data", (piece: Buffer) => {
      chunks.push(piece);
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 20);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, bytes: Buffer.concat(chunks) }));
  });
}

const jsonOf = (b: Buffer) => JSON.parse(b.toString("utf-8"));

describe("D2 run -j output lifecycle", () => {
  test("a result far above 64 KiB arrives byte-exact and valid through a slow pipe, with the intended exit code", async () => {
    const big = "y".repeat(600_000);
    const gw = await gateway(() => ({ text: big }));
    const ws = workspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    try {
      const viaFile = await runCli(gw.url, ws, home, ["answer at length"], "file");
      assert.ok(viaFile.bytes.length > 1_000_000, `fixture must exceed the old truncation boundary (got ${viaFile.bytes.length})`);
      const expected = jsonOf(viaFile.bytes);
      assert.equal(viaFile.code, expected.exitCode, "file destination: exit code equals the reported exit code");

      const viaPipe = await runCli(gw.url, ws, home, ["answer at length"], "slow-pipe");
      assert.equal(viaPipe.bytes.length > 65_536, true);
      const got = jsonOf(viaPipe.bytes);                       // throws if truncated
      assert.equal(got.output.length, expected.output.length, "complete output text");
      assert.equal(got.success, expected.success);
      assert.equal(viaPipe.code, got.exitCode, "pipe destination: exit code equals the reported exit code");
      assert.equal(viaPipe.code, viaFile.code);
    } finally {
      await gw.close(); fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a large failing result keeps its non-zero exit code through a slow pipe", async () => {
    const gw = await gateway(() => ({ fail: true }));            // inference failure -> exit 1
    const ws = workspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    try {
      const promptArgs = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(75_000));   // the JSON echoes the prompt: > 600 KB
      const r = await runCli(gw.url, ws, home, promptArgs, "slow-pipe");
      assert.ok(r.bytes.length > 600_000);
      const doc = jsonOf(r.bytes);
      assert.equal(doc.success, false);
      assert.equal(r.code, 1);
      assert.equal(doc.exitCode, 1);
    } finally {
      await gw.close(); fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a small result is unchanged: valid JSON and the intended exit code", async () => {
    const gw = await gateway(() => ({ text: "short answer" }));
    const ws = workspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-"));
    try {
      const r = await runCli(gw.url, ws, home, ["hi"], "slow-pipe");
      const doc = jsonOf(r.bytes);
      assert.equal(doc.output, "short answer");
      assert.equal(r.code, doc.exitCode);
    } finally {
      await gw.close(); fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
