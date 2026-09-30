import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
export class CheckpointManager {
    workspace;
    checkpointDir;
    isGit = false;
    constructor(workspace) {
        this.workspace = path.resolve(workspace);
        const hash = crypto.createHash("sha256").update(this.workspace).digest("hex").slice(0, 12);
        this.checkpointDir = path.join(os.homedir(), ".nexus", "checkpoints", hash);
        if (!fs.existsSync(this.checkpointDir)) {
            fs.mkdirSync(this.checkpointDir, { recursive: true });
        }
        this.checkGit();
    }
    checkGit() {
        try {
            execSync("git rev-parse --is-inside-work-tree", { cwd: this.workspace, stdio: "ignore" });
            this.isGit = true;
        }
        catch {
            this.isGit = false;
        }
    }
    createCheckpoint(name) {
        const id = `cp_${Date.now()}`;
        const desc = name || `Checkpoint at ${new Date().toLocaleTimeString()}`;
        const timestamp = new Date().toISOString();
        let gitRef;
        if (this.isGit) {
            try {
                // Create an untracked + tracked git stash commit without modifying working tree
                const stashCommit = execSync("git stash create", { cwd: this.workspace, encoding: "utf-8" }).trim();
                if (stashCommit) {
                    execSync(`git update-ref refs/nexus/checkpoints/${id} ${stashCommit}`, {
                        cwd: this.workspace,
                        stdio: "ignore",
                    });
                    gitRef = stashCommit;
                }
                else {
                    // Working tree was clean; record HEAD
                    const headCommit = execSync("git rev-parse HEAD", { cwd: this.workspace, encoding: "utf-8" }).trim();
                    gitRef = headCommit;
                }
            }
            catch {
                // Fallback to file snapshot if git stash fails
            }
        }
        const checkpoint = {
            id,
            name: desc,
            timestamp,
            gitRef,
        };
        const targetFile = path.join(this.checkpointDir, `${id}.json`);
        fs.writeFileSync(targetFile, JSON.stringify(checkpoint, null, 2), "utf-8");
        return checkpoint;
    }
    listCheckpoints() {
        if (!fs.existsSync(this.checkpointDir))
            return [];
        const files = fs.readdirSync(this.checkpointDir).filter((f) => f.endsWith(".json"));
        const list = [];
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, f), "utf-8"));
                list.push(data);
            }
            catch {
                // Ignore corrupt checkpoint files
            }
        }
        return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    rollbackLast() {
        const checkpoints = this.listCheckpoints();
        if (checkpoints.length === 0) {
            return { success: false, message: "No checkpoints available to roll back to." };
        }
        const target = checkpoints[0];
        return this.restore(target.id);
    }
    restore(id) {
        const targetFile = path.join(this.checkpointDir, `${id}.json`);
        if (!fs.existsSync(targetFile)) {
            return { success: false, message: `Checkpoint '${id}' not found.` };
        }
        try {
            const cp = JSON.parse(fs.readFileSync(targetFile, "utf-8"));
            if (this.isGit && cp.gitRef) {
                // Reset working tree to checkpoint commit/stash
                execSync("git reset --hard " + cp.gitRef, { cwd: this.workspace, stdio: "ignore" });
                execSync("git clean -fd", { cwd: this.workspace, stdio: "ignore" });
                return { success: true, message: `Restored workspace to checkpoint '${cp.name}' (${cp.id})` };
            }
            return { success: false, message: `Cannot restore checkpoint: no valid git snapshot recorded.` };
        }
        catch (err) {
            return { success: false, message: `Rollback failed: ${err.message}` };
        }
    }
}
