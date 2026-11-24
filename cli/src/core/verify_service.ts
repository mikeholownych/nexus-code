/**
 * VR-2: verification for a server's remote callers (the `nexus_verify` MCP tool; the ACP extension follows). It runs the
 * one verification path, `verifyChange`, in a forked worker, and keeps the receipts.
 *
 * The caller is untrusted and supplies nothing: the verifier, the deliverables, the deadline and the read-only flag are
 * fixed when the service is built, the base commit is pinned by the server before any request, the change is the
 * working tree on disk, and the sandbox is the core default. A receipt is created here, after a verdict exists, under
 * an id drawn here, and is kept only in this process: no request writes the store.
 */
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { verifierTimeoutSecs } from "../tester.js";
import { VERIFY_RESULT_SCHEMA_VERSION, type VerifyJsonResult } from "../verify_contract.js";
import { git } from "../worktrunk/git.js";
import type { EffectivePolicy } from "./managed_policy.js";
import { descendants, startedAt } from "./process_identity.js";
import { humanRequirementForEffect, managedPolicy } from "./policy_runtime.js";
import { descendants, processStartTicks as startedAt } from "./process_identity.js";

export const VERIFY_SERVICE_VERSION = 1;
export const VERIFY_RECEIPT_STORE_SIZE = 32;
export const VERIFY_RECEIPT_URI_PREFIX = "nexus://verify-receipt/";
/** A larger result document is not kept or served. */
export const VERIFY_MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Marks the messages of the worker protocol on the IPC channel. */
export const VERIFY_WORKER_TAG = "nexus-verify-worker/1";

const RECEIPT_ID = /^vr-[0-9a-f]{32}$/;
/** Time a stopped verification gets after SIGTERM before its verifier is killed; the worker is killed after as long again. */
export const VERIFY_KILL_GRACE_MS = 10_000;
const VERDICTS: readonly string[] = ["VERIFIED", "REGRESSION_FREE", "UNVERIFIED", "BLOCKED"];

export interface VerifyWorkerJob {
  tag: typeof VERIFY_WORKER_TAG;
  request: { worktree: string; base: string };
  operator: { verifierCommand?: string; deliverables: readonly string[]; timeoutSecs: number };
}

export type VerifyWorkerReply = { ready: true } | { result: VerifyJsonResult } | { usage: string } | { interrupted: true } | { failed: string };

/** Runs one job to its reply. Aborting the signal must end the run; the promise settles only once nothing is left running. */
export type VerifyRunner = (job: VerifyWorkerJob, signal: AbortSignal) => Promise<VerifyWorkerReply>;

/** The commit a server verifies against, resolved once, and when. */
export interface PinnedBase { commit: string; at: string }

export interface VerifyServiceConfig {
  /** The served working tree; a binding may name its own instead. */
  worktree?: string;
  /** The operator's verifier. Absent: nothing runs (a discovered verifier is never approved here). */
  verifierCommand?: string;
  deliverables: readonly string[];
  /** Deadline of each verifier run in seconds (default: NEXUS_VERIFIER_TIMEOUT_SECS, else 300), fixed at construction. */
  timeoutSecs?: number;
  readOnly: boolean;
  surface: "mcp" | "acp";
}

export interface VerifyServiceDeps {
  /** Test seam; the default forks the worker. */
  run?: VerifyRunner;
  policy?: () => EffectivePolicy;
  now?: () => Date;
  /** 32 lower-case hex digits. */
  random?: () => string;
  workerModule?: URL;
  /** Overall deadline of one verification (default: six runs and five minutes). */
  watchdogMs?: number;
  killGraceMs?: number;
}

export interface VerifyBinding {
  sessionId?: string;
  worktree?: string;
  base: PinnedBase;
}

export interface VerifyServiceSummary {
  service_version: typeof VERIFY_SERVICE_VERSION;
  receipt_id: string;
  receipt_uri: string;
  receipt_sha256: string;
  verify_schema_version: number;
  verdict: VerifyJsonResult["verdict"];
  outcome: VerifyJsonResult["outcome"];
  reason?: VerifyJsonResult["reason"];
  detail?: string;
  base?: { commit: string | null; tree: string };
  head?: { tree: string; workingTree: boolean };
  verifier?: { command: string; source: string; approval: string; digest: string };
  /** What the operator of the server can change; the caller cannot. */
  operator_hint?: string;
  issued_at: string;
}

export interface VerifyServiceReceipt {
  receipt_id: string;
  /** SHA-256 of the UTF-8 bytes of `JSON.stringify(result)`, which is how `result` is served. */
  receipt_sha256: string;
  issued_at: string;
  surface: "mcp" | "acp";
  session_id: string | null;
  workspace: string;
  base_pinned_at: string;
  result: VerifyJsonResult;
}

export type VerifyServiceErrorKind = "read_only" | "policy_requires_human" | "policy_error" | "no_workspace" | "busy" | "usage" | "interrupted" | "timeout" | "too_large" | "worker_failed";

/** No verdict was reached, so there is no receipt. */
export interface VerifyServiceError { kind: VerifyServiceErrorKind; message: string }

export type VerifyServiceOutcome = { summary: VerifyServiceSummary; receipt: VerifyServiceReceipt } | { error: VerifyServiceError };

/** The commit `HEAD` names in `worktree` now. A server calls this once, at start, so later commits are part of the change. */
export function pinBase(worktree: string): PinnedBase | { error: string } {
  try {
    const found = git(worktree, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], { allowFailure: true });
    const commit = found.stdout.trim();
    if (found.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) return { error: "the workspace had no commit to verify against when the server started (not a Git working tree, or no commit yet)" };
    return { commit, at: new Date().toISOString() };
  } catch (error) {
    return { error: `the workspace could not be read as a Git working tree when the server started: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/** How many listings a kill takes at most while it stops a process tree; each one after the first only catches late forks. */
const KILL_LISTING_PASSES = 6;

/**
 * The worker as a child process in its own group. The module's extension follows this file's, so the source runs under
 * the TypeScript loader (tests) and the build runs as plain JavaScript; the loader is named here because a child does
 * not inherit it on every way this process can have been started.
 */
function forkRunner(workerModule: URL, killGraceMs: number): VerifyRunner {
  return (job, signal) => new Promise((resolve) => {
    const file = fileURLToPath(workerModule);
    const child = fork(file, [], {
      detached: true,
      // Stdout is not connected: nothing the worker or a verifier prints can reach the server's protocol stream.
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      execArgv: file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
    });
    let reply: VerifyWorkerReply | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    // A verifier runs under `timeout`, which leaves the worker's process group, so the group alone does not reach it:
    // every descendant is signalled by its own pid.
    // Every process seen below the worker, with the time it started. A sandbox whose parent dies on SIGTERM while it
    // ignores the signal itself is handed to init: no later listing finds it under the worker, so it is remembered
    // here, and the start time tells it from an unrelated process that was given the same pid since.
    const seen = new Map<number, string>();
    const signalTree = (name: NodeJS.Signals, worker = true, passes = KILL_LISTING_PASSES) => {
      if (child.pid === undefined) return;
      const send = (pid: number, signal: NodeJS.Signals) => { try { process.kill(pid, signal); } catch { /* already gone */ } };
      // Once the worker has exited, its pid may belong to another process: it is then neither signalled nor searched.
      const workerPid = child.exitCode === null && child.signalCode === null ? child.pid : undefined;
      const survivors = () => [...seen].filter(([pid, started]) => startedAt(pid) === started).map(([pid]) => pid);
      const list = () => {
        const remembered = survivors();
        const found = [...new Set([...remembered, ...descendants([...(workerPid === undefined ? [] : [workerPid]), ...remembered])])];
        for (const pid of found) if (!seen.has(pid)) { const started = startedAt(pid); if (started !== undefined) seen.set(pid, started); }
        return found;
      };
      // One listing cannot promise that nothing is missed: a process on the list may fork after it was listed (timeout
      // starting the sandbox, the sandbox starting its inner process), and a newcomer whose parent then dies of the
      // signal is handed to init unseen. So the tree is stopped first, from the top down, one listing at a time: a
      // stopped process starts nothing, and each further listing can only add what was started before its parent
      // stopped. The worker is stopped too, since the moment a verifier dies it may start the next.
      if (workerPid !== undefined) send(workerPid, "SIGSTOP");
      const stopped = new Set<number>();
      let targets = list();
      for (let pass = 0; pass < passes; pass++) {
        const fresh = targets.filter((pid) => !stopped.has(pid));
        if (!fresh.length) break;
        for (const pid of fresh) { send(pid, "SIGSTOP"); stopped.add(pid); }
        targets = list();
      }
      // What the last listing added was never stopped, and is signalled all the same.
      for (const pid of new Set([...stopped, ...targets])) send(pid, name);
      if (worker && workerPid !== undefined) {
        send(workerPid, name);
        send(-workerPid, name);
      }
      // What was not killed goes on: a process handles SIGTERM only once it runs again, and a spared worker has its
      // scratch trees to remove.
      if (name !== "SIGKILL") for (const pid of stopped) send(pid, "SIGCONT");
      if (workerPid !== undefined && (name !== "SIGKILL" || !worker)) send(workerPid, "SIGCONT");
    };
    const onAbort = () => {
      // SIGTERM ends the running verifier, which lets the worker remove its scratch trees and exit.
      signalTree("SIGTERM");
      // A verifier that ignores SIGTERM is killed first and the worker spared, so the scratch trees are still removed;
      // a worker that does not finish even then is killed with whatever it has started since.
      killTimer = setTimeout(() => {
        signalTree("SIGKILL", false);
        killTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
      }, killGraceMs);
    };
    // The server is exiting: one listing after the first, so a process listing that hangs cannot hold the exit for long.
    const onProcessExit = () => signalTree("SIGKILL", true, 1);
    const finish = (final: VerifyWorkerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // A cancelled worker can exit while something it started lives on: the later stages will not run now.
      if (signal.aborted) signalTree("SIGKILL", false);
      signal.removeEventListener("abort", onAbort);
      process.removeListener("exit", onProcessExit);
      resolve(final);
    };
    // The channel closes after its last message is read, so the reply is complete only once both have happened.
    let open = 2;
    const closed = () => {
      if (--open === 0) finish(reply ?? { failed: "the verification worker ended without a result" });
    };
    child.once("exit", closed);
    child.once("disconnect", closed);
    child.once("error", (error) => finish({ failed: `the verification worker could not be started: ${error.message}` }));
    child.on("message", (message: any) => {
      if (message?.tag !== VERIFY_WORKER_TAG) return;
      if (message.ready === true) child.send(job, () => { /* a worker that is already gone is reported by its exit */ });
      else reply ??= message as VerifyWorkerReply;
    });
    process.once("exit", onProcessExit);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class VerifyService {
  private readonly config: VerifyServiceConfig;
  private readonly timeoutSecs: number;
  private readonly run: VerifyRunner;
  private readonly policy: () => EffectivePolicy;
  private readonly now: () => Date;
  private readonly random: () => string;
  private readonly watchdogMs: number;
  /** Insertion-ordered, so the first key is the oldest receipt. Each entry keeps the exact text it is served as. */
  private readonly receipts = new Map<string, { receipt: VerifyServiceReceipt; text: string }>();
  private running: AbortController | undefined;
  /** Resolves when the running verification has settled: its worker and what the worker started are gone. */
  private settled: Promise<void> | undefined;

  constructor(config: VerifyServiceConfig, deps: VerifyServiceDeps = {}) {
    this.config = { ...config, deliverables: [...config.deliverables] };
    this.timeoutSecs = verifierTimeoutSecs(config.timeoutSecs);
    this.policy = deps.policy ?? managedPolicy;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? (() => randomBytes(16).toString("hex"));
    this.watchdogMs = deps.watchdogMs ?? (6 * this.timeoutSecs + 300) * 1000;
    const here = import.meta.url;
    this.run = deps.run ?? forkRunner(deps.workerModule ?? new URL(`./verify_worker${here.endsWith(".ts") ? ".ts" : ".js"}`, here), deps.killGraceMs ?? VERIFY_KILL_GRACE_MS);
  }

  /**
   * Verifies the working tree against the pinned base. Every verdict, BLOCKED included, comes back with a receipt; an
   * error means no verdict was reached and nothing was stored. One verification runs at a time: a second call is
   * refused, not queued.
   */
  async verify(binding: VerifyBinding, signal?: AbortSignal): Promise<VerifyServiceOutcome> {
    const refuse = (kind: VerifyServiceErrorKind, message: string): VerifyServiceOutcome => ({ error: { kind, message } });
    if (this.config.readOnly) return refuse("read_only", "verification runs repository code, which read-only mode does not allow");
    try {
      const human = humanRequirementForEffect(this.policy(), "exec");
      if (human) return refuse("policy_requires_human", `managed policy requires a person to approve command execution, and no person decides a remote verification: ${human.message}`);
    } catch (error) {
      return refuse("policy_error", `the managed policy could not be read, so verification is refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    const worktree = binding.worktree ?? this.config.worktree;
    if (!worktree) return refuse("no_workspace", "no workspace is bound to this verification");
    if (this.running) return refuse("busy", "a verification is already running; this one was not started and is not queued");
    if (signal?.aborted) return refuse("interrupted", "interrupted: no verdict was reached");

    const controller = new AbortController();
    this.running = controller;
    let settle!: () => void;
    this.settled = new Promise((resolve) => (settle = resolve));
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.watchdogMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await this.run(
        { tag: VERIFY_WORKER_TAG, request: { worktree, base: binding.base.commit }, operator: { verifierCommand: this.config.verifierCommand, deliverables: this.config.deliverables, timeoutSecs: this.timeoutSecs } },
        controller.signal,
      );
      // After an abort nothing the worker sent is a verdict, whatever arrived first.
      if (timedOut) return refuse("timeout", `verification did not finish within ${Math.round(this.watchdogMs / 1000)} s and was stopped: no verdict was reached`);
      if (controller.signal.aborted || "interrupted" in reply) return refuse("interrupted", "interrupted: no verdict was reached");
      if ("usage" in reply) return refuse("usage", String(reply.usage));
      if (!("result" in reply)) return refuse("worker_failed", `verification could not be run: ${"failed" in reply ? String(reply.failed) : "the worker sent no result"}`);
      return this.issue(reply.result, binding, worktree);
    } catch (error) {
      return refuse("worker_failed", `verification could not be run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", onAbort);
      this.running = undefined;
      this.settled = undefined;
      settle();
    }
  }

  private issue(raw: VerifyJsonResult, binding: VerifyBinding, worktree: string): VerifyServiceOutcome {
    let served: string;
    try {
      served = JSON.stringify(raw);
    } catch {
      return { error: { kind: "worker_failed", message: "verification could not be run: the result is not a JSON document" } };
    }
    if (typeof served !== "string" || Buffer.byteLength(served, "utf8") > VERIFY_MAX_RESULT_BYTES) {
      return { error: { kind: "too_large", message: `the verification result exceeds ${VERIFY_MAX_RESULT_BYTES} bytes and was discarded: no receipt was created` } };
    }
    // Through JSON, so the stored document is plain data and owes nothing to the object the runner returned.
    const result = JSON.parse(served) as VerifyJsonResult;
    if (result?.schema_version !== VERIFY_RESULT_SCHEMA_VERSION || !VERDICTS.includes(result.verdict)) {
      return { error: { kind: "worker_failed", message: "verification could not be run: the worker's result is not a verify result document" } };
    }
    const receiptId = `vr-${this.random()}`;
    const issuedAt = this.now().toISOString();
    let workspace = worktree;
    try { workspace = fs.realpathSync(worktree); } catch { /* the path as given */ }
    const receipt: VerifyServiceReceipt = deepFreeze({
      receipt_id: receiptId,
      receipt_sha256: createHash("sha256").update(JSON.stringify(result), "utf8").digest("hex"),
      issued_at: issuedAt,
      surface: this.config.surface,
      session_id: binding.sessionId ?? null,
      workspace,
      base_pinned_at: binding.base.at,
      result,
    });
    if (!RECEIPT_ID.test(receiptId) || this.receipts.has(receiptId)) {
      return { error: { kind: "worker_failed", message: "verification could not be recorded: no receipt id could be drawn" } };
    }
    this.receipts.set(receiptId, { receipt, text: JSON.stringify(receipt) });
    while (this.receipts.size > VERIFY_RECEIPT_STORE_SIZE) this.receipts.delete(this.receipts.keys().next().value!);

    const command = this.config.surface === "mcp" ? "serve-mcp" : "acp";
    const hint = result.reason === "VERIFIER_NOT_APPROVED" || result.reason === "NO_APPLICABLE_VERIFIER"
      ? `Only the operator's own verifier runs here: the operator must start the server with \`nexus --authoritative-verifier <command> ${command}\`.`
      : result.reason === "REGRESSION_FREE" && this.config.deliverables.length === 0
        ? `VERIFIED needs the operator to declare the product files: \`nexus --deliverable-file <path> ${command}\`.`
        : undefined;
    const summary: VerifyServiceSummary = {
      service_version: VERIFY_SERVICE_VERSION,
      receipt_id: receiptId,
      receipt_uri: `${VERIFY_RECEIPT_URI_PREFIX}${receiptId}`,
      receipt_sha256: receipt.receipt_sha256,
      verify_schema_version: result.schema_version,
      verdict: result.verdict,
      outcome: result.outcome,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      ...(result.base ? { base: { commit: result.base.commit, tree: result.base.tree } } : {}),
      ...(result.head ? { head: { tree: result.head.tree, workingTree: result.head.workingTree } } : {}),
      ...(result.verifier ? { verifier: { command: result.verifier.command, source: result.verifier.source, approval: result.verifier.approval, digest: result.verifier.digest } } : {}),
      ...(hint ? { operator_hint: hint } : {}),
      issued_at: issuedAt,
    };
    return { summary, receipt };
  }

  /** A stored receipt and its text. Anything that is not a well-formed id issued to this session is simply not there. */
  private lookup(id: unknown, sessionId: string | null): { receipt: VerifyServiceReceipt; text: string } | undefined {
    if (typeof id !== "string" || !RECEIPT_ID.test(id)) return undefined;
    const entry = this.receipts.get(id);
    return entry && entry.receipt.session_id === sessionId ? entry : undefined;
  }

  receipt(id: unknown, sessionId: string | null = null): VerifyServiceReceipt | undefined {
    return this.lookup(id, sessionId)?.receipt;
  }

  /** The receipt as it is served: the same bytes on every read. */
  receiptText(id: unknown, sessionId: string | null = null): string | undefined {
    return this.lookup(id, sessionId)?.text;
  }

  /** The retained receipts of a session, oldest first. */
  list(sessionId: string | null = null): Array<{ receipt_id: string; issued_at: string; verdict: string }> {
    return [...this.receipts.values()]
      .filter(({ receipt }) => receipt.session_id === sessionId)
      .map(({ receipt }) => ({ receipt_id: receipt.receipt_id, issued_at: receipt.issued_at, verdict: receipt.result.verdict }));
  }

  /** Stops the running verification, if any; its caller gets an error and no receipt. */
  abort(): void {
    this.running?.abort();
  }

  /** Stops the running verification and resolves once nothing of it is left running. */
  async stop(): Promise<void> {
    this.abort();
    await this.settled;
  }
}
