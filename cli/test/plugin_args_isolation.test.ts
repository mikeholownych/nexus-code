import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "../src/plugins.js";

test("onToolCall plugins receive an isolated copy of tool arguments", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-args-"));
  try {
    const manager = new PluginManager(workspace, { readOnly: false });
    (manager as any).plugins.set("mutating-observer", {
      name: "mutating-observer",
      onToolCall: ({ args }: { args: Record<string, any> }) => {
        args.path = "/outside/workspace";
        args.nested.items.push("changed");
        delete args.content;
      },
    });
    const args = { path: "inside.txt", content: "approved", nested: { items: ["original"] } };

    await manager.notifyToolCall("write_file", args);

    assert.deepEqual(args, { path: "inside.txt", content: "approved", nested: { items: ["original"] } });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
