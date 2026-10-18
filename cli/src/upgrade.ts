import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getBuildIdentity } from "./build_identity.js";
import {
  isPathSafe,
  isSymlinkSafe,
  validateTarArchive,
  safeExtractTar,
  MAX_DOWNLOAD_BYTES,
  MAX_EXTRACT_BYTES,
} from "./tar_safety.js";
import {
  ReleaseCompatibilityMetadata,
  CURRENT_CONFIG_SCHEMA_VERSION,
  checkReleaseCompatibility,
  validateCompatibilityMetadata,
  validateCompatibilityAssetBinding,
  COMPATIBILITY_METADATA_FILENAME,
} from "./compatibility.js";
import { verifyInstalledRuntime } from "./upgrade_health.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./core/state.js";
import {
  UpgradeJournalEntry,
  readJournal,
  writeJournal,
  clearJournal,
  createPreMigrationBackup,
  restoreConfigBackup,
  recoverUpgrade,
  getJournalPath,
  syncDirectory,
} from "./upgrade_journal.js";

export const CANONICAL_REPO = "mikeholownych/nexus-code";
export const DEFAULT_RELEASES_API = `https://api.github.com/repos/${CANONICAL_REPO}/releases`;
export const DEFAULT_RELEASE_BASE_URL = `https://github.com/${CANONICAL_REPO}/releases`;

export type InstallProvenance = "packaged" | "development" | "package-manager" | "unsupported";
export type UpgradeAction = "upgrade" | "downgrade" | "reinstall" | "none";

export interface ProvenanceRecord {
  formatVersion: 1;
  method: "packaged" | "installer" | "upgrade";
  product: "nexus-code";
  version: string;
  revision?: string;
  builtAt?: string;
  prefix: string;
  installedPath: string;
  binPath: string;
  managed: boolean;
  packageManager?: string;
  archive?: string;
  archiveSha256?: string;
}

export interface SemVer {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  build?: string;
}

export interface InstalledProductInfo {
  version: string;
  normalizedVersion: string;
  semver: SemVer | null;
  isPrerelease: boolean;
  provenance: InstallProvenance;
  installRoot?: string;
  prefix?: string;
  binLink?: string;
  writable: boolean;
  permissionError?: string;
  detail?: string;
  provenanceRecord?: ProvenanceRecord;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface PublishedRelease {
  tag_name: string;
  name?: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string;
  html_url?: string;
  assets: ReleaseAsset[];
}

export interface UpgradeComparison {
  installed: InstalledProductInfo;
  target: PublishedRelease;
  targetVersion: string;
  targetSemver: SemVer;
  action: UpgradeAction;
  canUpgrade: boolean;
  reasons: string[];
}

export interface UpgradeExecutionResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  installedPath: string;
  binPath: string;
  restartRequired: boolean;
  restartNotice: string;
  attestationVerified?: boolean;
}

export interface UpgradeOptions {
  check?: boolean;
  version?: string;
  yes?: boolean;
  allowDowngrade?: boolean;
  force?: boolean;
  json?: boolean;
  timeoutMs?: number;
  prefix?: string;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
  confirm?: (proposal: UpgradeComparison) => Promise<boolean>;
}

// -----------------------------------------------------------------------------
// SemVer 2.0.0
// -----------------------------------------------------------------------------

export function parseSemver(input: string): SemVer | null {
  if (!input || typeof input !== "string") return null;
  const clean = input.trim().replace(/^[vV]/, "").split(/[\s(]/)[0];
  const regex = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
  const match = clean.match(regex);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);
  const prerelease: Array<string | number> = [];
  if (match[4]) {
    for (const part of match[4].split(".")) {
      if (/^\d+$/.test(part)) {
        prerelease.push(parseInt(part, 10));
      } else {
        prerelease.push(part);
      }
    }
  }
  return {
    raw: input.trim(),
    major,
    minor,
    patch,
    prerelease,
    build: match[5],
  };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  // Normal releases have higher precedence than prereleases
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;

  const minLen = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < minLen; i++) {
    const idA = a.prerelease[i];
    const idB = b.prerelease[i];
    if (idA === idB) continue;
    const isNumA = typeof idA === "number";
    const isNumB = typeof idB === "number";
    if (isNumA && !isNumB) return -1;
    if (!isNumA && isNumB) return 1;
    if (isNumA && isNumB) return (idA as number) > (idB as number) ? 1 : -1;
    return String(idA) > String(idB) ? 1 : -1;
  }
  if (a.prerelease.length !== b.prerelease.length) {
    return a.prerelease.length > b.prerelease.length ? 1 : -1;
  }
  return 0;
}

export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
    return `v${trimmed.slice(1)}`;
  }
  return `v${trimmed}`;
}

export function isValidTag(tag: string): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(-[-0-9A-Za-z.]+)?$/.test(tag);
}

// -----------------------------------------------------------------------------
// Provenance & Installation Layout
// -----------------------------------------------------------------------------

function testWritable(dir: string): { writable: boolean; error?: string } {
  try {
    // Diagnosis and --check must never create directories or probe files.
    let existing = path.resolve(dir);
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    fs.accessSync(existing, fs.constants.W_OK);
    return { writable: true };
  } catch (err: any) {
    return { writable: false, error: err?.message ?? String(err) };
  }
}

export function writeProvenance(versionDir: string, record: ProvenanceRecord): void {
  const provPath = path.join(versionDir, ".provenance.json");
  const tmpPath = `${provPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o644 });
  const fd = fs.openSync(tmpPath, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmpPath, provPath);
  syncDirectory(versionDir);
}

export function detectInstallation(customOptions?: {
  nexusHome?: string;
  hereDir?: string;
  envPrefix?: string;
}): InstalledProductInfo {
  const nexusHome = customOptions?.nexusHome ?? process.env.NEXUS_HOME;
  const here = customOptions?.hereDir ?? path.dirname(fileURLToPath(import.meta.url));
  const envPrefix = customOptions?.envPrefix ?? process.env.NEXUS_PREFIX;

  if (nexusHome) {
    const resolvedHome = path.resolve(nexusHome);
    const versionFile = path.join(resolvedHome, "VERSION");
    let versionStr = "unknown";
    if (fs.existsSync(versionFile)) {
      try {
        versionStr = fs.readFileSync(versionFile, "utf8").trim();
      } catch {}
    }
    if (versionStr === "unknown") {
      versionStr = getBuildIdentity().version;
    }
    const prefix = path.resolve(resolvedHome, "../../..");
    const binLink = path.join(prefix, "bin", "nexus");
    const writeCheck = testWritable(resolvedHome);
    const sem = parseSemver(versionStr);

    const provFile = path.join(resolvedHome, ".provenance.json");
    let provRecord: ProvenanceRecord | undefined;
    if (fs.existsSync(provFile)) {
      try {
        provRecord = JSON.parse(fs.readFileSync(provFile, "utf8"));
      } catch {}
    }

    if (provRecord && !provRecord.managed && provRecord.packageManager) {
      return {
        version: versionStr,
        normalizedVersion: sem ? normalizeTag(versionStr) : versionStr,
        semver: sem,
        isPrerelease: Boolean(sem && sem.prerelease.length > 0),
        provenance: "package-manager",
        installRoot: resolvedHome,
        prefix,
        binLink,
        writable: false,
        detail: `Installed via package manager (${provRecord.packageManager}). Use ${provRecord.packageManager} to update.`,
        provenanceRecord: provRecord,
      };
    }

    return {
      version: versionStr,
      normalizedVersion: sem ? normalizeTag(versionStr) : versionStr,
      semver: sem,
      isPrerelease: Boolean(sem && sem.prerelease.length > 0),
      provenance: "packaged",
      installRoot: resolvedHome,
      prefix,
      binLink,
      writable: writeCheck.writable,
      permissionError: writeCheck.error,
      detail: provRecord ? `Packaged installation at ${resolvedHome} (verified provenance)` : `Legacy packaged installation at ${resolvedHome}`,
      provenanceRecord: provRecord,
    };
  }

  // Check if running from a development checkout
  const candidateCheckoutRoot = path.resolve(here, "../..");
  const isGitRepo = fs.existsSync(path.join(candidateCheckoutRoot, ".git"));
  const hasCargo = fs.existsSync(path.join(candidateCheckoutRoot, "core", "Cargo.toml"));
  const hasRootPackage = fs.existsSync(path.join(candidateCheckoutRoot, "package.json"));

  if (isGitRepo || (hasCargo && hasRootPackage)) {
    const buildInfo = getBuildIdentity();
    const sem = parseSemver(buildInfo.version);
    return {
      version: buildInfo.string,
      normalizedVersion: sem ? normalizeTag(buildInfo.version) : buildInfo.version,
      semver: sem,
      isPrerelease: Boolean(sem && sem.prerelease.length > 0),
      provenance: "development",
      installRoot: candidateCheckoutRoot,
      prefix: envPrefix || path.join(process.env.HOME || "", ".local"),
      binLink: path.join(envPrefix || path.join(process.env.HOME || "", ".local"), "bin", "nexus"),
      writable: true,
      detail: `Source development checkout at ${candidateCheckoutRoot}`,
    };
  }

  // Fallback: check if here looks like <prefix>/lib/nexus/<version>/lib/cli/dist
  const parts = here.split(path.sep);
  const libNexusIdx = parts.lastIndexOf("nexus");
  if (libNexusIdx > 0 && parts[libNexusIdx - 1] === "lib") {
    const versionDir = parts.slice(0, libNexusIdx + 2).join(path.sep);
    const versionFile = path.join(versionDir, "VERSION");
    if (fs.existsSync(versionFile)) {
      const v = fs.readFileSync(versionFile, "utf8").trim();
      const prefix = parts.slice(0, libNexusIdx - 1).join(path.sep);
      const binLink = path.join(prefix, "bin", "nexus");
      const writeCheck = testWritable(versionDir);
      const sem = parseSemver(v);

      const provFile = path.join(versionDir, ".provenance.json");
      let provRecord: ProvenanceRecord | undefined;
      if (fs.existsSync(provFile)) {
        try {
          provRecord = JSON.parse(fs.readFileSync(provFile, "utf8"));
        } catch {}
      }

      if (provRecord && !provRecord.managed && provRecord.packageManager) {
        return {
          version: v,
          normalizedVersion: sem ? normalizeTag(v) : v,
          semver: sem,
          isPrerelease: Boolean(sem && sem.prerelease.length > 0),
          provenance: "package-manager",
          installRoot: versionDir,
          prefix,
          binLink,
          writable: false,
          detail: `Installed via package manager (${provRecord.packageManager}). Use ${provRecord.packageManager} to update.`,
          provenanceRecord: provRecord,
        };
      }

      return {
        version: v,
        normalizedVersion: sem ? normalizeTag(v) : v,
        semver: sem,
        isPrerelease: Boolean(sem && sem.prerelease.length > 0),
        provenance: "packaged",
        installRoot: versionDir,
        prefix,
        binLink,
        writable: writeCheck.writable,
        permissionError: writeCheck.error,
        detail: provRecord ? `Packaged installation at ${versionDir} (verified provenance)` : `Legacy packaged installation at ${versionDir}`,
        provenanceRecord: provRecord,
      };
    }
  }

  const identity = getBuildIdentity();
  const sem = parseSemver(identity.version);
  return {
    version: identity.string,
    normalizedVersion: sem ? normalizeTag(identity.version) : identity.version,
    semver: sem,
    isPrerelease: Boolean(sem && sem.prerelease.length > 0),
    provenance: "unsupported",
    detail: "Unknown installation location or execution method",
    writable: false,
  };
}

// -----------------------------------------------------------------------------
// Releases API Resolution
// -----------------------------------------------------------------------------

function getApiBase(): string {
  return process.env.NEXUS_RELEASES_API || DEFAULT_RELEASES_API;
}

function getReleaseBaseUrl(): string {
  return process.env.NEXUS_RELEASE_BASE_URL || DEFAULT_RELEASE_BASE_URL;
}

async function fetchJson(url: string, signal?: AbortSignal, timeoutMs = 15000): Promise<{ status: number; data: any; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "nexus-upgrade",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    let data: any = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveTargetRelease(
  pinnedTag?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<PublishedRelease> {
  const apiBase = getApiBase();
  const timeoutMs = options?.timeoutMs ?? 15000;
  const signal = options?.signal;

  if (pinnedTag) {
    const tag = normalizeTag(pinnedTag);
    if (!isValidTag(tag)) {
      throw new Error(`version must be a release tag like v1.2.3 or v1.2.3-alpha.1 (got: ${pinnedTag}).`);
    }
    const url = `${apiBase}/tags/${tag}`;
    let res;
    try {
      res = await fetchJson(url, signal, timeoutMs);
    } catch (err: any) {
      throw new Error(`could not query GitHub releases API: ${err.message || String(err)}`);
    }
    if (res.status === 200 && res.data && typeof res.data.tag_name === "string") {
      if (res.data.draft) {
        throw new Error(`release ${tag} is an unpublished draft and cannot be installed.`);
      }
      return {
        tag_name: res.data.tag_name,
        name: res.data.name,
        draft: Boolean(res.data.draft),
        prerelease: Boolean(res.data.prerelease),
        published_at: res.data.published_at,
        html_url: res.data.html_url,
        assets: Array.isArray(res.data.assets)
          ? res.data.assets.map((a: any) => ({
              name: a.name,
              browser_download_url: a.browser_download_url,
              size: a.size,
            }))
          : [],
      };
    }
    if (res.status === 404) {
      throw new Error(`could not find release ${tag} (HTTP 404 from ${url}).`);
    }
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        throw new Error("GitHub API rate limit exceeded; set GITHUB_TOKEN to authorize requests.");
      }
      throw new Error(`GitHub API returned HTTP 403 for ${url}.`);
    }
    throw new Error(`could not query GitHub releases API (HTTP ${res.status}); host unreachable or network error.`);
  }

  // Default: resolve latest stable release
  const latestUrl = `${apiBase}/latest`;
  let latestRes;
  try {
    latestRes = await fetchJson(latestUrl, signal, timeoutMs);
  } catch (err: any) {
    throw new Error(`could not query GitHub releases API: ${err.message || String(err)}`);
  }

  if (latestRes.status === 200 && latestRes.data && typeof latestRes.data.tag_name === "string") {
    const tag = latestRes.data.tag_name;
    if (!isValidTag(tag)) {
      throw new Error(`GitHub returned invalid stable release tag format: ${tag}`);
    }
    return {
      tag_name: tag,
      name: latestRes.data.name,
      draft: Boolean(latestRes.data.draft),
      prerelease: Boolean(latestRes.data.prerelease),
      published_at: latestRes.data.published_at,
      html_url: latestRes.data.html_url,
      assets: Array.isArray(latestRes.data.assets)
        ? latestRes.data.assets.map((a: any) => ({
            name: a.name,
            browser_download_url: a.browser_download_url,
            size: a.size,
          }))
        : [],
    };
  }

  if (latestRes.status === 404) {
    // Check if prereleases exist (matching install.sh behavior)
    const listUrl = `${apiBase}?per_page=1`;
    let listRes;
    try {
      listRes = await fetchJson(listUrl, signal, timeoutMs);
    } catch {}
    if (listRes?.status === 200 && Array.isArray(listRes.data) && listRes.data.length > 0) {
      const first = listRes.data[0];
      if (first.tag_name) {
        throw new Error(`no stable release yet; latest prerelease is ${first.tag_name} — rerun with --version ${first.tag_name}`);
      }
    }
    throw new Error(`could not find latest stable release (HTTP 404 from ${latestUrl}).`);
  }

  if (latestRes.status === 403) {
    const remaining = latestRes.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new Error("GitHub API rate limit exceeded; set --version <tag> to bypass the release lookup, or set GITHUB_TOKEN.");
    }
    throw new Error("GitHub API returned HTTP 403; set --version <tag> to bypass the release lookup.");
  }

  throw new Error(`could not query GitHub releases API (HTTP ${latestRes.status}); network failure or host unreachable.`);
}

// -----------------------------------------------------------------------------
// Comparison Engine
// -----------------------------------------------------------------------------

export function compareInstallationWithRelease(
  installed: InstalledProductInfo,
  target: PublishedRelease,
  options?: { force?: boolean }
): UpgradeComparison {
  const targetTag = normalizeTag(target.tag_name);
  const targetSem = parseSemver(targetTag);
  if (!targetSem) {
    throw new Error(`Target release tag ${target.tag_name} is not valid SemVer.`);
  }

  let action: UpgradeAction = "none";
  const reasons: string[] = [];
  let canUpgrade = true;

  // Platform check
  const osType = process.platform;
  const archType = process.arch;
  if (osType !== "linux" || (archType !== "x64" && (archType as string) !== "amd64")) {
    canUpgrade = false;
    reasons.push(`Unsupported system ${osType}/${archType}; supported: Linux x86-64 (glibc).`);
  }

  // Node version check
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10) || 0;
  if (nodeMajor < 20) {
    canUpgrade = false;
    reasons.push(`Node.js 20 or newer is required (found ${process.version}).`);
  }

  // Provenance check
  if (installed.provenance === "development") {
    canUpgrade = false;
    reasons.push(
      "Nexus is running from a source development checkout. Use `git pull && make build` to update, or install the packaged release via `install.sh`."
    );
  } else if (installed.provenance === "package-manager") {
    canUpgrade = false;
    reasons.push(
      installed.detail || "Nexus is managed by an external package manager. Use your system package manager to upgrade."
    );
  } else if (installed.provenance === "unsupported") {
    canUpgrade = false;
    reasons.push(`Cannot determine installation layout for ${installed.version}.`);
  }

  if (!installed.semver) {
    // Current version identity is unparseable / unknown
    action = "upgrade";
    reasons.push(`Installed version identity '${installed.version}' is unknown; target is ${targetTag}.`);
  } else {
    const cmp = compareSemver(targetSem, installed.semver);
    if (cmp > 0) {
      action = "upgrade";
    } else if (cmp < 0) {
      action = "downgrade";
    } else {
      action = options?.force ? "reinstall" : "none";
    }
  }

  return {
    installed,
    target,
    targetVersion: targetTag,
    targetSemver: targetSem,
    action,
    canUpgrade,
    reasons,
  };
}

// -----------------------------------------------------------------------------
// Download, Verification, and Atomic Installation
// -----------------------------------------------------------------------------

export function validateDownloadUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  // Reject URLs with embedded credentials (user:pass@...)
  if (parsed.username || parsed.password) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Test / override environments: allow custom release base URL or releases API host
  const customBase = process.env.NEXUS_RELEASE_BASE_URL || process.env.NEXUS_RELEASES_URL || process.env.NEXUS_RELEASES_API;
  if (customBase) {
    try {
      const customParsed = new URL(customBase);
      if (hostname === customParsed.hostname.toLowerCase()) {
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          return true;
        }
      }
    } catch {}
  }

  // Localhost allowed for local mock testing
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }

  // GitHub allowed domains - must be HTTPS
  if (parsed.protocol !== "https:") {
    return false;
  }

  if (hostname === "github.com") {
    return parsed.pathname.startsWith(`/${CANONICAL_REPO}/releases/download/`);
  }

  if (hostname === "objects.githubusercontent.com") {
    return true;
  }

  return false;
}

export async function downloadFile(
  url: string,
  destPath: string,
  signal?: AbortSignal,
  timeoutMs = 60000,
  maxHops = 5
): Promise<void> {
  let currentUrl = url;
  let hops = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Download timed out after ${timeoutMs}ms`)), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }

  try {
    while (hops <= maxHops) {
      if (!validateDownloadUrl(currentUrl)) {
        throw new Error(`Disallowed download origin or invalid URL: ${currentUrl}`);
      }

      const headers: Record<string, string> = { "User-Agent": "nexus-upgrade" };
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (token && (new URL(currentUrl)).hostname === "github.com") {
        headers.Authorization = `Bearer ${token}`;
      }

      const res = await fetch(currentUrl, {
        headers,
        signal: controller.signal,
        redirect: "manual",
      });

      // Handle redirect
      if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
        const location = res.headers.get("location");
        if (!location) {
          throw new Error(`HTTP ${res.status} redirect without Location header from ${currentUrl}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        hops++;
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} downloading ${currentUrl}`);
      }

      const contentLengthHeader = res.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (contentLength > MAX_DOWNLOAD_BYTES) {
          throw new Error(`Download size (${contentLength} bytes) exceeds maximum allowed limit (${MAX_DOWNLOAD_BYTES} bytes)`);
        }
      }

      const fileStream = fs.createWriteStream(destPath);
      if (!res.body) {
        throw new Error(`Empty body downloading ${currentUrl}`);
      }

      let bytesDownloaded = 0;
      const reader = res.body.getReader();

      try {
        await new Promise<void>((resolve, reject) => {
          fileStream.on("error", reject);
          fileStream.on("finish", () => resolve());
          function pump() {
            reader.read().then(({ done, value }) => {
              if (done) {
                fileStream.end();
                return;
              }
              bytesDownloaded += value.byteLength;
              if (bytesDownloaded > MAX_DOWNLOAD_BYTES) {
                reject(new Error(`Download exceeded maximum limit of ${MAX_DOWNLOAD_BYTES} bytes`));
                return;
              }
              fileStream.write(Buffer.from(value), (err) => {
                if (err) reject(err);
                else pump();
              });
            }).catch(reject);
          }
          pump();
        });
      } catch (streamErr) {
        try { fs.unlinkSync(destPath); } catch {}
        throw streamErr;
      }

      return;
    }

    throw new Error(`Too many redirects (exceeded ${maxHops} hops) while downloading`);
  } finally {
    clearTimeout(timer);
  }
}

export function computeSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

export function verifyChecksum(archivePath: string, checksumsContent: string, archiveName: string): boolean {
  for (const line of checksumsContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Expected format: "<sha256>  <filename>" or "<sha256> *<filename>"
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const expectedHash = parts[0].toLowerCase();
      const filename = parts.slice(1).join(" ").replace(/^\*/, "");
      if (filename === archiveName) {
        const actualHash = computeSha256(archivePath).toLowerCase();
        return actualHash === expectedHash;
      }
    }
  }
  return false;
}

function verifyManifest(pkgDir: string): boolean {
  const manifestPath = path.join(pkgDir, "MANIFEST.sha256");
  if (!fs.existsSync(manifestPath)) return true;
  const content = fs.readFileSync(manifestPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const expectedHash = parts[0].toLowerCase();
      const relFile = parts.slice(1).join(" ").replace(/^\*/, "");
      const fullPath = path.resolve(pkgDir, relFile);
      if (!fs.existsSync(fullPath)) return false;
      const actualHash = computeSha256(fullPath).toLowerCase();
      if (actualHash !== expectedHash) return false;
    }
  }
  return true;
}

export function detectPathShadowing(binDir: string): { shadowed: boolean; precedingPaths: string[] } {
  const envPath = process.env.PATH || "";
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const precedingPaths: string[] = [];
  const normalizedBinDir = path.resolve(binDir);

  for (const dir of dirs) {
    const resolvedDir = path.resolve(dir);
    if (resolvedDir === normalizedBinDir) {
      break;
    }
    const candidate = path.join(resolvedDir, "nexus");
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if ((stat.mode & 0o111) !== 0) {
          precedingPaths.push(candidate);
        }
      }
    } catch {}
  }

  return {
    shadowed: precedingPaths.length > 0,
    precedingPaths,
  };
}

export function rollbackBinary(prefix: string): { success: boolean; revertedTo?: string; error?: string } {
  const recorded = readJournal(prefix);
  if (fs.existsSync(getJournalPath(prefix))) {
    if (!recorded) return { success:false, error:"Invalid upgrade journal; no rollback was attempted." };
    if (recorded.state !== "complete") return { success:false, error:"Resolve the pending upgrade with --recover before binary rollback." };
    const outcome = recoverUpgrade(prefix, { forceRollback:true });
    return outcome.recovered ? { success:true, revertedTo:recorded.sourceVersion } : { success:false, error:outcome.details };
  }
  const libNexus = path.join(prefix, "lib", "nexus");
  const binNexus = path.join(prefix, "bin", "nexus");
  if (!fs.existsSync(libNexus)) {
    return { success: false, error: `Nexus directory ${libNexus} does not exist.` };
  }

  let currentTarget = "";
  try {
    if (fs.lstatSync(binNexus).isSymbolicLink()) {
      currentTarget = path.basename(path.dirname(path.dirname(fs.realpathSync(binNexus))));
    }
  } catch {}

  const entries = fs.readdirSync(libNexus, { withFileTypes: true });
  const versions: { dirName: string; semver: SemVer }[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    if (ent.name === currentTarget) continue;
    const binCheck = path.join(libNexus, ent.name, "bin", "nexus");
    if (!fs.existsSync(binCheck)) continue;
    const sem = parseSemver(ent.name);
    if (sem) {
      versions.push({ dirName: ent.name, semver: sem });
    }
  }

  if (versions.length === 0) {
    return { success: false, error: "No alternate installed version found to roll back to." };
  }

  // Sort descending semver
  versions.sort((a, b) => compareSemver(b.semver, a.semver));
  const candidate = versions[0];
  const candidateBin = path.join(libNexus, candidate.dirName, "bin", "nexus");

  // A rollback candidate must be the complete, exact reported release.
  const health = verifyInstalledRuntime(path.dirname(path.dirname(candidateBin)), candidate.dirName);
  if (!health.healthy) return { success:false, error:`Candidate rollback version failed runtime validation: ${health.error}` };

  // Atomic swap
  const binDir = path.dirname(binNexus);
  const tmpLink = path.join(binDir, `.nexus-link-rollback.${process.pid}.${Date.now()}`);
  try {
    fs.symlinkSync(candidateBin, tmpLink);
    fs.renameSync(tmpLink, binNexus);
  } catch (err: any) {
    try { fs.unlinkSync(tmpLink); } catch {}
    return { success: false, error: `Failed to update symlink: ${err.message}` };
  }

  return { success: true, revertedTo: candidate.dirName };
}

export async function performUpgrade(
  comparison: UpgradeComparison,
  options?: UpgradeOptions
): Promise<UpgradeExecutionResult> {
  if (!comparison.canUpgrade) {
    throw new Error(`Cannot upgrade: ${comparison.reasons.join(" ")}`);
  }

  const { installed, targetVersion, action } = comparison;
  const prefix = path.resolve(options?.prefix ?? installed.prefix ?? path.join(process.env.HOME || "", ".local"));
  const baseDownloadUrl = getReleaseBaseUrl();
  const archiveName = `nexus-linux-x86_64-${targetVersion}.tar.gz`;
  const archiveUrl = `${baseDownloadUrl}/download/${targetVersion}/${archiveName}`;
  const checksumsUrl = `${baseDownloadUrl}/download/${targetVersion}/SHA256SUMS`;
  const compatibilityUrl = `${baseDownloadUrl}/download/${targetVersion}/compatibility.json`;

  const libNexus = path.join(prefix, "lib", "nexus");
  const binDir = path.join(prefix, "bin");
  const linkPath = path.join(binDir, "nexus");
  const versionDir = path.join(libNexus, targetVersion);

  fs.mkdirSync(libNexus, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  if (fs.realpathSync(libNexus) !== path.resolve(libNexus) || fs.realpathSync(binDir) !== path.resolve(binDir)) throw new Error("Managed installation roots must not be redirected by symlinks.");

  // 1. Concurrency lock
  const lockFile = path.join(libNexus, ".upgrade.lock");
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
  } catch (err: any) {
    if (err.code === "EEXIST") {
      try {
        if (!fs.lstatSync(lockFile).isFile() || fs.realpathSync(lockFile) !== path.resolve(lockFile)) throw new Error("Upgrade lock path is redirected");
        const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error("Upgrade lock owner is invalid");
        if (typeof existing.pid === "number") {
          try {
            process.kill(existing.pid, 0);
            throw new Error(`Another upgrade process (PID ${existing.pid}) is currently running.`);
          } catch (probeErr: any) {
            if (probeErr.code === "ESRCH") {
              fs.unlinkSync(lockFile);
              lockFd = fs.openSync(lockFile, "wx");
              fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
            } else {
              throw probeErr;
            }
          }
        }
      } catch (inner: any) {
        throw new Error(`Another upgrade is in progress (lockfile present at ${lockFile}): ${inner.message || inner}`);
      }
    } else {
      throw new Error(`Could not acquire upgrade lock at ${lockFile}: ${err.message || err}`);
    }
  }

  const transactionId = `upg-${Date.now()}-${process.pid}`;
  const tmpDir = path.join(libNexus, `.tmp-upgrade-${transactionId}`);
  let journalEntry: UpgradeJournalEntry | undefined;
  const cleanup = () => {
    // A failed recovery keeps every artifact, including staging, for the operator.
    if (!journalEntry || ["complete", "rolled_back"].includes(journalEntry.state)) {
      try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
    }
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  };
  try {
    const pending = readJournal(prefix);
    if (fs.existsSync(getJournalPath(prefix)) && (!pending || !["idle", "complete", "rolled_back"].includes(pending.state))) throw new Error("Pending or invalid upgrade journal; run nexus upgrade --recover before starting another transaction.");
    options?.onProgress?.("pre_migration_backup", "Creating pre-migration configuration and state backup...");
    const backupResult = createPreMigrationBackup();
    fs.mkdirSync(tmpDir, { mode:0o700 });
    journalEntry = {
      formatVersion:1, id:transactionId, state:"preparing",
      sourceVersion:installed.version, sourceInstallDir:installed.installRoot || path.join(libNexus, installed.version),
      sourceSymlinkTarget:path.join(installed.installRoot || path.join(libNexus, installed.version), "bin", "nexus"),
      targetVersion, targetInstallDir:versionDir, stagingDir:tmpDir,
      replacementBackupDir:path.join(libNexus, `.rollback-${transactionId}`),
      displacedTargetDir:path.join(libNexus, `.failed-${transactionId}`),
      prefix, binPath:linkPath, startedAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
      configBackupPath:backupResult.configBackupPath, stateBackupDir:backupResult.stateBackupDir,
    };
    writeJournal(prefix, journalEntry);
    if (!readJournal(prefix)) throw new Error("Installation identity does not match the managed prefix; no package was changed.");
    // 4. Downloading phase
    options?.onProgress?.("downloading", `Fetching ${archiveName}...`);
    journalEntry.state = "downloading";
    journalEntry.updatedAt = new Date().toISOString();
    writeJournal(prefix, journalEntry);

    const localArchive = path.join(tmpDir, archiveName);
    const localSums = path.join(tmpDir, "SHA256SUMS");
    const localCompat = path.join(tmpDir, "compatibility.json");

    await downloadFile(archiveUrl, localArchive, options?.signal, options?.timeoutMs);
    options?.onProgress?.("verifying_checksum", "Verifying release checksums...");
    await downloadFile(checksumsUrl, localSums, options?.signal, options?.timeoutMs);

    const sumsContent = fs.readFileSync(localSums, "utf8");
    const verified = verifyChecksum(localArchive, sumsContent, archiveName);
    if (!verified) {
      throw new Error(`SHA-256 verification failed for ${archiveName}; no installation was changed.`);
    }

    // A detached metadata asset is optional for legacy releases, but if present
    // it must be valid and checksum-bound. Its policy is compared with the copy
    // embedded in the archive after extraction.
    let externalCompat: ReleaseCompatibilityMetadata | null = null;
    try {
      await downloadFile(compatibilityUrl, localCompat, options?.signal, 5000);
      if (fs.existsSync(localCompat)) {
        externalCompat = JSON.parse(fs.readFileSync(localCompat, "utf8"));
        const externalValidation = validateCompatibilityMetadata(externalCompat);
        if (!externalValidation.valid) throw new Error(`Invalid compatibility.json: ${externalValidation.errors.join("; ")}`);
        if (!verifyChecksum(localCompat, sumsContent, COMPATIBILITY_METADATA_FILENAME)) {
          throw new Error("SHA-256 verification failed for compatibility.json; no installation was changed.");
        }
      }
    } catch (err: any) {
      // Release may omit standalone compatibility asset
      if (!String(err?.message ?? err).includes("HTTP 404")) throw err;
    }

    // Optional attestation check via gh if present
    let attestationVerified: boolean | undefined;
    const verifyAttestation = process.env.NEXUS_VERIFY_ATTESTATION ?? "auto";
    if (verifyAttestation !== "0") {
      const ghProbe = spawnSync("gh", ["--version"]);
      if (ghProbe.status === 0) {
        options?.onProgress?.("verifying_attestation", "Checking build provenance attestation...");
        const attestCheck = spawnSync("gh", ["attestation", "verify", localArchive, "-R", CANONICAL_REPO]);
        const indexAttestCheck = spawnSync("gh", ["attestation", "verify", localSums, "-R", CANONICAL_REPO]);
        if (attestCheck.status === 0 && indexAttestCheck.status === 0) {
          attestationVerified = true;
        } else if (verifyAttestation === "1") {
          throw new Error(`Provenance attestation verification failed for ${archiveName} or SHA256SUMS.`);
        }
      }
    }

    // 5. Staging phase: Safe tar header validation and extraction
    options?.onProgress?.("extracting", "Inspecting and safely extracting package...");
    journalEntry.state = "staged";
    journalEntry.updatedAt = new Date().toISOString();
    writeJournal(prefix, journalEntry);

    const unpackDir = path.join(tmpDir, "unpack");
    const { extractedDir: packageRoot } = await safeExtractTar(localArchive, unpackDir, "nexus");

    // Validate package components
    const binNexus = path.join(packageRoot, "bin", "nexus");
    const coreHarness = path.join(packageRoot, "lib", "core", "harness-core");
    const coreTui = path.join(packageRoot, "lib", "core", "nexus-tui");
    const versionPath = path.join(packageRoot, "VERSION");

    if (!fs.existsSync(binNexus) || !fs.existsSync(coreHarness) || !fs.existsSync(coreTui) || !fs.existsSync(versionPath)) {
      throw new Error("Release archive is incomplete: essential runtime binaries are missing.");
    }

    const packageVersion = fs.readFileSync(versionPath, "utf8").trim();
    if (packageVersion !== targetVersion) {
      throw new Error(`Release archive version mismatch: expected ${targetVersion}, found ${packageVersion}.`);
    }

    // Ensure permissions
    fs.chmodSync(binNexus, 0o755);
    fs.chmodSync(coreHarness, 0o755);
    fs.chmodSync(coreTui, 0o755);

    // Verify manifest if present
    if (!verifyManifest(packageRoot)) {
      throw new Error("Release archive failed internal manifest checksum verification.");
    }

    // Pre-switch staging verification: ensure unpacked executable runs --version before touching installation
    options?.onProgress?.("verifying_staged", "Testing unpacked binary in staging...");
    const stageVerify = verifyInstalledRuntime(packageRoot, targetVersion, options?.timeoutMs);
    if (!stageVerify.healthy) throw new Error(`Unpacked binary failed staging self-test: ${stageVerify.error}`);

    // The in-archive copy is authenticated by the archive checksum/attestation.
    // Detached metadata may add only the archive digest; all policy fields must
    // match the embedded contract exactly.
    let compatMeta: ReleaseCompatibilityMetadata | null = null;
    const internalCompat = path.join(packageRoot, COMPATIBILITY_METADATA_FILENAME);
    if (fs.existsSync(internalCompat)) {
      try {
        compatMeta = JSON.parse(fs.readFileSync(internalCompat, "utf8"));
      } catch (err: any) {
        throw new Error(`Invalid compatibility metadata embedded in archive: ${err?.message ?? String(err)}`);
      }
      const internalValidation = validateCompatibilityMetadata(compatMeta);
      if (!internalValidation.valid) throw new Error(`Invalid compatibility metadata embedded in archive: ${internalValidation.errors.join("; ")}`);
    }
    if (externalCompat) {
      if (!compatMeta) throw new Error("Detached compatibility metadata is not bound to the downloaded archive.");
      const binding = validateCompatibilityAssetBinding(
        externalCompat,
        compatMeta,
        targetVersion,
        archiveName,
        computeSha256(localArchive)
      );
      if (!binding.valid) throw new Error(`Compatibility metadata binding failed: ${binding.errors.join("; ")}`);
    }

    // Evaluate compatibility against current state schema
    const compatResult = checkReleaseCompatibility(
      installed.version,
      CURRENT_STATE_SCHEMA_VERSION,
      compatMeta,
      "linux-x86_64",
      CURRENT_CONFIG_SCHEMA_VERSION,
      targetVersion
    );
    if (!compatResult.compatible) {
      if (action === "downgrade" && compatMeta && compatMeta.compatibility.stateSchemaVersion < CURRENT_STATE_SCHEMA_VERSION) {
        throw new Error(
          `Downgrade refused: Target version ${targetVersion} uses state schema version ${compatMeta.compatibility.stateSchemaVersion}, which cannot read current state schema version ${CURRENT_STATE_SCHEMA_VERSION}. Explicit downgrade flag cannot bypass state incompatibility.`
        );
      }
      throw new Error(`Compatibility check failed: ${compatResult.reasons.join("; ")}`);
    }
    if (compatResult.isLegacy) {
      options?.onProgress?.("legacy_policy", compatResult.reasons[0]);
    }

    // Verify existing link safety
    if (fs.existsSync(linkPath) && !fs.lstatSync(linkPath).isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink; left it unchanged.`);
    }
    if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
      const oldTarget = fs.readlinkSync(linkPath);
      const expectedPrefix = path.join(prefix, "lib", "nexus");
      if (!path.resolve(binDir, oldTarget).startsWith(`${expectedPrefix}${path.sep}`)) {
        throw new Error(`${linkPath} points outside the Nexus installation (${oldTarget}); left it unchanged.`);
      }
    }

    // 6. Switching phase: Move package to versionDir and write provenance
    options?.onProgress?.("installing", `Installing into ${versionDir}...`);
    journalEntry.state = "switching";
    journalEntry.updatedAt = new Date().toISOString();
    writeJournal(prefix, journalEntry);

    // Durable identity is already journaled. Never place the sole working
    // package in staging: cleanup or a killed process must not erase rollback.
    const backupDir = journalEntry.replacementBackupDir!;
    if (fs.existsSync(versionDir)) {
      fs.renameSync(versionDir, backupDir);
      syncDirectory(libNexus);
      options?.onProgress?.("package_preserved", "Previous package preserved for rollback.");
    }
    fs.renameSync(packageRoot, versionDir);
    syncDirectory(libNexus);
    options?.onProgress?.("package_moved", "Staged package moved into place.");

    // Record durable provenance
    writeProvenance(versionDir, {
      formatVersion: 1,
      method: "upgrade",
      product: "nexus-code",
      version: targetVersion,
      revision: compatMeta?.revision,
      builtAt: compatMeta?.builtAt,
      prefix,
      installedPath: versionDir,
      binPath: linkPath,
      managed: true,
      archive: archiveName,
      archiveSha256: computeSha256(localArchive),
    });

    options?.onProgress?.("provenance_written", "Installation provenance recorded.");

    // Atomic symlink swap
    const nextLink = path.join(binDir, `.nexus-link.${process.pid}`);
    try {
      fs.unlinkSync(nextLink);
    } catch {}
    fs.symlinkSync(path.join(versionDir, "bin", "nexus"), nextLink);
    fs.renameSync(nextLink, linkPath);
    syncDirectory(binDir);
    options?.onProgress?.("launcher_switched", "Launcher switched; runtime verification pending.");

    journalEntry.state = "switched";
    journalEntry.updatedAt = new Date().toISOString();
    writeJournal(prefix, journalEntry);

    // 7. Post-installation verification phase
    options?.onProgress?.("verifying_install", "Verifying installed product...");
    const verifyRun = verifyInstalledRuntime(versionDir, targetVersion, options?.timeoutMs);
    if (!verifyRun.healthy) throw new Error(`Installed binary failed self-test: ${verifyRun.error}`);

    // Retain the old same-version package after success for --rollback-binary.
    journalEntry.state = "verified";
    journalEntry.updatedAt = new Date().toISOString();
    writeJournal(prefix, journalEntry);

    // Check for PATH shadowing
    const shadowing = detectPathShadowing(binDir);
    let pathWarning: string | undefined;
    if (shadowing.shadowed) {
      pathWarning = `Warning: Installed launcher at ${linkPath} is shadowed by '${shadowing.precedingPaths[0]}' earlier in PATH. Run 'hash -r' or adjust PATH order.`;
      options?.onProgress?.("path_shadow_warning", pathWarning);
    }

    // 8. Complete journal
    journalEntry.state = "complete";
    journalEntry.updatedAt = new Date().toISOString();
    writeJournal(prefix, journalEntry);

    return {
      success: true,
      previousVersion: installed.version,
      newVersion: targetVersion,
      installedPath: versionDir,
      binPath: linkPath,
      restartRequired: true,
      restartNotice: `Nexus has been upgraded to ${targetVersion} in ${versionDir}. The current session continues running on ${installed.version}. Restart Nexus to activate the new version.${pathWarning ? `\n\n${pathWarning}` : ""}`,
      attestationVerified,
    };
  } catch (error: any) {
    if (journalEntry) {
      const outcome = recoverUpgrade(prefix, { forceRollback:true, timeoutMs:options?.timeoutMs, lockHeld:true });
      // Read back the durable outcome rather than claiming rollback after a
      // failed rename, journal write, probe, or symlink update.
      const durable = readJournal(prefix);
      if (durable) journalEntry = durable;
      if (!outcome.recovered) throw new Error(`${error.message}; ${outcome.details}`);
    }
    throw error;
  } finally {
    cleanup();
  }
}

export const UPGRADE_EXIT = {
  ok: 0,
  updateAvailableOrDeclined: 1,
  error: 2,
} as const;

export async function upgradeCommand(options: any): Promise<void> {
  const isJson = Boolean(options.json);
  const timeoutMs = options.timeout ? Number(options.timeout) : 15000;
  const isCheckOnly = Boolean(options.check);
  const prefix = options.prefix ?? path.join(process.env.HOME || "", ".local");

  if (isCheckOnly && (options.rollbackBinary || options.restoreBackup || options.recover)) {
    console.error("--check cannot be combined with modifying recovery operations.");
    process.exit(UPGRADE_EXIT.error);
  }

  // 1. Rollback binary command
  if (options.rollbackBinary) {
    const outcome = rollbackBinary(prefix);
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            tool: "nexus upgrade",
            status: outcome.success ? "reverted" : "error",
            ...outcome,
          },
          null,
          2
        )
      );
    } else {
      if (outcome.success) {
        console.log(`✔ Executable launcher reverted to ${outcome.revertedTo}.`);
        console.log(`Note: Run with --restore-backup <path> if state restoration is also required.`);
      } else {
        console.error(`Rollback failed: ${outcome.error}`);
      }
    }
    process.exit(outcome.success ? UPGRADE_EXIT.ok : UPGRADE_EXIT.error);
  }

  // 2. Restore backup command
  if (options.restoreBackup) {
    const backupPath = String(options.restoreBackup);
    const restored = restoreConfigBackup(backupPath);
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            tool: "nexus upgrade",
            status: restored ? "restored" : "error",
            backupPath,
          },
          null,
          2
        )
      );
    } else {
      if (restored) {
        console.log(`✔ Restored configuration/state backup from ${backupPath}.`);
      } else {
        console.error(`Restore failed: backup file ${backupPath} not found.`);
      }
    }
    process.exit(restored ? UPGRADE_EXIT.ok : UPGRADE_EXIT.error);
  }

  // 3. Crash recovery command
  if (options.recover && isCheckOnly) {
    console.error("--check cannot be combined with recovery or restore operations.");
    process.exit(UPGRADE_EXIT.error);
  }
  if (options.recover) {
    const outcome = recoverUpgrade(prefix);
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            tool: "nexus upgrade",
            status: outcome.recovered ? "recovered" : outcome.action === "none" ? "no_action" : "error",
            ...outcome,
          },
          null,
          2
        )
      );
    } else {
      if (outcome.recovered) {
        console.log(`✔ Recovery completed (${outcome.action}): ${outcome.details}`);
      } else {
        console.log(`Recovery check: ${outcome.details}`);
      }
    }
    process.exit(outcome.recovered || outcome.action === "none" ? UPGRADE_EXIT.ok : UPGRADE_EXIT.error);
  }

  // 4. Automatic crash recovery check at startup
  const journal = readJournal(prefix);
  if (!isCheckOnly && journal && journal.state !== "complete" && journal.state !== "idle" && journal.state !== "rolled_back") {
    if (!isJson) {
      console.warn(`[upgrade] Detected interrupted upgrade in state '${journal.state}'. Attempting recovery...`);
    }
    const recoveryOutcome = recoverUpgrade(prefix);
    if (!isJson) {
      console.warn(`[upgrade] Recovery: ${recoveryOutcome.details}`);
    }
    if (!recoveryOutcome.recovered && recoveryOutcome.action !== "none") {
      if (isJson) console.log(JSON.stringify({ schemaVersion:1, tool:"nexus upgrade", status:"error", error:recoveryOutcome.details }));
      process.exit(UPGRADE_EXIT.error);
    }
  }

  try {
    const installed = detectInstallation();
    let targetRelease: PublishedRelease;
    try {
      targetRelease = await resolveTargetRelease(options.version, { timeoutMs });
    } catch (err: any) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              tool: "nexus upgrade",
              status: "error",
              installedVersion: installed.version,
              error: err.message || String(err),
            },
            null,
            2
          )
        );
      } else {
        console.error(`nexus upgrade: ${err.message || String(err)}`);
      }
      process.exit(UPGRADE_EXIT.error);
    }

    const comparison = compareInstallationWithRelease(installed, targetRelease, { force: options.force });

    if (isCheckOnly) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              tool: "nexus upgrade",
              status:
                comparison.action === "upgrade"
                  ? "update_available"
                  : comparison.action === "downgrade"
                  ? "downgrade_available"
                  : "up_to_date",
              installedVersion: installed.version,
              targetVersion: comparison.targetVersion,
              action: comparison.action,
              installPrefix: installed.prefix,
              installProvenance: installed.provenance,
              canUpgrade: comparison.canUpgrade,
              reasons: comparison.reasons,
              release: {
                tag: targetRelease.tag_name,
                name: targetRelease.name,
                prerelease: targetRelease.prerelease,
                publishedAt: targetRelease.published_at,
                url: targetRelease.html_url,
              },
            },
            null,
            2
          )
        );
      } else {
        console.log(`Current version: ${installed.version} (${installed.provenance})`);
        console.log(
          `Target release:  ${targetRelease.tag_name}${
            targetRelease.prerelease ? " (prerelease)" : " (stable)"
          }${targetRelease.published_at ? ` [published ${targetRelease.published_at}]` : ""}`
        );
        if (installed.prefix) console.log(`Install prefix:  ${installed.prefix}`);
        if (comparison.reasons.length > 0) {
          for (const reason of comparison.reasons) console.log(`Note:            ${reason}`);
        }
        if (comparison.action === "upgrade") {
          console.log(`\nAn update is available: ${installed.version} -> ${comparison.targetVersion}.`);
          console.log(`Run 'nexus upgrade' to upgrade to the latest stable release.`);
        } else if (comparison.action === "downgrade") {
          console.log(
            `\nTarget release ${comparison.targetVersion} is older than currently installed version ${installed.version}.`
          );
          console.log(`Run 'nexus upgrade --version ${comparison.targetVersion} --allow-downgrade' to downgrade.`);
        } else {
          console.log(`\nNexus is already up to date (${installed.version}).`);
        }
      }
      process.exit(comparison.action === "upgrade" ? UPGRADE_EXIT.updateAvailableOrDeclined : UPGRADE_EXIT.ok);
    }

    // Modify / installation mode:
    if (!comparison.canUpgrade) {
      const errorMsg = comparison.reasons.join("\n");
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              tool: "nexus upgrade",
              status: "unsupported",
              installedVersion: installed.version,
              targetVersion: comparison.targetVersion,
              error: errorMsg,
            },
            null,
            2
          )
        );
      } else {
        console.error(`nexus upgrade: ${errorMsg}`);
      }
      process.exit(UPGRADE_EXIT.error);
    }

    if (comparison.action === "none" && !options.force) {
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              tool: "nexus upgrade",
              status: "up_to_date",
              installedVersion: installed.version,
              targetVersion: comparison.targetVersion,
              message: `Nexus is already at version ${installed.version}. Use --force to reinstall.`,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Nexus is already up to date (${installed.version}). Use --force to reinstall.`);
      }
      process.exit(UPGRADE_EXIT.ok);
    }

    if (comparison.action === "downgrade" && !options.allowDowngrade && !options.yes) {
      if (!process.stdin.isTTY) {
        const msg = `Target version ${comparison.targetVersion} is a downgrade from ${installed.version}. Non-interactive downgrade requires --allow-downgrade and --yes.`;
        if (isJson) {
          console.log(JSON.stringify({ schemaVersion: 1, tool: "nexus upgrade", status: "declined", error: msg }, null, 2));
        } else {
          console.error(`nexus upgrade: ${msg}`);
        }
        process.exit(UPGRADE_EXIT.updateAvailableOrDeclined);
      }
    }

    // Confirmation
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !isJson);
    if (!options.yes) {
      if (!isInteractive) {
        const msg = `nexus upgrade: ${comparison.action} from ${installed.version} to ${comparison.targetVersion} requires confirmation. Re-run with --yes in non-interactive scripts.`;
        if (isJson) {
          console.log(JSON.stringify({ schemaVersion: 1, tool: "nexus upgrade", status: "declined", error: msg }, null, 2));
        } else {
          console.error(msg);
        }
        process.exit(UPGRADE_EXIT.updateAvailableOrDeclined);
      }

      console.log(`Proposed ${comparison.action}:`);
      console.log(`  Installed:    ${installed.version} (${installed.provenance})`);
      console.log(`  Target:       ${comparison.targetVersion} (${targetRelease.prerelease ? "prerelease" : "stable"})`);
      console.log(`  Destination:  ${path.join(installed.prefix || "", "lib/nexus", comparison.targetVersion)}`);
      if (comparison.action === "downgrade") {
        console.log(`  WARNING: This is a downgrade to an older release.`);
      }
      process.stdout.write(`\nProceed with ${comparison.action}? [y/N]: `);

      const answer = await new Promise<string>((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", (d) => {
          process.stdin.pause();
          resolve(String(d).trim().toLowerCase());
        });
      });

      if (answer !== "y" && answer !== "yes") {
        console.log(`Upgrade cancelled.`);
        process.exit(UPGRADE_EXIT.updateAvailableOrDeclined);
      }
    }

    if (!isJson) {
      console.log(`Starting ${comparison.action} to ${comparison.targetVersion}...`);
    }

    const result = await performUpgrade(comparison, {
      prefix: options.prefix,
      force: options.force,
      allowDowngrade: options.allowDowngrade,
      timeoutMs,
      onProgress: (_stage, detail) => {
        if (!isJson && detail) {
          console.log(`  • ${detail}`);
        }
      },
    });

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            tool: "nexus upgrade",
            status: "success",
            previousVersion: result.previousVersion,
            newVersion: result.newVersion,
            installedPath: result.installedPath,
            binPath: result.binPath,
            restartRequired: result.restartRequired,
            restartNotice: result.restartNotice,
          },
          null,
          2
        )
      );
    } else {
      console.log(`\n✔ Nexus successfully upgraded to ${result.newVersion}.`);
      console.log(`Location: ${result.installedPath}`);
      console.log(`Launcher: ${result.binPath}`);
      console.log(`\nNote: ${result.restartNotice}\n`);
    }
    process.exit(UPGRADE_EXIT.ok);
  } catch (err: any) {
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            tool: "nexus upgrade",
            status: "error",
            error: err.message || String(err),
          },
          null,
          2
        )
      );
    } else {
      console.error(`nexus upgrade failed: ${err.message || String(err)}`);
    }
    process.exit(UPGRADE_EXIT.error);
  }
}
