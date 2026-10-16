#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const noticesPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'THIRD_PARTY_NOTICES.txt');

if (!fs.existsSync(noticesPath)) {
  console.error(`[-] Notices file not found: ${noticesPath}`);
  process.exit(1);
}

const noticesContent = fs.readFileSync(noticesPath, 'utf-8');

// 1. Check npm production dependency closure (ACC-SUP-01)
const cliDir = path.join(rootDir, 'cli');
const candidateNpmDirs = [
  path.join(path.dirname(noticesPath), 'lib', 'cli'),
  cliDir,
];

let npmTree = null;
for (const dir of candidateNpmDirs) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) {
    try {
      const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      npmTree = JSON.parse(out);
      break;
    } catch {
      // try next
    }
  }
}

const npmPkgs = new Map();
if (npmTree && npmTree.dependencies) {
  function collectNpm(node) {
    if (!node || !node.dependencies) return;
    for (const [name, info] of Object.entries(node.dependencies)) {
      if (info.version) {
        npmPkgs.set(`${name}@${info.version}`, { name, version: info.version });
      }
      collectNpm(info);
    }
  }
  collectNpm(npmTree);
} else {
  // Fallback to lockfile if node_modules is not yet installed in working tree
  const lockPath = path.join(cliDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    for (const [k, v] of Object.entries(lock.packages || {})) {
      if (k === '' || v.dev) continue;
      const marker = 'node_modules/';
      const idx = k.lastIndexOf(marker);
      const pkgName = idx !== -1 ? k.slice(idx + marker.length) : k;
      npmPkgs.set(`${pkgName}@${v.version}`, { name: pkgName, version: v.version });
    }
  }
}

const missingNpm = [];
for (const [key, pkg] of npmPkgs.entries()) {
  const pattern1 = `${pkg.name} ${pkg.version}`;
  const pattern2 = `${pkg.name}@${pkg.version}`;
  if (!noticesContent.includes(pattern1) && !noticesContent.includes(pattern2)) {
    missingNpm.push(key);
  }
}

// 2. Check Rust dependency closure for shipped binaries (ACC-SUP-01)
const coreManifest = path.join(rootDir, 'core', 'Cargo.toml');
const metaOut = execFileSync(
  'cargo',
  ['metadata', '--locked', '--format-version', '1', '--manifest-path', coreManifest],
  { cwd: rootDir, encoding: 'utf-8' }
);
const meta = JSON.parse(metaOut);

// Use cargo tree to get exact crate closure for the shipped targets (excluding dev-dependencies)
const treeOut = execFileSync(
  'cargo',
  ['tree', '--locked', '--manifest-path', coreManifest, '--prefix', 'none'],
  { cwd: rootDir, encoding: 'utf-8' }
);

const rustPkgs = new Map();
for (const line of treeOut.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s+v([0-9a-zA-Z\.\+-]+)/);
  if (match) {
    const name = match[1];
    const version = match[2];
    if (name === 'harness-core') continue; // Workspace root package
    rustPkgs.set(`${name}@${version}`, { name, version });
  }
}

const missingRust = [];
for (const [key, pkg] of rustPkgs.entries()) {
  const pattern1 = `${pkg.name} ${pkg.version}`;
  const pattern2 = `${pkg.name}@${pkg.version}`;
  if (!noticesContent.includes(pattern1) && !noticesContent.includes(pattern2)) {
    missingRust.push(key);
  }
}

// 3. Report results
let failed = false;
if (missingNpm.length > 0) {
  failed = true;
  console.error(`[-] Missing ${missingNpm.length} npm production package(s) in notices:`);
  for (const pkg of missingNpm) {
    console.error(`    ${pkg}`);
  }
}

if (missingRust.length > 0) {
  failed = true;
  console.error(`[-] Missing ${missingRust.length} Rust crate(s) in notices:`);
  for (const pkg of missingRust) {
    console.error(`    ${pkg}`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(
  `NOTICES_CHECK_PASS: Verified ${rustPkgs.size} Rust crate(s) and ${npmPkgs.size} npm package(s) in ${noticesPath}`
);
