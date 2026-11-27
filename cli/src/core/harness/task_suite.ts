import * as fs from "node:fs";
import * as path from "node:path";
import { assertValid, validateHirTaskSuite } from "./schema.js";
import type { HirTaskSuite } from "./types.js";

export function loadTaskSuiteFile(filePath: string): HirTaskSuite {
  const abs = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  return assertValid("taskSuite", raw, validateHirTaskSuite);
}

export function taskSuiteHash(suite: HirTaskSuite): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(JSON.stringify(suite)).digest("hex");
}
