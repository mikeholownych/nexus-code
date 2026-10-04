import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildConfig, autoDetectModel } from "../src/config.js";
import { startGateway } from "./helpers/fixtures.js";

describe("config", () => {
  test("buildConfig applies flags and defaults", () => {
    const config = buildConfig({ endpoint: "http://127.0.0.1:1/v1", model: "x", workspace: "rel-dir", maxSteps: "7", readOnly: true });
    assert.equal(config.endpoint, "http://127.0.0.1:1/v1");
    assert.equal(config.model, "x");
    assert.equal(config.workspace, path.resolve("rel-dir"));
    assert.equal(config.maxSteps, 7);
    assert.equal(config.readOnly, true);
    assert.equal(buildConfig({ endpoint: "e", model: "x" }).maxSteps, 30);
  });

  test("autoDetectModel replaces the placeholder with the first listed model", async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "unused" }));
    try {
      const detected = await autoDetectModel(buildConfig({ endpoint: gw.url, model: "local-model" }));
      assert.equal(detected.model, "m");
      const explicit = await autoDetectModel(buildConfig({ endpoint: gw.url, model: "chosen" }));
      assert.equal(explicit.model, "chosen");
    } finally {
      await gw.close();
    }
  });
});
