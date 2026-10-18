/**
 * Machine-Readable Release Compatibility Metadata (REQ-REL-116, ACC-UPG-07)
 *
 * Defines versioned metadata schema for published releases, component compatibility,
 * and state/config schema boundaries.
 */

export const COMPATIBILITY_METADATA_FILENAME = "compatibility.json";
export const COMPATIBILITY_SCHEMA_VERSION = 1;
export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

export interface ComponentVersions {
  cli: string;
  core: string;
  tui: string;
  harness: string;
}

export interface SchemaCompatibility {
  configSchemaVersion: number;
  stateSchemaVersion: number;
  minSupportedConfigVersion: number;
  minSupportedStateVersion: number;
}

export interface PlatformAsset {
  archive: string;
  sha256?: string;
  libc?: string;
  os: string;
  arch: string;
}

export interface ReleaseCompatibilityMetadata {
  schemaVersion: number;
  product: "nexus-code";
  version: string;
  revision: string;
  builtAt: string;
  minimumUpdaterVersion?: string;
  components: ComponentVersions;
  compatibility: SchemaCompatibility;
  platforms: Record<string, PlatformAsset>;
}

export interface CompatibilityCheckResult {
  compatible: boolean;
  isLegacy: boolean;
  reasons: string[];
  metadata?: ReleaseCompatibilityMetadata;
}

/**
 * Generates release compatibility metadata for packaging.
 */
export function generateCompatibilityMetadata(
  version: string,
  revision: string,
  platforms?: Record<string, PlatformAsset>
): ReleaseCompatibilityMetadata {
  const normVersion = version.replace(/^v/, "");
  return {
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    product: "nexus-code",
    version: normVersion,
    revision,
    builtAt: new Date().toISOString(),
    minimumUpdaterVersion: "0.1.0-alpha.2",
    components: {
      cli: normVersion,
      core: normVersion,
      tui: normVersion,
      harness: normVersion,
    },
    compatibility: {
      configSchemaVersion: 1,
      stateSchemaVersion: 1,
      minSupportedConfigVersion: 1,
      minSupportedStateVersion: 1,
    },
    platforms: platforms ?? {
      "linux-x86_64": {
        archive: `nexus-linux-x86_64-v${normVersion}.tar.gz`,
        os: "linux",
        arch: "x86_64",
        libc: "glibc-2.35",
      },
    },
  };
}

/**
 * Validates the structure and consistency of compatibility metadata.
 */
export function validateCompatibilityMetadata(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Metadata is not an object"] };
  }
  if (data.product !== "nexus-code") {
    errors.push(`Invalid product '${data.product}', expected 'nexus-code'`);
  }
  if (typeof data.version !== "string" || !parseSemver(data.version)) {
    errors.push("Missing or invalid SemVer 'version'");
  }
  if (data.schemaVersion !== COMPATIBILITY_SCHEMA_VERSION) {
    errors.push(`Unsupported 'schemaVersion' ${data.schemaVersion}; expected ${COMPATIBILITY_SCHEMA_VERSION}`);
  }
  if (typeof data.revision !== "string" || !data.revision.trim()) errors.push("Missing or invalid 'revision'");
  if (typeof data.builtAt !== "string" || Number.isNaN(Date.parse(data.builtAt))) errors.push("Missing or invalid 'builtAt'");
  if (data.minimumUpdaterVersion !== undefined && (typeof data.minimumUpdaterVersion !== "string" || !parseSemver(data.minimumUpdaterVersion))) {
    errors.push("Invalid SemVer 'minimumUpdaterVersion'");
  }
  if (!data.compatibility || typeof data.compatibility !== "object") {
    errors.push("Missing 'compatibility' section");
  } else {
    const c = data.compatibility;
    const schemaFields = ["stateSchemaVersion", "configSchemaVersion", "minSupportedStateVersion", "minSupportedConfigVersion"] as const;
    for (const field of schemaFields) {
      if (!Number.isSafeInteger(c[field]) || c[field] < 0) errors.push(`Missing or invalid 'compatibility.${field}'`);
    }
    if (Number.isSafeInteger(c.stateSchemaVersion) && Number.isSafeInteger(c.minSupportedStateVersion) && c.minSupportedStateVersion > c.stateSchemaVersion) {
      errors.push("compatibility.minSupportedStateVersion exceeds stateSchemaVersion");
    }
    if (Number.isSafeInteger(c.configSchemaVersion) && Number.isSafeInteger(c.minSupportedConfigVersion) && c.minSupportedConfigVersion > c.configSchemaVersion) {
      errors.push("compatibility.minSupportedConfigVersion exceeds configSchemaVersion");
    }
  }
  if (!data.components || typeof data.components !== "object") {
    errors.push("Missing 'components' section");
  } else {
    for (const name of ["cli", "core", "tui", "harness"] as const) {
      if (typeof data.components[name] !== "string" || !parseSemver(data.components[name])) errors.push(`Missing or invalid SemVer 'components.${name}'`);
    }
  }
  if (!data.platforms || typeof data.platforms !== "object" || Object.keys(data.platforms).length === 0) {
    errors.push("Missing or empty 'platforms' section");
  } else {
    for (const [key, asset] of Object.entries(data.platforms) as Array<[string, any]>) {
      if (!asset || typeof asset !== "object") {
        errors.push(`Invalid platform asset '${key}'`);
        continue;
      }
      for (const field of ["archive", "os", "arch"] as const) {
        if (typeof asset[field] !== "string" || !asset[field].trim()) errors.push(`Missing or invalid 'platforms.${key}.${field}'`);
      }
      if (asset.sha256 !== undefined && (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256))) {
        errors.push(`Invalid SHA-256 digest 'platforms.${key}.sha256'`);
      }
      if (asset.libc !== undefined && typeof asset.libc !== "string") errors.push(`Invalid 'platforms.${key}.libc'`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseSemver(input: string): { major: number; minor: number; patch: number; prerelease: Array<string | number> } | null {
  const clean = input.trim().replace(/^[vV]/, "");
  const match = clean.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) : [];
  if (prerelease.some((part, index) => typeof part === "number" && (part > Number.MAX_SAFE_INTEGER || /^0\d/.test(match[4]!.split(".")[index])))) return null;
  return { major, minor, patch, prerelease };
}

function compareSemver(left: NonNullable<ReturnType<typeof parseSemver>>, right: NonNullable<ReturnType<typeof parseSemver>>): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  const count = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < count; i++) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === b) continue;
    if (typeof a === "number" && typeof b !== "number") return -1;
    if (typeof a !== "number" && typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1;
}

function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Ensures the detached metadata asset is the checksummed, archive-bound form of package metadata. */
export function validateCompatibilityAssetBinding(
  external: ReleaseCompatibilityMetadata,
  embedded: ReleaseCompatibilityMetadata,
  expectedVersion: string,
  expectedArchive: string,
  actualArchiveSha256: string,
  platformKey = "linux-x86_64"
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const externalValidation = validateCompatibilityMetadata(external);
  const embeddedValidation = validateCompatibilityMetadata(embedded);
  if (!externalValidation.valid) errors.push(...externalValidation.errors.map((error) => `external ${error}`));
  if (!embeddedValidation.valid) errors.push(...embeddedValidation.errors.map((error) => `embedded ${error}`));
  const externalAsset = external?.platforms?.[platformKey];
  const embeddedAsset = embedded?.platforms?.[platformKey];
  if (!externalAsset || externalAsset.archive !== expectedArchive) errors.push(`external metadata does not name expected archive '${expectedArchive}'`);
  if (!embeddedAsset || embeddedAsset.archive !== expectedArchive) errors.push(`embedded metadata does not name expected archive '${expectedArchive}'`);
  if (externalAsset?.sha256?.toLowerCase() !== actualArchiveSha256.toLowerCase()) errors.push("external metadata archive digest does not match downloaded archive");
  if (external?.version !== expectedVersion.replace(/^[vV]/, "") || embedded?.version !== expectedVersion.replace(/^[vV]/, "")) {
    errors.push("compatibility metadata version does not match release tag");
  }
  if (external && embedded) {
    const externalComparable = JSON.parse(JSON.stringify(external));
    const embeddedComparable = JSON.parse(JSON.stringify(embedded));
    for (const data of [externalComparable, embeddedComparable]) {
      for (const asset of Object.values(data.platforms ?? {}) as any[]) delete asset.sha256;
    }
    if (canonicalJson(externalComparable) !== canonicalJson(embeddedComparable)) errors.push("external metadata does not match metadata embedded in the verified archive");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Evaluates whether target release compatibility metadata is compatible with the local installation.
 * Implements explicit legacy fallback policy for releases lacking metadata.
 */
export function checkReleaseCompatibility(
  currentVersion: string,
  currentStateSchemaVersion: number,
  targetMetadata?: ReleaseCompatibilityMetadata | null,
  platformKey: string = "linux-x86_64",
  currentConfigSchemaVersion: number = CURRENT_CONFIG_SCHEMA_VERSION
): CompatibilityCheckResult {
  if (!targetMetadata) {
    // Legacy policy: older releases prior to compatibility metadata introduction
    // are allowed with legacy advisory, assuming schema version 1.
    return {
      compatible: true,
      isLegacy: true,
      reasons: ["Target release lacks compatibility metadata; proceeding under legacy compatibility policy."],
    };
  }

  const reasons: string[] = [];
  const validation = validateCompatibilityMetadata(targetMetadata);
  if (!validation.valid) {
    return {
      compatible: false,
      isLegacy: false,
      reasons: [`Malformed compatibility metadata: ${validation.errors.join("; ")}`],
      metadata: targetMetadata,
    };
  }

  // 1. Platform support check
  const platform = targetMetadata.platforms[platformKey];
  if (!platform) {
    reasons.push(`Target release does not support platform '${platformKey}'. Available: ${Object.keys(targetMetadata.platforms).join(", ")}`);
  }

  // 2. State schema compatibility for downgrade check
  if (targetMetadata.compatibility.stateSchemaVersion < currentStateSchemaVersion) {
    reasons.push(
      `Target version uses state schema version ${targetMetadata.compatibility.stateSchemaVersion}, which cannot read current state schema version ${currentStateSchemaVersion}.`
    );
  }
  if (currentStateSchemaVersion < targetMetadata.compatibility.minSupportedStateVersion) {
    reasons.push(`Target version requires state schema version ${targetMetadata.compatibility.minSupportedStateVersion}, above current version ${currentStateSchemaVersion}.`);
  }
  if (currentConfigSchemaVersion < targetMetadata.compatibility.minSupportedConfigVersion) {
    reasons.push(`Target version requires config schema version ${targetMetadata.compatibility.minSupportedConfigVersion}, above current version ${currentConfigSchemaVersion}.`);
  }
  if (currentConfigSchemaVersion > targetMetadata.compatibility.configSchemaVersion) {
    reasons.push(`Target version uses config schema version ${targetMetadata.compatibility.configSchemaVersion}, which cannot read current config schema version ${currentConfigSchemaVersion}.`);
  }

  // 3. Minimum updater version check
  if (targetMetadata.minimumUpdaterVersion) {
    const minimum = parseSemver(targetMetadata.minimumUpdaterVersion);
    const current = parseSemver(currentVersion);
    if (!current || !minimum || compareSemver(current, minimum) < 0) {
      reasons.push(`Current updater version (${currentVersion}) is below minimum updater version (${targetMetadata.minimumUpdaterVersion}) required by target release.`);
    }
  }

  return {
    compatible: reasons.length === 0,
    isLegacy: false,
    reasons,
    metadata: targetMetadata,
  };
}
