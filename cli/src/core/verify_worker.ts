/**
 * VR-2: the process a server forks to run one verification. `verifyChange` runs every repository process synchronously,
 * so it cannot run on a server's event loop. One job arrives over IPC and one reply goes back: the result, a usage
 * error, or "interrupted". Nothing is written to stdout.
 *
 * The job carries only the operator's verifier, deliverables and deadline. Approval of a discovered verifier, approval
 * of a verification edit and a sandbox setting have no field here, so no caller of a server can reach them.
 */
import { verifyChange, VerifyInterrupted, VerifyUsageError } from "./verify.js";
import { VERIFY_WORKER_TAG, type VerifyWorkerJob, type VerifyWorkerReply } from "./verify_service.js";

const abort = new AbortController();
// SIGTERM is the server's cancellation. A lost channel means the server is gone and nobody can read a verdict.
process.on("SIGTERM", () => abort.abort());
process.on("disconnect", () => abort.abort());

function send(reply: VerifyWorkerReply): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send!({ tag: VERIFY_WORKER_TAG, ...reply }, () => resolve());
  });
}

function isJob(value: any): value is VerifyWorkerJob {
  return value?.tag === VERIFY_WORKER_TAG
    && typeof value.request?.worktree === "string" && typeof value.request?.base === "string"
    && (value.operator?.verifierCommand === undefined || typeof value.operator.verifierCommand === "string")
    && Array.isArray(value.operator?.deliverables) && value.operator.deliverables.every((file: unknown) => typeof file === "string")
    && Number.isInteger(value.operator?.timeoutSecs);
}

async function runJob(job: VerifyWorkerJob): Promise<VerifyWorkerReply> {
  if (abort.signal.aborted) return { interrupted: true };
  try {
    // No `head`: the change is always the working tree on disk. No `sandbox`: the core default (confined, network off).
    const result = await verifyChange(
      { worktree: job.request.worktree, base: job.request.base },
      { verifierCommand: job.operator.verifierCommand, deliverables: job.operator.deliverables, timeoutSecs: job.operator.timeoutSecs, signal: abort.signal },
    );
    return { result };
  } catch (error) {
    if (error instanceof VerifyInterrupted) return { interrupted: true };
    if (error instanceof VerifyUsageError) return { usage: error.message };
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

let started = false;
process.on("message", (message: unknown) => {
  // The TypeScript loader used in tests also talks on this channel, so anything that is not the job is ignored.
  if (started || (message as any)?.tag !== VERIFY_WORKER_TAG) return;
  started = true;
  void (isJob(message) ? runJob(message) : Promise.resolve<VerifyWorkerReply>({ failed: "malformed verification job" }))
    .then(send)
    .then(() => process.exit(0));
});

// The listener above exists now: a job sent earlier could have been lost.
void send({ ready: true });
