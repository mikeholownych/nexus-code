import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PARSERS } from "./parsers.mjs";
import { evaluatorResult } from "./result.mjs";

const EXTENSIONS = new Map([
  [".ts", "typescript"], [".mts", "typescript"], [".cts", "typescript"], [".tsx", "tsx"],
  [".js", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"], [".jsx", "jsx"],
  [".rs", "rust"], [".py", "python"],
]);

export function isSupportedSyntaxPath(relativePath) {
  return typeof relativePath === "string" && EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function confinedFile(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new Error(`unsafe source path: ${String(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe source path: ${relativePath}`);
  const rootReal = fs.realpathSync(root);
  const fileReal = fs.realpathSync(path.join(rootReal, ...segments));
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`source path escapes workspace: ${relativePath}`);
  if (!fs.statSync(fileReal).isFile()) throw new Error(`source path is not a file: ${relativePath}`);
  return fileReal;
}

/**
 * Parse every modified source file with a real parser: the built-in ones (parsers.mjs) unless the caller supplies a
 * parser for that language. Parser functions receive source text and { file, language, absolutePath } and return an
 * object, or throw/return { errors: [...] } when parsing fails. Unsupported extensions and languages without a parser
 * fail closed.
 */
export async function evaluateSyntaxAst({ root, files, parsers = {} }) {
  const available = { ...DEFAULT_PARSERS, ...parsers };
  if (!Array.isArray(files) || !files.length) return evaluatorResult("syntax_ast", false, 0, { error: "no modified source files supplied", files: [] });
  const failures = [];
  const parsed = [];
  for (const relativePath of [...new Set(files)].sort()) {
    let file;
    try { file = confinedFile(root, relativePath); }
    catch (error) { failures.push({ file: relativePath, error: error.message }); continue; }
    const language = EXTENSIONS.get(path.extname(relativePath).toLowerCase());
    if (!language) { failures.push({ file: relativePath, error: "unsupported source extension" }); continue; }
    const parser = available[language];
    if (typeof parser !== "function") { failures.push({ file: relativePath, error: `no ${language} AST parser configured` }); continue; }
    try {
      const ast = await parser(fs.readFileSync(file, "utf8"), { file: relativePath, language, absolutePath: file });
      if (ast == null || typeof ast !== "object" || Array.isArray(ast) ||
          (Object.hasOwn(ast, "errors") && (!Array.isArray(ast.errors) || ast.errors.length > 0))) {
        failures.push({ file: relativePath, error: "parser returned no AST or reported errors" });
      } else parsed.push(relativePath);
    } catch (error) { failures.push({ file: relativePath, error: String(error?.message ?? error) }); }
  }
  return evaluatorResult("syntax_ast", failures.length === 0, failures.length === 0 ? 1 : 0, { files: parsed, failures });
}
