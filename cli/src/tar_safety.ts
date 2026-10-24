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
// PAX records are attacker-controlled metadata. Keep one record bounded even
// when it does not contribute to the declared file payload total.
export const MAX_PAX_HEADER_BYTES = 64 * 1024;
export const MAX_TOTAL_PAX_BYTES = 1024 * 1024;

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

  // Normalize separators before resolving from the package-relative entry directory. The check
  // below enforces containment of the final normalized target; it does not reject a target solely
  // because its unnormalized spelling temporarily climbs above the package-root prefix.
  const entryDir = path.posix.dirname(entryPath.replace(/\\/g, "/"));
  const resolved = path.posix.normalize(
    path.posix.join(entryDir, linkname.replace(/\\/g, "/"))
  );

  // Check if it escapes the package root
  const segments = resolved.split("/").filter(Boolean);
  if (segments.length === 0 || segments[0] !== expectedRoot || segments.includes("..")) {
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
  let decompressedBytes = 0;
  let paxBytes = 0;
  // Headers, padding and terminators also consume memory/CPU. Bound the full
  // decompressed stream independently from the sum of regular-file payloads.
  const maxStreamBytes = maxBytes + maxEntries * 1024 + MAX_TOTAL_PAX_BYTES + 2048;

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
    let globalPaxHeaders: Record<string, string> = {};
    let finished = false;
    const fail = (message: string) => {
      if (finished) return;
      errors.push(message);
      inputStream.destroy();
      gunzip.destroy();
      finalize();
    };

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
      if (finished) return;
      errors.push(`Read error: ${err.message}`);
      finalize();
    });

    gunzip.on("error", (err) => {
      if (finished) return;
      errors.push(`Decompression error: ${err.message}`);
      finalize();
    });

    gunzip.on("data", (chunk: Buffer) => {
      decompressedBytes += chunk.length;
      if (decompressedBytes > maxStreamBytes) {
        fail(`Archive decompressed stream exceeds safety limit (${maxStreamBytes} bytes)`);
        return;
      }
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

        const size = parseInt(sizeOctal, 8) || 0;
        if (!Number.isSafeInteger(size) || size < 0) {
          fail("Archive contains an invalid or unsafe entry size");
          return;
        }
        const paddedSize = Math.ceil(size / 512) * 512;
        if (!Number.isSafeInteger(paddedSize) || paddedSize > maxStreamBytes) {
          fail(`Archive entry size exceeds safety limit (${maxStreamBytes} bytes)`);
          return;
        }
        if ((typeflag === "x" || typeflag === "g") && size > MAX_PAX_HEADER_BYTES) {
          fail(`PAX metadata exceeds safety limit (${MAX_PAX_HEADER_BYTES} bytes per header)`);
          return;
        }
        if (buffer.length < 512 + paddedSize) {
          // Incomplete block, wait for more data
          break;
        }

        const content = buffer.subarray(512, 512 + size);
        buffer = buffer.subarray(512 + paddedSize);

        // Handle PAX extended header block ('x' or 'g')
        if (typeflag === "x" || typeflag === "g") {
          paxBytes += size;
          if (paxBytes > MAX_TOTAL_PAX_BYTES || content.length !== size) {
            fail(`PAX metadata exceeds total safety limit (${MAX_TOTAL_PAX_BYTES} bytes)`);
            return;
          }
          try {
            const parsed = parsePax(content);
            if (typeflag === "g") globalPaxHeaders = { ...globalPaxHeaders, ...parsed };
            else paxHeaders = { ...paxHeaders, ...parsed };
          } catch (err: any) {
            fail(`Malformed PAX metadata: ${err.message}`);
            return;
          }
          continue;
        }

        // Global PAX defaults persist; local PAX values override them for the
        // next entry. Validate the effective names used by the tar extractor.
        if (globalPaxHeaders["path"]) name = globalPaxHeaders["path"];
        if (globalPaxHeaders["linkpath"]) linkname = globalPaxHeaders["linkpath"];
        if (paxHeaders["path"]) name = paxHeaders["path"];
        if (paxHeaders["linkpath"]) linkname = paxHeaders["linkpath"];
        paxHeaders = {};

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

function parsePax(paxData: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const safeMetadata = new Set(["uid", "gid", "uname", "gname", "mtime", "atime", "ctime", "comment"]);
  let offset = 0;
  while (offset < paxData.byteLength) {
    const space = paxData.indexOf(0x20, offset);
    if (space < 0) throw new Error("record length is missing");
    const lengthText = paxData.subarray(offset, space).toString("ascii");
    if (!/^\d+$/.test(lengthText)) throw new Error("record length is invalid");
    const recordLength = Number(lengthText);
    const recordEnd = offset + recordLength;
    if (!Number.isSafeInteger(recordLength) || recordLength <= space - offset + 2 || recordEnd > paxData.byteLength || paxData[recordEnd - 1] !== 0x0a) {
      throw new Error("record length is invalid");
    }
    const record = paxData.subarray(space + 1, recordEnd - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("record key/value is invalid");
    const key = decoder.decode(record.subarray(0, equals));
    if (key === "path" || key === "linkpath") result[key] = decoder.decode(record.subarray(equals + 1));
    else if (!safeMetadata.has(key)) throw new Error(`unsupported extraction-affecting key '${key}'`);
    offset = recordEnd;
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

  // Extract with a fixed system tar, not whatever PATH resolves, and without ambient TAR_OPTIONS
  // (which can carry --to-command or checkpoint actions that execute code during extraction).
  const tar = ["/usr/bin/tar", "/bin/tar"].find((candidate) => fs.existsSync(candidate)) ?? "tar";
  const tarRes = spawnSync(tar, ["-xzf", archivePath, "-C", destinationDir], {
    env: { ...process.env, TAR_OPTIONS: "" },
  });
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
