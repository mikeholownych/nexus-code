/**
 * Machine-Readable Release Compatibility Metadata (REQ-REL-116, ACC-UPG-07)
 *
 * Defines versioned metadata schema for published releases, component compatibility,
 * and state/config schema boundaries.
 */

export const COMPATIBILITY_METADATA_FILENAME = "compatibility.json";
export const COMPATIBILITY_SCHEMA_VERSION = 1;

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
  if (typeof data.version !== "string" || !data.version) {
    errors.push("Missing or invalid 'version'");
  }
  if (typeof data.schemaVersion !== "number" || data.schemaVersion < 1) {
    errors.push("Missing or invalid 'schemaVersion'");
  }
  if (!data.compatibility || typeof data.compatibility !== "object") {
    errors.push("Missing 'compatibility' section");
  } else {
    const c = data.compatibility;
    if (typeof c.stateSchemaVersion !== "number") errors.push("Missing 'compatibility.stateSchemaVersion'");
    if (typeof c.configSchemaVersion !== "number") errors.push("Missing 'compatibility.configSchemaVersion'");
    if (typeof c.minSupportedStateVersion !== "number") errors.push("Missing 'compatibility.minSupportedStateVersion'");
    if (typeof c.minSupportedConfigVersion !== "number") errors.push("Missing 'compatibility.minSupportedConfigVersion'");
  }
  if (!data.components || typeof data.components !== "object") {
    errors.push("Missing 'components' section");
  }
  if (!data.platforms || typeof data.platforms !== "object" || Object.keys(data.platforms).length === 0) {
    errors.push("Missing or empty 'platforms' section");
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
  platformKey: string = "linux-x86_64"
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

  // 3. Minimum updater version check
  if (targetMetadata.minimumUpdaterVersion) {
    // Basic semver check if minimum updater is specified
    const minParts = targetMetadata.minimumUpdaterVersion.replace(/^v/, "").split(/[-.]/).map((p) => parseInt(p, 10) || 0);
    const curParts = currentVersion.replace(/^v/, "").split(/[-.]/).map((p) => parseInt(p, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const min = minParts[i] || 0;
      const cur = curParts[i] || 0;
      if (cur < min) {
        reasons.push(`Current updater version (${currentVersion}) is below minimum updater version (${targetMetadata.minimumUpdaterVersion}) required by target release.`);
        break;
      }
      if (cur > min) break;
    }
  }

  return {
    compatible: reasons.length === 0,
    isLegacy: false,
    reasons,
    metadata: targetMetadata,
  };
}
