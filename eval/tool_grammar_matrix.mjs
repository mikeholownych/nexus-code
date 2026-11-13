import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TOOL_NAMES = Object.freeze(["read_file", "write_file", "edit_file", "run_command"]);
const PROVIDER_KIND = Object.freeze({ llamacpp: "llamacpp", vllm: "vllm", ollama: "ollama", gateway: "gateway" });
const DIRECT_KINDS = Object.freeze(Object.keys(PROVIDER_KIND).filter((name) => name !== "gateway"));
const digestPattern = /^sha256:[a-f0-9]{64}$/i;
const PROVIDER_SET_MESSAGE = "llama.cpp, vLLM, and Ollama endpoints, or gateway-routed models";

/** A gateway entry may omit the image and model digests it cannot attest (it is pinned by `limits_version`); a digest that is present must still be well formed. */
function checkDigest(entry, field, message) {
  if (entry.provider === "gateway" && entry[field] === undefined) return;
  if (typeof entry[field] !== "string" || !digestPattern.test(entry[field])) throw new TypeError(message);
}

/** Either the three direct servers exactly once each, or one or more distinct gateway-routed models; never a mix. */
function assertProviderSet(entries, what) {
  const gateway = entries.filter((entry) => entry?.provider === "gateway");
  if (gateway.length === 0) {
    if (entries.length !== DIRECT_KINDS.length) throw new TypeError(`${what} must contain ${PROVIDER_SET_MESSAGE}`);
    const kinds = new Set(entries.map((entry) => entry?.provider));
    if (kinds.size !== DIRECT_KINDS.length) throw new TypeError(`${what} repeats a provider identity or is missing one`);
    return;
  }
  if (gateway.length !== entries.length) throw new TypeError(`${what} must not mix gateway-routed models with direct servers`);
  if (new Set(gateway.map((entry) => entry.modelName)).size !== gateway.length) throw new TypeError(`${what} repeats a provider identity (gateway model)`);
}
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
  checkDigest(endpoint, "imageDigest", "server identity requires an immutable image digest");
  if (typeof endpoint.modelName !== "string" || !endpoint.modelName.trim()) throw new TypeError("model identity requires a name");
  checkDigest(endpoint, "modelDigest", "model identity requires an immutable model digest");
  assertCount(endpoint.contextSize, "context size");
  if (endpoint.contextSize === 0) throw new TypeError("context size must be positive");
  if (!isRecord(endpoint.sampling) || !Number.isFinite(endpoint.sampling.temperature)) throw new TypeError("sampling identity requires the temperature sent by the candidate");
  if (endpoint.sampling.max_tokens !== undefined && (!Number.isSafeInteger(endpoint.sampling.max_tokens) || endpoint.sampling.max_tokens <= 0)) throw new TypeError("sampling max_tokens must be a positive integer");
  if (endpoint.toolChoice !== "auto") throw new TypeError("tool choice must match the candidate client's auto selection");
  if (typeof endpoint.promptFixtureSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(endpoint.promptFixtureSha256)) throw new TypeError("prompt fixture identity requires SHA-256");
  if (!Array.isArray(endpoint.serverFlags) || endpoint.serverFlags.some((flag) => typeof flag !== "string")) throw new TypeError("server flags identity must be a string array");
  if (endpoint.serverFlags.some((flag) => /api[-_]?key|token|secret|password|credential|authorization|bearer/i.test(flag))) throw new TypeError("server flags must omit credentials and authentication options");
  if (typeof endpoint.compatibilityMode !== "string" || !endpoint.compatibilityMode.trim()) throw new TypeError("compatibility mode identity is required");
  for (const field of ["throttledRetries", "requestIntervalMs"]) {
    if (endpoint[field] !== undefined) assertCount(endpoint[field], field);
  }
  if (endpoint.workers !== undefined && (!Array.isArray(endpoint.workers) || endpoint.workers.some((worker) => typeof worker !== "string" || !worker.trim()))) throw new TypeError("workers must be a list of non-empty strings");
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
  if (!isRecord(evidence.candidate) || !sha256Pattern.test(evidence.candidate.archiveSha256) || !commitPattern.test(evidence.candidate.sourceCommit) || !commitPattern.test(evidence.candidate.sourceTree)) {
    throw new TypeError("candidate identity requires archive SHA-256, full source commit and source tree id");
  }
  if (!Array.isArray(evidence.endpoints) || evidence.endpoints.length === 0) throw new TypeError(`matrix evidence must contain ${PROVIDER_SET_MESSAGE}`);
  for (const endpoint of evidence.endpoints) validateEndpoint(endpoint);
  assertProviderSet(evidence.endpoints, "matrix evidence");
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

/**
 * Release archives ship exactly one kind of symlink: a relative link in `node_modules/.bin` that stays inside
 * `node_modules`. `relative` is the package-relative path (no leading `nexus/`). Every other link is rejected.
 */
function resolveConfinedBinLink(relative, target) {
  const binDir = "lib/cli/node_modules/.bin/";
  if (!relative.startsWith(binDir) || typeof target !== "string" || !target || target.startsWith("/") || /[\r\n\\\0]/.test(target)) return undefined;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  return resolved.startsWith("lib/cli/node_modules/") && !resolved.startsWith(binDir) ? resolved : undefined;
}

function listArchiveEntries(archivePath) {
  const names = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
  if (names.at(-1) === "") names.pop();
  const types = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
  if (types.at(-1) === "") types.pop();
  if (names.length === 0 || names.length !== types.length) throw new TypeError("candidate archive entry listing is malformed");
  const seen = new Set();
  const regularFiles = new Set();
  const links = [];
  for (let index = 0; index < names.length; index++) {
    const parsed = archiveEntryPath(names[index]);
    if (seen.has(parsed.relative)) throw new TypeError("candidate archive contains duplicate paths");
    seen.add(parsed.relative);
    const type = types[index]?.[0];
    if (type === "l" && !parsed.directory) {
      const target = types[index].split(`${names[index]} -> `)[1];
      const resolved = resolveConfinedBinLink(parsed.relative.slice("nexus/".length), target);
      if (resolved !== undefined) {
        links.push({ relative: parsed.relative, resolved });
        continue;
      }
    }
    if ((parsed.directory && type !== "d") || (!parsed.directory && type !== "-")) {
      throw new TypeError("candidate archive contains a symlink, hard link, or non-regular entry");
    }
    if (!parsed.directory) regularFiles.add(parsed.relative.slice("nexus/".length));
  }
  // tar extracts before the tree is verified: a link must resolve to a regular file in the archive and nothing may be written beneath a link.
  for (const link of links) {
    if (!regularFiles.has(link.resolved)) throw new TypeError("candidate archive contains a symlink that is not confined to a manifested file");
    if (seen.has(`${link.relative}/`) || [...seen].some((entry) => entry.startsWith(`${link.relative}/`))) throw new TypeError("candidate archive writes beneath a symlink");
  }
  return names;
}

function verifyPackageTree(packageRoot) {
  const rootStat = fs.lstatSync(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError("candidate package root is not a real directory");
  const files = new Set();
  const links = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        const relative = path.relative(packageRoot, fullPath).split(path.sep).join("/");
        const target = fs.readlinkSync(fullPath);
        if (resolveConfinedBinLink(relative, target) === undefined) throw new TypeError("candidate package contains a symlink");
        links.set(relative, target);
        continue;
      }
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
  for (const [relative, target] of links) {
    if (!expected.has(resolveConfinedBinLink(relative, target))) throw new TypeError(`candidate package symlink does not point at a manifested file: ${relative}`);
  }
  expected.set("MANIFEST.sha256", sha256(fs.readFileSync(manifestPath)));
  return { files: expected, links };
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
    const { files: packageFiles, links: packageLinks } = verifyPackageTree(packageRoot);
    return { snapshotRoot, packageRoot, packageFiles, packageLinks };
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
  checkDigest(provider, "imageDigest", "immutable server image digest must be pinned before inference");
  if (typeof provider.modelName !== "string" || !provider.modelName.trim()) throw new TypeError("model identity requires a name");
  checkDigest(provider, "modelDigest", "immutable model digest must be pinned before inference");
  if (!Number.isSafeInteger(provider.contextSize) || provider.contextSize <= 0) throw new TypeError("positive context size must be pinned before inference");
  if (!isRecord(provider.sampling) || !Number.isFinite(provider.sampling.temperature)) throw new TypeError("sampling temperature must be pinned before inference");
  if (provider.sampling.max_tokens !== undefined && (!Number.isSafeInteger(provider.sampling.max_tokens) || provider.sampling.max_tokens <= 0)) throw new TypeError("sampling max_tokens must be a positive integer");
  if (provider.toolChoice !== "auto") throw new TypeError("tool choice must be auto for the candidate client");
  if (!Array.isArray(provider.serverFlags) || provider.serverFlags.some((flag) => typeof flag !== "string")) throw new TypeError("server flags must be pinned before inference");
  if (provider.serverFlags.some((flag) => /api[-_]?key|token|secret|password|credential|authorization|bearer/i.test(flag))) {
    throw new TypeError("server flags must omit credentials and authentication options before inference");
  }
  if (typeof provider.compatibilityMode !== "string" || !provider.compatibilityMode.trim()) throw new TypeError("compatibility mode must be pinned before inference");
  for (const field of ["requestIntervalMs", "rateLimitRetries", "rateLimitDelayMs"]) {
    if (provider[field] !== undefined) assertCount(provider[field], field);
  }
  return expected;
}

function verifyInstalledArchive(installRoot, archiveSha256, sourceCommit, expectedPackageFiles, expectedPackageLinks) {
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
  const installedLinks = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(resolvedInstallRoot, fullPath).split(path.sep).join("/");
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        if (resolveConfinedBinLink(relative, target) === undefined) throw new TypeError("installed candidate package contains a symlink");
        installedLinks.set(relative, target);
        continue;
      }
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) {
        if (relative !== ".provenance.json") installedFiles.set(relative, sha256(fs.readFileSync(fullPath)));
      } else {
        throw new TypeError("installed candidate package contains a non-regular file");
      }
    }
  };
  walk(resolvedInstallRoot);
  if (installedLinks.size !== expectedPackageLinks.size || [...expectedPackageLinks].some(([relative, target]) => installedLinks.get(relative) !== target)) {
    throw new TypeError("installed candidate symlinks do not match the verified archive");
  }
  if (installedFiles.size !== expectedPackageFiles.size || [...expectedPackageFiles.keys()].some((relative) => !installedFiles.has(relative))) {
    throw new TypeError("installed candidate package file set does not match the verified archive manifest");
  }
  for (const [relative, expectedDigest] of expectedPackageFiles) {
    if (installedFiles.get(relative) !== expectedDigest) {
      throw new TypeError(`installed candidate file does not match the verified archive manifest: ${relative}`);
    }
  }
}

/** Every git call of the matrix runner: replace refs ignored, an explicit large buffer (listings of big repos exceed 1 MiB). */
function runGit(root, args, options = {}) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    ...options, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

function verifyCandidateCheckout(checkoutRoot, sourceCommit, sourceTree) {
  if (typeof sourceTree !== "string" || !commitPattern.test(sourceTree)) throw new TypeError("pinned candidate source tree id (40 hex) is required");
  if (typeof checkoutRoot !== "string" || !checkoutRoot) throw new TypeError("explicit candidate Git checkout root is required");
  const resolvedRoot = path.resolve(checkoutRoot);
  const stat = fs.lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new TypeError("candidate checkout root must be a real directory");
  }
  const git = (args) => runGit(resolvedRoot, args).trim();
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
  verifyCheckoutContent(resolvedRoot, git, sourceTree);
  return head;
}

/**
 * Bind the measured candidate to checkout CONTENT, not only the commit id. `git status` can be blind (assume-unchanged,
 * skip-worktree) and ignores ignored files, so the worktree is re-read: the tree id must equal the pinned one, every
 * tracked file's bytes must hash to its recorded blob id, and no untracked or ignored file may exist.
 */
function verifyCheckoutContent(root, git, sourceTree) {
  if (git(["for-each-ref", "--count=1", "refs/replace"])) throw new TypeError("candidate checkout has git replace refs, which can make a commit id stand for other content");
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  if (tree.toLowerCase() !== sourceTree.toLowerCase()) throw new TypeError("candidate checkout source tree does not match the pinned tree id");
  const extra = runGit(root, ["ls-files", "-z", "--others"]).split("\0").filter(Boolean);
  if (extra.length > 0) throw new TypeError(`candidate checkout has untracked or ignored files (extra content): ${extra[0]}`);
  const listing = runGit(root, ["ls-tree", "-r", "-z", "HEAD"]).split("\0").filter(Boolean);
  const regular = [];
  for (const line of listing) {
    const tab = line.indexOf("\t");
    const [mode, type, blob] = line.slice(0, tab).split(" ");
    const relative = line.slice(tab + 1);
    if (type !== "blob" || mode === "160000") throw new TypeError(`candidate checkout contains an unsupported entry: ${relative}`);
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    if (mode === "120000") {
      const target = runGit(root, ["hash-object", "--stdin"], { input: fs.readlinkSync(full) }).trim();
      if (target !== blob) throw new TypeError(`checkout content does not match the pinned tree: ${relative}`);
    } else {
      if (!stat.isFile()) throw new TypeError(`checkout content does not match the pinned tree: ${relative}`);
      // The recorded mode is authoritative whatever core.fileMode says: an exec bit must match the tree's 100755/100644.
      if (((stat.mode & 0o100) !== 0) !== (mode === "100755")) throw new TypeError(`checkout file mode does not match the pinned tree (executable bit): ${relative}`);
      regular.push({ relative, blob });
    }
  }
  if (regular.length > 0) {
    const hashes = runGit(root, ["hash-object", "--no-filters", "--stdin-paths"], { input: regular.map(({ relative }) => relative).join("\n") + "\n" }).trim().split("\n");
    regular.forEach(({ relative, blob }, index) => {
      if (hashes[index] !== blob) throw new TypeError(`checkout content does not match the pinned tree: ${relative}`);
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRateLimited = (error) => /\bHTTP 429\b/.test(String(error?.message ?? error));

/** Invoke the exact installed candidate client for 50 attempts/tool and retain only non-secret aggregate evidence. */
export async function runToolGrammarMatrix(options) {
  if (!options || typeof options.archivePath !== "string" || typeof options.installRoot !== "string") throw new TypeError("candidate archive and installed root are required");
  if (Object.hasOwn(options, "runtime")) throw new TypeError("caller-supplied runtime is not accepted; runtime must be loaded from the installed candidate");
  if (Object.hasOwn(options, "tools")) throw new TypeError("tool schemas must be loaded from the exact installed candidate");
  if (!commitPattern.test(options.sourceCommit)) throw new TypeError("full candidate source commit is required");
  verifyCandidateCheckout(options.candidateCheckoutRoot, options.sourceCommit, options.sourceTree);
  if (typeof options.archiveSha256 !== "string" || !sha256Pattern.test(options.archiveSha256)) {
    throw new TypeError("pinned candidate archive SHA-256 is required");
  }
  const archivePath = fs.realpathSync(options.archivePath);
  const archiveSha256 = sha256(fs.readFileSync(archivePath));
  if (options.archiveSha256.replace(/^sha256:/i, "").toLowerCase() !== archiveSha256) throw new TypeError("candidate archive SHA-256 does not match the pinned digest");
  const snapshot = createVerifiedArchiveSnapshot(archivePath, archiveSha256);
  try {
    verifyInstalledArchive(options.installRoot, archiveSha256, options.sourceCommit, snapshot.packageFiles, snapshot.packageLinks);
    if (!Array.isArray(options.providers) || options.providers.length === 0) throw new TypeError("provider configurations are required");
    const configuredProviders = options.providers.map((provider) => {
      validProviderIdentity(provider);
      return provider;
    });
    assertProviderSet(configuredProviders, "provider configuration");
    const runtime = await loadInstalledRuntime(snapshot.packageRoot);
  const tools = validateTools(runtime.tools);
  const clientFactory = runtime.clientFactory;
  const repairJsonWithClass = runtime.repairJsonWithClass;
  const adaptToolsForServer = runtime.adaptToolsForServer;
  if (typeof clientFactory !== "function" || typeof repairJsonWithClass !== "function" || typeof adaptToolsForServer !== "function") throw new TypeError("installed candidate runtime is incomplete");
  const digests = { archiveSha256, sourceCommit: options.sourceCommit, sourceTree: options.sourceTree.toLowerCase() };
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
    const workers = expectedKind === "gateway" ? [...(discovery.advertised?.workers ?? [])].sort() : undefined;
    if (expectedKind === "gateway" && discovery.advertised?.limitsVersion !== provider.serverVersion) {
      throw new Error(`gateway limits_version mismatch: pinned ${provider.serverVersion}, advertised ${discovery.advertised?.limitsVersion ?? "none"}`);
    }
    const providerTools = validateTools(adaptToolsForServer(detectedKind, tools));
    const counts = Object.fromEntries(TOOL_NAMES.map((name) => [name, {
      attempts: 50, native_valid: 0, repaired: 0, schema_invalid: 0, invalid: 0,
      hybrid_attempts: 5, hybrid_reasoning_present: 0, hybrid_schema_valid: 0,
    }]));
    // A rate-limited reply says nothing about tool-call validity, so a provider may budget retries for HTTP 429
    // (spent retries are recorded); a refusal that outlasts the budget is still an invalid attempt.
    const retryBudget = provider.rateLimitRetries ?? 0;
    const interval = provider.requestIntervalMs ?? 0;
    let throttledRetries = 0;
    let lastStarted = 0;
    const complete = async (messages, offered) => {
      for (let retry = 0; ; retry++) {
        const wait = lastStarted + interval - Date.now();
        if (wait > 0) await sleep(wait);
        lastStarted = Date.now();
        try {
          return await client.chatCompletion(messages, offered);
        } catch (error) {
          if (!isRateLimited(error) || retry >= retryBudget) throw error;
          throttledRetries++;
          await sleep(provider.rateLimitDelayMs ?? 0);
        }
      }
    };
    for (const toolName of TOOL_NAMES) {
      const tool = providerTools.find((entry) => entry.function.name === toolName);
      const toolCounts = counts[toolName];
      for (let index = 0; index < 50; index++) {
        const hybrid = index < 5;
        let response;
        try {
          response = await complete([{ role: "user", content: promptFor(toolName, hybrid) }], [tool]);
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
        // The gateway returns model reasoning in a separate reasoning_content channel rather than as a <think> block in content.
        const channelReasoning = provider.provider === "gateway" && typeof response.reasoning_content === "string" && response.reasoning_content.trim() !== "";
        const reasoningPresent = Boolean(reasoningMatch?.[1]?.trim()) || channelReasoning;
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
      ...(provider.imageDigest !== undefined ? { imageDigest: provider.imageDigest } : {}),
      modelName: provider.modelName,
      ...(provider.modelDigest !== undefined ? { modelDigest: provider.modelDigest } : {}),
      ...(workers && workers.length > 0 ? { workers } : {}),
      ...(retryBudget > 0 ? { throttledRetries } : {}),
      ...(interval > 0 ? { requestIntervalMs: interval } : {}),
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
