import * as fs from "node:fs";
import * as path from "node:path";
import { OperationStore } from "../../src/core/operation_runner_persistence.js";

const [root, id, go, results] = process.argv.slice(2);
const store = new OperationStore(path.join(root, "workspace"), path.join(root, "state"), root);
console.log("READY");
while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 1));
try {
  const release = store.acquire(id);
  fs.appendFileSync(results, `won ${process.pid}\n`);
  await new Promise((r) => setTimeout(r, 1500));
  release();
} catch (error: any) {
  fs.appendFileSync(results, `${error?.name === "OperationLockedError" || /already being driven|cannot be taken over|stale lock/.test(error?.message) ? "locked" : `error ${error?.message}`} ${process.pid}\n`);
}
