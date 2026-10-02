import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { InformationFlowBoundary } from "./egress.js";
export class SensitivePersistenceError extends Error {
    constructor(destination) {
        super(`Sensitive content prevents durable persistence to ${destination}.`);
        this.name = "SensitivePersistenceError";
    }
}
/**
 * Apply Nexus's canonical classifier with irreversible redaction for durable
 * application data. No reversible mapping is created or persisted.
 */
export function redactForPersistence(value) {
    return InformationFlowBoundary.getGlobalInstance().redactForDurablePersistence(value);
}
/**
 * Protect a task-state record while preserving only the WorkspacePath supplied
 * by the selected workspace model. Arbitrary objects receive no path exception.
 */
export function redactTaskStateForPersistence(value, workspacePaths = []) {
    if (workspacePaths.length === 0)
        return redactForPersistence(value);
    for (const identity of workspacePaths)
        identity.assertCurrent();
    const selectedWorkspace = workspacePaths.find((identity) => identity.matches(value.workspacePath));
    if (!selectedWorkspace ||
        (value.workspace !== undefined && !selectedWorkspace.matches(value.workspace))) {
        throw new Error("Task state workspace identity does not match the selected workspace");
    }
    const boundary = InformationFlowBoundary.getGlobalInstance();
    const typedPaths = [selectedWorkspace];
    const worktreePath = value.worktreeBinding?.worktreePath;
    if (worktreePath) {
        const typedWorktree = workspacePaths.find((identity) => identity.matches(worktreePath));
        if (typedWorktree)
            typedPaths.push(typedWorktree);
    }
    for (const identity of typedPaths) {
        const identityFindings = boundary.classifyText(identity.value);
        if (identityFindings.some((finding) => finding.classificationType !== "UNCERTAIN")) {
            throw new Error("Workspace identity contains positively classified sensitive material");
        }
    }
    // Mask only schema fields whose values match a validated WorkspacePath.
    const masked = {
        ...value,
        workspacePath: "[NEXUS_TYPED_WORKSPACE_PATH]",
        ...(value.workspace === undefined ? {} : { workspace: "[NEXUS_TYPED_WORKSPACE_PATH]" }),
        ...(worktreePath && typedPaths.length > 1
            ? { worktreeBinding: { ...value.worktreeBinding, worktreePath: "[NEXUS_TYPED_WORKSPACE_PATH]" } }
            : {}),
    };
    const protectedValue = redactForPersistence(masked);
    return {
        ...protectedValue,
        workspacePath: selectedWorkspace.value,
        ...(value.workspace === undefined ? {} : { workspace: selectedWorkspace.value }),
        ...(worktreePath && typedPaths.length > 1
            ? { worktreeBinding: { ...protectedValue.worktreeBinding, worktreePath } }
            : {}),
    };
}
/**
 * Refuse a durable copy when redaction would alter its source-of-truth content.
 * Checkpoint snapshots use this instead of creating a sanitized, unrestorable
 * workspace copy.
 */
export function assertNoSensitivePersistenceContent(value, destination) {
    try {
        const protectedValue = redactForPersistence(value);
        if (JSON.stringify(protectedValue) !== JSON.stringify(value)) {
            throw new SensitivePersistenceError(destination);
        }
    }
    catch (error) {
        if (error instanceof SensitivePersistenceError)
            throw error;
        throw new SensitivePersistenceError(destination);
    }
}
export function appendProtectedHistoryLine(filePath, line) {
    const safeLine = redactForPersistence(line);
    fs.appendFileSync(filePath, `${safeLine}\n`, "utf8");
}
export function writeProtectedTextFile(filePath, content) {
    const safeContent = redactForPersistence(content);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(tempPath, safeContent, { encoding: "utf8", flag: "wx" });
        fs.renameSync(tempPath, filePath);
    }
    catch {
        try {
            if (fs.existsSync(tempPath))
                fs.unlinkSync(tempPath);
        }
        catch { }
        throw new Error("Protected persistence write failed");
    }
}
