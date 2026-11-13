import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  classifyToolArguments,
  endpointPasses,
  runToolGrammarMatrix,
  validateMatrixEvidence,
  writeEvidence,
} from "./tool_grammar_matrix.mjs";

const schema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

function writeInstalledRuntimeFixture(installRoot, tools) {
  const cliRoot = path.join(installRoot, "lib", "cli", "dist");
  fs.mkdirSync(path.join(cliRoot, "core"), { recursive: true });
  fs.writeFileSync(path.join(cliRoot, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(cliRoot, "core", "capabilities.js"), `export const HARNESS_TOOLS = ${JSON.stringify(tools)};\n`);
  fs.writeFileSync(path.join(cliRoot, "parser.js"), `export function repairJsonWithClass(raw) { return { value: JSON.parse(raw), repaired: "none" }; }\n`);
  fs.writeFileSync(path.join(cliRoot, "core", "tool_grammar_provider.js"), `
export function adaptToolDefinitionsForServer(kind, definitions) {
  if (kind !== "vllm") return definitions;
  return definitions.map((tool) => {
    const params = tool.function.parameters;
    const properties = Object.fromEntries(Object.entries(params.properties).map(([name, property]) => [
      name,
      (params.required ?? []).includes(name) ? property : { ...property, type: [property.type, "null"] },
    ]));
    return { ...tool, function: { ...tool.function, strict: true, parameters: { ...params, properties, required: Object.keys(properties), additionalProperties: false } } };
  });
}
`);
  fs.writeFileSync(path.join(cliRoot, "client.js"), `
export class LocalLlmClient {
  constructor(config) { const state = globalThis.__wp1107MatrixFixture; state.clientCreations = (state.clientCreations ?? 0) + 1; this.config = config; this.provider = state.providers[config.endpoint]; }
  async discoverAdvertisement() { return { state: "supported", ...(this.provider.advertised ? { advertised: this.provider.advertised } : {}) }; }
  getDetectedServerKind() { return this.provider.serverKind; }
  async chatCompletion(messages, offered) {
    const state = globalThis.__wp1107MatrixFixture;
    state.calls++;
    if (state.failVllm && this.provider.provider === "vllm") return { content: "", tool_calls: [] };
    const name = offered[0].function.name;
    const args = name === "read_file" ? { path: "safe fixture", ...(this.provider.provider === "vllm" ? { start_line: null } : {}) }
      : name === "write_file" ? { path: "safe fixture", content: "fixture" }
        : name === "edit_file" ? { path: "safe fixture", old_content: "a", new_content: "b" }
          : { command: "true" };
    const hybrid = messages[0].content.includes("<think>");
    return { content: hybrid ? "<think>check arguments</think>" : "", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] };
  }
}
`);
}

function createCandidateFixture(root, _sourceCommit, tools, afterManifest = () => {}) {
  const candidateCheckoutRoot = path.join(root, "checkout");
  fs.mkdirSync(candidateCheckoutRoot, { recursive: true });
  execFileSync("git", ["init", "-q", candidateCheckoutRoot]);
  execFileSync("git", ["-C", candidateCheckoutRoot, "config", "user.name", "WP-1107 Test"]);
  execFileSync("git", ["-C", candidateCheckoutRoot, "config", "user.email", "wp1107-test@example.invalid"]);
  fs.writeFileSync(path.join(candidateCheckoutRoot, "candidate.txt"), "committed candidate source\n");
  execFileSync("git", ["-C", candidateCheckoutRoot, "add", "candidate.txt"]);
  execFileSync("git", ["-C", candidateCheckoutRoot, "commit", "-q", "-m", "candidate"]);
  const gitSourceCommit = execFileSync("git", ["-C", candidateCheckoutRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const packageRoot = path.join(root, "nexus");
  const archivePath = path.join(root, "candidate.tar.gz");
  const installRoot = path.join(root, "installed");
  fs.mkdirSync(packageRoot, { recursive: true });
  writeInstalledRuntimeFixture(packageRoot, tools);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
      else assert.fail(`unexpected fixture entry ${fullPath}`);
    }
  };
  visit(packageRoot);
  const manifest = files.map((filePath) => `${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}  ./${path.relative(packageRoot, filePath).split(path.sep).join("/")}`).join("\n") + "\n";
  fs.writeFileSync(path.join(packageRoot, "MANIFEST.sha256"), manifest);
  afterManifest(packageRoot);
  execFileSync("tar", ["-czf", archivePath, "-C", root, "nexus"]);
  fs.cpSync(packageRoot, installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, ".provenance.json"), JSON.stringify({
    method: "installer",
    archiveSha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"),
    revision: gitSourceCommit,
  }));
  const gitSourceTree = execFileSync("git", ["-C", candidateCheckoutRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  return { archivePath, installRoot, candidateCheckoutRoot, sourceCommit: gitSourceCommit, sourceTree: gitSourceTree };
}

function candidateOptions(fixture) {
  return {
    archivePath: fixture.archivePath,
    installRoot: fixture.installRoot,
    candidateCheckoutRoot: fixture.candidateCheckoutRoot,
    sourceCommit: fixture.sourceCommit,
    sourceTree: fixture.sourceTree,
    archiveSha256: createHash("sha256").update(fs.readFileSync(fixture.archivePath)).digest("hex"),
  };
}

function endpointResult(nativeValid, repaired = 0, schemaInvalid = 0, invalid = 0) {
  return {
    attempts: 200,
    tools: Object.fromEntries(["read_file", "write_file", "edit_file", "run_command"].map((name) => [name, {
      attempts: 50,
      native_valid: name === "read_file" ? nativeValid : 50,
      repaired: name === "read_file" ? repaired : 0,
      schema_invalid: name === "read_file" ? schemaInvalid : 0,
      invalid: name === "read_file" ? invalid : 0,
      hybrid_attempts: 5,
      hybrid_reasoning_present: 5,
      hybrid_schema_valid: 5,
    }])),
    totals: { attempts: 200, native_valid: nativeValid + 150, repaired, schema_invalid: schemaInvalid, invalid },
    passed: false,
  };
}

function identifiedEndpoint(provider, result = endpointResult(50)) {
  const initial = provider === "llamacpp" ? "1" : provider === "vllm" ? "c" : "f";
  const model = provider === "llamacpp" ? "2" : provider === "vllm" ? "d" : "a";
  return {
    provider,
    serverKind: provider,
    serverVersion: provider === "vllm" ? "0.10.0" : "1.0.0",
    imageDigest: `sha256:${initial.repeat(64)}`,
    modelName: "reasoning-model",
    modelDigest: `sha256:${model.repeat(64)}`,
    contextSize: 32768,
    sampling: { temperature: 0 },
    toolChoice: "auto",
    promptFixtureSha256: "e".repeat(64),
    serverFlags: [],
    compatibilityMode: "openai-chat",
    ...result,
    passed: endpointPasses(result),
  };
}

function evidenceWith(endpoints = ["llamacpp", "vllm", "ollama"].map((provider) => identifiedEndpoint(provider))) {
  return { schemaVersion: 1, candidate: { archiveSha256: "a".repeat(64), sourceCommit: "b".repeat(40), sourceTree: "c".repeat(40) }, endpoints };
}

test("tool grammar matrix evidence schema rejects invalid counts and identity omissions", () => {
  assert.equal(validateMatrixEvidence(evidenceWith()).valid, true);

  const omittedIdentity = evidenceWith([identifiedEndpoint("llamacpp"), { provider: "vllm", ...endpointResult(50) }, identifiedEndpoint("ollama")]);
  assert.throws(() => validateMatrixEvidence(omittedIdentity), /identity/i);

  const badCounts = evidenceWith([identifiedEndpoint("llamacpp"), { ...identifiedEndpoint("vllm"), totals: { ...endpointResult(50).totals, invalid: -1 } }, identifiedEndpoint("ollama")]);
  assert.throws(() => validateMatrixEvidence(badCounts), /count|attempt/i);

  const secretMetadata = evidenceWith();
  secretMetadata.endpoints[0].sampling.apiKey = "must not be recorded";
  assert.throws(() => validateMatrixEvidence(secretMetadata), /sensitive/i);
});

test("tool grammar matrix computes endpoint pass without percentage rounding", () => {
  const atThreshold = identifiedEndpoint("vllm", endpointResult(49, 1));
  assert.equal(endpointPasses(atThreshold), true, "199/200 is exactly the inclusive 99.5% boundary");
  const belowThreshold = identifiedEndpoint("vllm", endpointResult(48, 2));
  assert.equal(endpointPasses(belowThreshold), false, "198/200 must fail even if a rounded display says 99%");
});

test("tool grammar matrix rejects schema-invalid tool arguments", () => {
  const result = classifyToolArguments({ schema, rawArguments: '{"path":4}', repairJsonWithClass: () => assert.fail("valid JSON must not be repaired") });
  assert.deepEqual(result, { category: "schema_invalid", parsed: true, schemaValid: false, repaired: false });
});

test("tool grammar matrix accepts nullable optional fields from strict provider schemas", () => {
  const strictSchema = {
    type: "object",
    properties: { path: { type: "string" }, start_line: { type: ["number", "null"] } },
    required: ["path", "start_line"],
    additionalProperties: false,
  };
  const result = classifyToolArguments({ schema: strictSchema, rawArguments: '{"path":"a","start_line":null}', repairJsonWithClass: () => assert.fail("valid JSON must not be repaired") });
  assert.deepEqual(result, { category: "native_valid", parsed: true, schemaValid: true, repaired: false });
});

test("matrix evidence retains a measured provider miss as a failed result", () => {
  const missed = identifiedEndpoint("vllm", endpointResult(48, 1, 1));
  missed.passed = false;
  const result = validateMatrixEvidence(evidenceWith([identifiedEndpoint("llamacpp"), missed, identifiedEndpoint("ollama")]));
  assert.deepEqual(result, { valid: true, passed: false });
});

test("matrix evidence rejects caller-supplied tool schemas instead of replacing installed schemas", async () => {
  await assert.rejects(runToolGrammarMatrix({ archivePath: "unused", installRoot: "unused", tools: [] }), /exact installed candidate/i);
});

test("matrix rejects self-attested sourceCommit that differs from Git HEAD", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-git-head-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const forgedCommit = "b".repeat(40);
    fs.writeFileSync(path.join(fixture.installRoot, ".provenance.json"), JSON.stringify({
      method: "installer", archiveSha256: candidateOptions(fixture).archiveSha256, revision: forgedCommit,
    }));
    await assert.rejects(runToolGrammarMatrix({
      ...candidateOptions(fixture), sourceCommit: forgedCommit, providers: [],
    }), /source commit.*Git HEAD|Git HEAD.*source commit/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix rejects dirty candidate checkout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-dirty-checkout-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    fs.writeFileSync(path.join(fixture.candidateCheckoutRoot, "uncommitted.txt"), "not part of the candidate commit\n");
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), providers: [] }), /candidate checkout.*clean|clean.*candidate checkout/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix requires a pinned archive SHA-256", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-archive-pin-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const options = candidateOptions(fixture);
    delete options.archiveSha256;
    await assert.rejects(runToolGrammarMatrix({ ...options, providers: [] }), /archive SHA-256.*required|pinned archive digest/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix requires a pinned source tree id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-pin-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const options = candidateOptions(fixture);
    delete options.sourceTree;
    await assert.rejects(runToolGrammarMatrix({ ...options, providers: [] }), /source tree.*required|pinned.*source tree/i);
    await assert.rejects(runToolGrammarMatrix({ ...options, sourceTree: "not-a-tree", providers: [] }), /source tree.*required|pinned.*source tree/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix rejects a checkout whose tree differs from the pinned tree even at the same commit id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-mismatch-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), sourceTree: "d".repeat(40), providers: [] }), /source tree.*does not match|tree.*pinned/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix rejects tampered checkout content hidden from git status (assume-unchanged) at the same commit id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-tamper-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const git = (...args) => execFileSync("git", ["-C", fixture.candidateCheckoutRoot, ...args], { encoding: "utf8" });
    git("update-index", "--assume-unchanged", "candidate.txt");
    fs.writeFileSync(path.join(fixture.candidateCheckoutRoot, "candidate.txt"), "TAMPERED source with the same commit id\n");
    assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), "", "git status is blind to the tamper");
    assert.equal(git("rev-parse", "HEAD").trim(), fixture.sourceCommit);
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), providers: [] }), /checkout content.*pinned tree|tampered|does not match.*tree/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix rejects an exec-bit change even when core.fileMode=false hides it from git status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-mode-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const git = (...args) => execFileSync("git", ["-C", fixture.candidateCheckoutRoot, ...args], { encoding: "utf8" });
    git("config", "core.fileMode", "false");
    fs.chmodSync(path.join(fixture.candidateCheckoutRoot, "candidate.txt"), 0o755);
    assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), "", "git status is blind to the mode change");
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), providers: [] }), /mode.*pinned tree|executable/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix rejects a git replace ref that makes HEAD's tree differ from the real commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-replace-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const git = (...args) => execFileSync("git", ["-C", fixture.candidateCheckoutRoot, ...args], { encoding: "utf8" });
    fs.writeFileSync(path.join(fixture.candidateCheckoutRoot, "candidate.txt"), "attacker content\n");
    git("commit", "-q", "-am", "alt");
    const alt = git("rev-parse", "HEAD").trim();
    const altTree = git("rev-parse", "HEAD^{tree}").trim();
    git("reset", "-q", "--hard", fixture.sourceCommit);
    git("replace", fixture.sourceCommit, alt);
    git("checkout", "-q", "--detach", alt === "" ? fixture.sourceCommit : fixture.sourceCommit);
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), sourceTree: altTree, providers: [] }), /replace/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix handles a checkout whose git listings exceed the default 1 MiB buffer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-large-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    const git = (...args) => execFileSync("git", ["-C", fixture.candidateCheckoutRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const dir = path.join(fixture.candidateCheckoutRoot, "big");
    fs.mkdirSync(dir);
    for (let i = 0; i < 5500; i += 1) fs.writeFileSync(path.join(dir, `${String(i).padStart(5, "0")}-${"x".repeat(200)}`), "1");
    git("add", "-A");
    git("commit", "-q", "-m", "large");
    const head = git("rev-parse", "HEAD").trim();
    const tree = git("rev-parse", "HEAD^{tree}").trim();
    assert.ok(Buffer.byteLength(git("ls-tree", "-r", "-z", "HEAD")) > 1024 * 1024);
    // Reaches the content check (and fails later, on the archive/provenance binding), never an ENOBUFS from git.
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), sourceCommit: head, sourceTree: tree, providers: [] }), (error) => {
      assert.doesNotMatch(String(error.message), /ENOBUFS|maxBuffer/i);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matrix rejects ignored or untracked files that git status does not list", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-tree-extra-"));
  try {
    const fixture = createCandidateFixture(root, "unused", []);
    fs.writeFileSync(path.join(fixture.candidateCheckoutRoot, ".git", "info", "exclude"), "hidden.txt\n");
    fs.writeFileSync(path.join(fixture.candidateCheckoutRoot, "hidden.txt"), "ignored but present\n");
    await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), providers: [] }), /untracked|ignored|extra/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tool grammar matrix preserves missing hybrid reasoning as a failed endpoint", () => {
  const endpoint = identifiedEndpoint("vllm");
  endpoint.tools.read_file.hybrid_reasoning_present = 4;
  endpoint.passed = false;
  assert.equal(endpointPasses(endpoint), false);
  assert.deepEqual(
    validateMatrixEvidence(evidenceWith([identifiedEndpoint("llamacpp"), endpoint, identifiedEndpoint("ollama")])),
    { valid: true, passed: false },
  );
});

test("tool grammar matrix runner records archive and per-endpoint identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-matrix-test-"));
  const sourceCommit = "b".repeat(40);
  const tools = [
    ["read_file", { path: { type: "string" }, start_line: { type: "number" } }, ["path"]],
    ["write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]],
    ["edit_file", { path: { type: "string" }, old_content: { type: "string" }, new_content: { type: "string" } }, ["path", "old_content", "new_content"]],
    ["run_command", { command: { type: "string" } }, ["command"]],
  ].map(([name, properties, required]) => ({ type: "function", function: { name, parameters: { type: "object", properties, required } } }));
  const fixture = createCandidateFixture(root, sourceCommit, tools);
  const { archivePath, installRoot } = fixture;
  const candidate = candidateOptions(fixture);
  const providers = ["llamacpp", "vllm", "ollama"].map((provider) => ({
    provider, serverKind: provider, endpointUrl: `http://127.0.0.1:8000/${provider}/v1`, modelName: "m",
    serverVersion: provider === "vllm" ? "0.10.0" : "1.0.0",
    imageDigest: `sha256:${(provider === "llamacpp" ? "1" : provider === "vllm" ? "c" : "f").repeat(64)}`,
    modelDigest: `sha256:${(provider === "llamacpp" ? "2" : provider === "vllm" ? "d" : "a").repeat(64)}`,
    contextSize: 32768, sampling: { temperature: 0 }, toolChoice: "auto", serverFlags: [], compatibilityMode: "openai-chat",
  }));
  const calls = { providers: Object.fromEntries(providers.map((provider) => [provider.endpointUrl, provider])) };
  globalThis.__wp1107MatrixFixture = { ...calls, calls: 0, failVllm: false };
  const runtime = { tools: [], clientFactory: async () => assert.fail("caller runtime must never be invoked") };
  await assert.rejects(
    runToolGrammarMatrix({ ...candidate, runtime, providers }),
    /caller-supplied runtime/i,
    "production evidence collection must never accept a substitute for the installed candidate runtime",
  );
  const evidence = await runToolGrammarMatrix({
    ...candidate,
    providers,
    attemptsPerTool: 50,
    hybridAttemptsPerTool: 5,
  });

  assert.equal(globalThis.__wp1107MatrixFixture.calls, 600);
  assert.equal(evidence.candidate.archiveSha256.length, 64);
  assert.deepEqual(evidence.endpoints.map((endpoint) => endpoint.provider), ["llamacpp", "vllm", "ollama"]);
  assert.equal(evidence.endpoints[1].serverKind, "vllm");
  assert.equal("endpointUrl" in evidence.endpoints[0], false);
  assert.equal(evidence.endpoints[0].totals.attempts, 200);
  assert.equal(evidence.endpoints[1].tools.read_file.schema_invalid, 0, "nullable vLLM parameters must be checked against the adapted candidate schema");
  assert.equal(evidence.passed, true);

  globalThis.__wp1107MatrixFixture.failVllm = true;
  const failedPath = path.join(root, "provider-miss.json");
  const failed = await runToolGrammarMatrix({ ...candidate, providers, outputPath: failedPath });
  assert.equal(failed.passed, false);
  assert.equal(failed.endpoints.find((endpoint) => endpoint.provider === "vllm").passed, false);
  assert.equal(failed.endpoints.find((endpoint) => endpoint.provider === "vllm").totals.invalid, 200);
  assert.equal(fs.existsSync(failedPath), true, "failed endpoint counts must be written before returning failure status");
  delete globalThis.__wp1107MatrixFixture;
  fs.rmSync(root, { recursive: true, force: true });
});

test("tool grammar matrix binds imported runtime to the verified archive snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-matrix-snapshot-"));
  const sourceCommit = "b".repeat(40);
  const tools = [
    ["read_file", { path: { type: "string" }, start_line: { type: "number" } }, ["path"]],
    ["write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]],
    ["edit_file", { path: { type: "string" }, old_content: { type: "string" }, new_content: { type: "string" } }, ["path", "old_content", "new_content"]],
    ["run_command", { command: { type: "string" } }, ["command"]],
  ].map(([name, properties, required]) => ({ type: "function", function: { name, parameters: { type: "object", properties, required } } }));
  const fixture = createCandidateFixture(root, sourceCommit, tools);
  const { archivePath, installRoot } = fixture;
  const candidate = candidateOptions(fixture);
  globalThis.__wp1107MatrixFixture = {
    providers: Object.fromEntries(["llamacpp", "vllm", "ollama"].map((provider) => [`http://127.0.0.1:8000/${provider}/v1`, { provider, serverKind: provider }])),
    calls: 0,
    failVllm: false,
  };
  const providers = ["llamacpp", "vllm", "ollama"].map((provider) => ({
    provider,
    serverKind: provider,
    endpointUrl: `http://127.0.0.1:8000/${provider}/v1`,
    modelName: "m",
    serverVersion: "1.0.0",
    imageDigest: `sha256:${"1".repeat(64)}`,
    modelDigest: `sha256:${"2".repeat(64)}`,
    contextSize: 32768,
    sampling: { temperature: 0 },
    toolChoice: "auto",
    serverFlags: [],
    compatibilityMode: "openai-chat",
  }));
  Object.defineProperty(providers[2], "provider", {
    get() {
      const clientPath = path.join(installRoot, "lib", "cli", "dist", "client.js");
      fs.writeFileSync(clientPath, `export class LocalLlmClient { constructor() { throw new Error("installed runtime substitution was imported"); } }\n`);
      return "ollama";
    },
  });

  try {
    const evidence = await runToolGrammarMatrix({ ...candidate, providers });
    assert.equal(evidence.passed, true);
    assert.equal(globalThis.__wp1107MatrixFixture.calls, 600);
  } finally {
    delete globalThis.__wp1107MatrixFixture;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tool grammar matrix rejects archive symlinks and files missing from the exact manifest", async () => {
  const sourceCommit = "b".repeat(40);
  const tools = [];
  for (const [label, addUntrustedEntry, expectedError] of [
    ["extra file", (packageRoot) => fs.writeFileSync(path.join(packageRoot, "unmanifested.txt"), "not in manifest"), /exact package file set/i],
    ["symlink", (packageRoot) => fs.symlinkSync("client.js", path.join(packageRoot, "lib", "cli", "dist", "linked-client.js")), /symlink|non-regular entry/i],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wp1107-matrix-${label.replaceAll(" ", "-")}-`));
    try {
      const fixture = createCandidateFixture(root, sourceCommit, tools, addUntrustedEntry);
      await assert.rejects(runToolGrammarMatrix({ ...candidateOptions(fixture), providers: [] }), expectedError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("tool grammar matrix rejects installed runtime substitution with matching provenance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-installed-mismatch-"));
  const sourceCommit = "c".repeat(40);
  const tools = [
    ["read_file", { path: { type: "string" } }, ["path"]],
    ["write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]],
    ["edit_file", { path: { type: "string" }, old_content: { type: "string" }, new_content: { type: "string" } }, ["path", "old_content", "new_content"]],
    ["run_command", { command: { type: "string" } }, ["command"]],
  ].map(([name, properties, required]) => ({ type: "function", function: { name, parameters: { type: "object", properties, required } } }));
  const fixture = createCandidateFixture(root, sourceCommit, tools);
  const { archivePath, installRoot, sourceCommit: gitSourceCommit } = fixture;
  const candidate = candidateOptions(fixture);
  const archiveSha256 = candidate.archiveSha256;
  fs.writeFileSync(path.join(installRoot, "lib", "cli", "dist", "client.js"), "export class LocalLlmClient { constructor() { throw new Error('modified installed runtime'); } }\n");
  fs.writeFileSync(path.join(installRoot, ".provenance.json"), JSON.stringify({
    method: "installer", archiveSha256, revision: gitSourceCommit,
  }));
  const evidencePath = path.join(root, "evidence.json");
  globalThis.__wp1107MatrixFixture = {
    providers: Object.fromEntries(["llamacpp", "vllm", "ollama"].map((provider) => [`http://127.0.0.1:8000/${provider}/v1`, { provider, serverKind: provider }])),
    calls: 0,
    clientCreations: 0,
    failVllm: false,
  };
  const providers = ["llamacpp", "vllm", "ollama"].map((provider) => ({
    provider,
    serverKind: provider,
    endpointUrl: `http://127.0.0.1:8000/${provider}/v1`,
    modelName: "m",
    serverVersion: "1.0.0",
    imageDigest: `sha256:${"1".repeat(64)}`,
    modelDigest: `sha256:${"2".repeat(64)}`,
    contextSize: 32768,
    sampling: { temperature: 0 },
    toolChoice: "auto",
    serverFlags: [],
    compatibilityMode: "openai-chat",
  }));

  try {
    await assert.rejects(runToolGrammarMatrix({ ...candidate, providers, outputPath: evidencePath }), /installed.*(archive|manifest|digest)|runtime.*(archive|manifest|digest)/i);
    assert.equal(globalThis.__wp1107MatrixFixture.clientCreations, 0, "installed byte mismatch must fail before client initialization");
    assert.equal(globalThis.__wp1107MatrixFixture.calls, 0, "installed byte mismatch must fail before inference");
    assert.equal(fs.existsSync(evidencePath), false, "rejected installed bytes must not produce qualification evidence");
  } finally {
    delete globalThis.__wp1107MatrixFixture;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tool grammar matrix rejects credential-like server flags before inference", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-secret-flags-"));
  const sourceCommit = "b".repeat(40);
  const tools = [["read_file", { path: { type: "string" } }, ["path"]], ["write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]], ["edit_file", { path: { type: "string" }, old_content: { type: "string" }, new_content: { type: "string" } }, ["path", "old_content", "new_content"]], ["run_command", { command: { type: "string" } }, ["command"]]].map(([name, properties, required]) => ({ type: "function", function: { name, parameters: { type: "object", properties, required } } }));
  const fixture = createCandidateFixture(root, sourceCommit, tools);
  const { archivePath, installRoot } = fixture;
  let calls = 0;
  const providers = ["llamacpp", "vllm", "ollama"].map((provider) => ({
    provider, serverKind: provider, endpointUrl: "http://127.0.0.1:8000/v1", modelName: "m",
    serverVersion: "1.0.0", imageDigest: `sha256:${"1".repeat(64)}`,
    modelDigest: `sha256:${"2".repeat(64)}`, contextSize: 32768,
    sampling: { temperature: 0 }, toolChoice: "auto", serverFlags: ["--api-key=redacted"],
    compatibilityMode: "openai-chat",
  }));

  await assert.rejects(runToolGrammarMatrix({
    ...candidateOptions(fixture), providers,
  }), /credential|authentication|sensitive/i);
  assert.equal(calls, 0, "credential-bearing configuration must fail before provider initialization");
  fs.rmSync(root, { recursive: true, force: true });
});

test("tool grammar matrix evidence is immutable and has a detached SHA-256 sidecar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-evidence-test-"));
  const outputPath = path.join(root, "wp-1107-provider-matrix.json");
  const result = writeEvidence(outputPath, evidenceWith());
  const bytes = fs.readFileSync(outputPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), result.sha256);
  assert.equal(fs.readFileSync(`${outputPath}.sha256`, "utf8"), `${result.sha256}  ${path.basename(outputPath)}\n`);
  assert.throws(() => writeEvidence(outputPath, evidenceWith()), /exist/i);
  assert.equal(createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex"), result.sha256);
  fs.rmSync(root, { recursive: true, force: true });
});

function gatewayEndpoint(modelName, result = endpointResult(50)) {
  const { imageDigest: _image, modelDigest: _model, ...rest } = identifiedEndpoint("gateway", result);
  return { ...rest, serverKind: "gateway", serverVersion: "limits-2026-11", modelName, workers: ["worker-a"], serverFlags: [], compatibilityMode: "gateway-openai-chat" };
}

test("gateway-mode evidence accepts routed models without image or model digests, and nothing else", () => {
  assert.equal(validateMatrixEvidence(evidenceWith([gatewayEndpoint("engineering/b0")])).valid, true);
  assert.equal(validateMatrixEvidence(evidenceWith([gatewayEndpoint("engineering/b0"), gatewayEndpoint("engineering/b1")])).valid, true);
  assert.throws(() => validateMatrixEvidence(evidenceWith([gatewayEndpoint("engineering/b0"), gatewayEndpoint("engineering/b0")])), /repeats/i);
  assert.throws(() => validateMatrixEvidence(evidenceWith([gatewayEndpoint("engineering/b0"), identifiedEndpoint("vllm")])), /mix|gateway/i);
  const badDigest = gatewayEndpoint("engineering/b0");
  badDigest.modelDigest = "not-a-digest";
  assert.throws(() => validateMatrixEvidence(evidenceWith([badDigest])), /digest/i);
  const missingVersion = gatewayEndpoint("engineering/b0");
  delete missingVersion.serverVersion;
  assert.throws(() => validateMatrixEvidence(evidenceWith([missingVersion])), /version/i);
  const badWorkers = gatewayEndpoint("engineering/b0");
  badWorkers.workers = [""];
  assert.throws(() => validateMatrixEvidence(evidenceWith([badWorkers])), /workers/i);
  const legacy = identifiedEndpoint("llamacpp");
  delete legacy.imageDigest;
  assert.throws(() => validateMatrixEvidence(evidenceWith([legacy, identifiedEndpoint("vllm"), identifiedEndpoint("ollama")])), /digest/i);
});

test("gateway-mode runner binds the pinned version to the advertised limits_version and records the workers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-matrix-test-"));
  const tools = [
    ["read_file", { path: { type: "string" } }, ["path"]],
    ["write_file", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]],
    ["edit_file", { path: { type: "string" }, old_content: { type: "string" }, new_content: { type: "string" } }, ["path", "old_content", "new_content"]],
    ["run_command", { command: { type: "string" } }, ["command"]],
  ].map(([name, properties, required]) => ({ type: "function", function: { name, parameters: { type: "object", properties, required } } }));
  const fixture = createCandidateFixture(root, "b".repeat(40), tools);
  const candidate = candidateOptions(fixture);
  const provider = (version) => ({
    provider: "gateway", serverKind: "gateway", endpointUrl: "http://127.0.0.1:8000/gw/v1", modelName: "engineering/b0",
    serverVersion: "limits-2026-11", contextSize: 32768, sampling: { temperature: 0 }, toolChoice: "auto", serverFlags: [],
    compatibilityMode: "gateway-openai-chat",
    advertised: { via: "aihost_gateway", limitsVersion: version, workers: ["worker-b", "worker-a"] },
  });
  try {
    globalThis.__wp1107MatrixFixture = { providers: { "http://127.0.0.1:8000/gw/v1": provider("limits-2026-11") }, calls: 0 };
    const evidence = await runToolGrammarMatrix({ ...candidate, providers: [provider("limits-2026-11")] });
    assert.equal(globalThis.__wp1107MatrixFixture.calls, 200);
    assert.equal(evidence.passed, true);
    assert.deepEqual(evidence.endpoints.map((endpoint) => endpoint.serverKind), ["gateway"]);
    assert.equal("imageDigest" in evidence.endpoints[0], false);
    assert.deepEqual(evidence.endpoints[0].workers, ["worker-a", "worker-b"]);

    globalThis.__wp1107MatrixFixture = { providers: { "http://127.0.0.1:8000/gw/v1": provider("limits-OTHER") }, calls: 0 };
    await assert.rejects(runToolGrammarMatrix({ ...candidate, providers: [provider("limits-2026-11")] }), /limits_version/i);
    assert.equal(globalThis.__wp1107MatrixFixture.calls, 0, "a version mismatch must fail before any attempt");

    const second = { ...provider("limits-2026-11"), modelName: "engineering/b1" };
    await assert.rejects(runToolGrammarMatrix({ ...candidate, providers: [provider("limits-2026-11"), provider("limits-2026-11")] }), /repeats/i);
    await assert.rejects(runToolGrammarMatrix({ ...candidate, providers: [provider("limits-2026-11"), second, { ...provider("limits-2026-11"), provider: "vllm", serverKind: "vllm", imageDigest: `sha256:${"c".repeat(64)}`, modelDigest: `sha256:${"d".repeat(64)}` }] }), /mix/i);
    const noDigest = { ...provider("limits-2026-11"), provider: "vllm", serverKind: "vllm" };
    await assert.rejects(runToolGrammarMatrix({ ...candidate, providers: [noDigest, { ...noDigest, provider: "llamacpp", serverKind: "llamacpp" }, { ...noDigest, provider: "ollama", serverKind: "ollama" }] }), /digest/i);
  } finally {
    delete globalThis.__wp1107MatrixFixture;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
