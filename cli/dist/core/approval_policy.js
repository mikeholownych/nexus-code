export class ApprovalPolicy {
    /**
     * Decides whether an operator decision is required before executing a capability with effect class `effect`.
     * SPEC-01 §5.1, DEC-01 option C:
     * - Untrusted workspace -> review for write_workspace, exec, egress and context_inject.
     * - Trusted workspace -> auto for write_workspace and exec; egress asks once per origin per session.
     * - --yes / fullAccess forces auto for write and exec.
     */
    requiresDecision(effect, context) {
        const { mode, trusted, approvedEgressOrigins, egressOrigin, isUntrustedSource, fullAccess } = context;
        // Full access (--yes / operator force auto) bypasses confirmation prompts for write and exec
        if (fullAccess) {
            if (effect === "egress") {
                if (egressOrigin && approvedEgressOrigins?.has(egressOrigin))
                    return false;
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
            if (effect === "context_inject") {
                return Boolean(isUntrustedSource || !trusted);
            }
            return false;
        }
        // mode === "auto"
        if (mode === "auto") {
            if (effect === "write_workspace") {
                return false;
            }
            if (effect === "exec") {
                // DEC-01 option C: auto mode in an untrusted workspace asks before exec unless trusted
                return !trusted;
            }
            if (effect === "egress") {
                // Egress asks on the first call per origin per session, then allowed for that origin
                if (egressOrigin && approvedEgressOrigins?.has(egressOrigin)) {
                    return false;
                }
                return true;
            }
            if (effect === "context_inject") {
                return Boolean(isUntrustedSource || !trusted);
            }
            return false;
        }
        return false;
    }
}
export const defaultApprovalPolicy = new ApprovalPolicy();
