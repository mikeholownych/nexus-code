import * as fs from "node:fs";
import * as path from "node:path";
const workspacePathCapabilities = new WeakSet();
/**
 * Runtime provenance for a workspace selected by Nexus and checked against the
 * live filesystem. This is intentionally not serializable; persisted strings do
 * not acquire WorkspacePath status merely by occupying a similarly named field.
 */
export class WorkspacePath {
    value;
    canonicalPath;
    constructor(value, canonicalPath) {
        this.value = value;
        this.canonicalPath = canonicalPath;
    }
    /** Establish workspace identity from the application workspace model. */
    static fromSelectedWorkspace(input) {
        if (typeof input !== "string" || input.length === 0 || !path.isAbsolute(input)) {
            throw new Error("Workspace identity must be an absolute path");
        }
        const normalized = path.resolve(input);
        if (normalized !== input)
            throw new Error("Workspace identity must be normalized");
        const stat = fs.statSync(normalized);
        if (!stat.isDirectory())
            throw new Error("Workspace identity must name a directory");
        const identity = new WorkspacePath(normalized, fs.realpathSync(normalized));
        workspacePathCapabilities.add(identity);
        Object.freeze(identity);
        return identity;
    }
    /** Recheck that the selected path still names the same concrete directory. */
    assertCurrent() {
        if (!workspacePathCapabilities.has(this))
            throw new Error("Workspace identity lacks trusted runtime provenance");
        const stat = fs.statSync(this.value);
        if (!stat.isDirectory() || fs.realpathSync(this.value) !== this.canonicalPath) {
            throw new Error("Workspace identity changed after validation");
        }
    }
    matches(value) {
        return typeof value === "string" && value === this.value;
    }
}
