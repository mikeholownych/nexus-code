import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PluginManager } from "../src/plugins.js";
import { FlightRecorder, FlightPlayer } from "../src/flight.js";

async function withHome(run: (home: string, ws: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ext004-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ext004-ws-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await run(home, ws);
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("ACC-TRUST-07: EXT-004 middleware audit (REQ-SEC-116)", () => {
  test("a plugin rewriting write_file.content produces an audit record with differing digests", async () => {
    await withHome(async (home, ws) => {
      const pm = new PluginManager(ws, { trusted: true });
      const flightRecorder = new FlightRecorder(ws);
      pm.setFlightRecorder(flightRecorder);

      // Register a plugin that rewrites write_file.content
      pm.registerPlugin({
        name: "test-rewriter",
        preToolExecution: async (ctx, next) => {
          if (ctx.toolName === "write_file") {
            return next({ ...ctx.args, content: "rewritten content" });
          }
          return next();
        },
      });

      const initialArgs = { path: "greeting.txt", content: "original content" };
      let executedArgs: any = null;

      const result = await pm.executeToolPipeline("write_file", initialArgs, async (args) => {
        executedArgs = args;
        return { success: true, output: "written successfully" };
      });

      assert.equal(result.success, true);
      assert.equal(executedArgs.content, "rewritten content");

      // Verify audit.log has the middleware_rewrite record
      const auditLogPath = path.join(home, ".nexus", "audit.log");
      assert.ok(fs.existsSync(auditLogPath), "audit.log must be created");

      const lines = fs
        .readFileSync(auditLogPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      const rewriteRecords = lines.filter((r) => r.kind === "middleware_rewrite");
      assert.equal(rewriteRecords.length, 1, "exactly one middleware_rewrite record emitted");

      const rec = rewriteRecords[0];
      assert.equal(rec.plugin, "test-rewriter");
      assert.equal(rec.tool, "write_file");
      assert.equal(rec.phase, "pre");

      const expectedBeforeDigest = sha256(JSON.stringify(initialArgs));
      const expectedAfterDigest = sha256(JSON.stringify({ path: "greeting.txt", content: "rewritten content" }));

      assert.equal(rec.before_digest, expectedBeforeDigest);
      assert.equal(rec.after_digest, expectedAfterDigest);
      assert.notEqual(rec.before_digest, rec.after_digest, "before and after digests must differ");

      // Verify flight log has the record
      const flightLogPath = flightRecorder.getLogPath();
      assert.ok(fs.existsSync(flightLogPath), "flight log must exist");

      const flightEvents = fs
        .readFileSync(flightLogPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      const flightRewriteEvents = flightEvents.filter((e) => e.type === "middleware_rewrite");
      assert.equal(flightRewriteEvents.length, 1, "flight log contains middleware_rewrite event");
      assert.equal(flightRewriteEvents[0].payload.plugin, "test-rewriter");
      assert.equal(flightRewriteEvents[0].payload.before_digest, expectedBeforeDigest);
      assert.equal(flightRewriteEvents[0].payload.after_digest, expectedAfterDigest);
    });
  });

  test("a plugin rewriting postToolExecution result produces a post-phase audit record", async () => {
    await withHome(async (home, ws) => {
      const pm = new PluginManager(ws, { trusted: true });

      pm.registerPlugin({
        name: "result-rewriter",
        postToolExecution: async (ctx) => {
          return { ...ctx.result, output: "tampered output" };
        },
      });

      const initialArgs = { path: "test.txt" };
      const originalResult = { success: true, output: "original output" };

      const result = await pm.executeToolPipeline("read_file", initialArgs, async () => {
        return originalResult;
      });

      assert.equal(result.output, "tampered output");

      const auditLogPath = path.join(home, ".nexus", "audit.log");
      const lines = fs
        .readFileSync(auditLogPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      const rec = lines.find((r) => r.kind === "middleware_rewrite" && r.plugin === "result-rewriter");
      assert.ok(rec, "post-phase rewrite record found");
      assert.equal(rec.phase, "post");
      assert.equal(rec.tool, "read_file");
      assert.equal(rec.before_digest, sha256(JSON.stringify(originalResult)));
      assert.equal(rec.after_digest, sha256(JSON.stringify({ success: true, output: "tampered output" })));
    });
  });

  test("a passthrough plugin produces no middleware_rewrite audit record", async () => {
    await withHome(async (home, ws) => {
      const pm = new PluginManager(ws, { trusted: true });

      pm.registerPlugin({
        name: "passthrough-plugin",
        preToolExecution: async (_ctx, next) => next(),
        postToolExecution: async (ctx) => ctx.result,
      });

      await pm.executeToolPipeline("read_file", { path: "a.txt" }, async () => {
        return { success: true, output: "content" };
      });

      const auditLogPath = path.join(home, ".nexus", "audit.log");
      if (fs.existsSync(auditLogPath)) {
        const lines = fs
          .readFileSync(auditLogPath, "utf-8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l));
        assert.equal(lines.filter((r) => r.kind === "middleware_rewrite").length, 0);
      }
    });
  });
});
