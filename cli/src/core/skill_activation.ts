/**
 * Governed skill activation identity, digests, and optional constraint intersection.
 * WP-GS-01..05 — additive; does not expand session authority.
 */
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";

export type SkillSourceClass = "global" | "workspace";

export type SkillConstraint =
  | { kind: "unconstrained" }
  | {
      kind: "constrained";
      allowedTools?: Set<string>;
      deniedTools?: Set<string>;
    };

export interface SkillActivation {
  activationId: string;
  skillName: string;
  sourcePath: string;
  sourceClass: SkillSourceClass;
  contentDigest: string;
  activatedAt: string;
  taskId: string;
  constraints: SkillConstraint;
  status: "active" | "revoked" | "superseded";
}

export interface SkillAttribution {
  skillActivationId?: string;
  skillName?: string;
  skillContentDigest?: string;
}

/** Additive receipt fields are on by default; set NEXUS_SKILL_ACTIVATION_IDS=0 to disable. */
export function skillActivationIdsEnabled(): boolean {
  return process.env.NEXUS_SKILL_ACTIVATION_IDS !== "0";
}

/** Opt-in enforcement of skill capability intersection. */
export function skillConstraintsEnabled(): boolean {
  return process.env.NEXUS_SKILL_CONSTRAINTS === "1" || process.env.NEXUS_SKILL_CONSTRAINTS === "true";
}

/** sticky (default) keeps activation digest; live blocks tools when file content drifts. */
export function skillIntegrityMode(): "sticky" | "live" | "off" {
  const v = (process.env.NEXUS_SKILL_INTEGRITY || "sticky").toLowerCase();
  if (v === "live") return "live";
  if (v === "off" || v === "0") return "off";
  return "sticky";
}

/** Opt-in: treat workspace skill activation as isUntrustedSource for approval. */
export function skillConfirmWorkspaceEnabled(): boolean {
  return process.env.NEXUS_SKILL_CONFIRM_WORKSPACE === "1" || process.env.NEXUS_SKILL_CONFIRM_WORKSPACE === "true";
}

/** Opt-in symlink / realpath-outside-HOME policy. */
export function skillSymlinkPolicy(): "off" | "warn" | "deny" {
  const v = (process.env.NEXUS_SKILL_SYMLINK_POLICY || "off").toLowerCase();
  if (v === "warn" || v === "deny") return v;
  return "off";
}

export function skillContentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse optional enforced constraint fields from skill frontmatter / Skill fields.
 * Informational keys are ignored. Empty allow+deny ⇒ unconstrained.
 */
export function parseSkillConstraints(meta: Record<string, string | undefined>): SkillConstraint {
  const allowed = splitCsv(meta["allowed-capabilities"] ?? meta.allowedCapabilities);
  const denied = splitCsv(meta["denied-capabilities"] ?? meta.deniedCapabilities);
  if (!allowed.length && !denied.length) return { kind: "unconstrained" };
  return {
    kind: "constrained",
    ...(allowed.length ? { allowedTools: new Set(allowed) } : {}),
    ...(denied.length ? { deniedTools: new Set(denied) } : {}),
  };
}

/** Whether a tool is permitted by skill constraints (intersection semantics). */
export function resolveSkillToolAllowed(toolName: string, constraints: SkillConstraint): boolean {
  if (constraints.kind === "unconstrained") return true;
  if (constraints.deniedTools?.has(toolName)) return false;
  if (constraints.allowedTools && constraints.allowedTools.size > 0) {
    return constraints.allowedTools.has(toolName);
  }
  return true;
}

export class SkillActivationRegistry {
  private activations = new Map<string, SkillActivation>();
  private currentId: string | undefined;

  activate(input: {
    skillName: string;
    sourcePath: string;
    sourceClass: SkillSourceClass;
    content: string;
    taskId: string;
    constraints?: SkillConstraint;
  }): SkillActivation {
    if (this.currentId) {
      const prev = this.activations.get(this.currentId);
      if (prev && prev.status === "active") prev.status = "superseded";
    }
    const activation: SkillActivation = {
      activationId: randomUUID(),
      skillName: input.skillName,
      sourcePath: input.sourcePath,
      sourceClass: input.sourceClass,
      contentDigest: skillContentDigest(input.content),
      activatedAt: new Date().toISOString(),
      taskId: input.taskId,
      constraints: input.constraints ?? { kind: "unconstrained" },
      status: "active",
    };
    this.activations.set(activation.activationId, activation);
    this.currentId = activation.activationId;
    return activation;
  }

  current(): SkillActivation | undefined {
    if (!this.currentId) return undefined;
    const a = this.activations.get(this.currentId);
    return a?.status === "active" ? a : undefined;
  }

  get(id: string): SkillActivation | undefined {
    return this.activations.get(id);
  }

  deactivate(id?: string): void {
    const target = id ?? this.currentId;
    if (!target) return;
    const a = this.activations.get(target);
    if (a) a.status = "revoked";
    if (this.currentId === target) this.currentId = undefined;
  }

  attribution(): SkillAttribution {
    if (!skillActivationIdsEnabled()) return {};
    const cur = this.current();
    if (!cur) return {};
    return {
      skillActivationId: cur.activationId,
      skillName: cur.skillName,
      skillContentDigest: cur.contentDigest,
    };
  }

  contentMatches(activationId: string, content: string): boolean {
    const a = this.activations.get(activationId);
    if (!a) return false;
    return a.contentDigest === skillContentDigest(content);
  }

  /** Live integrity: true when tools should be blocked due to digest drift. */
  liveIntegrityBlocked(readContent: () => string | null): { blocked: boolean; reason?: string } {
    if (skillIntegrityMode() !== "live") return { blocked: false };
    const cur = this.current();
    if (!cur) return { blocked: false };
    let content: string | null;
    try {
      content = readContent();
    } catch (err: any) {
      return { blocked: true, reason: `SKILL_INTEGRITY: cannot read skill file for live check: ${err?.message || err}` };
    }
    if (content === null) {
      return { blocked: true, reason: `SKILL_INTEGRITY: skill file missing for activation ${cur.activationId}` };
    }
    if (!this.contentMatches(cur.activationId, content)) {
      return {
        blocked: true,
        reason: `SKILL_INTEGRITY: skill '${cur.skillName}' content changed since activation (digest mismatch). Re-activate to continue.`,
      };
    }
    return { blocked: false };
  }
}

/** Discovery roots (must stay aligned with SkillManager.refresh). */
export function discoverySkillDirs(workspace: string, home: string = os.homedir()): string[] {
  return [
    path.join(home, ".nexus", "skills"),
    path.join(home, ".config", "nexus", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(workspace, ".nexus", "skills"),
    path.join(workspace, ".agents", "skills"),
    path.join(workspace, ".claude", "skills"),
    path.join(workspace, "skills"),
  ];
}

/** Watcher roots — must be a superset of discovery roots (S-03 fix). */
export function watcherSkillDirs(workspace: string, home: string = os.homedir()): string[] {
  return discoverySkillDirs(workspace, home);
}
