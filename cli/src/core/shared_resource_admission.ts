/** Cross-operation, same-host admission for configured inference-resource slots. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir, writeFileDurably } from "./durable_file.js";
import { acquireFileGuard, releaseFileGuard, type FileGuard } from "./file_guard.js";
import type { ResourceDescriptor } from "./resources.js";
import { MAX_CONCURRENT_UNITS } from "./operation_schema.js";

/** Persistent lock files are never unlinked while other processes may hold their inodes. Bound unique identities. */
export const MAX_SHARED_RESOURCE_IDENTITIES = 1_024;

interface CapacityRecord {
  format: "NEXUS_RESOURCE_ADMISSION";
  version: 1;
  capacity: number;
}

export interface ResourceSlotLease {
  /** Idempotently releases this unit's kernel-owned slot. */
  release(): void;
}

export class ResourceAdmissionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceAdmissionConflictError";
  }
}

function canonicalEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ResourceAdmissionConflictError("resource endpoint is not a valid URL; shared admission refused");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResourceAdmissionConflictError("resource endpoint must use HTTP or HTTPS; shared admission refused");
  }
  // Credentials and query strings can contain secrets. They are not part of the stored key material.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resourceKey(resource: ResourceDescriptor): string {
  const identity = JSON.stringify({
    provider: resource.provider.trim().toLowerCase(),
    providerId: resource.providerId?.trim().toLowerCase() ?? "",
    endpoint: canonicalEndpoint(resource.endpoint),
    // A declared serving pool spans models, so it replaces the model component of the slot identity.
    model: resource.pool ? "" : resource.model,
    pool: resource.pool ?? "",
    // Account is a non-secret identity label/fingerprint in ResourceDescriptor; hash it before persistence.
    account: resource.account ?? "default",
  });
  return createHash("sha256").update(identity).digest("hex");
}

function capacityOf(resource: ResourceDescriptor, operatorMaximum: number): number {
  const declared = resource.maxConcurrentUnits ?? operatorMaximum;
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_CONCURRENT_UNITS) {
    throw new ResourceAdmissionConflictError("resource maxConcurrentUnits is invalid; shared admission refused");
  }
  // A workspace operation spec may supply this descriptor. It can lower the operator-owned ceiling, never raise it.
  return Math.min(declared, operatorMaximum);
}

function ensureAdmissionDirectory(dir: string): void {
  ensurePrivateDir(dir);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("resource admission directory is redirected");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("resource admission directory is not owned by the running user");
  if ((stat.mode & 0o077) !== 0) throw new Error("resource admission directory has unsafe permissions");
}

function readCapacity(file: string): CapacityRecord | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ResourceAdmissionConflictError("shared resource admission record is redirected; admission refused");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ResourceAdmissionConflictError("shared resource admission record has a foreign owner; admission refused");
  if ((stat.mode & 0o077) !== 0 || stat.nlink !== 1) throw new ResourceAdmissionConflictError("shared resource admission record has unsafe permissions; admission refused");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new ResourceAdmissionConflictError("shared resource admission record disappeared while being read; admission refused");
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ResourceAdmissionConflictError("shared resource admission record is unreadable; admission refused");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResourceAdmissionConflictError("shared resource admission record is invalid; admission refused");
  }
  const record = parsed as Partial<CapacityRecord>;
  if (
    record.format !== "NEXUS_RESOURCE_ADMISSION" ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.capacity) ||
    (record.capacity ?? 0) < 1 ||
    (record.capacity ?? 0) > MAX_CONCURRENT_UNITS ||
    Object.keys(parsed).some((key) => !["format", "version", "capacity"].includes(key))
  ) {
    throw new ResourceAdmissionConflictError("shared resource admission record is invalid; admission refused");
  }
  return record as CapacityRecord;
}

/**
 * Atomically reserves slots across operation IDs and Nexus processes on the same host/filesystem.
 * `operatorMaxUnits` is the operator-owned ceiling; a resource descriptor can lower it, never raise it. Concurrent
 * effective declarations for one identity must agree; an active mismatch fails closed.
 */
export class SharedResourceAdmission {
  constructor(
    private readonly directory: string,
    private readonly options: { operatorMaxUnits?: number; guardWaitMs?: number; maxResourceIdentities?: number } = {},
  ) {
    const operatorMaxUnits = options.operatorMaxUnits ?? 1;
    const guardWaitMs = options.guardWaitMs ?? 1_000;
    const maxResourceIdentities = options.maxResourceIdentities ?? MAX_SHARED_RESOURCE_IDENTITIES;
    if (!Number.isSafeInteger(operatorMaxUnits) || operatorMaxUnits < 1 || operatorMaxUnits > MAX_CONCURRENT_UNITS) {
      throw new Error(`invalid operator shared-resource capacity; expected 1..${MAX_CONCURRENT_UNITS}`);
    }
    if (!Number.isSafeInteger(guardWaitMs) || guardWaitMs < 0) throw new Error("invalid resource admission guard wait bound");
    if (!Number.isSafeInteger(maxResourceIdentities) || maxResourceIdentities < 1 || maxResourceIdentities > MAX_SHARED_RESOURCE_IDENTITIES) {
      throw new Error(`invalid shared-resource identity bound; expected 1..${MAX_SHARED_RESOURCE_IDENTITIES}`);
    }
  }

  private get operatorMaxUnits(): number {
    return this.options.operatorMaxUnits ?? 1;
  }

  private get guardWaitMs(): number {
    return this.options.guardWaitMs ?? 1_000;
  }

  private get maxResourceIdentities(): number {
    return this.options.maxResourceIdentities ?? MAX_SHARED_RESOURCE_IDENTITIES;
  }

  private acquireIdentityGuard(prefix: string): FileGuard | null {
    const catalog = acquireFileGuard(path.join(this.directory, "catalog.guard"), {
      label: "Shared resource catalog guard",
      waitMs: this.guardWaitMs,
    });
    if (!catalog) return null;
    try {
      const guardPath = `${prefix}.guard`;
      const exists = fs.lstatSync(guardPath, { throwIfNoEntry: false }) !== undefined;
      if (!exists) {
        const registered = fs.readdirSync(this.directory).filter((name) => /^[0-9a-f]{64}\.guard$/.test(name)).length;
        if (registered >= this.maxResourceIdentities) {
          throw new ResourceAdmissionConflictError(
            `shared resource identity limit (${this.maxResourceIdentities}) reached; refusing to create another admission record`,
          );
        }
      }
      try {
        return acquireFileGuard(guardPath, { label: "Shared resource admission guard", waitMs: this.guardWaitMs });
      } catch (error) {
        throw new ResourceAdmissionConflictError(`cannot establish shared resource admission: ${(error as Error).message}`);
      }
    } finally {
      releaseFileGuard(catalog);
    }
  }

  acquire(resource: ResourceDescriptor): ResourceSlotLease | null {
    ensureAdmissionDirectory(this.directory);
    const key = resourceKey(resource);
    const capacity = capacityOf(resource, this.operatorMaxUnits);
    const prefix = path.join(this.directory, key);
    const mutex = this.acquireIdentityGuard(prefix);
    if (!mutex) return null;

    let slot: FileGuard | null = null;
    try {
      const capacityFile = `${prefix}.json`;
      const existing = readCapacity(capacityFile);
      if (!existing && this.probeActiveSlots(prefix, MAX_CONCURRENT_UNITS) > 0) {
        throw new ResourceAdmissionConflictError("shared resource admission metadata is missing while a slot is active; admission refused");
      }
      if (existing && existing.capacity !== capacity) {
        const active = this.probeActiveSlots(prefix, existing.capacity);
        if (active > 0) {
          throw new ResourceAdmissionConflictError(
            `active operations declare different capacities (${existing.capacity} and ${capacity}) for the same inference resource`,
          );
        }
      }
      const effectiveCapacity = existing?.capacity === capacity ? existing.capacity : capacity;
      for (let index = 0; index < effectiveCapacity; index++) {
        try {
          slot = acquireFileGuard(`${prefix}.slot-${index}`, { label: "Shared inference resource slot" });
        } catch (error) {
          throw new ResourceAdmissionConflictError(`cannot reserve shared inference resource slot: ${(error as Error).message}`);
        }
        if (slot) break;
      }
      if (!slot) return null;
      if (!existing || existing.capacity !== effectiveCapacity) {
        try {
          writeFileDurably(capacityFile, JSON.stringify({ format: "NEXUS_RESOURCE_ADMISSION", version: 1, capacity: effectiveCapacity } satisfies CapacityRecord));
        } catch (error) {
          releaseFileGuard(slot);
          slot = null;
          throw error;
        }
      }
      const held = slot;
      slot = null;
      return {
        release: () => releaseFileGuard(held),
      };
    } finally {
      if (slot) releaseFileGuard(slot);
      releaseFileGuard(mutex);
    }
  }

  private probeActiveSlots(prefix: string, capacity: number): number {
    let active = 0;
    for (let index = 0; index < capacity; index++) {
      if (!fs.existsSync(`${prefix}.slot-${index}`)) continue;
      let probe: FileGuard | null;
      try {
        probe = acquireFileGuard(`${prefix}.slot-${index}`, { label: "Shared inference resource slot" });
      } catch (error) {
        throw new ResourceAdmissionConflictError(`cannot inspect shared inference resource slots: ${(error as Error).message}`);
      }
      if (probe) releaseFileGuard(probe);
      else active++;
    }
    return active;
  }
}
