import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The list is defined once, in eval/runtime_files.mjs, and shared with eval/run.mjs harnessIdentity().
import { EVAL_RUNTIME_FILES } from "../eval/runtime_files.mjs";
export { EVAL_RUNTIME_FILES };

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
