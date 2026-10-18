#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "../dist/compatibility.json");

if (!fs.existsSync(filePath)) {
  console.error(`Error: compatibility file not found: ${filePath}`);
  process.exit(1);
}

try {
  const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (content.product !== "nexus-code") {
    throw new Error(`Invalid product: ${content.product}`);
  }
  if (!content.version || typeof content.version !== "string") {
    throw new Error("Missing or invalid version");
  }
  if (!content.compatibility || typeof content.compatibility.stateSchemaVersion !== "number") {
    throw new Error("Missing compatibility.stateSchemaVersion");
  }
  if (!content.platforms || typeof content.platforms !== "object" || Object.keys(content.platforms).length === 0) {
    throw new Error("Missing platforms section");
  }
  console.log(`✔ Compatibility metadata at ${filePath} is valid (version ${content.version}, schema ${content.schemaVersion}).`);
  process.exit(0);
} catch (err) {
  console.error(`✖ Compatibility metadata validation failed: ${err.message}`);
  process.exit(1);
}
