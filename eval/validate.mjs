// Checks that make an evaluation run valid before it starts (SPEC-10, REQ-QUAL-101/102/106): every task is well formed,
// a qualification run records which model actually answered (a fingerprint, not an alias), and hidden tests are out of
// the agent's reach when the agent runs as its own user.
import fs from "node:fs";
import path from "node:path";

export const TIERS = ["T1", "T2", "T3", "T4"];
export const CLASSES = ["bugfix", "feature", "refactor", "debug"];
export const DIFFICULTIES = ["easy", "medium", "hard"];

/** Problems with one task.json (empty when valid). `qualification` adds the fields held-out tasks must carry. */
export function validateTask(task, dir, { qualification = false } = {}) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(typeof task.id === "string" && task.id === path.basename(dir), `id must equal its directory name (${path.basename(dir)})`);
  need(TIERS.includes(task.tier), `tier must be one of ${TIERS.join(", ")}`);
  need(typeof task.objective === "string" && task.objective.trim().length > 0, "objective is required");
  need(Boolean(task.fixture) !== Boolean(task.repo), "exactly one of fixture or repo is required");
  if (task.fixture) need(fs.existsSync(path.join(dir, task.fixture)), `fixture ${task.fixture} does not exist`);
  if (task.repo) {
    need(typeof task.repo.url === "string" && task.repo.url.length > 0, "repo.url is required");
    need(/^[0-9a-f]{40}$/.test(task.repo.commit ?? ""), "repo.commit must be a full 40-character commit id (pinned)");
  }
  need(task.hidden && typeof task.hidden.command === "string" && task.hidden.command.length > 0, "hidden.command is required");
  if (task.hidden?.dir) need(fs.existsSync(path.join(dir, task.hidden.dir)), `hidden.dir ${task.hidden.dir} does not exist`);
  for (const key of ["steps", "minutes"]) {
    if (task[key] !== undefined) need(Number.isInteger(task[key]) && task[key] > 0, `${key} must be a positive integer`);
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

/**
 * When the agent runs as its own user (`runAs`), the hidden tests must be unreadable to it: the tasks directory may grant
 * nothing to other users. Returns a problem, or null when isolated (or when `runAs` is not used).
 */
export function hiddenTestIsolationProblem(config, tasksDir) {
  if (!config.runAs) return config.qualification ? "qualification runs need runAs (the agent's own user) so hidden tests are unreadable to it" : null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.runAs)) return `runAs '${config.runAs}' is not a valid user name`;
  const mode = fs.statSync(tasksDir).mode & 0o777;
  if (mode & 0o007) return `${tasksDir} is readable by other users (mode ${mode.toString(8)}): run chmod o-rwx on it so ${config.runAs} cannot read hidden tests`;
  return null;
}

/** The command line that runs `cmd argv` as `user` with exactly `env` (sudo -n: no password prompt in a run). */
export function asUser(user, cmd, argv, env) {
  const assignments = Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
  return { cmd: "sudo", argv: ["-n", "-u", user, "--", "env", "-i", ...assignments, cmd, ...argv] };
}
