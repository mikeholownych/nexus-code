// Stages a pinned repository commit as a candidate workspace that carries no history beyond that commit.
// Held-out baselines are the parent of an upstream fix, so any descendant object, ref, remote or alternates link in
// the workspace would expose the reference solution to the candidate (eval/README.md, "Hidden tests").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `cache` is a trusted local clone that may hold upstream history after `commit`. The workspace is a fresh repository
 * that fetches only `commit` and its ancestors: no `--shared`, no alternates, no remote, no tags, no FETCH_HEAD.
 */
export function stageRepoWorkspace(cache, commit, ws) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("repository workspace requires a full pinned commit");
  const source = fs.realpathSync(cache);
  git(["-c", "init.defaultBranch=main", "init", "-q", ws], os.tmpdir());
  git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", source, commit], ws, "file");
  git(["checkout", "-q", "--detach", commit], ws);
  const problem = workspaceHistoryProblem(ws, commit);
  if (problem) throw new Error(`staged workspace is not history-isolated: ${problem}`);
}

/** Null when `ws` exposes nothing beyond `commit` and its ancestors; otherwise the first exposure found. */
export function workspaceHistoryProblem(ws, commit) {
  const gitDir = path.join(ws, ".git");
  if (fs.existsSync(path.join(gitDir, "objects", "info", "alternates"))) return "objects/info/alternates is present";
  if (fs.existsSync(path.join(gitDir, "FETCH_HEAD"))) return "FETCH_HEAD is present";
  if (git(["remote"], ws).trim()) return "a remote is configured";
  const head = git(["rev-parse", "HEAD"], ws).trim();
  if (head !== commit) return `HEAD is ${head}, not the pinned commit`;
  const beyond = git(["rev-list", "--all", "--reflog", `^${commit}`], ws).trim();
  if (beyond) return `${beyond.split("\n").length} commit(s) reachable that are not ancestors of the pinned commit`;
  const reachable = new Set(git(["rev-list", "--objects", commit], ws).split("\n").map((line) => line.split(" ", 1)[0]).filter(Boolean));
  const objects = git(["cat-file", "--batch-check=%(objectname)", "--batch-all-objects"], ws).split("\n").map((line) => line.trim()).filter(Boolean);
  const unreachable = objects.filter((object) => !reachable.has(object));
  if (unreachable.length) return `${unreachable.length} unreachable object(s) in .git/objects: ${unreachable.slice(0, 5).join(", ")}`;
  return null;
}

function git(argv, cwd, allowProtocol = "none") {
  const result = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: allowProtocol },
  });
  if (result.status !== 0) throw new Error(`git ${argv[0] === "-c" ? argv[2] : argv[0]} failed (${result.status ?? "signal"}): ${(result.stderr || result.stdout || "").slice(-2000)}`);
  return result.stdout;
}
