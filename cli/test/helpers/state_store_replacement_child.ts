import * as fs from "node:fs";
import { withStateStoreGuard } from "../../src/core/state_store_guard.ts";

const [storeDir, corruptPath] = process.argv.slice(2);
if (!storeDir || !corruptPath) {
  console.error("expected state store and replacement paths");
  process.exit(2);
}

try {
  withStateStoreGuard(storeDir, () => fs.writeFileSync(corruptPath, JSON.stringify({
    taskId: "newer",
    schemaVersion: 2,
    messageLog: {},
    messages: undefined,
  })));
} catch (error) {
  console.error(error instanceof Error ? error.name : "UnknownError");
  process.exit(23);
}
