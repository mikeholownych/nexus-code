import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EVAL_RUNTIME_FILES = [
  "eval/run.mjs", "eval/validate.mjs", "eval/t4_fixtures.mjs", "eval/isolate.mjs",
  "eval/hide_oracle.cjs", "eval/hide_oracle.py", "eval/unlink_then_exec.sh",
  "eval/agent_sandbox.mjs", "eval/model_proxy.mjs", "eval/score.mjs", "eval/dataset.mjs",
  "eval/runner_integrity.mjs", "eval/runner_api.mjs", "eval/oracle.mjs", "eval/infra.mjs",
  "eval/workspace.mjs", "eval/resources.mjs", "eval/cgroup_supervisor.mjs", "eval/t3.mjs",
  "eval/hardened_check.mjs", "eval/check_phase.mjs", "eval/toolchain-versions.json", "eval/scan-compiler-exposure.mjs",
  "eval/evaluators/code/index.mjs",
  "eval/evaluators/code/syntax_ast.mjs",
  "eval/evaluators/code/build.mjs",
  "eval/evaluators/code/typecheck_clean.mjs",
  "eval/evaluators/code/diff_boundary.mjs",
  "eval/evaluators/code/runner.mjs",
  "eval/evaluators/code/json_repair_rate.mjs",
  "eval/evaluators/code/parsers.mjs",
  "eval/evaluators/code/command.mjs",
  "eval/evaluators/code/result.mjs",
  "eval/evaluators/code/README.md",
];

export function stageEvaluatorRuntime(sourceRoot, packageRoot) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(packageRoot);
  for (const relativePath of EVAL_RUNTIME_FILES) {
    const sourcePath = path.resolve(source, relativePath);
    if (sourcePath !== source && !sourcePath.startsWith(`${source}${path.sep}`)) {
      throw new Error(`evaluator runtime path escapes source root: ${relativePath}`);
    }
    let sourceStat;
    try { sourceStat = fs.lstatSync(sourcePath); } catch { throw new Error(`required evaluator runtime module is missing: ${relativePath}`); }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`required evaluator runtime module is not a regular file: ${relativePath}`);
    }
    const targetPath = path.resolve(target, relativePath);
    if (targetPath !== target && !targetPath.startsWith(`${target}${path.sep}`)) {
      throw new Error(`evaluator runtime path escapes package root: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, sourceStat.mode & 0o777);
  }
  return [...EVAL_RUNTIME_FILES];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , sourceRoot, packageRoot] = process.argv;
  if (!sourceRoot || !packageRoot) {
    console.error("usage: stage_eval_runtime.mjs <source-root> <package-root>");
    process.exitCode = 2;
  } else {
    try { stageEvaluatorRuntime(sourceRoot, packageRoot); }
    catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
