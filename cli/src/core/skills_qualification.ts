/**
 * Continuous skill qualification (WP-GS-06): local fixtures, negative checks,
 * and digest-based invalidation. Air-gapped; no remote registry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Skill } from "../skills.js";
import { skillContentDigest, parseSkillConstraints, resolveSkillToolAllowed } from "./skill_activation.js";
import {
  loadSkillLifecycleIndex,
  saveSkillLifecycleIndex,
  type SkillLifecycleEntry,
} from "./skills_lifecycle.js";

/** Fixture describing how a skill must behave under qualification. */
export interface SkillQualificationFixture {
  /** Skill name the fixture applies to */
  skillName: string;
  /** When set, the skill body digest must match exactly */
  contentDigest?: string;
  /** Tools the skill is expected to allow when constraints are present */
  expectedTools?: string[];
  /** Tools that must remain denied (negative security) */
  forbiddenTools?: string[];
  /** Require a constrained manifest (allowed/denied capabilities) */
  requireConstraints?: boolean;
  /** Substrings that must not appear in the skill body (prompt-forge / escalation) */
  forbiddenBodySubstrings?: string[];
}

export interface SkillQualificationResult {
  ok: boolean;
  skillName: string;
  contentDigest: string;
  failures: string[];
}

export function skillRequireQualificationEnabled(): boolean {
  return process.env.NEXUS_SKILL_REQUIRE_QUALIFICATION === "1" || process.env.NEXUS_SKILL_REQUIRE_QUALIFICATION === "true";
}

export function loadQualificationFixture(filePath: string): SkillQualificationFixture {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw.skillName !== "string") {
    throw new Error(`Invalid skill qualification fixture: ${filePath}`);
  }
  return raw as SkillQualificationFixture;
}

export function loadQualificationFixtures(dir: string): SkillQualificationFixture[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadQualificationFixture(path.join(dir, f)));
}

/**
 * Evaluate a skill against a fixture. Does not mutate lifecycle state.
 */
export function evaluateSkillQualification(skill: Skill, fixture: SkillQualificationFixture): SkillQualificationResult {
  const failures: string[] = [];
  const digest = skillContentDigest(skill.content);

  if (fixture.skillName !== skill.name) {
    failures.push(`fixture skillName '${fixture.skillName}' does not match skill '${skill.name}'`);
  }
  if (fixture.contentDigest && fixture.contentDigest !== digest) {
    failures.push(`content digest mismatch: expected ${fixture.contentDigest}, got ${digest}`);
  }

  const constraints = parseSkillConstraints({
    allowedCapabilities: skill.allowedCapabilities,
    deniedCapabilities: skill.deniedCapabilities,
  });

  if (fixture.requireConstraints && constraints.kind !== "constrained") {
    failures.push("fixture requires constraints but skill has none (allowed-capabilities / denied-capabilities)");
  }

  for (const tool of fixture.expectedTools ?? []) {
    if (!resolveSkillToolAllowed(tool, constraints)) {
      failures.push(`expected tool '${tool}' is not allowed by skill constraints`);
    }
  }
  for (const tool of fixture.forbiddenTools ?? []) {
    if (resolveSkillToolAllowed(tool, constraints) && constraints.kind === "constrained") {
      failures.push(`forbidden tool '${tool}' is still allowed by skill constraints`);
    }
    // Unconstrained skills: forbiddenTools only fail when requireConstraints is also set,
    // otherwise informational skills without manifests remain compatible.
    if (constraints.kind === "unconstrained" && fixture.requireConstraints) {
      failures.push(`forbidden tool '${tool}' cannot be enforced without constraints`);
    }
  }

  const body = skill.content;
  for (const needle of fixture.forbiddenBodySubstrings ?? []) {
    if (needle && body.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`skill body contains forbidden substring: ${needle}`);
    }
  }

  return { ok: failures.length === 0, skillName: skill.name, contentDigest: digest, failures };
}

/** Persist a successful qualification against the current digest. */
export function recordSkillQualification(name: string, contentDigest: string, sourcePath: string): void {
  const index = loadSkillLifecycleIndex();
  const prev = index.entries[name];
  const now = new Date().toISOString();
  index.entries[name] = {
    name,
    contentDigest,
    sourcePath: sourcePath || prev?.sourcePath || "",
    revoked: prev?.revoked,
    revokedAt: prev?.revokedAt,
    qualifiedAt: now,
    qualificationDigest: contentDigest,
    updatedAt: now,
  };
  saveSkillLifecycleIndex(index);
}

/** Clear qualification when the activated digest no longer matches the qualified digest. */
export function invalidateQualificationIfDigestChanged(name: string, contentDigest: string): boolean {
  const index = loadSkillLifecycleIndex();
  const entry = index.entries[name];
  if (!entry?.qualifiedAt) return false;
  if (entry.qualificationDigest && entry.qualificationDigest === contentDigest) return false;
  if (!entry.qualificationDigest && entry.contentDigest === contentDigest) return false;
  delete entry.qualifiedAt;
  delete entry.qualificationDigest;
  entry.contentDigest = contentDigest;
  entry.updatedAt = new Date().toISOString();
  saveSkillLifecycleIndex(index);
  return true;
}

export function isSkillQualified(name: string, contentDigest: string): boolean {
  const entry = loadSkillLifecycleIndex().entries[name];
  if (!entry?.qualifiedAt) return false;
  const pinned = entry.qualificationDigest || entry.contentDigest;
  return pinned === contentDigest;
}

export function qualificationStatus(name: string): Pick<SkillLifecycleEntry, "qualifiedAt" | "qualificationDigest" | "contentDigest"> | undefined {
  const entry = loadSkillLifecycleIndex().entries[name];
  if (!entry) return undefined;
  return {
    qualifiedAt: entry.qualifiedAt,
    qualificationDigest: entry.qualificationDigest,
    contentDigest: entry.contentDigest,
  };
}
