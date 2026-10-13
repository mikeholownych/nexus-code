/**
 * Whether a passing verifier run is independent evidence of a change (VERIFIED), or only shows nothing broke
 * (REGRESSION_FREE). Rule (accepted 2026-10-13 after the eval pilot's false VERIFIED): a discovered verifier counts as
 * independent only when tests that existed before the change, unmodified, failed before it and pass after it —
 * fail-before / pass-after. Tests the agent wrote or edited in the same change cannot catch its own misreading of the
 * specification, so they never make a change VERIFIED on their own. (An operator-configured verifier is the operator's
 * own check and is handled by the caller.)
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_TEST_BYTES, SKIP_DIRS, workspaceTestFiles } from "../tester.js";
/** Test files of the workspace by relative path, or null when one exceeds the size kept for restoring. */
export function snapshotTests(workspace) {
    const root = path.resolve(workspace);
    const tests = new Map();
    for (const file of workspaceTestFiles(root)) {
        const stat = fs.statSync(file);
        if (stat.size > MAX_TEST_BYTES)
            return null;
        tests.set(path.relative(root, file), fs.readFileSync(file, "utf8"));
    }
    return tests;
}
/** Whether any test file was added, removed or changed since the baseline. */
export function testsChangedSince(workspace, baseline) {
    const now = snapshotTests(workspace);
    if (!now || now.size !== baseline.size)
        return true;
    for (const [file, content] of now)
        if (baseline.get(file) !== content)
            return true;
    return false;
}
/** What a passing, deliverable-covering run of `command` shows, given the baseline (no extra run needed). */
export function judgeWithoutCopy(workspace, command, baseline) {
    if (!baseline || baseline.command !== command) {
        return { independent: false, detail: `no run of ${command} before this change was recorded, so nothing shows the tests exercise the change` };
    }
    const changed = !baseline.tests || testsChangedSince(workspace, baseline.tests);
    if (!baseline.failed) {
        return {
            independent: false,
            detail: changed
                ? "the existing tests passed before the change too; the new behaviour is checked only by tests Nexus wrote"
                : "the existing tests passed before the change too, so they do not show the change",
        };
    }
    if (!changed)
        return { independent: true, detail: "tests that failed before the change pass after it" };
    if (!baseline.tests)
        return { independent: false, detail: "Nexus changed test files that were too large to set aside, so its own test edits cannot be excluded" };
    return "needs-copy";
}
const MAX_COPY_FILES = 20_000;
/**
 * A copy of the workspace (dependency and build directories linked, not copied) with the test files as they were at
 * the baseline: tests the change added are removed, tests it edited are restored. Under `.nexus/verify/`, so it stays
 * inside the workspace's sandbox. Returns null when the workspace is too large to copy.
 */
export function prepareBaselineTestsCopy(workspace, tests) {
    const root = path.resolve(workspace);
    const dir = path.join(root, ".nexus", "verify", randomUUID());
    let files = 0;
    const copy = (from, to) => {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const src = path.join(from, entry.name);
            const dst = path.join(to, entry.name);
            if (from === root && entry.name === ".nexus")
                continue;
            if (entry.isDirectory() && SKIP_DIRS.has(entry.name) && entry.name !== ".git") {
                fs.symlinkSync(src, dst, "dir");
            }
            else if (entry.isDirectory()) {
                if (entry.name === ".git")
                    continue;
                if (!copy(src, dst))
                    return false;
            }
            else if (entry.isFile() || entry.isSymbolicLink()) {
                if (++files > MAX_COPY_FILES)
                    return false;
                fs.copyFileSync(src, dst);
            }
        }
        return true;
    };
    try {
        if (!copy(root, dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            return null;
        }
        for (const file of workspaceTestFiles(dir)) {
            if (!tests.has(path.relative(dir, file)))
                fs.rmSync(file, { force: true });
        }
        for (const [rel, content] of tests) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
        return dir;
    }
    catch {
        fs.rmSync(dir, { recursive: true, force: true });
        return null;
    }
}
