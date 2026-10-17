import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";

async function captureHeaders(configure: (c: LocalLlmClient) => void, taskClass?: string) {
  let seen: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const client = new LocalLlmClient({ model: "m", endpoint: `http://127.0.0.1:${port}`, apiKey: "k", taskClass } as any);
    configure(client);
    await client.chatCompletion([{ role: "user", content: "hello" }], []);
    return seen;
  } finally {
    server.close();
  }
}

test("X-Task-Class is sent when configured", async () => {
  const h = await captureHeaders(() => {}, "review");
  assert.equal(h["x-task-class"], "review");
});

test("X-Task-Class is absent by default and can be set at runtime", async () => {
  assert.equal((await captureHeaders(() => {}))["x-task-class"], undefined);
  assert.equal((await captureHeaders((c) => c.setTaskClass("architecture")))["x-task-class"], "architecture");
});

test("an invalid task class is never sent (no header injection)", async () => {
  const h = await captureHeaders((c) => c.setTaskClass("bad value\r\nX-Evil: 1"));
  assert.equal(h["x-task-class"], undefined);
  assert.equal(h["x-evil"], undefined);
});

test("standalone local servers discovered via /models do not receive X-Task-Class unless configured (REQ-PRV-109)", async () => {
  let lastChatHeaders: http.IncomingHttpHeaders = {};
  let mode: "llamacpp" | "gateway" = "llamacpp";
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/v1/models")) {
        const entry =
          mode === "llamacpp"
            ? { id: "m", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }
            : { id: "m", owned_by: "gateway", context_length: 32768, limits_version: "1" };
        res.end(JSON.stringify({ data: [entry] }));
        return;
      }
      if (req.url === "/props") {
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
        return;
      }
      lastChatHeaders = req.headers;
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const ep = `http://127.0.0.1:${port}/v1`;
    const main = new LocalLlmClient({ model: "m", endpoint: ep, apiKey: "k" } as any);
    await main.discoverAdvertisement();
    const sub = new LocalLlmClient({ model: "m", endpoint: ep, apiKey: "k", taskClass: "subagent" } as any);
    await sub.chatCompletion([{ role: "user", content: "hello" }], []);
    assert.equal(lastChatHeaders["x-task-class"], undefined, "standalone llamacpp server should not receive X-Task-Class");

    mode = "gateway";
    await main.discoverAdvertisement();
    await sub.chatCompletion([{ role: "user", content: "hello" }], []);
    assert.equal(lastChatHeaders["x-task-class"], "subagent", "gateway server should receive X-Task-Class");
  } finally {
    server.close();
  }
});

test("ACC-INF-08: code and docs carry no homelab-specific identifiers (t5820, engineering/b0, A770, 18010)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const forbidden = /\b(t5820|A770|18010)\b|engineering\/b0/;
  const offenders: string[] = [];

  const scanFile = (filePath: string) => {
    const text = fs.readFileSync(filePath, "utf-8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (forbidden.test(lines[i])) {
        offenders.push(`${path.relative(repoRoot, filePath)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  };

  const walkSrc = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkSrc(full);
      else if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) scanFile(full);
    }
  };

  walkSrc(path.join(repoRoot, "cli/src"));
  for (const entry of fs.readdirSync(path.join(repoRoot, "docs"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      scanFile(path.join(repoRoot, "docs", entry.name));
    }
  }
  scanFile(path.join(repoRoot, "README.md"));
  scanFile(path.join(repoRoot, "quickstart.md"));

  assert.deepEqual(offenders, [], `Found forbidden homelab identifiers:\n${offenders.join("\n")}`);
});
