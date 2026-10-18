#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const requireDigest = args.includes("--require-digest");
const fileArg = args.find((arg) => arg !== "--require-digest");
const filePath = fileArg ? path.resolve(fileArg) : path.resolve(__dirname, "../dist/compatibility.json");

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
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(content.version)) {
    throw new Error("Version is not valid SemVer");
  }
  if (content.schemaVersion !== 1) {
    throw new Error("Unsupported schemaVersion; expected 1");
  }
  if (typeof content.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(content.revision)) {
    throw new Error("Missing or invalid source revision");
  }
  if (typeof content.builtAt !== "string" || Number.isNaN(Date.parse(content.builtAt))) {
    throw new Error("Missing or invalid build timestamp");
  }
  if (content.minimumUpdaterVersion !== undefined && (typeof content.minimumUpdaterVersion !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(content.minimumUpdaterVersion))) {
    throw new Error("minimumUpdaterVersion is not valid SemVer");
  }
  if (!content.components || ["cli", "core", "tui", "harness"].some((name) => typeof content.components[name] !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(content.components[name]))) {
    throw new Error("Missing or invalid component SemVer");
  }
  for (const name of ["cli", "core", "tui", "harness"]) {
    if (content.components[name] !== content.version) {
      throw new Error(`Component '${name}' version must match release version '${content.version}'`);
    }
  }
  if (!content.compatibility || typeof content.compatibility.stateSchemaVersion !== "number") {
    throw new Error("Missing compatibility.stateSchemaVersion");
  }
  for (const [versionKey, minimumKey] of [["stateSchemaVersion", "minSupportedStateVersion"], ["configSchemaVersion", "minSupportedConfigVersion"]]) {
    const version = content.compatibility[versionKey];
    const minimum = content.compatibility[minimumKey];
    if (!Number.isSafeInteger(version) || version < 0 || !Number.isSafeInteger(minimum) || minimum < 0 || minimum > version) {
      throw new Error(`Invalid compatibility.${versionKey}/${minimumKey}`);
    }
  }
  if (!content.platforms || typeof content.platforms !== "object" || Object.keys(content.platforms).length === 0) {
    throw new Error("Missing platforms section");
  }
  for (const [key, asset] of Object.entries(content.platforms)) {
    if (!asset || typeof asset.archive !== "string" || typeof asset.os !== "string" || typeof asset.arch !== "string") {
      throw new Error(`Invalid platforms.${key} asset`);
    }
    if (asset.archive !== `nexus-${asset.os}-${asset.arch}-v${content.version}.tar.gz`) {
      throw new Error(`platforms.${key}.archive is not bound to release version`);
    }
    if (asset.sha256 !== undefined && (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256))) {
      throw new Error(`Invalid platforms.${key}.sha256`);
    }
    if (requireDigest && !asset.sha256) throw new Error(`Missing platforms.${key}.sha256`);
  }
  console.log(`✔ Compatibility metadata at ${filePath} is valid (version ${content.version}, schema ${content.schemaVersion}).`);
  process.exit(0);
} catch (err) {
  console.error(`✖ Compatibility metadata validation failed: ${err.message}`);
  process.exit(1);
}
