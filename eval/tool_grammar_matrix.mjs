import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TOOL_NAMES = Object.freeze(["read_file", "write_file", "edit_file", "run_command"]);
const PROVIDER_KIND = Object.freeze({ llamacpp: "llamacpp", vllm: "vllm", ollama: "ollama" });
const sha256Pattern = /^(?:sha256:)?[a-f0-9]{64}$/i;
const commitPattern = /^[a-f0-9]{40}$/i;
const categories = ["native_valid", "repaired", "schema_invalid", "invalid"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function assertCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} count must be a non-negative integer`);
}

function assertNonSecretMetadata(value, location = "evidence") {
  const sensitiveKey = /(?:^|[_-])(api[_-]?key|token|secret|password|credential|authorization|endpoint[_-]?url|url|raw[_-]?arguments|reasoning[_-]?text|prompt[_-]?text)(?:$|[_-])/i;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNonSecretMetadata(item, `${location}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (sensitiveKey.test(key)) throw new TypeError(`evidence contains sensitive field ${location}.${key}`);
      assertNonSecretMetadata(nested, `${location}.${key}`);
    }
  } else if (typeof value === "string" && /(?:bearer\s+\S+|https?:\/\/[^\s/@]+:[^\s/@]+@)/i.test(value)) {
    throw new TypeError(`evidence contains a credential-like value at ${location}`);
  }
}

/** Validate the flat JSON Schema subset used by the four registered grammar pilot tools. */
export function validateToolArguments(schema, value) {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return false;
  if (!isRecord(value)) return false;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) return false;
  for (const name of required) if (!Object.hasOwn(value, name)) return false;
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) if (!Object.hasOwn(schema.properties, name)) return false;
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, name)) continue;
    if (!isRecord(property)) return false;
    const actual = value[name];
    const types = Array.isArray(property.type) ? property.type : [property.type];
    const valid = types.some((type) => type === "string" ? typeof actual === "string"
      : type === "number" ? typeof actual === "number" && Number.isFinite(actual)
        : type === "integer" ? Number.isSafeInteger(actual)
          : type === "boolean" ? typeof actual === "boolean"
            : type === "object" ? isRecord(actual)
              : type === "array" ? Array.isArray(actual)
                : type === "null" ? actual === null
                  : false);
    if (!valid) return false;
    if (Array.isArray(property.enum) && !property.enum.some((item) => Object.is(item, actual))) return false;
  }
  return true;
}

/** Classify raw JSON before repair, then use the exact candidate's existing repair routine only when needed. */
export function classifyToolArguments({ schema, rawArguments, repairJsonWithClass }) {
  if (typeof rawArguments !== "string") {
    return { category: "invalid", parsed: false, schemaValid: false, repaired: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    if (typeof repairJsonWithClass !== "function") {
      return { category: "invalid", parsed: false, schemaValid: false, repaired: false };
    }
    try {
      const repair = repairJsonWithClass(rawArguments);
      if (!repair || !Object.hasOwn(repair, "value")) throw new Error("repair returned no value");
      parsed = repair.value;
      if (!validateToolArguments(schema, parsed)) {
        return { category: "schema_invalid", parsed: true, schemaValid: false, repaired: repair.repaired !== "none" };
      }
      if (repair.repaired === "none") {
        return { category: "invalid", parsed: true, schemaValid: false, repaired: false };
      }
      return { category: "repaired", parsed: true, schemaValid: true, repaired: true };
    } catch {
      return { category: "invalid", parsed: false, schemaValid: false, repaired: false };
    }
  }
  const schemaValid = validateToolArguments(schema, parsed);
  return {
    category: schemaValid ? "native_valid" : "schema_invalid",
    parsed: true,
    schemaValid,
    repaired: false,
  };
}

/** Apply the exact integer threshold and hybrid requirements; no rounded percentages are used. */
export function endpointPasses(endpoint) {
  try {
    if (!isRecord(endpoint) || !isRecord(endpoint.tools) || !isRecord(endpoint.totals)) return false;
    if (endpoint.attempts !== 200 || endpoint.totals.attempts !== 200) return false;
    let attemptSum = 0;
    let nativeValid = 0;
    let repaired = 0;
    let schemaInvalid = 0;
    let invalid = 0;
    for (const name of TOOL_NAMES) {
      const tool = endpoint.tools[name];
      if (!isRecord(tool) || tool.attempts !== 50 || tool.hybrid_attempts !== 5) return false;
      let toolSum = 0;
      for (const category of categories) {
        assertCount(tool[category], `${name}.${category}`);
        toolSum += tool[category];
      }
      if (toolSum !== 50 || tool.hybrid_reasoning_present !== 5 || tool.hybrid_schema_valid !== 5) return false;
      attemptSum += toolSum;
      nativeValid += tool.native_valid;
      repaired += tool.repaired;
      schemaInvalid += tool.schema_invalid;
      invalid += tool.invalid;
    }
    if (attemptSum !== 200 || endpoint.totals.native_valid !== nativeValid || endpoint.totals.repaired !== repaired || endpoint.totals.schema_invalid !== schemaInvalid || endpoint.totals.invalid !== invalid) return false;
    return nativeValid * 1000 >= 200 * 995 && schemaInvalid === 0 && invalid === 0;
  } catch {
    return false;
  }
}

function validateEndpoint(endpoint) {
  if (!isRecord(endpoint)) throw new TypeError("endpoint identity and counts must be an object");
  const expected = PROVIDER_KIND[endpoint.provider];
  if (!expected || endpoint.serverKind !== expected) throw new TypeError("provider identity mismatch");
  if (typeof endpoint.serverVersion !== "string" || !endpoint.serverVersion.trim()) throw new TypeError("server identity requires a version");
  if (typeof endpoint.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(endpoint.imageDigest)) throw new TypeError("server identity requires an immutable image digest");
  if (typeof endpoint.modelName !== "string" || !endpoint.modelName.trim()) throw new TypeError("model identity requires a name");
  if (typeof endpoint.modelDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(endpoint.modelDigest)) throw new TypeError("model identity requires an immutable model digest");
  assertCount(endpoint.contextSize, "context size");
  if (endpoint.contextSize === 0) throw new TypeError("context size must be positive");
  if (!isRecord(endpoint.sampling) || !Number.isFinite(endpoint.sampling.temperature)) throw new TypeError("sampling identity requires the temperature sent by the candidate");
  if (endpoint.sampling.max_tokens !== undefined && (!Number.isSafeInteger(endpoint.sampling.max_tokens) || endpoint.sampling.max_tokens <= 0)) throw new TypeError("sampling max_tokens must be a positive integer");
  if (endpoint.toolChoice !== "auto") throw new TypeError("tool choice must match the candidate client's auto selection");
  if (typeof endpoint.promptFixtureSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(endpoint.promptFixtureSha256)) throw new TypeError("prompt fixture identity requires SHA-256");
  if (!Array.isArray(endpoint.serverFlags) || endpoint.serverFlags.some((flag) => typeof flag !== "string")) throw new TypeError("server flags identity must be a string array");
  if (endpoint.serverFlags.some((flag) => /api[-_]?key|token|secret|password|credential|authorization|bearer/i.test(flag))) throw new TypeError("server flags must omit credentials and authentication options");
  if (typeof endpoint.compatibilityMode !== "string" || !endpoint.compatibilityMode.trim()) throw new TypeError("compatibility mode identity is required");
  assertNonSecretMetadata(endpoint, "endpoint");
  if (!isRecord(endpoint.tools) || Object.keys(endpoint.tools).length !== TOOL_NAMES.length) throw new TypeError("attempt counts must include exactly the four allowlisted tools");
  const totals = { attempts: 0, native_valid: 0, repaired: 0, schema_invalid: 0, invalid: 0 };
  for (const name of TOOL_NAMES) {
    const tool = endpoint.tools[name];
    if (!isRecord(tool)) throw new TypeError(`attempt counts missing ${name}`);
    if (tool.attempts !== 50 || tool.hybrid_attempts !== 5) {
      throw new TypeError(`${name} hybrid/attempt counts violate the 50-attempt and five-hybrid matrix`);
    }
    assertCount(tool.hybrid_reasoning_present, `${name}.hybrid_reasoning_present`);
    assertCount(tool.hybrid_schema_valid, `${name}.hybrid_schema_valid`);
    if (tool.hybrid_reasoning_present > 5 || tool.hybrid_schema_valid > 5) throw new TypeError(`${name} hybrid counts exceed the five-hybrid matrix`);
    let sum = 0;
    for (const category of categories) {
      assertCount(tool[category], `${name}.${category}`);
      sum += tool[category];
      totals[category] += tool[category];
    }
    if (sum !== 50) throw new TypeError(`${name} attempt counts do not sum to 50`);
    totals.attempts += tool.attempts;
  }
  if (!isRecord(endpoint.totals) || Object.keys(totals).some((key) => endpoint.totals[key] !== totals[key])) {
    throw new TypeError("aggregate attempt counts do not match per-tool counts");
  }
  if (endpoint.attempts !== 200) throw new TypeError("endpoint attempt count must be 200");
  if (typeof endpoint.passed !== "boolean" || endpoint.passed !== endpointPasses(endpoint)) {
    throw new TypeError("endpoint pass status does not match its exact syntax, schema, and hybrid reasoning counts");
  }
  return endpoint;
}

/** Validate final matrix evidence; partial endpoint results are not release evidence. */
export function validateMatrixEvidence(evidence) {
  if (!isRecord(evidence) || evidence.schemaVersion !== 1) throw new TypeError("unsupported evidence schema version");
  if (!isRecord(evidence.candidate) || !sha256Pattern.test(evidence.candidate.archiveSha256) || !commitPattern.test(evidence.candidate.sourceCommit)) {
    throw new TypeError("candidate identity requires archive SHA-256 and full source commit");
  }
  if (!Array.isArray(evidence.endpoints) || evidence.endpoints.length !== Object.keys(PROVIDER_KIND).length) throw new TypeError("matrix evidence must contain llama.cpp, vLLM, and Ollama endpoints");
  const kinds = new Set();
  for (const endpoint of evidence.endpoints) {
    validateEndpoint(endpoint);
    if (kinds.has(endpoint.provider)) throw new TypeError("matrix evidence repeats a provider identity");
    kinds.add(endpoint.provider);
  }
  if (kinds.size !== 3) throw new TypeError("matrix evidence is missing a provider identity");
  return { valid: true, passed: evidence.endpoints.every((endpoint) => endpoint.passed) };
}

function validateTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError("candidate tool definitions are required");
  const selected = TOOL_NAMES.map((name) => {
    const matches = tools.filter((tool) => tool?.type === "function" && tool?.function?.name === name);
    if (matches.length !== 1 || !isRecord(matches[0].function.parameters)) throw new TypeError(`candidate must expose exactly one schema for ${name}`);
    return matches[0];
  });
  return selected;
}

async function loadInstalledRuntime(installRoot) {
  const cliRoot = path.resolve(installRoot, "lib", "cli", "dist");
  const [clientModule, capabilitiesModule, parserModule, grammarProviderModule] = await Promise.all([
    import(pathToFileURL(path.join(cliRoot, "client.js")).href),
    import(pathToFileURL(path.join(cliRoot, "core", "capabilities.js")).href),
    import(pathToFileURL(path.join(cliRoot, "parser.js")).href),
    import(pathToFileURL(path.join(cliRoot, "core", "tool_grammar_provider.js")).href),
  ]);
  if (typeof clientModule.LocalLlmClient !== "function" || !Array.isArray(capabilitiesModule.HARNESS_TOOLS) || typeof parserModule.repairJsonWithClass !== "function" || typeof grammarProviderModule.adaptToolDefinitionsForServer !== "function") {
    throw new TypeError("installed candidate is missing client, tool registry, argument repair, or provider schema adaptation exports");
  }
  return {
    tools: capabilitiesModule.HARNESS_TOOLS,
    adaptToolsForServer: grammarProviderModule.adaptToolDefinitionsForServer,
    repairJsonWithClass: parserModule.repairJsonWithClass,
    clientFactory: async (provider) => new clientModule.LocalLlmClient({
      model: provider.modelName,
      endpoint: provider.endpointUrl,
      temperature: provider.sampling.temperature,
      contextLimit: provider.contextSize,
      completionReserveTokens: provider.sampling.max_tokens ?? 512,
      workspace: process.cwd(),
      shell: "bash",
      maxSteps: 1,
      pinEndpoint: true,
      ...(provider.apiKeyEnv && process.env[provider.apiKeyEnv] ? { apiKey: process.env[provider.apiKeyEnv] } : {}),
    }),
  };
}

function archiveEntryPath(entry) {
  if (typeof entry !== "string" || !entry || /[\r\n\\\0]/.test(entry) || entry.startsWith("/") || /^[a-zA-Z]:/.test(entry)) {
    throw new TypeError("candidate archive contains an unsafe path");
  }
  const directory = entry.endsWith("/");
  const parts = (directory ? entry.slice(0, -1) : entry).split("/");
  if (parts.length < 1 || parts.some((part) => !part || part === "." || part === "..")) throw new TypeError("candidate archive contains an unsafe path");
  if (parts[0] !== "nexus") throw new TypeError("candidate archive must contain only the nexus package root");
  return { relative: parts.join("/"), directory };
}

function listArchiveEntries(archivePath) {
  const names = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
  if (names.at(-1) === "") names.pop();
  const types = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
  if (types.at(-1) === "") types.pop();
  if (names.length === 0 || names.length !== types.length) throw new TypeError("candidate archive entry listing is malformed");
  const seen = new Set();
  for (let index = 0; index < names.length; index++) {
    const parsed = archiveEntryPath(names[index]);
    if (seen.has(parsed.relative)) throw new TypeError("candidate archive contains duplicate paths");
    seen.add(parsed.relative);
    const type = types[index]?.[0];
    if ((parsed.directory && type !== "d") || (!parsed.directory && type !== "-")) {
      throw new TypeError("candidate archive contains a symlink, hard link, or non-regular entry");
    }
  }
  return names;
}

function verifyPackageTree(packageRoot) {
  const rootStat = fs.lstatSync(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError("candidate package root is not a real directory");
  const files = new Set();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new TypeError("candidate package contains a symlink");
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) files.add(path.relative(packageRoot, fullPath).split(path.sep).join("/"));
      else throw new TypeError("candidate package contains a non-regular file");
    }
  };
  walk(packageRoot);
  const manifestPath = path.join(packageRoot, "MANIFEST.sha256");
  if (!files.has("MANIFEST.sha256")) throw new TypeError("candidate package is missing MANIFEST.sha256");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new TypeError("candidate manifest is not a regular file");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const expected = new Map();
  for (const line of manifest.split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (?:\*)?(.+)$/i.exec(line);
    if (!match) throw new TypeError("candidate manifest has a malformed entry");
    const relative = match[2].startsWith("./") ? match[2].slice(2) : match[2];
    if (!relative || /[\r\n\\\0]/.test(relative) || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new TypeError("candidate manifest contains an unsafe path");
    }
    if (relative === "MANIFEST.sha256" || expected.has(relative)) throw new TypeError("candidate manifest contains a duplicate or self-referential path");
    expected.set(relative, match[1].toLowerCase());
  }
  const actual = new Set([...files].filter((relative) => relative !== "MANIFEST.sha256"));
  if (actual.size !== expected.size || [...actual].some((relative) => !expected.has(relative))) {
    throw new TypeError("candidate manifest does not describe the exact package file set");
  }
  for (const [relative, digest] of expected) {
    const fullPath = path.join(packageRoot, ...relative.split("/"));
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(fullPath)) !== digest) {
      throw new TypeError("candidate package file does not match MANIFEST.sha256");
    }
  }
  for (const runtimePath of ["lib/cli/dist/client.js", "lib/cli/dist/core/capabilities.js", "lib/cli/dist/parser.js", "lib/cli/dist/core/tool_grammar_provider.js"]) {
    if (!actual.has(runtimePath)) throw new TypeError("candidate package is missing an installed runtime module");
  }
  expected.set("MANIFEST.sha256", sha256(fs.readFileSync(manifestPath)));
  return expected;
}

function createVerifiedArchiveSnapshot(archivePath, expectedDigest) {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp1107-candidate-snapshot-"));
  try {
    fs.chmodSync(snapshotRoot, 0o700);
    const snapshotArchive = path.join(snapshotRoot, "candidate.tar.gz");
    fs.copyFileSync(archivePath, snapshotArchive, fs.constants.COPYFILE_EXCL);
    if (sha256(fs.readFileSync(snapshotArchive)) !== expectedDigest) throw new TypeError("private candidate archive snapshot digest changed");
    listArchiveEntries(snapshotArchive);
    execFileSync("tar", ["-xzf", snapshotArchive, "-C", snapshotRoot, "--no-same-owner", "--no-same-permissions"], { maxBuffer: 64 * 1024 * 1024 });
    const packageRoot = path.join(snapshotRoot, "nexus");
    const packageFiles = verifyPackageTree(packageRoot);
    return { snapshotRoot, packageRoot, packageFiles };
  } catch (error) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function promptFor(toolName, hybrid) {
  return `Call the ${toolName} tool exactly once with arguments that satisfy its supplied JSON Schema.${hybrid ? " Think before the call and emit a non-empty <think>...</think> block." : " Do not add prose."}`;
}

function validProviderIdentity(provider) {
  const expected = PROVIDER_KIND[provider.provider];
  if (!expected || provider.serverKind !== expected) throw new TypeError("configured provider identity is invalid");
  if (typeof provider.endpointUrl !== "string" || !provider.endpointUrl) throw new TypeError("provider endpoint is required");
  if (typeof provider.serverVersion !== "string" || !provider.serverVersion.trim()) throw new TypeError("server version must be pinned before inference");
  if (typeof provider.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(provider.imageDigest)) throw new TypeError("immutable server image digest must be pinned before inference");
  if (typeof provider.modelName !== "string" || !provider.modelName.trim()) throw new TypeError("model identity requires a name");
  if (typeof provider.modelDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(provider.modelDigest)) throw new TypeError("immutable model digest must be pinned before inference");
  if (!Number.isSafeInteger(provider.contextSize) || provider.contextSize <= 0) throw new TypeError("positive context size must be pinned before inference");
  if (!isRecord(provider.sampling) || !Number.isFinite(provider.sampling.temperature)) throw new TypeError("sampling temperature must be pinned before inference");
  if (provider.sampling.max_tokens !== undefined && (!Number.isSafeInteger(provider.sampling.max_tokens) || provider.sampling.max_tokens <= 0)) throw new TypeError("sampling max_tokens must be a positive integer");
  if (provider.toolChoice !== "auto") throw new TypeError("tool choice must be auto for the candidate client");
  if (!Array.isArray(provider.serverFlags) || provider.serverFlags.some((flag) => typeof flag !== "string")) throw new TypeError("server flags must be pinned before inference");
  if (provider.serverFlags.some((flag) => /api[-_]?key|token|secret|password|credential|authorization|bearer/i.test(flag))) {
    throw new TypeError("server flags must omit credentials and authentication options before inference");
  }
  if (typeof provider.compatibilityMode !== "string" || !provider.compatibilityMode.trim()) throw new TypeError("compatibility mode must be pinned before inference");
  return expected;
}

function verifyInstalledArchive(installRoot, archiveSha256, sourceCommit, expectedPackageFiles) {
  const resolvedInstallRoot = path.resolve(installRoot);
  const rootStat = fs.lstatSync(resolvedInstallRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(resolvedInstallRoot) !== resolvedInstallRoot) {
    throw new TypeError("installed candidate root is not a real directory");
  }
  const provenancePath = path.join(resolvedInstallRoot, ".provenance.json");
  let provenance;
  try {
    const provenanceStat = fs.lstatSync(provenancePath);
    if (!provenanceStat.isFile() || provenanceStat.isSymbolicLink()) throw new Error("provenance is not a regular file");
    provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  } catch {
    throw new TypeError("installed candidate has no readable installer provenance");
  }
  if (provenance.method !== "installer" || provenance.archiveSha256 !== archiveSha256 || provenance.revision !== sourceCommit) {
    throw new TypeError("installed candidate provenance does not bind the exact archive and source commit");
  }
  const installedFiles = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(resolvedInstallRoot, fullPath).split(path.sep).join("/");
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new TypeError("installed candidate package contains a symlink");
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) {
        if (relative !== ".provenance.json") installedFiles.set(relative, sha256(fs.readFileSync(fullPath)));
      } else {
        throw new TypeError("installed candidate package contains a non-regular file");
      }
    }
  };
  walk(resolvedInstallRoot);
  if (installedFiles.size !== expectedPackageFiles.size || [...expectedPackageFiles.keys()].some((relative) => !installedFiles.has(relative))) {
    throw new TypeError("installed candidate package file set does not match the verified archive manifest");
  }
  for (const [relative, expectedDigest] of expectedPackageFiles) {
    if (installedFiles.get(relative) !== expectedDigest) {
      throw new TypeError(`installed candidate file does not match the verified archive manifest: ${relative}`);
    }
  }
}

function verifyCandidateCheckout(checkoutRoot, sourceCommit) {
  if (typeof checkoutRoot !== "string" || !checkoutRoot) throw new TypeError("explicit candidate Git checkout root is required");
  const resolvedRoot = path.resolve(checkoutRoot);
  const stat = fs.lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new TypeError("candidate checkout root must be a real directory");
  }
  const git = (args) => execFileSync("git", args, { cwd: resolvedRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let gitRoot;
  let head;
  let status;
  try {
    gitRoot = git(["rev-parse", "--show-toplevel"]);
    head = git(["rev-parse", "HEAD"]);
    status = git(["status", "--porcelain", "--untracked-files=all"]);
  } catch {
    throw new TypeError("candidate checkout root is not a readable Git worktree");
  }
  if (path.resolve(gitRoot) !== resolvedRoot) throw new TypeError("candidate checkout root must be the Git worktree root");
  if (head !== sourceCommit) throw new TypeError("candidate source commit does not match Git HEAD");
  if (status) throw new TypeError("candidate checkout must be clean before matrix qualification");
  return head;
}

/** Invoke the exact installed candidate client for 50 attempts/tool and retain only non-secret aggregate evidence. */
export async function runToolGrammarMatrix(options) {
  if (!options || typeof options.archivePath !== "string" || typeof options.installRoot !== "string") throw new TypeError("candidate archive and installed root are required");
  if (Object.hasOwn(options, "runtime")) throw new TypeError("caller-supplied runtime is not accepted; runtime must be loaded from the installed candidate");
  if (Object.hasOwn(options, "tools")) throw new TypeError("tool schemas must be loaded from the exact installed candidate");
  if (!commitPattern.test(options.sourceCommit)) throw new TypeError("full candidate source commit is required");
  verifyCandidateCheckout(options.candidateCheckoutRoot, options.sourceCommit);
  if (typeof options.archiveSha256 !== "string" || !sha256Pattern.test(options.archiveSha256)) {
    throw new TypeError("pinned candidate archive SHA-256 is required");
  }
  const archivePath = fs.realpathSync(options.archivePath);
  const archiveSha256 = sha256(fs.readFileSync(archivePath));
  if (options.archiveSha256.replace(/^sha256:/i, "").toLowerCase() !== archiveSha256) throw new TypeError("candidate archive SHA-256 does not match the pinned digest");
  const snapshot = createVerifiedArchiveSnapshot(archivePath, archiveSha256);
  try {
    verifyInstalledArchive(options.installRoot, archiveSha256, options.sourceCommit, snapshot.packageFiles);
    if (!Array.isArray(options.providers) || options.providers.length !== 3) throw new TypeError("exactly one configuration per supported provider is required");
    const configuredProviders = options.providers.map((provider) => {
      validProviderIdentity(provider);
      return provider;
    });
    const runtime = await loadInstalledRuntime(snapshot.packageRoot);
  const tools = validateTools(runtime.tools);
  const clientFactory = runtime.clientFactory;
  const repairJsonWithClass = runtime.repairJsonWithClass;
  const adaptToolsForServer = runtime.adaptToolsForServer;
  if (typeof clientFactory !== "function" || typeof repairJsonWithClass !== "function" || typeof adaptToolsForServer !== "function") throw new TypeError("installed candidate runtime is incomplete");
  const digests = { archiveSha256, sourceCommit: options.sourceCommit };
  const endpoints = [];
  for (const provider of configuredProviders) {
    const expectedKind = validProviderIdentity(provider);
    const promptFixtures = TOOL_NAMES.flatMap((toolName) => Array.from({ length: 50 }, (_, index) => promptFor(toolName, index < 5)));
    const client = await clientFactory(provider, runtime);
    const discovery = await client.discoverAdvertisement();
    const detectedKind = client.getDetectedServerKind?.();
    if (discovery?.state !== "supported" || detectedKind !== expectedKind) {
      throw new Error(`provider identity mismatch: configured ${expectedKind}, detected ${detectedKind ?? "unknown"}`);
    }
    const providerTools = validateTools(adaptToolsForServer(detectedKind, tools));
    const counts = Object.fromEntries(TOOL_NAMES.map((name) => [name, {
      attempts: 50, native_valid: 0, repaired: 0, schema_invalid: 0, invalid: 0,
      hybrid_attempts: 5, hybrid_reasoning_present: 0, hybrid_schema_valid: 0,
    }]));
    for (const toolName of TOOL_NAMES) {
      const tool = providerTools.find((entry) => entry.function.name === toolName);
      const toolCounts = counts[toolName];
      for (let index = 0; index < 50; index++) {
        const hybrid = index < 5;
        let response;
        try {
          response = await client.chatCompletion([{ role: "user", content: promptFor(toolName, hybrid) }], [tool]);
        } catch {
          toolCounts.invalid++;
          continue;
        }
        const calls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
        if (calls.length !== 1 || calls[0]?.function?.name !== toolName) {
          toolCounts.invalid++;
          continue;
        }
        const classification = classifyToolArguments({
          schema: tool.function.parameters,
          rawArguments: calls[0].function.arguments,
          repairJsonWithClass,
        });
        toolCounts[classification.category]++;
        const reasoningMatch = /<think>\s*([\s\S]*?)\s*<\/think>/i.exec(typeof response.content === "string" ? response.content : "");
        const reasoningPresent = Boolean(reasoningMatch?.[1]?.trim());
        if (hybrid && reasoningPresent) toolCounts.hybrid_reasoning_present++;
        if (hybrid && classification.schemaValid) toolCounts.hybrid_schema_valid++;
      }
    }
    const totals = { attempts: 200, native_valid: 0, repaired: 0, schema_invalid: 0, invalid: 0 };
    for (const tool of Object.values(counts)) for (const category of categories) totals[category] += tool[category];
    const fixtureBytes = Buffer.from(promptFixtures.join("\n"), "utf8");
    const endpoint = {
      provider: provider.provider,
      serverKind: detectedKind,
      serverVersion: provider.serverVersion,
      imageDigest: provider.imageDigest,
      modelName: provider.modelName,
      modelDigest: provider.modelDigest,
      contextSize: provider.contextSize,
      sampling: provider.sampling,
      toolChoice: provider.toolChoice,
      promptFixtureSha256: sha256(fixtureBytes),
      serverFlags: provider.serverFlags,
      compatibilityMode: provider.compatibilityMode,
      attempts: 200,
      tools: counts,
      totals,
      passed: false,
    };
    endpoint.passed = endpointPasses(endpoint);
    endpoints.push(endpoint);
  }
  const evidence = { schemaVersion: 1, candidate: digests, endpoints };
  const validation = validateMatrixEvidence(evidence);
  evidence.passed = validation.passed;
  if (options.outputPath) writeEvidence(options.outputPath, evidence);
    return evidence;
  } finally {
    fs.rmSync(snapshot.snapshotRoot, { recursive: true, force: true });
  }
}

/** Write immutable JSON evidence and a detached SHA-256 sidecar. */
export function writeEvidence(outputPath, evidence) {
  validateMatrixEvidence(evidence);
  const destination = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const sidecar = `${destination}.sha256`;
  let wroteEvidence = false;
  try {
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o644 });
    wroteEvidence = true;
    fs.writeFileSync(sidecar, `${sha256(bytes)}  ${path.basename(destination)}\n`, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (wroteEvidence) fs.unlinkSync(destination);
    throw error;
  }
  return { path: destination, sha256: sha256(bytes), sidecar };
}

function readArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") throw new Error("usage: node eval/tool_grammar_matrix.mjs --config <private-config.json>");
  return JSON.parse(fs.readFileSync(argv[1], "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const config = readArgs(process.argv.slice(2));
    const evidence = await runToolGrammarMatrix(config);
    process.stdout.write(`${JSON.stringify({ candidate: evidence.candidate, providers: evidence.endpoints.map(({ provider, passed, totals }) => ({ provider, passed, totals })) })}\n`);
    process.exitCode = evidence.endpoints.every((endpoint) => endpoint.passed) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`tool grammar matrix failed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
