import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getBuildIdentity } from "./build_identity.js";

export const CANONICAL_REPO = "mikeholownych/nexus-code";
export const DEFAULT_RELEASES_API = `https://api.github.com/repos/${CANONICAL_REPO}/releases`;
export const DEFAULT_RELEASE_BASE_URL = `https://github.com/${CANONICAL_REPO}/releases`;

export type InstallProvenance = "packaged" | "development" | "unsupported";
export type UpgradeAction = "upgrade" | "downgrade" | "reinstall" | "none";

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
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { writable: true };
  } catch (err: any) {
    return { writable: false, error: err?.message ?? String(err) };
  }
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
      detail: `Packaged installation at ${resolvedHome} (symlink: ${binLink})`,
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
        detail: `Packaged installation at ${versionDir}`,
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

async function downloadFile(
  url: string,
  destPath: string,
  signal?: AbortSignal,
  timeoutMs = 60000
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Download timed out after ${timeoutMs}ms`)), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  const headers: Record<string, string> = { "User-Agent": "nexus-upgrade" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading ${url}`);
    }
    const fileStream = fs.createWriteStream(destPath);
    if (!res.body) {
      throw new Error(`Empty body downloading ${url}`);
    }
    const reader = res.body.getReader();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("error", reject);
      fileStream.on("finish", () => resolve());
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            fileStream.end();
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

export async function performUpgrade(
  comparison: UpgradeComparison,
  options?: UpgradeOptions
): Promise<UpgradeExecutionResult> {
  if (!comparison.canUpgrade) {
    throw new Error(`Cannot upgrade: ${comparison.reasons.join(" ")}`);
  }

  const { installed, targetVersion } = comparison;
  const prefix = options?.prefix ?? installed.prefix ?? path.join(process.env.HOME || "", ".local");
  const baseDownloadUrl = getReleaseBaseUrl();
  const archiveName = `nexus-linux-x86_64-${targetVersion}.tar.gz`;
  const archiveUrl = `${baseDownloadUrl}/download/${targetVersion}/${archiveName}`;
  const checksumsUrl = `${baseDownloadUrl}/download/${targetVersion}/SHA256SUMS`;

  const libNexus = path.join(prefix, "lib", "nexus");
  const binDir = path.join(prefix, "bin");
  const linkPath = path.join(binDir, "nexus");
  const versionDir = path.join(libNexus, targetVersion);

  fs.mkdirSync(libNexus, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Concurrency lock
  const lockFile = path.join(libNexus, ".upgrade.lock");
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
  } catch (err: any) {
    if (err.code === "EEXIST") {
      try {
        const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        // Check if process is still alive
        if (typeof existing.pid === "number") {
          try {
            process.kill(existing.pid, 0);
            throw new Error(`Another upgrade process (PID ${existing.pid}) is currently running.`);
          } catch (probeErr: any) {
            if (probeErr.code === "ESRCH") {
              // Stale lock
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

  const tmpDir = path.join(libNexus, `.tmp-upgrade-${Date.now()}-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }
  };

  try {
    options?.onProgress?.("downloading", `Fetching ${archiveName}...`);
    const localArchive = path.join(tmpDir, archiveName);
    const localSums = path.join(tmpDir, "SHA256SUMS");

    await downloadFile(archiveUrl, localArchive, options?.signal, options?.timeoutMs);
    options?.onProgress?.("verifying_checksum", "Verifying release checksums...");
    await downloadFile(checksumsUrl, localSums, options?.signal, options?.timeoutMs);

    const sumsContent = fs.readFileSync(localSums, "utf8");
    const verified = verifyChecksum(localArchive, sumsContent, archiveName);
    if (!verified) {
      throw new Error(`SHA-256 verification failed for ${archiveName}; no installation was changed.`);
    }

    // Optional attestation check via gh if present
    let attestationVerified: boolean | undefined;
    const verifyAttestation = process.env.NEXUS_VERIFY_ATTESTATION ?? "auto";
    if (verifyAttestation !== "0") {
      const ghProbe = spawnSync("gh", ["--version"]);
      if (ghProbe.status === 0) {
        options?.onProgress?.("verifying_attestation", "Checking build provenance attestation...");
        const attestCheck = spawnSync("gh", ["attestation", "verify", localArchive, "-R", CANONICAL_REPO]);
        if (attestCheck.status === 0) {
          attestationVerified = true;
        } else if (verifyAttestation === "1") {
          throw new Error(`Provenance attestation verification failed for ${archiveName}.`);
        }
      }
    }

    // Extract archive
    options?.onProgress?.("extracting", "Extracting package...");
    const unpackDir = path.join(tmpDir, "unpack");
    fs.mkdirSync(unpackDir, { recursive: true });
    const tarResult = spawnSync("tar", ["-xzf", localArchive, "-C", unpackDir]);
    if (tarResult.status !== 0) {
      throw new Error(`Archive extraction failed: ${tarResult.stderr?.toString() || "tar failed"}`);
    }

    const packageRoot = path.join(unpackDir, "nexus");
    if (!fs.existsSync(packageRoot)) {
      throw new Error("Release archive did not contain top-level 'nexus' directory.");
    }

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

    // Verify existing link
    if (fs.existsSync(linkPath) && !fs.lstatSync(linkPath).isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink; left it unchanged.`);
    }
    if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
      const oldTarget = fs.readlinkSync(linkPath);
      const expectedPrefix = path.join(prefix, "lib", "nexus");
      if (!path.resolve(binDir, oldTarget).startsWith(expectedPrefix)) {
        throw new Error(`${linkPath} points outside the Nexus installation (${oldTarget}); left it unchanged.`);
      }
    }

    // Move validated package to version directory
    options?.onProgress?.("installing", `Installing into ${versionDir}...`);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    fs.renameSync(packageRoot, versionDir);

    // Atomic symlink swap
    const nextLink = path.join(binDir, `.nexus-link.${process.pid}`);
    try {
      fs.unlinkSync(nextLink);
    } catch {}
    fs.symlinkSync(path.join(versionDir, "bin", "nexus"), nextLink);
    fs.renameSync(nextLink, linkPath);

    // Post-installation verification
    options?.onProgress?.("verifying_install", "Verifying installed product...");
    const verifyRun = spawnSync(linkPath, ["--version"], { encoding: "utf8" });
    if (verifyRun.status !== 0) {
      throw new Error(`Installed binary failed self-test: ${verifyRun.stderr || "exit " + verifyRun.status}`);
    }

    return {
      success: true,
      previousVersion: installed.version,
      newVersion: targetVersion,
      installedPath: versionDir,
      binPath: linkPath,
      restartRequired: true,
      restartNotice: `Nexus has been upgraded to ${targetVersion} in ${versionDir}. The current session continues running on ${installed.version}. Restart Nexus to activate the new version.`,
      attestationVerified,
    };
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
