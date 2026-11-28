import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { PluginProcessClient, PluginProcessError } from "../src/core/plugin_process.js";
import { PluginManager } from "../src/plugins.js";

const roots: string[] = [];
function fixture(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-worker-test-"));
  roots.push(dir);
  const modulePath = path.join(dir, "plugin.mjs");
  fs.writeFileSync(modulePath, source, { mode: 0o600, flag: "wx" });
  return modulePath;
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("plugin worker keeps module state and returns bounded JSON results", async () => {
  const { client, metadata } = await PluginProcessClient.start(fixture(`
    let calls = 0;
    export default {
      name: "stateful",
      customTools: [{ definition: { type: "function", function: { name: "count" } }, handler: async () => ({ success: true, output: String(++calls) }) }]
    };
  `), { timeoutMs: 1000 });
  try {
    assert.equal(metadata.name, "stateful");
    assert.equal(metadata.customTools.length, 1);
    assert.deepEqual(await client.invoke("customTool", { name: "count", args: {} }), { success: true, output: "1" });
    assert.deepEqual(await client.invoke("customTool", { name: "count", args: {} }), { success: true, output: "2" });
  } finally {
    client.shutdown();
  }
});

test("parent deadline kills synchronous plugin code and reports custom-tool outcome unknown", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "busy",
      customTools: [{ definition: { type: "function", function: { name: "busy" } }, handler: () => { while (true) {} } }]
    };
  `), { timeoutMs: 75 });
  const started = Date.now();
  try {
    await assert.rejects(client.invoke("customTool", { name: "busy", args: {} }), (error: unknown) => {
      assert.ok(error instanceof PluginProcessError);
      assert.equal(error.outcomeUnknown, true);
      return true;
    });
    assert.ok(Date.now() - started < 2500, "parent should remain responsive and enforce a finite deadline");
    await assert.rejects(client.invoke("customTool", { name: "busy", args: {} }), PluginProcessError);
  } finally {
    client.shutdown();
  }
});

test("a timed-out middleware cannot call the parent-owned next continuation later", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "late-next",
      preToolExecution: async (_context, next) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return next();
      }
    };
  `), { timeoutMs: 40 });
  let coreCalls = 0;
  try {
    await assert.rejects(
      client.invoke("preToolExecution", { context: {} }, async () => {
        coreCalls++;
        return { success: true, output: "must not run" };
      }),
      (error: unknown) => error instanceof PluginProcessError && error.outcomeUnknown === false,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(coreCalls, 0);
  } finally {
    client.shutdown();
  }
});

test("a timeout after middleware called next marks the tool outcome unknown", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "next-then-hang",
      preToolExecution: async (_context, next) => {
        await next();
        await new Promise(() => {});
      }
    };
  `), { timeoutMs: 75 });
  let coreCalls = 0;
  try {
    await assert.rejects(
      client.invoke("preToolExecution", { context: {} }, async () => {
        coreCalls++;
        return { success: true, output: "started" };
      }),
      (error: unknown) => error instanceof PluginProcessError && error.outcomeUnknown === true,
    );
    assert.equal(coreCalls, 1);
  } finally {
    client.shutdown();
  }
});

test("turn cancellation kills a running custom tool and marks its outcome unknown", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "cancelled-tool",
      customTools: [{ definition: { type: "function", function: { name: "wait" } }, handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { success: true, output: "late result" };
      } }]
    };
  `), { timeoutMs: 5000 });
  const controller = new AbortController();
  try {
    const pending = client.invoke("customTool", { name: "wait", args: {} }, undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => error instanceof PluginProcessError && error.cancelled && error.outcomeUnknown);
    await assert.rejects(client.invoke("customTool", { name: "wait", args: {} }), PluginProcessError);
  } finally {
    client.shutdown();
  }
});

test("turn cancellation after middleware next starts reports an unknown tool outcome", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "cancelled-middleware",
      preToolExecution: async (_context, next) => {
        await next();
        await new Promise(() => {});
      }
    };
  `), { timeoutMs: 5000 });
  const controller = new AbortController();
  let coreCalls = 0;
  try {
    const pending = client.invoke("preToolExecution", { context: {} }, async () => {
      coreCalls++;
      return { success: true, output: "started" };
    }, controller.signal);
    setTimeout(() => controller.abort(), 75);
    await assert.rejects(pending, (error: unknown) => error instanceof PluginProcessError && error.cancelled && error.outcomeUnknown);
    assert.equal(coreCalls, 1);
  } finally {
    client.shutdown();
  }
});

test("oversized plugin output fails closed with an unknown custom-tool result", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "oversized",
      customTools: [{ definition: { type: "function", function: { name: "large" } }, handler: async () => ({ success: true, output: "x".repeat(1100000) }) }]
    };
  `), { timeoutMs: 1500 });
  try {
    await assert.rejects(client.invoke("customTool", { name: "large", args: {} }), (error: unknown) => {
      assert.ok(error instanceof PluginProcessError);
      assert.equal(error.outcomeUnknown, true);
      return true;
    });
  } finally {
    client.shutdown();
  }
});

test("malformed worker protocol messages fail closed and retire the plugin", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    export default {
      name: "malformed-protocol",
      customTools: [{ definition: { type: "function", function: { name: "malform" } }, handler: async () => {
        process.send?.({ protocol: 99, type: "result", id: "forged", ok: true, value: { success: true, output: "false success" } });
        await new Promise(() => {});
      } }]
    };
  `), { timeoutMs: 1000 });
  try {
    await assert.rejects(client.invoke("customTool", { name: "malform", args: {} }), (error: unknown) => error instanceof PluginProcessError && error.outcomeUnknown);
    await assert.rejects(client.invoke("customTool", { name: "malform", args: {} }), PluginProcessError);
  } finally {
    client.shutdown();
  }
});

test("a malformed result envelope cannot be accepted as custom-tool success", async () => {
  const { client } = await PluginProcessClient.start(fixture(`
    process.on("message", (message) => {
      if (message?.type === "invoke" && message.method === "customTool") {
        process.send?.({ protocol: 1, type: "result", id: message.id, ok: "yes", value: { success: true, output: "forged" } });
      }
    });
    export default {
      name: "malformed-result",
      customTools: [{ definition: { type: "function", function: { name: "wait" } }, handler: async () => new Promise(() => {}) }]
    };
  `), { timeoutMs: 1000 });
  try {
    await assert.rejects(client.invoke("customTool", { name: "wait", args: {} }), (error: unknown) => error instanceof PluginProcessError && error.outcomeUnknown);
    await assert.rejects(client.invoke("customTool", { name: "wait", args: {} }), PluginProcessError);
  } finally {
    client.shutdown();
  }
});

test("manager loads file plugins in a separate worker and retires a timed-out custom tool", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-manager-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plugin-manager-workspace-"));
  roots.push(home, workspace);
  const priorHome = process.env.HOME;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  fs.mkdirSync(path.join(home, ".nexus", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".nexus", "plugins", "manager.mjs"), `
    export default {
      name: "managed-worker",
      customTools: [{ definition: { type: "function", function: { name: "sleep" } }, handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { success: true, output: String(process.pid) };
      } }]
    };
  `, { mode: 0o600, flag: "wx" });
  const notices: string[] = [];
  const manager = new PluginManager(workspace, { readOnly: true, pluginTimeoutMs: 60, notify: (notice) => notices.push(notice) });
  try {
    await manager.loadPlugins();
    assert.deepEqual(manager.listPlugins().map((plugin) => plugin.name), ["managed-worker"]);
    const result = await manager.executeCustomTool("sleep", {});
    assert.equal(result.success, false);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(manager.isCustomTool("sleep"), false);
    assert.ok(notices.some((notice) => notice.includes("plugin worker") && notice.includes("stopped")));
  } finally {
    manager.shutdown();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  }
});

test("timeout terminates a detached plugin descendant before its delayed marker", async () => {
  const marker = path.join(os.tmpdir(), `nexus-plugin-child-marker-${process.pid}-${Date.now()}`);
  const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 900)`;
  const { client } = await PluginProcessClient.start(fixture(`
    import { spawn } from "node:child_process";
    export default {
      name: "detached-child",
      customTools: [{ definition: { type: "function", function: { name: "spawn" } }, handler: async () => {
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { detached: true, stdio: "ignore" });
        child.unref();
        await new Promise(() => {});
      } }]
    };
  `), { timeoutMs: 200 });
  try {
    await assert.rejects(client.invoke("customTool", { name: "spawn", args: {} }), (error: unknown) => error instanceof PluginProcessError && error.outcomeUnknown);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(fs.existsSync(marker), false, "a detached process must not outlive the failed plugin worker");
  } finally {
    client.shutdown();
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
  }
});

test("timeout terminates an ordinary plugin descendant before its delayed marker", async () => {
  const marker = path.join(os.tmpdir(), `nexus-plugin-child-marker-${process.pid}-${Date.now()}`);
  const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 900)`;
  const { client } = await PluginProcessClient.start(fixture(`
    import { spawn } from "node:child_process";
    export default {
      name: "ordinary-child",
      customTools: [{ definition: { type: "function", function: { name: "spawn" } }, handler: async () => {
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });
        await new Promise(() => {});
      } }]
    };
  `), { timeoutMs: 200 });
  try {
    await assert.rejects(client.invoke("customTool", { name: "spawn", args: {} }), (error: unknown) => error instanceof PluginProcessError && error.outcomeUnknown);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(fs.existsSync(marker), false, "an ordinary child process must not outlive the failed plugin worker");
  } finally {
    client.shutdown();
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
  }
});
