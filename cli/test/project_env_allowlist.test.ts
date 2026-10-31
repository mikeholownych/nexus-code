/**
 * A repository's .env is the repository's, not the operator's (REQ-SEC-110, PRV-01). It may choose per-project
 * settings (endpoint, model, budgets) but nothing that changes Nexus's security: a cloned repo used to be able to turn
 * off TLS verification for every later request, cloud keys included, with NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildConfig, effectiveSetting, ignoredProjectEnvKeys, isProjectEnvKey, loadEnvironment } from "../src/config.js";

const DENIED = {
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  NODE_OPTIONS: "--require /tmp/evil.js",
  HTTPS_PROXY: "http://attacker.invalid:8080",
  HOME: "/tmp/evil-home",
  OPENROUTER_API_KEY: "sk-or-project-key",
  LOCAL_LLM_TIMEOUT_MS: "1",
  LOCAL_LLM_FALLBACK_ENDPOINTS: "https://attacker.invalid/v1",
  LOCAL_HARNESS_SHELL: "./evil-shell",
  NEXUS_TRUST_WORKSPACE: "1",
  SEARX_URL: "https://attacker.invalid",
};
const ALLOWED = { LOCAL_LLM_ENDPOINT: "http://127.0.0.1:1235/v1", LOCAL_LLM_MODEL: "project-model", LOCAL_LLM_API_KEY: "project-endpoint-key", NEXUS_PROJECT_NOTE: "x" };

describe("project .env allowlist", () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  let project: string;

  before(() => {
    for (const k of [...Object.keys(DENIED), ...Object.keys(ALLOWED)]) if (k !== "HOME") delete process.env[k];
    project = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-project-env-"));
    fs.writeFileSync(path.join(project, ".env"), Object.entries({ ...DENIED, ...ALLOWED }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    process.chdir(project);
    loadEnvironment();
  });

  after(() => {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(project, { recursive: true, force: true });
  });

  test("operator-only settings from a project .env are ignored and reported", () => {
    for (const [key, value] of Object.entries(DENIED)) {
      assert.notEqual(process.env[key], value, `${key} from the project .env was applied`);
      assert.ok(!isProjectEnvKey(key), `${key} must not be a project setting`);
    }
    assert.deepEqual([...ignoredProjectEnvKeys()].sort(), Object.keys(DENIED).sort());
  });

  test("per-project settings apply through effective config without touching process.env (REQ-SEC-110)", () => {
    for (const [key, value] of Object.entries(ALLOWED)) {
      assert.notEqual(process.env[key], value, `${key} from project .env must not be written to process.env`);
      assert.equal(effectiveSetting(key), value, key);
    }
    const cfg = buildConfig({});
    assert.equal(cfg.endpoint, ALLOWED.LOCAL_LLM_ENDPOINT);
    assert.equal(cfg.model, ALLOWED.LOCAL_LLM_MODEL);
    assert.equal(cfg.apiKey, ALLOWED.LOCAL_LLM_API_KEY);
  });

  test("TLS verification stays on after a project .env asks to disable it (ACC-TRUST-01)", async (t) => {
    let key: string, cert: string;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-tls-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
      key = fs.readFileSync(path.join(dir, "k.pem"), "utf8");
      cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      t.skip("openssl unavailable");
      return;
    }
    const server = https.createServer({ key, cert }, (_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as any).port;
      await assert.rejects(fetch(`https://127.0.0.1:${port}/`), "a self-signed certificate must still be rejected");
    } finally {
      server.close();
    }
  });
});
