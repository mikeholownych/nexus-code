// Worker thread for `doctor`'s schema-2 message-journal check. Journal reads are synchronous and hash the whole file,
// so they run here and the parent terminates this thread on cancellation. Compiled to dist/ with the rest of src/.
import { parentPort, workerData } from "node:worker_threads";
import { readTaskMessages } from "./core/task_message_log.js";

try {
  readTaskMessages(workerData.file, workerData.taskId, workerData.cursor);
  parentPort?.postMessage({ ok: true });
} catch (error: any) {
  parentPort?.postMessage({
    ok: false,
    kind: error?.kind === "corrupt" || error?.kind === "future" ? error.kind : "io",
    code: error?.code,
    message: error?.message ?? String(error),
  });
}
