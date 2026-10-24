#!/usr/bin/env node
// Fail closed when the release-tool dependency lock contains a deprecated npm package.
import fs from "node:fs";
import path from "node:path";
import { registryPackageName } from "./registry-package-name.mjs";

const lockPath = process.argv[2];
if (!lockPath) {
  console.error("usage: check_deprecated_lock.mjs <package-lock.json>");
  process.exit(2);
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
if (lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== "object") {
  throw new Error("release-tool lockfile must use npm lockfileVersion 2 or newer");
}

function packageName(location) {
  const parts = location.split("/");
  let marker = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "node_modules") marker = index;
  }
  if (marker < 0 || !parts[marker + 1]) throw new Error(`cannot derive package name from lock path ${location}`);
  return parts[marker + 1].startsWith("@")
    ? `${parts[marker + 1]}/${parts[marker + 2]}`
    : parts[marker + 1];
}

const entries = new Map();
for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location) continue;
  const name = packageName(location);
  if (!metadata.version) throw new Error(`missing locked version for ${location}`);
  if (metadata.resolved && !metadata.resolved.startsWith("https://registry.npmjs.org/")) {
    throw new Error(`cannot verify deprecation metadata for non-npm registry dependency ${name}@${metadata.version}`);
  }
  entries.set(`${name}@${metadata.version}`, { name, version: metadata.version });
}

const packages = [...entries.values()];
const deprecated = [];
let next = 0;
let failed = null;
async function worker() {
  while (!failed) {
    const index = next++;
    if (index >= packages.length) return;
    const { name, version } = packages[index];
    const registryName = registryPackageName(name);
    let response;
    try {
      response = await fetch(`https://registry.npmjs.org/${registryName}/${encodeURIComponent(version)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
      const metadata = await response.json();
      if (metadata.deprecated) deprecated.push(`${name}@${version}: ${metadata.deprecated}`);
    } catch (error) {
      failed = `could not verify ${name}@${version}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(8, packages.length) }, () => worker()));
if (failed) {
  console.error(`release dependency deprecation check failed closed: ${failed}`);
  process.exit(1);
}
if (deprecated.length) {
  console.error(`release lock contains ${deprecated.length} deprecated npm package version(s):`);
  for (const item of deprecated.sort()) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`release lock deprecation check passed: ${packages.length} unique npm package versions verified`);
