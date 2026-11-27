import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const KILL_GRACE_MS = 500;
const OUTPUT_LIMIT = 1024 * 1024;

export function scrubProbeEnv(): NodeJS.ProcessEnv {
  const allow = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "NODE_ENV"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allow.has(key)) env[key] = value;
  }
  env.NEXUS_HIR_PROBE = "1";
  env.NEXUS_HIR_LIVE_MUTATION = "0";
  return env;
}

export interface ProbeProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (signal === "SIGKILL" && child.pid !== undefined) {
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 1_000,
        env: { PATH: process.env.PATH },
      });
      if (!result.error && result.status === 0) return;
    }
    child.kill(signal);
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      return;
    }
  }
  child.kill(signal);
}

/** Run a verifier in its own process group so cancellation and deadlines stop its shell descendants too. */
export function runProbeProcess(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; dockerContainerName?: string },
): Promise<ProbeProcessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ status: null, signal: null, timedOut: false, cancelled: true, stdout: "", stderr: "" });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env ?? scrubProbeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ status: null, signal: null, error: error instanceof Error ? error.message : String(error), timedOut: false, cancelled: false, stdout: "", stderr: "" });
      return;
    }

    const capture = (stream: NodeJS.ReadableStream | null): (() => string) => {
      const chunks: Buffer[] = [];
      let length = 0;
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (length >= OUTPUT_LIMIT) return;
        const kept = buffer.subarray(0, OUTPUT_LIMIT - length);
        chunks.push(kept);
        length += kept.length;
      });
      return () => Buffer.concat(chunks).toString("utf8");
    };
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);

    let termination: "timeout" | "cancelled" | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let timer: NodeJS.Timeout;

    const terminate = (reason: "timeout" | "cancelled") => {
      if (termination || settled) return;
      termination = reason;
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => terminate("cancelled");
    timer = setTimeout(() => terminate("timeout"), Math.max(1, options.timeoutMs));
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: { status: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      // A shell can exit on SIGTERM while leaving descendants alive. Sweep the owned tree
      // before settling, even when the leader closed before the grace timer fired.
      if (termination) signalProcessTree(child, "SIGKILL");
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.dockerContainerName && (termination || result.error)) {
        // Killing the Docker CLI does not stop its container. Name it at launch and remove it on abort/deadline.
        spawnSync("docker", ["rm", "--force", options.dockerContainerName], { stdio: "ignore", timeout: 5_000, env: scrubProbeEnv() });
      }
      resolve({
        ...result,
        timedOut: termination === "timeout",
        cancelled: termination === "cancelled",
        stdout: stdout(),
        stderr: stderr(),
      });
    };

    child.once("error", (error) => finish({ status: null, signal: null, error: error.message }));
    child.once("close", (status, signal) => finish({ status, signal }));
    // Close the abort race between the initial check and listener registration.
    if (options.signal?.aborted) onAbort();
  });
}
