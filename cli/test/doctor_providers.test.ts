import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "../src/doctor.js";
import { parseProvidersDocument } from "../src/provider_file.js";
import { providerSource, setOperatorProviders } from "../src/providers.js";
import type { HarnessConfig } from "../src/types.js";

let home = "";
let savedHome: string | undefined;
before(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-doctor-prov-home-"));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  setOperatorProviders([]);
  delete process.env.DOCTOR_TEST_KEY;
});

const cfg = (): HarnessConfig => ({ endpoint: "http://127.0.0.1:9/v1", model: "m", maxSteps: 30, temperature: 0, workspace: home, shell: "bash" });
const finding = async () => (await runDoctor({ home, timeoutMs: 1500, config: cfg() })).findings.find((f) => f.id === "config.providers_file")!;
const declare = () => setOperatorProviders(parseProvidersDocument({ providers: { "my-gw": { label: "My gateway", baseUrl: "https://gw.example.com/v1", credentialEnv: "DOCTOR_TEST_KEY" } } }));

test("provider source distinguishes built-in from operator-declared", () => {
  assert.equal(providerSource("openai"), "built-in");
  assert.equal(providerSource("my-gw"), undefined);
  declare();
  assert.equal(providerSource("my-gw"), "providers.json");
});

test("config.providers_file: skip with none, warn without a credential, pass with one", async () => {
  assert.equal((await finding()).status, "skip");
  declare();
  const warned = await finding();
  assert.equal(warned.status, "warn");
  assert.match(warned.evidence.join(" "), /my-gw: openai-chat https:\/\/gw\.example\.com\/v1 \(no credential\)/);
  process.env.DOCTOR_TEST_KEY = "k-doctor-0001";
  const ok = await finding();
  assert.equal(ok.status, "pass");
  assert.doesNotMatch(JSON.stringify(ok), /k-doctor-0001/, "the key never appears in the finding");
});
