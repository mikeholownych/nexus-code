/**
 * What the trigger tests share (BG-3): a throwaway HOME with a trusted repository, spec files written and approved the
 * way `nexus triggers approve` would record them, an in-process firer with a clock the test moves, and the jobs it
 * submits kept in a list the test can end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import http from "node:http";
import { makeRepo } from "./fixtures.js";
import { newJobRecord, runnerPaths, type JobRecord, type JobSubmission, type RunnerPaths } from "../../src/core/runner_store.js";
import { TriggerFirer, type TriggerFirerOptions } from "../../src/core/trigger_firer.js";
import { entryForSpec, approveTrigger } from "../../src/core/trigger_trust.js";
import { parseTriggerSpec, type TriggerSpec } from "../../src/core/trigger_spec.js";
import { workspaceKey } from "../../src/core/trigger_paths.js";
import { trackResource } from "./leak_guard.js";

export const RATE = { maxPerMinute: 5, maxPerHour: 60, maxPerDay: 500 };
export const BOUNDS = { maxToolInvocations: 50, maxRounds: 10, maxTurnMinutes: 5 };

export const fileSpec = (id: string, paths: string[], extra: Record<string, unknown> = {}) => ({
  format: "nexus-trigger", version: 1, id,
  event: { kind: "file-change", paths },
  action: { prompt: `Review the change (${id}).`, policy: "read-only" },
  rate: RATE, bounds: BOUNDS, ...extra,
});

export const webhookSpec = (id: string, secretEnv: string, extra: Record<string, unknown> = {}) => ({
  format: "nexus-trigger", version: 1, id,
  event: { kind: "webhook", secretEnv },
  action: { prompt: `Handle the delivery (${id}).`, policy: "read-only" },
  rate: RATE, bounds: BOUNDS, ...extra,
});

export interface TriggerWorld {
  home: string;
  repo: string;
  root: string;
  paths: RunnerPaths;
  /** Submitted jobs, in order. */
  jobs: JobRecord[];
  /** The frozen operation spec of each submitted job, in order. */
  specs: Array<Record<string, any>>;
  log: string[];
  clock: { ms: number };
  env: NodeJS.ProcessEnv;
  specFile: string;
  /** Writes `.nexus/triggers.json` (mode 0600). */
  writeSpecs(specs: unknown[]): void;
  /** Records the approval of the spec with this id as the file holds it now. */
  approve(id: string): void;
  trust(): void;
  firer(options?: Partial<TriggerFirerOptions>): TriggerFirer;
  /** Runs one tick and advances the clock. */
  tick(firer: TriggerFirer, advanceMs?: number): void;
  cleanup(): void;
}

export function triggerWorld(): TriggerWorld {
  const previousHome = process.env.HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trig-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".config", "nexus"), { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  const repo = fs.realpathSync(makeRepo({ "src/a.ts": "a\n", "README.md": "hi\n" }));
  const paths = runnerPaths(path.join(root, "runner"));
  const clock = { ms: Date.UTC(2026, 5, 1, 12, 0, 0) };
  const jobs: JobRecord[] = [];
  const specs: Array<Record<string, any>> = [];
  const log: string[] = [];
  const firers: TriggerFirer[] = [];
  const specFile = path.join(repo, ".nexus", "triggers.json");
  const world: TriggerWorld = {
    home, repo, root, paths, jobs, specs, log, clock, env: {}, specFile,
    writeSpecs: (specs) => {
      fs.mkdirSync(path.dirname(specFile), { recursive: true });
      fs.writeFileSync(specFile, JSON.stringify({ version: 1, triggers: specs }), { mode: 0o600 });
    },
    approve: (id) => {
      const raw = JSON.parse(fs.readFileSync(specFile, "utf8")).triggers.find((t: any) => t.id === id);
      const spec: TriggerSpec = parseTriggerSpec(JSON.stringify(raw));
      approveTrigger(entryForSpec(repo, spec, new Date(clock.ms).toISOString()), { workspaceTrusted: true });
    },
    trust: () => fs.writeFileSync(path.join(home, ".config", "nexus", "trusted_workspaces.json"), JSON.stringify({ trustedPaths: [repo] }), { mode: 0o600 }),
    firer: (options = {}) => {
      const firer = new TriggerFirer({
        paths, now: () => new Date(clock.ms), log: (line) => log.push(line), env: world.env,
        submit: (job: JobSubmission, spec: Record<string, unknown>) => { jobs.push(newJobRecord(job, new Date(clock.ms))); specs.push(spec); },
        jobs: () => jobs, scanMs: 1_000, watch: { debounceMs: 100 },
        ...options,
      });
      firers.push(firer);
      trackResource("trigger firer", `firer for ${repo}`, () => firer.webhookAddress() !== undefined, () => firer.closeNow());
      return firer;
    },
    tick: (firer, advanceMs = 1_500) => { firer.tick(); clock.ms += advanceMs; },
    cleanup: () => {
      for (const firer of firers) firer.closeNow();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
  world.trust();
  return world;
}

/** The headers of a delivery signed as the docs describe. */
export function signed(secret: string, body: string | Buffer, opts: { timestamp?: number; delivery?: string } = {}): Record<string, string> {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const delivery = opts.delivery ?? `d-${Math.random().toString(16).slice(2, 14)}`;
  const mac = createHmac("sha256", secret).update(`${timestamp}.${delivery}.`).update(body).digest("hex");
  return { "x-nexus-timestamp": timestamp, "x-nexus-delivery": delivery, "x-nexus-signature": `sha256=${mac}` };
}

export const hookPath = (repo: string, id: string): string => `/hook/${workspaceKey(repo)}/${id}`;

/** One request to the loopback listener; resolves with the status and body, or the error code of a connection that was cut. */
export function post(port: number, urlPath: string, body: string | Buffer, headers: Record<string, string> = {}, options: { host?: string } = {}): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST", agent: false, headers: { host: options.host ?? `127.0.0.1:${port}`, "content-length": String(Buffer.byteLength(body)), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
    req.end(body);
  });
}

// ---------------------------------------------------------------- the real runner

import { parseTriggerFile, specSha256 } from "../../src/core/trigger_load.js";
import type { RunnerWorld } from "./runner_fixture.js";

/** Writes `.nexus/triggers.json` into `repo` from `specs`, and records the approvals a person would have typed `yes` for. */
export function approveInRepo(world: RunnerWorld, repo: string, specs: unknown[] | { copyFrom: string }, ids?: string[]): void {
  const file = path.join(repo, ".nexus", "triggers.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (Array.isArray(specs)) fs.writeFileSync(file, JSON.stringify({ version: 1, triggers: specs }), { mode: 0o600 });
  else fs.copyFileSync(specs.copyFrom, file), fs.chmodSync(file, 0o600);
  const parsed = parseTriggerFile(file);
  if (parsed.problem) throw new Error(parsed.problem);
  const storePath = path.join(world.home, ".config", "nexus", "trigger_trust.json");
  for (const spec of parsed.specs) {
    if (ids && !ids.includes(spec.id)) continue;
    void specSha256;
    approveTrigger(entryForSpec(fs.realpathSync(repo), spec, new Date().toISOString()), { workspaceTrusted: true, storePath });
  }
}
