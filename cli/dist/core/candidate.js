/**
 * Candidate Identity, Validation Authority & Receipt Management
 * Nexus Issue #12 — WP-04 (INC-05, DEC-02, CAND-001..004, EVID-002, VER-001..005)
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
/**
 * Computes SHA-256 digest of input content.
 */
export function hashContent(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}
/**
 * Normalizes a path into a relative POSIX path.
 */
export function toPosixRelativePath(basePath, targetPath) {
    const rel = path.isAbsolute(targetPath)
        ? path.relative(basePath, targetPath)
        : targetPath;
    return rel.split(path.sep).join("/");
}
/**
 * Computes deterministic digest over an array of material dependencies.
 */
export function computeMaterialDependenciesHash(deps) {
    if (!deps || deps.length === 0)
        return hashContent("NO_DEPENDENCIES");
    const sorted = [...deps].sort((a, b) => {
        const nameCmp = a.name.localeCompare(b.name);
        if (nameCmp !== 0)
            return nameCmp;
        return (a.path || "").localeCompare(b.path || "");
    });
    const canonical = sorted
        .map((d) => `${d.name}\t${d.path || ""}\t${d.versionOrHash}`)
        .join("\n");
    return hashContent(canonical);
}
/**
 * Computes candidate identity for a workspace directory (git or non-git fallback).
 */
export function computeCandidateIdentitySync(workspacePath, options = {}) {
    const resolvedWorkspace = path.resolve(workspacePath);
    if (!fs.existsSync(resolvedWorkspace)) {
        throw new Error(`Workspace path does not exist: ${resolvedWorkspace}`);
    }
    const stat = fs.statSync(resolvedWorkspace);
    if (!stat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${resolvedWorkspace}`);
    }
    let isGit = false;
    try {
        const gitCheck = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: resolvedWorkspace,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        isGit = gitCheck === "true";
    }
    catch {
        isGit = false;
    }
    const includeUntracked = options.includeUntracked !== false;
    if (isGit) {
        return computeGitCandidateIdentity(resolvedWorkspace, options, includeUntracked);
    }
    else {
        return computeNonGitCandidateIdentity(resolvedWorkspace, options);
    }
}
/**
 * Computes candidate identity for a Git-backed workspace or worktree.
 */
function computeGitCandidateIdentity(workspacePath, options, includeUntracked) {
    let rootBaseSha = "UNKNOWN_BASE";
    try {
        rootBaseSha = execFileSync("git", ["rev-parse", options.baseRef || "HEAD"], {
            cwd: workspacePath,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        rootBaseSha = "EMPTY_GIT_BASE";
    }
    const trackedEntriesMap = new Map();
    const untrackedEntriesMap = new Map();
    // 1. If baseRef is provided and differs from worktree HEAD, inspect committed differences on branch
    if (options.baseRef && options.baseRef !== "HEAD") {
        try {
            const diffOut = execFileSync("git", ["diff", "--name-status", options.baseRef, "HEAD"], {
                cwd: workspacePath,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (diffOut.length > 0) {
                const lines = diffOut.split("\n");
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const statusChar = parts[0][0];
                        const filePath = parts[parts.length - 1];
                        const posixPath = filePath.split(path.sep).join("/");
                        const fullPath = path.join(workspacePath, filePath);
                        if (statusChar === "D") {
                            trackedEntriesMap.set(posixPath, {
                                path: posixPath,
                                contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
                                size: 0,
                                status: "deleted",
                            });
                        }
                        else if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                            const buf = fs.readFileSync(fullPath);
                            trackedEntriesMap.set(posixPath, {
                                path: posixPath,
                                contentHash: hashContent(buf),
                                size: buf.length,
                                status: statusChar === "A" ? "added" : "modified",
                            });
                        }
                    }
                }
            }
        }
        catch {
            // Diff command fallback
        }
    }
    // 2. Query git status for working tree modifications and untracked files
    try {
        const statusOut = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
            cwd: workspacePath,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        if (statusOut.length > 0) {
            const lines = statusOut.split(/\r?\n/);
            for (const line of lines) {
                if (!line || line.length < 3)
                    continue;
                const match = line.match(/^([ MADRCU?!]{2})\s+(.*)$/);
                if (!match)
                    continue;
                const code = match[1];
                let rawFile = match[2].trim();
                // Handle rename syntax: "R  orig -> new"
                if (rawFile.includes(" -> ")) {
                    const parts = rawFile.split(" -> ");
                    rawFile = parts[1];
                }
                // Strip quotes if present
                if (rawFile.startsWith('"') && rawFile.endsWith('"')) {
                    rawFile = rawFile.slice(1, -1);
                }
                const posixPath = rawFile.split(path.sep).join("/");
                const fullPath = path.join(workspacePath, rawFile);
                if (code === "??") {
                    if (includeUntracked) {
                        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                            const buf = fs.readFileSync(fullPath);
                            untrackedEntriesMap.set(posixPath, {
                                path: posixPath,
                                contentHash: hashContent(buf),
                                size: buf.length,
                                status: "untracked",
                            });
                        }
                    }
                }
                else {
                    // Tracked modification (staged or unstaged)
                    if (!fs.existsSync(fullPath) || code.includes("D")) {
                        trackedEntriesMap.set(posixPath, {
                            path: posixPath,
                            contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
                            size: 0,
                            status: "deleted",
                        });
                    }
                    else if (fs.statSync(fullPath).isFile()) {
                        const buf = fs.readFileSync(fullPath);
                        trackedEntriesMap.set(posixPath, {
                            path: posixPath,
                            contentHash: hashContent(buf),
                            size: buf.length,
                            status: code.includes("A") ? "added" : "modified",
                        });
                    }
                }
            }
        }
    }
    catch (err) {
        throw new Error(`Failed to query git status for candidate identity: ${err.message}`);
    }
    // Canonicalize entries in sorted order
    const trackedChanges = Array.from(trackedEntriesMap.values()).sort((a, b) => a.path.localeCompare(b.path));
    const untrackedFiles = Array.from(untrackedEntriesMap.values()).sort((a, b) => a.path.localeCompare(b.path));
    const manifestLines = [];
    for (const entry of trackedChanges) {
        manifestLines.push(`T\t${entry.path}\t${entry.status}\t${entry.contentHash}\t${entry.size}`);
    }
    for (const entry of untrackedFiles) {
        manifestLines.push(`U\t${entry.path}\t${entry.status}\t${entry.contentHash}\t${entry.size}`);
    }
    const manifestContent = manifestLines.length > 0 ? manifestLines.join("\n") : "CLEAN_TREE_NO_CANDIDATE_CHANGES";
    const manifestHash = hashContent(manifestContent);
    const candidateId = hashContent(`candidate-v1:git:${rootBaseSha}:${manifestHash}`);
    return {
        candidateId,
        workspacePath,
        rootBaseSha,
        trackedChanges,
        untrackedFiles,
        manifestHash,
        isGit: true,
        timestamp: new Date().toISOString(),
    };
}
/**
 * Computes candidate identity for a non-Git workspace via deterministic filesystem manifest.
 */
function computeNonGitCandidateIdentity(workspacePath, options) {
    const rootBaseSha = "NON_GIT_WORKSPACE";
    const allEntries = [];
    const defaultExcludes = new Set([
        ".git",
        "node_modules",
        ".nexus",
        "target",
        "dist",
        "build",
        ".cache",
    ]);
    function walk(currentDir) {
        const items = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const item of items) {
            if (defaultExcludes.has(item.name))
                continue;
            const fullPath = path.join(currentDir, item.name);
            if (item.isDirectory()) {
                walk(fullPath);
            }
            else if (item.isFile()) {
                const relPath = toPosixRelativePath(workspacePath, fullPath);
                const buf = fs.readFileSync(fullPath);
                allEntries.push({
                    path: relPath,
                    contentHash: hashContent(buf),
                    size: buf.length,
                    status: "modified",
                });
            }
        }
    }
    walk(workspacePath);
    allEntries.sort((a, b) => a.path.localeCompare(b.path));
    const manifestLines = allEntries.map((e) => `F\t${e.path}\t${e.status}\t${e.contentHash}\t${e.size}`);
    const manifestContent = manifestLines.length > 0 ? manifestLines.join("\n") : "EMPTY_NON_GIT_WORKSPACE";
    const manifestHash = hashContent(manifestContent);
    const candidateId = hashContent(`candidate-v1:nongit:${manifestHash}`);
    return {
        candidateId,
        workspacePath,
        rootBaseSha,
        trackedChanges: allEntries,
        untrackedFiles: [],
        manifestHash,
        isGit: false,
        timestamp: new Date().toISOString(),
    };
}
/**
 * CandidateTracker manages candidate identities, validation receipts,
 * post-validation mutation invalidation, and merge gating.
 */
export class CandidateTracker {
    activeReceipts = new Map();
    latestReceipt;
    knownCandidateIdentities = new Map();
    /**
     * Computes the candidate identity synchronously.
     */
    computeCandidateIdentitySync(workspacePath, options = {}) {
        const identity = computeCandidateIdentitySync(workspacePath, options);
        this.knownCandidateIdentities.set(identity.candidateId, identity);
        return identity;
    }
    /**
     * Computes the candidate identity asynchronously.
     */
    async computeCandidateIdentity(workspacePath, options = {}) {
        return this.computeCandidateIdentitySync(workspacePath, options);
    }
    /**
     * Records an authoritative validation receipt.
     */
    recordValidationReceipt(params) {
        if (!params.candidateId || typeof params.candidateId !== "string") {
            throw new Error("CAND-001: Validation receipt must carry a non-empty candidateId string.");
        }
        const receipt = {
            receiptId: `rcpt-${crypto.randomUUID()}`,
            timestamp: new Date().toISOString(),
            ...params,
            materialDependencies: params.materialDependencies ? [...params.materialDependencies] : [],
        };
        this.activeReceipts.set(receipt.receiptId, receipt);
        this.latestReceipt = receipt;
        return receipt;
    }
    /**
     * Retrieves the current active receipt for a candidate.
     */
    getActiveReceipt(candidateId) {
        if (!this.latestReceipt)
            return null;
        if (this.latestReceipt.status !== "PASSED")
            return null;
        if (candidateId && this.latestReceipt.candidateId !== candidateId)
            return null;
        return this.latestReceipt;
    }
    /**
     * Retrieves a receipt by its unique ID.
     */
    getReceipt(receiptId) {
        return this.activeReceipts.get(receiptId) || null;
    }
    /**
     * Returns all recorded receipts.
     */
    getAllReceipts() {
        return Array.from(this.activeReceipts.values());
    }
    /**
     * Invalidates active validation receipts.
     * If mutatedPaths is specified, checks whether the mutated paths overlap with candidate files
     * or material validation dependencies per CAND-002.
     */
    invalidateReceipts(reason, mutatedPaths) {
        let invalidatedCount = 0;
        const now = new Date().toISOString();
        for (const receipt of this.activeReceipts.values()) {
            if (receipt.status === "PASSED") {
                if (mutatedPaths && mutatedPaths.length > 0) {
                    const candidateIdentity = this.knownCandidateIdentities.get(receipt.candidateId);
                    if (candidateIdentity) {
                        // Check if any mutated path touches candidate changes or material dependencies
                        const candidatePaths = new Set([
                            ...candidateIdentity.trackedChanges.map((t) => t.path),
                            ...candidateIdentity.untrackedFiles.map((u) => u.path),
                            ...receipt.materialDependencies.map((d) => d.path || d.name),
                        ]);
                        const hasOverlap = mutatedPaths.some((p) => {
                            const norm = p.split(path.sep).join("/");
                            return (candidatePaths.has(norm) ||
                                Array.from(candidatePaths).some((cp) => norm.endsWith(cp) || cp.endsWith(norm)));
                        });
                        if (!hasOverlap) {
                            // Mutation is strictly confined outside candidate identity and dependencies (CAND-002)
                            continue;
                        }
                    }
                }
                receipt.status = "INVALIDATED";
                receipt.invalidationReason = reason;
                receipt.invalidatedAt = now;
                invalidatedCount++;
            }
        }
        return invalidatedCount;
    }
    /**
     * Creates an ExecutionSpine CandidateMutationHook that invalidates receipts upon file mutation.
     */
    createMutationHook() {
        return async (event) => {
            const paths = event.mutatedPaths && event.mutatedPaths.length > 0
                ? event.mutatedPaths.join(", ")
                : "unspecified resources";
            this.invalidateReceipts(`Candidate mutated post-validation by tool '${event.toolName}' (mutated: ${paths})`, event.mutatedPaths);
        };
    }
    /**
     * Verifies candidate eligibility for worktree merge (CAND-001..CAND-004).
     * Re-evaluates actual state on disk to defeat out-of-band mutations and race conditions.
     */
    isCandidateValidForMergeSync(workspacePath, receipt, options = {}) {
        if (!receipt) {
            return {
                valid: false,
                reason: "CAND-003: No validation receipt provided for candidate merge.",
            };
        }
        if (receipt.status !== "PASSED") {
            return {
                valid: false,
                receiptCandidateId: receipt.candidateId,
                reason: `CAND-003: Validation receipt status is ${receipt.status}: ${receipt.invalidationReason || "receipt is not in PASSED state"}`,
            };
        }
        // Recompute actual current candidate identity from disk (detects out-of-band modifications)
        let currentIdentity;
        try {
            currentIdentity = this.computeCandidateIdentitySync(workspacePath, options);
        }
        catch (err) {
            return {
                valid: false,
                receiptCandidateId: receipt.candidateId,
                reason: `CAND-003: Failed to compute current candidate identity: ${err.message}`,
            };
        }
        // CAND-003: Verify candidate identity equality
        if (currentIdentity.candidateId !== receipt.candidateId) {
            return {
                valid: false,
                currentCandidateId: currentIdentity.candidateId,
                receiptCandidateId: receipt.candidateId,
                reason: `CAND-003: Candidate identity at merge (${currentIdentity.candidateId}) does not match validated candidate (${receipt.candidateId}). Candidate was modified after validation.`,
            };
        }
        // CAND-002: Verify material validation dependencies remain unchanged
        if (receipt.materialDependencies && receipt.materialDependencies.length > 0) {
            for (const dep of receipt.materialDependencies) {
                if (dep.path) {
                    const depFullPath = path.isAbsolute(dep.path)
                        ? dep.path
                        : path.join(workspacePath, dep.path);
                    if (!fs.existsSync(depFullPath)) {
                        return {
                            valid: false,
                            currentCandidateId: currentIdentity.candidateId,
                            receiptCandidateId: receipt.candidateId,
                            reason: `CAND-002: Material validation dependency '${dep.name}' at '${dep.path}' is missing on disk.`,
                        };
                    }
                    const currentHash = hashContent(fs.readFileSync(depFullPath));
                    if (currentHash !== dep.versionOrHash) {
                        return {
                            valid: false,
                            currentCandidateId: currentIdentity.candidateId,
                            receiptCandidateId: receipt.candidateId,
                            reason: `CAND-002: Material validation dependency '${dep.name}' has changed: expected ${dep.versionOrHash}, found ${currentHash}.`,
                        };
                    }
                }
            }
        }
        return {
            valid: true,
            currentCandidateId: currentIdentity.candidateId,
            receiptCandidateId: receipt.candidateId,
        };
    }
    /**
     * Asynchronous candidate merge eligibility check.
     */
    async isCandidateValidForMerge(workspacePath, receipt, options = {}) {
        return this.isCandidateValidForMergeSync(workspacePath, receipt, options);
    }
}
