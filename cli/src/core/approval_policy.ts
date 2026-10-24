/**
 * Approval Policy Framework
 * Nexus SPEC-01 §5.1, §5.2 — Safe Execution Defaults (DEC-01, as amended)
 */
import { EffectClass } from "./capabilities.js";

export type ApprovalMode = "auto" | "review" | "read-only";

export interface PolicyContext {
  mode: ApprovalMode;
  /** Workspace trust is reported separately; it never selects or widens tool authority. */
  trusted: boolean;
  sandbox?: boolean | string;
  approvedEgressOrigins?: Set<string>;
  egressOrigin?: string;
  isUntrustedSource?: boolean;
  fullAccess?: boolean;
}

export class ApprovalPolicy {
  /**
   * Decides whether an operator decision is required before executing a capability with effect class `effect`.
   * Permission mode controls tool approvals independently of workspace trust:
   * - Review mode asks before writes, commands and egress.
   * - Auto mode allows writes and commands; egress asks once per origin per session.
   * - Untrusted context sources remain distinguishable from workspace trust.
   * - --yes / fullAccess forces auto for write and exec.
   */
  public requiresDecision(effect: EffectClass, context: PolicyContext): boolean {
    const { mode, approvedEgressOrigins, egressOrigin, isUntrustedSource, fullAccess } = context;

    // Full access (--yes / operator force auto) bypasses confirmation prompts for write and exec
    if (fullAccess) {
      if (effect === "egress") {
        if (egressOrigin && approvedEgressOrigins?.has(egressOrigin)) return false;
        // In fullAccess / --yes mode, egress does not prompt if no interactive operator is present
        return false;
      }
      return false;
    }

    // read_workspace, delegate, internal never require an operator decision
    if (effect === "read_workspace" || effect === "delegate" || effect === "internal") {
      return false;
    }

    if (mode === "read-only") {
      // In read-only mode, mutating tools are denied directly by read-only policy rather than prompting the operator
      return false;
    }

    if (mode === "review") {
      if (effect === "write_workspace" || effect === "exec") {
        return true;
      }
      if (effect === "egress") {
        if (egressOrigin && approvedEgressOrigins?.has(egressOrigin)) {
          return false;
        }
        return true;
      }
      if (effect === "context_inject") return Boolean(isUntrustedSource);
      return false;
    }

    // mode === "auto"
    if (mode === "auto") {
      if (effect === "write_workspace") {
        return false;
      }
      if (effect === "exec") {
        return false;
      }
      if (effect === "egress") {
        // Egress asks on the first call per origin per session, then allowed for that origin
        if (egressOrigin && approvedEgressOrigins?.has(egressOrigin)) {
          return false;
        }
        return true;
      }
      if (effect === "context_inject") {
        return Boolean(isUntrustedSource);
      }
      return false;
    }

    return false;
  }
}

export const defaultApprovalPolicy = new ApprovalPolicy();
