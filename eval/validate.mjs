// Checks that make an evaluation run valid before it starts (SPEC-10, REQ-QUAL-101/102/106): every task is well formed,
// a qualification run records which model actually answered (a fingerprint, not an alias), and hidden tests are out of
// the agent's reach when the agent runs as its own user.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assertNoSymlinks, candidateSandboxHostMountSources, confinedPath, runtimeMountProblem, sandboxAvailable } from "./isolate.mjs";
import { blackBoxOracleProblem } from "./oracle.mjs";
import { t3TaskProblems } from "./t3.mjs";
import { resourceProbeProblem } from "./resources.mjs";

export const TIERS = ["T1", "T2", "T3", "T4"];
export const CLASSES = ["bugfix", "feature", "refactor", "debug"];
export const DIFFICULTIES = ["easy", "medium", "hard"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Problems with one task.json (empty when valid). `qualification` adds the fields held-out tasks must carry. */
export function validateTask(task, dir, { qualification = false } = {}) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(typeof task.id === "string" && task.id === path.basename(dir), `id must equal its directory name (${path.basename(dir)})`);
  need(TIERS.includes(task.tier), `tier must be one of ${TIERS.join(", ")}`);
  need(typeof task.objective === "string" && task.objective.trim().length > 0, "objective is required");
  problems.push(...t3TaskProblems(task));
  need(Boolean(task.fixture) !== Boolean(task.repo), "exactly one of fixture or repo is required");
  if (task.fixture) {
    try { confinedPath(dir, task.fixture); }
    catch (error) { need(false, error.message); }
  }
  if (task.repo) {
    need(typeof task.repo.url === "string" && task.repo.url.length > 0, "repo.url is required");
    try {
      const repoUrl = new URL(task.repo.url);
      need(repoUrl.protocol === "https:" && !repoUrl.username && !repoUrl.password, "repo.url must use HTTPS without embedded credentials");
    } catch { need(false, "repo.url must be a valid HTTPS URL without embedded credentials"); }
    need(/^[0-9a-f]{40}$/.test(task.repo.commit ?? ""), "repo.commit must be a full 40-character commit id (pinned)");
  }
  const hiddenCommand = typeof task.hidden?.command === "string" && task.hidden.command.length > 0;
  const hiddenOracle = task.hidden?.protocol === "blackbox-v1";
  need(hiddenCommand || hiddenOracle, "hidden.command or hidden blackbox-v1 oracle is required");
  if (hiddenOracle) {
    const oracleProblem = blackBoxOracleProblem(task.hidden, dir, task.fixture ?? null);
    need(!oracleProblem, oracleProblem ?? "hidden black-box oracle is invalid");
  }
  // Legacy validators execute candidate modules in the same runtime. File hiding and a fresh workspace cannot prevent
  // candidate code from inspecting or mutating that runtime, so they are never valid independent qualification.
  if (qualification) need(hiddenOracle && !hiddenCommand, "qualification requires the isolated blackbox-v1 hidden oracle; in-process legacy validators are not accepted");
  if (task.hidden?.dir) {
    try { confinedPath(dir, task.hidden.dir); }
    catch (error) { need(false, error.message); }
  }
  if (task.regression?.dir) {
    try { confinedPath(dir, task.regression.dir); }
    catch (error) { need(false, error.message); }
  }
  for (const key of ["steps", "minutes"]) {
    if (task[key] !== undefined) need(Number.isInteger(task[key]) && task[key] > 0, `${key} must be a positive integer`);
  }
  if (task.faults !== undefined) {
    const kinds = ["refuse", "overloaded", "stream_cut", "truncate", "context_overflow", "malformed_tool_json"];
    need(Array.isArray(task.faults) && task.faults.every((f) => kinds.includes(f?.kind) && Number.isInteger(f?.atRequest) && f.atRequest >= 1), `faults must be [{ kind: ${kinds.join("|")}, atRequest: n >= 1 }]`);
  }
  if (task.class !== undefined || qualification) need(CLASSES.includes(task.class), `class must be one of ${CLASSES.join(", ")}`);
  if (task.difficulty !== undefined || qualification) need(DIFFICULTIES.includes(task.difficulty), `difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  return problems;
}

/**
 * What a run's model is, beyond its alias: from the endpoint's /models entry (id, owner, advertised context) and the
 * operator's config (`fingerprint`: weights sha256, server build; `sampling`: temperature, seed). A qualification config
 * that cannot state weights, server build and sampling is refused (REQ-QUAL-102).
 */
export function modelFingerprint(config, entry) {
  const fp = config.fingerprint ?? {};
  const sampling = config.sampling ?? null;
  const fingerprint = {
    alias: config.model,
    listed: Boolean(entry),
    ownedBy: entry?.owned_by ?? null,
    contextLength: entry?.context_length ?? entry?.max_model_len ?? entry?.meta?.n_ctx_train ?? null,
    weightsSha256: fp.weightsSha256 ?? null,
    serverBuild: fp.serverBuild ?? null,
    sampling,
  };
  const missing = [];
  if (config.qualification) {
    if (!fingerprint.listed) missing.push(`the endpoint does not list model ${config.model}`);
    if (!/^[0-9a-f]{64}$/.test(fingerprint.weightsSha256 ?? "")) missing.push("fingerprint.weightsSha256 (sha256 of the served weights file)");
    if (!fingerprint.serverBuild) missing.push("fingerprint.serverBuild (inference server name and build)");
    if (!sampling || typeof sampling.temperature !== "number") missing.push("sampling.temperature (and sampling.seed where the server supports one)");
  }
  return { fingerprint, missing };
}

/** Compare the requested Nexus output/context limits with the limits exposed by the serving endpoint. */
export function nexusLimitsProblem(config, entry) {
  const limits = config.limits;
  if (!limits || !Number.isInteger(limits.context) || limits.context <= 0 || !Number.isInteger(limits.output) || limits.output <= 0) {
    return "qualification requires explicit positive limits.context and limits.output for matched peer settings";
  }
  const advertisedContext = positiveInt(entry?.context_length) ?? positiveInt(entry?.max_model_len) ?? positiveInt(entry?.meta?.n_ctx_train);
  if (advertisedContext && limits.context > advertisedContext) {
    return `configured context limit ${limits.context} exceeds the installed Nexus provider limit ${advertisedContext}`;
  }
  const context = advertisedContext ? Math.min(advertisedContext, limits.context) : limits.context;
  const advertisedOutput = positiveInt(entry?.max_completion_tokens);
  const actualOutput = Math.max(1, Math.min(advertisedOutput ?? Math.min(8192, Math.floor(context / 4)), Math.floor(context / 2)));
  if (limits.output !== actualOutput) {
    return `Nexus output allowance ${actualOutput} differs from matched peer limit ${limits.output}`;
  }
  return null;
}

/** Select an explicit operator override or let standalone server profiles discover their own context limit. */
export function nexusContextLimitArgs(config, defaultContext) {
  if (config.serverProfile && config.limits?.context === undefined) return [];
  const context = config.limits?.context ?? defaultContext;
  return Number.isSafeInteger(context) && context > 0 ? ["--context-limit", String(context)] : [];
}

export function qualificationBudgetProblem(config) {
  const limits = config.limits;
  for (const key of ["output", "requests", "totalOutput"]) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1) {
      return `qualification requires a frozen positive limits.${key} cap for proxy enforcement`;
    }
  }
  if (limits.totalOutput < limits.output) return "qualification limits.totalOutput cannot be lower than limits.output";
  return null;
}

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function resolveCanonicalOrLexical(source) {
  if (typeof source !== "string" || !path.isAbsolute(source)) return null;
  const lexical = path.resolve(source);
  let current = lexical;
  const suffix = [];
  while (true) {
    try {
      return { lexical, canonical: path.resolve(fs.realpathSync(current), ...suffix) };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { lexical, canonical: lexical };
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function overlapVariants(left, right) {
  return [left.lexical, left.canonical].some((a) => [right.lexical, right.canonical].some((b) => pathOverlaps(a, b)));
}

/** Refuse candidate runtime mounts that could expose the task tree or its private corpus store. */
export function runtimeCorpusOverlapProblem(runtimePaths, runtimeRoots, tasksDir, extraPrivatePaths = [], mountContext = {}) {
  if (!Array.isArray(runtimePaths) || !Array.isArray(runtimeRoots) || !Array.isArray(extraPrivatePaths)) {
    return "qualification runtime and corpus paths must be explicit arrays";
  }
  const taskPath = resolveCanonicalOrLexical(tasksDir);
  if (!taskPath || !fs.existsSync(tasksDir)) return "qualification task corpus path is unavailable";
  // Held-out stores keep tasks/, references/, and custody material under one directory. Keep that parent private
  // outside the in-repo development eval/tasks tree, where eval/ also contains the trusted sandbox supervisor.
  const parentDir = resolveCanonicalOrLexical(path.dirname(tasksDir));
  const evalDir = resolveCanonicalOrLexical(path.join(ROOT, "eval"));
  const includeParent = mountContext.qualification === true || parentDir.canonical !== evalDir.canonical;
  const privatePaths = [tasksDir, ...(includeParent ? [path.dirname(tasksDir)] : []), ...extraPrivatePaths];
  const protectedPaths = [];
  for (const item of privatePaths) {
    const resolved = resolveCanonicalOrLexical(item);
    if (!resolved) return "qualification private corpus paths must be absolute";
    protectedPaths.push({ source: item, resolved, exists: fs.existsSync(item) });
  }
  for (const item of [...runtimePaths, ...runtimeRoots]) {
    if (typeof item !== "string" || !path.isAbsolute(item)) return "qualification runtime paths and roots must be absolute";
    if (!fs.existsSync(item)) return `qualification runtime path is unavailable: ${item}`;
  }
  const mountSources = candidateSandboxHostMountSources({
    readOnlyPaths: runtimePaths,
    supervisorPath: mountContext.supervisorPath ?? path.join(ROOT, "eval/agent_sandbox.mjs"),
    nodeRuntime: mountContext.nodeRuntime ?? process.execPath,
    cwd: mountContext.cwd,
    home: mountContext.home,
    proxyDirectory: mountContext.proxyDirectory,
  });
  const hostSources = [
    ...mountSources.systemDirectories,
    ...mountSources.systemFiles,
    ...mountSources.systemEtcDirectories,
    ...mountSources.toolchainDirectories,
    ...Object.values(mountSources.runtimeSources).flatMap((value) => Array.isArray(value) ? value : value === null ? [] : [value]),
  ];
  const candidatePaths = [...new Set([...hostSources, ...runtimePaths, ...runtimeRoots])];
  const candidates = [];
  for (const item of candidatePaths) {
    const resolved = resolveCanonicalOrLexical(item);
    if (!resolved) return "qualification runtime paths and roots must be absolute";
    candidates.push({ source: item, resolved });
  }
  for (const candidate of candidates) {
    for (const protectedPath of protectedPaths) {
      if (overlapVariants(candidate.resolved, protectedPath.resolved)) {
        return `qualification runtime mount overlaps protected corpus material: ${candidate.source}`;
      }
    }
  }
  const unavailablePrivate = protectedPaths.find((item) => !item.exists);
  if (unavailablePrivate) return `qualification private corpus path is unavailable: ${unavailablePrivate.source}`;
  return null;
}

function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Reads the endpoint's /models entry for the configured model (through the run's proxy, so CA handling is shared). */
export async function fetchModelEntry(baseUrl, model, apiKey) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data.find((e) => e?.id === model) ?? null : null;
  } catch {
    return null;
  }
}

/** Qualification requires an evaluator UID, working Bubblewrap namespaces, and explicit safe runtime mount roots. */
export function hiddenTestIsolationProblem(config, tasksDir) {
  if (config.qualification && Array.isArray(config.sandboxRuntimePaths) && Array.isArray(config.sandboxRuntimeRoots)) {
    const corpusPaths = [
      config.corpusCustody?.reportPath,
      config.corpusCustody?.storeRoot,
      config.corpusCustody?.validatorPath,
      config.corpusCustody?.referencePath,
      config.corpusCustody?.authorLogPath,
    ].filter((item) => item !== undefined);
    const corpusOverlap = runtimeCorpusOverlapProblem(config.sandboxRuntimePaths, config.sandboxRuntimeRoots, tasksDir, corpusPaths, { ...(config.mountContext ?? {}), qualification: Boolean(config.qualification) });
    if (corpusOverlap) return corpusOverlap;
  }
  if (!config.runAs) return config.qualification ? "qualification runs need runAs (the agent's own user) so hidden tests are unreadable to it" : null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.runAs)) return `runAs '${config.runAs}' is not a valid user name`;
  if (!sandboxAvailable()) return "Bubblewrap is unavailable; qualification commands must fail closed";
  const account = fs.readFileSync("/etc/passwd", "utf8").split(/\r?\n/).map((line) => line.split(":" )).find((parts) => parts[0] === config.runAs);
  if (!account) return `qualification evaluator account '${config.runAs}' is unavailable`;
  if (Number(account[2]) === process.getuid()) return "qualification evaluator account must differ from the harness uid";
  if (!fs.existsSync("/usr/bin/setfacl")) return "setfacl is unavailable; refusing unsafe workspace permission changes";
  if (!Array.isArray(config.sandboxRuntimePaths) || config.sandboxRuntimePaths.some((item) => typeof item !== "string" || !path.isAbsolute(item))) {
    return "qualification requires explicit absolute sandboxRuntimePaths for the agent runtime";
  }
  if (!Array.isArray(config.sandboxRuntimeRoots) || config.sandboxRuntimeRoots.length === 0) {
    return "qualification requires explicit sandboxRuntimeRoots for the agent runtime allowlist";
  }
  const mountProblem = runtimeMountProblem(config.sandboxRuntimePaths, config.sandboxRuntimeRoots);
  if (mountProblem) return mountProblem;
  if (config.qualification) return qualificationResourceIsolationProblem(config);
  return null;
}

/** Qualification needs the kernel-enforced resource contract (eval/resources.mjs), proved on this host before any run. */
export function qualificationResourceIsolationProblem(config = {}) {
  if (config.resources === undefined) {
    return "qualification is blocked until the candidate and validators inherit enforced CPU, memory, process-count, and workspace-storage limits (set resources)";
  }
  return resourceProbeProblem(config.resources);
}

/** A deterministic digest of task content. Symlinks are rejected instead of followed. */
export function taskTreeDigest(dir) {
  assertNoSymlinks(dir);
  const hash = createHash("sha256");
  hash.update("nexus-task-tree-v2\0");
  const frame = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size);
    hash.update(bytes);
  };
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = path.join(current, entry.name);
      const relative = path.relative(dir, item).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hash.update("D");
        frame(relative);
        walk(item);
      } else if (entry.isFile()) {
        hash.update("F");
        frame(relative);
        const stat = fs.statSync(item);
        frame(String(stat.mode & 0o111));
        frame(fs.readFileSync(item));
      }
      else throw new Error(`unsupported task entry: ${relative}`);
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** Build the task identity rows that a frozen, externally approved corpus manifest must bind. */
export function corpusTaskRows(tasksDir, ids) {
  return [...ids].sort().map((id) => {
    const dir = confinedPath(tasksDir, id);
    const taskFile = confinedPath(dir, "task.json");
    const treeSha256 = taskTreeDigest(dir);
    const taskSha256 = createHash("sha256").update(fs.readFileSync(taskFile)).digest("hex");
    return { id, taskSha256, treeSha256 };
  });
}

const HELDOUT_V2_HASH_SCHEME = {
  task_sha256: "sha256 of raw tasks/<id>/task.json bytes",
  hidden_sha256: "sha256 of sorted '<path>  <sha256(file)>\\n' lines over tasks/<id>/<hidden.dir> (bin/hidden_digest.mjs)",
};

/**
 * The custodian's hidden-directory digest (heldout-v2 hash_scheme): regular files only, paths relative to the hidden
 * directory with "/" separators, sorted byte-wise by path, each line `<path>  <sha256(bytes)>\n`.
 */
export function heldoutHiddenDigest(hiddenDir) {
  assertNoSymlinks(hiddenDir);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(item);
      else if (entry.isFile()) files.push([path.relative(hiddenDir, item).split(path.sep).join("/"), item]);
    }
  };
  walk(hiddenDir);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = createHash("sha256");
  for (const [relative, file] of files) hash.update(`${relative}  ${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}\n`);
  return hash.digest("hex");
}

/**
 * The sealed T2 corpus (eval/heldout-manifest.json) uses the custodian's heldout-v2 schema, which binds each task's
 * task.json and hidden directory and carries no custody fields: custody is stated in the frozen config (corpusCustody)
 * with the committed custody report pinned by digest; the reviewer still verifies the report's content.
 * Limit: the manifest binds task.json and hidden.dir only, not other files in a task directory.
 */
function heldoutV2ManifestProblem(config, tasksDir, ids, manifest) {
  if (JSON.stringify(manifest.hash_scheme) !== JSON.stringify(HELDOUT_V2_HASH_SCHEME)) return "qualification corpus manifest uses an unknown hash scheme";
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 1 || manifest.tasks.length !== manifest.task_count) return "qualification corpus manifest task list is empty or does not match its task_count";
  const custody = config.corpusCustody;
  if (typeof custody?.custodian !== "string" || !custody.custodian.trim() || Number.isNaN(Date.parse(custody?.approvedAt ?? "")) || typeof custody?.reportPath !== "string" || !/^[0-9a-f]{64}$/.test(custody?.reportSha256 ?? "")) {
    return "a heldout-v2 corpus needs corpusCustody { custodian, approvedAt, reportPath, reportSha256 } in the frozen config";
  }
  try {
    if (createHash("sha256").update(fs.readFileSync(custody.reportPath)).digest("hex") !== custody.reportSha256) return "the custody report differs from corpusCustody.reportSha256";
  } catch { return "the custody report named by corpusCustody.reportPath is unavailable"; }
  const sealed = [...manifest.tasks].map((t) => t.id).sort();
  if (JSON.stringify(sealed) !== JSON.stringify([...ids].sort())) return "qualification task population differs from the frozen corpus manifest";
  for (const row of manifest.tasks) {
    try {
      const dir = confinedPath(tasksDir, row.id);
      const taskFile = confinedPath(dir, "task.json");
      const raw = fs.readFileSync(taskFile);
      if (createHash("sha256").update(raw).digest("hex") !== row.task_sha256) return `task ${row.id}: task.json differs from the frozen corpus manifest`;
      const task = JSON.parse(raw.toString("utf8"));
      if (Object.hasOwn(task, "fixture") && !task.repo) {
        if (typeof row.sha256 !== "string") return `corpusManifest task ${row.id} uses a local fixture without a full-tree sha256 digest in the v2 manifest`;
        if (taskTreeDigest(dir) !== row.sha256) return `task ${row.id}: local fixture full-tree sha256 differs from the v2 manifest`;
      }
      const hiddenDir = task.hidden?.dir;
      if (typeof hiddenDir !== "string" || !hiddenDir) return `task ${row.id}: sealed task has no hidden.dir`;
      if (heldoutHiddenDigest(confinedPath(dir, hiddenDir)) !== row.hidden_sha256) return `task ${row.id}: hidden tests differ from the frozen corpus manifest`;
    } catch (error) {
      return `qualification task content cannot be safely hashed: ${error.message}`;
    }
  }
  return null;
}

/** Verify both the committed manifest pin and the exact selected task population/content. */
export function corpusManifestProblem(config, tasksDir, ids, frozenRows = null) {
  if (!config.corpusManifest || !/^[0-9a-f]{64}$/.test(config.corpusManifestSha256 ?? "")) {
    return "qualification requires a frozen corpusManifest and corpusManifestSha256 pin";
  }
  let manifestPath;
  try { manifestPath = fs.realpathSync(config.corpusManifest); }
  catch { return "qualification corpus manifest is unavailable"; }
  const raw = fs.readFileSync(manifestPath);
  if (createHash("sha256").update(raw).digest("hex") !== config.corpusManifestSha256) return "qualification corpus manifest digest mismatch";
  let manifest;
  try { manifest = JSON.parse(raw.toString("utf8")); }
  catch { return "qualification corpus manifest is invalid JSON"; }
  if (manifest.schemaVersion === undefined && manifest.hash_scheme) return heldoutV2ManifestProblem(config, tasksDir, ids, manifest);
  if (manifest.schemaVersion !== 1 || manifest.split !== "heldout" || manifest.custody?.status !== "approved") {
    return "qualification corpus manifest lacks the frozen heldout approval contract";
  }
  if (typeof manifest.custody?.custodian !== "string" || !manifest.custody.custodian.trim() || !manifest.custody?.approvedAt) {
    return "qualification corpus manifest lacks custodian identity or approval timestamp";
  }
  let actual;
  try { actual = corpusTaskRows(tasksDir, ids); }
  catch (error) { return `qualification task content cannot be safely hashed: ${error.message}`; }
  if (frozenRows && JSON.stringify(actual) !== JSON.stringify(frozenRows)) return "source task content changed while the runner froze its input";
  if (JSON.stringify(frozenRows ?? actual) !== JSON.stringify(manifest.tasks)) return "qualification task population or content differs from the frozen corpus manifest";
  return null;
}

/** The command line that runs `cmd argv` as `user` with exactly `env` (sudo -n: no password prompt in a run). */
/**
 * Run `cmd` as the evaluator account, in exactly the form eval/host/provision.sh's sudoers rule permits
 * (`<operator> ALL=(nexus-eval) NOPASSWD: /usr/bin/bwrap`). sudo resets the environment (env_reset) and every caller
 * passes Bubblewrap, which clears it again (--clearenv); an `env` wrapper would need a rule allowing any command.
 */
export function asUser(user, cmd, argv) {
  if (!path.isAbsolute(cmd)) throw new Error("evaluator-account commands must be absolute paths");
  return { cmd: "/usr/bin/sudo", argv: ["-n", "-u", user, "--", cmd, ...argv] };
}

/** Run a process spec as `user` while retaining its timeout and other execution metadata. */
export function asUserSpec(user, spec) {
  return { ...spec, ...asUser(user, spec.cmd, spec.argv) };
}
