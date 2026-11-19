import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CampaignRunIdentity,
  EvaluationDefinition,
  InstalledEvaluatorEvidence,
  RecoveryReference,
  RequestContextManifest,
  RunManifest,
} from "./contracts.js";
import type { CeriEvidenceStore } from "./evidence_store.js";
import { CeriBaselineComparator } from "./baseline.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_CAMPAIGN_RUNS = 1_000;
const MAX_CAMPAIGN_STEPS = 100_000;
const MAX_CAMPAIGN_MINUTES = 1_440;
const MAX_CAMPAIGN_TOKENS = 10_000_000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Create a privacy-preserving identity for the exact request context; only the digest and counts are retained. */
export function createRequestContextManifest(input: {
  messages: unknown[];
  tools: unknown[];
  parameters: Record<string, unknown>;
}): RequestContextManifest {
  if (!input || !Array.isArray(input.messages) || !Array.isArray(input.tools) || !input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) {
    throw new Error("request context requires messages, tools and an object of sampling parameters");
  }
  const serialized = canonicalJson({ messages: input.messages, tools: input.tools, parameters: input.parameters });
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_CONTEXT_BYTES) throw new Error(`request context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  return {
    schemaVersion: 1,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    requestCount: 1,
    messageCount: input.messages.length,
    toolCount: input.tools.length,
    serializedBytes: bytes,
  };
}

function containedRegularFile(root: string, candidate: string): string {
  const realRoot = fs.realpathSync(root);
  const lexical = path.resolve(candidate);
  const lexicalRel = path.relative(realRoot, lexical);
  if (lexicalRel === "" || path.isAbsolute(lexicalRel) || lexicalRel.split(path.sep)[0] === "..") throw new Error(`evaluator evidence path escapes its root: ${candidate}`);
  const real = fs.realpathSync(candidate);
  const rel = path.relative(realRoot, real);
  if (rel === "" || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") throw new Error(`evaluator evidence path escapes its root: ${candidate}`);
  let current = realRoot;
  for (const part of path.relative(realRoot, path.resolve(candidate)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`evaluator evidence path contains a symlink: ${candidate}`);
  }
  const st = fs.lstatSync(real);
  if (!st.isFile()) throw new Error(`evaluator evidence is not a regular file: ${candidate}`);
  return real;
}

function shaFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readJson(file: string): Record<string, unknown> {
  if (fs.statSync(file).size > MAX_RESULT_BYTES) throw new Error(`installed evaluator evidence exceeds ${MAX_RESULT_BYTES} bytes: ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`invalid evaluator JSON file: ${file}`);
  return data;
}

/**
 * Bind a completed installed-evaluator result to its installed executable, expected package digest and dataset.
 * `packageSha256` must come from the caller's verified release-asset/checksum/attestation step; this helper does not
 * claim to verify a signature or provenance attestation itself.
 */
export function bindInstalledEvaluatorEvidence(input: {
  packageRoot: string;
  nexusExecutable: string;
  expectedVersion: string;
  packageSha256: string;
  datasetManifestSha256: string;
  outputDir: string;
}): InstalledEvaluatorEvidence {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.expectedVersion)) throw new Error("expected evaluator version must be a semantic version");
  if (!SHA256.test(input.packageSha256) || !SHA256.test(input.datasetManifestSha256)) throw new Error("package and dataset identities must be lowercase SHA-256 digests");
  const packageRoot = fs.realpathSync(input.packageRoot);
  if (fs.lstatSync(input.packageRoot).isSymbolicLink() || !fs.statSync(packageRoot).isDirectory()) throw new Error("installed package root must be a real directory");
  const executable = containedRegularFile(packageRoot, input.nexusExecutable);
  if ((fs.statSync(executable).mode & 0o111) === 0) throw new Error("installed Nexus executable is not executable");
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, shell: false, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" } });
  if (version.error || version.status !== 0) throw new Error("installed Nexus version probe failed");
  const versionLine = (version.stdout ?? "").trim().split(/\r?\n/, 1)[0];
  if (!new RegExp(`^v?${input.expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|\\s|\\()`).test(versionLine)) throw new Error(`installed Nexus version does not match expected ${input.expectedVersion}`);

  const outputStat = fs.lstatSync(input.outputDir);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error("installed evaluator output path must be a real directory");
  const outputDir = fs.realpathSync(input.outputDir);
  const runnerManifestPath = containedRegularFile(outputDir, path.join(outputDir, "manifest.json"));
  const resultsPath = containedRegularFile(outputDir, path.join(outputDir, "results.jsonl"));
  const scorePath = containedRegularFile(outputDir, path.join(outputDir, "score.json"));
  const runnerManifest = readJson(runnerManifestPath);
  readJson(scorePath);
  const config = record(runnerManifest.config);
  const agentVersion = record(runnerManifest.agentVersion);
  const dataset = record(runnerManifest.dataset);
  if (config?.qualification !== true) throw new Error("installed evaluator result is not from a qualification run");
  if (agentVersion?.agent !== "nexus" || agentVersion?.packageSha256 !== input.packageSha256) {
    throw new Error("installed evaluator manifest does not bind the expected Nexus package digest");
  }
  if (typeof agentVersion.version !== "string" || !new RegExp(`^${input.expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|\\s|\\()`).test(agentVersion.version)) {
    throw new Error("installed evaluator manifest version mismatch");
  }
  if (dataset?.manifestSha256 !== input.datasetManifestSha256) throw new Error("installed evaluator dataset manifest digest mismatch");
  if (agentVersion.executableSha256 !== shaFile(executable)) throw new Error("installed evaluator executable digest mismatch");

  const resultsStat = fs.statSync(resultsPath);
  if (resultsStat.size > MAX_RESULT_BYTES) throw new Error(`installed evaluator results exceed ${MAX_RESULT_BYTES} bytes`);
  const resultsBytes = fs.readFileSync(resultsPath);
  const rows = resultsBytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (rows.length === 0) throw new Error("installed evaluator produced no result rows");
  const plannedTasks = Array.isArray(runnerManifest.tasks) ? runnerManifest.tasks : [];
  const expectedRuns = runnerManifest.runs;
  if (typeof expectedRuns !== "number" || !Number.isSafeInteger(expectedRuns) || expectedRuns < 1 || plannedTasks.length < 1 || rows.length !== expectedRuns * plannedTasks.length) {
    throw new Error("installed evaluator result count does not match its recorded campaign");
  }
  const taskIds = new Set(plannedTasks.map((item) => record(item)?.id).filter((id): id is string => typeof id === "string"));
  if (taskIds.size !== plannedTasks.length) throw new Error("installed evaluator manifest has invalid or duplicate task identities");
  const observed = new Set<string>();
  const requestObservations: Array<{ task: string; run: number; requestIndex: number; sha256: string; serializedBytes: number; messageCount: number | null; toolCount: number | null }> = [];
  for (let i = 0; i < rows.length; i++) {
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(rows[i])); } catch { throw new Error(`installed evaluator result row ${i + 1} is invalid JSON`); }
    if (!row || typeof row.task !== "string" || !taskIds.has(row.task) || typeof row.run !== "number" || !Number.isSafeInteger(row.run) || row.run < 1 || row.run > expectedRuns || typeof row.hiddenPass !== "boolean" || typeof row.claimedComplete !== "boolean" || typeof row.claimedVerified !== "boolean" || typeof row.falseVerified !== "boolean") {
      throw new Error(`installed evaluator result row ${i + 1} is missing required outcome fields`);
    }
    if (row.falseVerified !== (row.claimedVerified && !row.hiddenPass)) throw new Error(`installed evaluator result row ${i + 1} has inconsistent falseVerified`);
    const key = `${row.task}\0${row.run}`;
    if (observed.has(key)) throw new Error(`installed evaluator result row ${i + 1} duplicates a task/run identity`);
    observed.add(key);
    const model = record(row.model);
    if (!model || !Array.isArray(model.requestContexts)) throw new Error(`installed evaluator result row ${i + 1} is missing request-context evidence`);
    for (let j = 0; j < model.requestContexts.length; j++) {
      const context = record(model.requestContexts[j]);
      if (!context || context.requestIndex !== j + 1 || typeof context.sha256 !== "string" || !SHA256.test(context.sha256) ||
          typeof context.serializedBytes !== "number" || !Number.isSafeInteger(context.serializedBytes) || context.serializedBytes < 0 ||
          (context.messageCount !== null && (typeof context.messageCount !== "number" || !Number.isSafeInteger(context.messageCount) || context.messageCount < 0)) ||
          (context.toolCount !== null && (typeof context.toolCount !== "number" || !Number.isSafeInteger(context.toolCount) || context.toolCount < 0))) {
        throw new Error(`installed evaluator result row ${i + 1} has malformed request-context evidence`);
      }
      requestObservations.push({
        task: row.task,
        run: row.run,
        requestIndex: context.requestIndex,
        sha256: context.sha256,
        serializedBytes: context.serializedBytes,
        messageCount: context.messageCount as number | null,
        toolCount: context.toolCount as number | null,
      });
    }
  }
  const contextTotal = (key: "messageCount" | "toolCount") => requestObservations.every((item) => item[key] !== null)
    ? requestObservations.reduce((total, item) => total + (item[key] ?? 0), 0)
    : null;
  const requestContext: RequestContextManifest = {
    schemaVersion: 1,
    sha256: createHash("sha256").update(canonicalJson(requestObservations)).digest("hex"),
    requestCount: requestObservations.length,
    messageCount: contextTotal("messageCount"),
    toolCount: contextTotal("toolCount"),
    serializedBytes: requestObservations.reduce((total, item) => total + item.serializedBytes, 0),
  };
  return {
    packageSha256: input.packageSha256,
    executableSha256: shaFile(executable),
    datasetManifestSha256: input.datasetManifestSha256,
    runnerManifestSha256: shaFile(runnerManifestPath),
    resultsSha256: shaFile(resultsPath),
    scoreSha256: shaFile(scorePath),
    resultCount: rows.length,
    evaluatorVersion: input.expectedVersion,
    requestContext,
  };
}

export type RecoveryReferenceCheck =
  | { ok: true; reference: RecoveryReference; manifest: RunManifest }
  | { ok: false; reference: RecoveryReference; reason: string };

/** Verify each resume link against the CERI store's integrity-checked manifest and require an earlier terminal run. */
export function checkRecoveryReferences(
  store: CeriEvidenceStore,
  references: RecoveryReference[],
  current: Pick<RunManifest, "evaluationId" | "startedAt">,
): RecoveryReferenceCheck[] {
  return references.map((reference) => {
    if (reference.evaluationId !== current.evaluationId) return { ok: false, reference, reason: "evaluation id differs from resumed run" };
    try {
      const integrity = store.verifyRun(reference.evaluationId, reference.runId);
      if (!integrity.ok) return { ok: false, reference, reason: `${integrity.reason}: ${integrity.detail}` };
      const manifest = store.loadManifest(reference.evaluationId, reference.runId);
      if (!manifest) return { ok: false, reference, reason: "referenced run manifest is missing or unreadable" };
      if (CeriBaselineComparator.manifestSha256(manifest) !== reference.manifestSha256) return { ok: false, reference, reason: "referenced run manifest digest mismatch" };
      if (manifest.status !== "COMPLETED" && manifest.status !== "FAILED") return { ok: false, reference, reason: `referenced run is not terminal (${manifest.status})` };
      if (reference.expectedStatus && manifest.status !== reference.expectedStatus) return { ok: false, reference, reason: `referenced run status mismatch (${manifest.status})` };
      if (!Number.isFinite(Date.parse(current.startedAt)) || !Number.isFinite(Date.parse(manifest.startedAt)) || Date.parse(manifest.startedAt) >= Date.parse(current.startedAt)) {
        return { ok: false, reference, reason: "referenced run is not earlier than the resumed run" };
      }
      return { ok: true, reference, manifest };
    } catch (error) {
      return { ok: false, reference, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

export interface BoundedCampaignLimits {
  maxRuns: number;
  maxAggregateSteps: number;
  maxAggregateMinutes: number;
  maxAggregateTokens: number;
}

export interface BoundedCampaignRun<T> {
  campaign: CampaignRunIdentity;
  definition: EvaluationDefinition;
  result: T;
}

/** Sequential, no-retry CERI campaigns with mandatory aggregate ceilings checked before the first run. */
export async function runBoundedCampaign<T>(input: {
  definitions: EvaluationDefinition[];
  limits: BoundedCampaignLimits;
  run: (definition: EvaluationDefinition, campaign: CampaignRunIdentity) => Promise<T>;
  campaignId?: string;
}): Promise<BoundedCampaignRun<T>[]> {
  const { definitions, limits } = input;
  const integer = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!Array.isArray(definitions) || definitions.length === 0) throw new Error("campaign requires at least one evaluation definition");
  if (!integer(limits.maxRuns) || limits.maxRuns > MAX_CAMPAIGN_RUNS ||
      !integer(limits.maxAggregateSteps) || limits.maxAggregateSteps > MAX_CAMPAIGN_STEPS ||
      !integer(limits.maxAggregateMinutes) || limits.maxAggregateMinutes > MAX_CAMPAIGN_MINUTES ||
      !integer(limits.maxAggregateTokens) || limits.maxAggregateTokens > MAX_CAMPAIGN_TOKENS) {
    throw new Error("campaign limits are missing, non-positive, unsafe or exceed the hard ceiling");
  }
  if (definitions.length > limits.maxRuns) throw new Error("campaign run count exceeds maxRuns");
  const ids = new Set<string>();
  let steps = 0;
  let minutes = 0;
  let tokens = 0;
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`campaign contains duplicate evaluation id '${definition.id}'`);
    ids.add(definition.id);
    const budget = definition.executionBudget;
    if (!budget || !integer(budget.maxSteps) || !integer(budget.timeoutSeconds) || !integer(budget.maxTokens ?? 0)) {
      throw new Error(`campaign evaluation '${definition.id}' must declare positive step, timeout and token ceilings`);
    }
    steps += budget.maxSteps;
    minutes += Math.ceil(budget.timeoutSeconds / 60);
    tokens += budget.maxTokens!;
  }
  if (steps > limits.maxAggregateSteps || minutes > limits.maxAggregateMinutes || tokens > limits.maxAggregateTokens) {
    throw new Error("campaign aggregate budget exceeds its declared ceilings");
  }
  const campaignId = input.campaignId ?? randomUUID();
  const planSha256 = createHash("sha256").update(canonicalJson(definitions)).digest("hex");
  const results: BoundedCampaignRun<T>[] = [];
  for (let index = 0; index < definitions.length; index++) {
    const campaign: CampaignRunIdentity = {
      campaignId,
      planSha256,
      index: index + 1,
      plannedRuns: definitions.length,
      maxAggregateSteps: limits.maxAggregateSteps,
      maxAggregateMinutes: limits.maxAggregateMinutes,
      maxAggregateTokens: limits.maxAggregateTokens,
    };
    results.push({ campaign, definition: definitions[index], result: await input.run(definitions[index], campaign) });
  }
  return results;
}
