/**
 * BG-3: reading a workspace's `.nexus/triggers.json`, once.
 *
 * All or nothing: a file that does not parse in full (one bad spec, a duplicate id) yields no specs and says why, so
 * nothing in it can be approved or fired. The file must be a regular file owned by you and not writable by group or
 * others. The bytes are read once and every spec returned comes from that one read, so what is hashed, compared with
 * an approval and then fired is the same parse (a spec file swapped between a check and a use cannot be fired).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeStrictUtf8, parseStrictJson, readHardenedFile } from "./strict_json.js";
import { canonicalizeTriggerSpec, parseTriggerSpec, triggerSpecSha256, type TriggerSpec } from "./trigger_spec.js";

export const TRIGGER_FILE_LIMIT = 256 * 1024;

export interface ParsedTriggerFile {
  specs: TriggerSpec[];
  problem?: string;
  /** SHA-256 of the file's bytes as read. */
  rawSha256?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const triggerFilePath = (workspace: string): string => path.join(workspace, ".nexus", "triggers.json");

/** The SHA-256 of a spec's canonical serialization: what an approval pins. */
export const specSha256 = (spec: TriggerSpec): string => triggerSpecSha256(Buffer.from(canonicalizeTriggerSpec(spec), "utf8"));

/** Reads and parses one trigger file (a path), as above. A missing file is no specs and no problem. */
export function parseTriggerFile(file: string): ParsedTriggerFile {
  try {
    if (!fs.existsSync(file)) return { specs: [] };
    const fileData = readHardenedFile(file, { maxBytes: TRIGGER_FILE_LIMIT, forbiddenMode: 0o022 });
    if (!fileData) return { specs: [] };
    const parsed = parseStrictJson(decodeStrictUtf8(fileData.bytes));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.triggers)) return { specs: [], problem: "it is not a version 1 trigger spec file" };
    const specs: TriggerSpec[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of parsed.triggers.entries()) {
      let spec: TriggerSpec;
      try {
        spec = parseTriggerSpec(JSON.stringify(raw));
      } catch (error) {
        return { specs: [], problem: `trigger #${index + 1} is invalid, so nothing in the file can be approved: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (seen.has(spec.id)) return { specs: [], problem: `trigger id ${JSON.stringify(spec.id)} appears twice, so nothing in the file can be approved` };
      seen.add(spec.id);
      specs.push(spec);
    }
    return { specs, rawSha256: createHash("sha256").update(fileData.bytes).digest("hex") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fix = /permissions are too open/.test(message) ? `; fix: chmod go-w ${file}` : "";
    return { specs: [], problem: `the trigger spec file cannot be used: ${message}${fix}` };
  }
}
