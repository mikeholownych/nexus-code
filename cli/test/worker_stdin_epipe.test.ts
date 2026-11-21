/**
 * A worker process that exits immediately after launch must not take the CLI down. Writing a request to its closed stdin
 * raises EPIPE on the stream asynchronously; with no "error" listener that is an uncaught exception. The request is
 * answered as a failure instead. (Found on CS-10: a Docker worker whose container fails to start exits at once.)
 */
import "./helpers/leak_guard.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RustCoreBridge } from "../src/tools.js";

let dir = "";
let workspace = "";
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-epipe-"));
  workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a worker that exits at once", { skip: process.platform === "win32" ? "POSIX stand-in worker" : false }, () => {
  test("requests are answered as failures and no stream error escapes, repeatedly", async () => {
    // A stand-in core that reads nothing and exits: its stdin closes while the bridge is still writing.
    const fake = path.join(dir, "harness-core");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const escaped: unknown[] = [];
    const onUncaught = (err: unknown) => escaped.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      for (let round = 0; round < 25; round++) {
        const bridge = new RustCoreBridge(workspace, "bash", fake, false, false, false);
        try {
          // Several writes per worker: the first may land before the process is gone, the later ones do not.
          const results = await Promise.all([1, 2, 3].map(() => (bridge as any).executeViaRpc("read_file", { path: "a.txt" })));
          for (const res of results) assert.notEqual(res?.success, true, "a worker that never answers cannot succeed");
        } finally {
          bridge.shutdown();
        }
      }
      // Give a late stream error the chance to surface before the listener is removed.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    assert.deepEqual(escaped.map((e) => String((e as Error)?.message ?? e)), [], "no uncaught stream error");
  });
});
