/**
 * Download & Extraction Safety Engine (REQ-REL-116, ACC-UPG-08)
 *
 * Implements strict tar archive structural validation:
 * - Rejection of path traversal (..), absolute paths, and drive letters
 * - Containment enforcement within designated staging root
 * - File type filtering (blocks character/block devices, FIFOs, hardlinks)
 * - Safe symlink validation (prevents directory escaping)
 * - Tar bomb protection (bounds maximum entries and total uncompressed size)
 * - Duplicate entry conflict detection
 * - Verification of essential distribution layout
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";

export const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024; // 250 MB
export const MAX_EXTRACT_BYTES = 1024 * 1024 * 1024;  // 1 GB
export const MAX_ARCHIVE_ENTRIES = 50_000;

export interface TarEntryInfo {
  name: string;
  size: number;
  typeflag: string;
  linkname?: string;
}

export interface TarValidationResult {
  valid: boolean;
  errors: string[];
  totalBytes: number;
  entryCount: number;
  entries: TarEntryInfo[];
}

/**
 * Validates whether a file path contains path traversal, absolute components, or escapes expected root.
 */
export function isPathSafe(entryPath: string, expectedRoot: string = "nexus"): { safe: boolean; reason?: string } {
  if (!entryPath || typeof entryPath !== "string") {
    return { safe: false, reason: "Empty path" };
  }

  // Reject absolute paths and Windows drive letters
  if (entryPath.startsWith("/") || entryPath.startsWith("\\") || /^[a-zA-Z]:/.test(entryPath)) {
    return { safe: false, reason: `Absolute path forbidden: ${entryPath}` };
  }

  // Normalize and split
  const normalized = path.normalize(entryPath).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.includes("..") || segments.includes(".")) {
    return { safe: false, reason: `Path traversal '..' forbidden: ${entryPath}` };
  }

  // Ensure root containment
  if (segments.length === 0 || segments[0] !== expectedRoot) {
    return { safe: false, reason: `Path '${entryPath}' is not contained within '${expectedRoot}/'` };
  }

  return { safe: true };
}

/**
 * Validates a symlink target relative to its entry path.
 */
export function isSymlinkSafe(linkname: string, entryPath: string, expectedRoot: string = "nexus"): { safe: boolean; reason?: string } {
  if (!linkname) {
    return { safe: false, reason: "Empty symlink target" };
  }

  // Reject absolute symlinks
  if (linkname.startsWith("/") || linkname.startsWith("\\") || /^[a-zA-Z]:/.test(linkname)) {
    return { safe: false, reason: `Absolute symlink target forbidden: ${linkname}` };
  }

  // Compute resolved target relative to fake root
  const entryDir = path.dirname(entryPath);
  const resolved = path.normalize(path.join("/", entryDir, linkname)).replace(/\\/g, "/");

  // Check if it escapes fake root or expected root
  const segments = resolved.split("/").filter(Boolean);
  if (segments.length === 0 || segments[0] !== expectedRoot) {
    return { safe: false, reason: `Symlink target '${linkname}' at '${entryPath}' escapes '${expectedRoot}/' (resolves to ${resolved})` };
  }

  return { safe: true };
}

/**
 * Parses and inspects a .tar.gz archive's headers without extracting to disk.
 */
export async function validateTarArchive(
  archivePath: string,
  expectedRoot: string = "nexus",
  options?: {
    maxBytes?: number;
    maxEntries?: number;
    requiredFiles?: string[];
  }
): Promise<TarValidationResult> {
  const maxBytes = options?.maxBytes ?? MAX_EXTRACT_BYTES;
  const maxEntries = options?.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const requiredFiles = options?.requiredFiles ?? [
    `${expectedRoot}/bin/nexus`,
    `${expectedRoot}/lib/core/harness-core`,
    `${expectedRoot}/lib/core/nexus-tui`,
    `${expectedRoot}/VERSION`,
  ];

  const errors: string[] = [];
  const entries: TarEntryInfo[] = [];
  const seenEntries = new Set<string>();
  let totalBytes = 0;
  let entryCount = 0;

  return new Promise<TarValidationResult>((resolve) => {
    let gunzip: zlib.Gunzip;
    try {
      gunzip = zlib.createGunzip();
    } catch (err: any) {
      return resolve({
        valid: false,
        errors: [`Failed to initialize gunzip: ${err.message}`],
        totalBytes: 0,
        entryCount: 0,
        entries: [],
      });
    }

    const inputStream = fs.createReadStream(archivePath);
    let buffer = Buffer.alloc(0);
    let paxHeaders: Record<string, string> = {};
    let finished = false;

    const finalize = () => {
      if (finished) return;
      finished = true;

      // Check required distribution files
      for (const req of requiredFiles) {
        if (!seenEntries.has(req)) {
          errors.push(`Archive missing essential component: ${req}`);
        }
      }

      resolve({
        valid: errors.length === 0,
        errors,
        totalBytes,
        entryCount,
        entries,
      });
    };

    inputStream.on("error", (err) => {
      errors.push(`Read error: ${err.message}`);
      finalize();
    });

    gunzip.on("error", (err) => {
      errors.push(`Decompression error: ${err.message}`);
      finalize();
    });

    gunzip.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 512) {
        // Read 512-byte block
        const header = buffer.subarray(0, 512);

        // Check for end-of-archive marker (zero block)
        if (header.every((b) => b === 0)) {
          buffer = buffer.subarray(512);
          continue;
        }

        // Parse header fields
        let name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
        const sizeOctal = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
        const typeflag = header.toString("utf8", 156, 157) || "0";
        let linkname = header.toString("utf8", 157, 257).replace(/\0.*$/, "");
        const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");

        if (prefix) {
          name = `${prefix}/${name}`;
        }

        // Apply PAX header overrides if present
        if (paxHeaders["path"]) {
          name = paxHeaders["path"];
          delete paxHeaders["path"];
        }
        if (paxHeaders["linkpath"]) {
          linkname = paxHeaders["linkpath"];
          delete paxHeaders["linkpath"];
        }

        const size = parseInt(sizeOctal, 8) || 0;
        const paddedSize = Math.ceil(size / 512) * 512;

        if (buffer.length < 512 + paddedSize) {
          // Incomplete block, wait for more data
          break;
        }

        const content = buffer.subarray(512, 512 + size);
        buffer = buffer.subarray(512 + paddedSize);

        // Handle PAX extended header block ('x' or 'g')
        if (typeflag === "x" || typeflag === "g") {
          const paxStr = content.toString("utf8");
          paxHeaders = parsePax(paxStr);
          continue;
        }

        // Strip trailing slash for uniform name checks
        const cleanName = name.replace(/\/+$/, "");
        if (!cleanName) continue;

        entryCount++;
        if (entryCount > maxEntries) {
          errors.push(`Archive entry count exceeds maximum limit (${maxEntries})`);
          inputStream.destroy();
          return finalize();
        }

        totalBytes += size;
        if (totalBytes > maxBytes) {
          errors.push(`Archive uncompressed size (${totalBytes} bytes) exceeds limit (${maxBytes} bytes)`);
          inputStream.destroy();
          return finalize();
        }

        // 1. Path safety check
        const pathCheck = isPathSafe(cleanName, expectedRoot);
        if (!pathCheck.safe) {
          errors.push(pathCheck.reason!);
        }

        // 2. Type filtering: allow regular files (0, \0), dirs (5), symlinks (2)
        const isFile = typeflag === "0" || typeflag === "\0";
        const isDir = typeflag === "5";
        const isSymlink = typeflag === "2";

        if (!isFile && !isDir && !isSymlink) {
          errors.push(`Disallowed archive entry type '${typeflag}' for entry '${cleanName}'. Only regular files, directories, and symlinks permitted.`);
        }

        // 3. Symlink safety
        if (isSymlink) {
          const symlinkCheck = isSymlinkSafe(linkname, cleanName, expectedRoot);
          if (!symlinkCheck.safe) {
            errors.push(symlinkCheck.reason!);
          }
        }

        // 4. Duplicate entry check
        if (seenEntries.has(cleanName)) {
          errors.push(`Duplicate archive entry detected: '${cleanName}'`);
        }
        seenEntries.add(cleanName);

        entries.push({
          name: cleanName,
          size,
          typeflag,
          linkname: isSymlink ? linkname : undefined,
        });
      }
    });

    gunzip.on("end", finalize);
    inputStream.pipe(gunzip);
  });
}

function parsePax(paxData: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = paxData.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const match = line.match(/^\d+\s+([^=]+)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

/**
 * Validates and safely extracts a verified tar archive into destinationDir.
 */
export async function safeExtractTar(
  archivePath: string,
  destinationDir: string,
  expectedRoot: string = "nexus"
): Promise<{ extractedDir: string; totalBytes: number; entryCount: number }> {
  // Pre-extraction structural audit
  const validation = await validateTarArchive(archivePath, expectedRoot);
  if (!validation.valid) {
    throw new Error(`Archive failed structural safety inspection: ${validation.errors.join("; ")}`);
  }

  fs.mkdirSync(destinationDir, { recursive: true });

  // Extract
  const tarRes = spawnSync("tar", ["-xzf", archivePath, "-C", destinationDir]);
  if (tarRes.status !== 0) {
    throw new Error(`tar extraction failed: ${tarRes.stderr?.toString() || "unknown tar error"}`);
  }

  const extractedPackage = path.join(destinationDir, expectedRoot);
  if (!fs.existsSync(extractedPackage)) {
    throw new Error(`Extracted package missing top-level directory '${expectedRoot}'`);
  }

  // Post-extraction containment walk: verify no realpath escapes destinationDir
  const realDest = fs.realpathSync(destinationDir);
  function verifyContainment(currentDir: string) {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(currentDir, item.name);
      if (item.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(full);
          if (!target.startsWith(realDest)) {
            throw new Error(`Extracted symlink '${full}' resolves outside destination directory: ${target}`);
          }
        } catch (err: any) {
          throw new Error(`Invalid symlink '${full}': ${err.message}`);
        }
      } else if (item.isDirectory()) {
        verifyContainment(full);
      }
    }
  }

  verifyContainment(extractedPackage);

  return {
    extractedDir: extractedPackage,
    totalBytes: validation.totalBytes,
    entryCount: validation.entryCount,
  };
}
