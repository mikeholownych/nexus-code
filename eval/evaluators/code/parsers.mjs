import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";

/**
 * Built-in syntax parsers that need nothing beyond the evaluation host's own Node.js and Python:
 * - TypeScript (.ts, .mts, .cts): Node's built-in TypeScript parser (`module.stripTypeScriptTypes`, transform mode),
 *   which parses the whole file and throws on any syntax error. Requires Node.js >= 22.13; older hosts have no default.
 * - JavaScript (.js, .mjs, .cjs): `node --check` of the source on stdin, as a module or as CommonJS following the file's
 *   extension and nearest package.json. An undeclared `.js` passes when it parses as either. (`node --check <file>` alone
 *   is not used: on a `.js` file with no declared type it accepts ESM syntax errors.)
 * - Python (.py): `ast.parse` in an isolated interpreter (`python3 -I`), source on stdin.
 * Rust, TSX and JSX have no built-in parser; callers that need them supply one, and otherwise those files fail closed.
 * Each parser returns a small descriptor object on success and throws with the parser's message on failure.
 */

const CHILD_ENV = () => ({ PATH: process.env.PATH ?? "", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
const TIMEOUT_MS = 30_000;

function childFailure(result, what) {
  if (result.error) return `${what} could not run: ${result.error.message}`;
  if (result.signal) return `${what} was terminated by ${result.signal}`;
  const text = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean);
  return text.slice(-3).join(" | ") || `${what} exited with status ${result.status}`;
}

function parseTypeScript(source) {
  const strip = module.stripTypeScriptTypes;
  if (typeof strip !== "function") throw new Error("no built-in TypeScript parser on this Node.js (requires >= 22.13)");
  strip(source, { mode: "transform" });
  return { parser: "node:module.stripTypeScriptTypes" };
}

function declaredModuleType(absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension === ".mjs") return "module";
  if (extension === ".cjs") return "commonjs";
  for (let directory = path.dirname(absolutePath); ; directory = path.dirname(directory)) {
    try {
      const type = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))?.type;
      return type === "module" || type === "commonjs" ? type : null;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR" && !(error instanceof SyntaxError)) throw error;
    }
    if (path.dirname(directory) === directory) return null;
  }
}

function parseJavaScript(source, { absolutePath }) {
  const declared = declaredModuleType(absolutePath);
  const failures = [];
  for (const inputType of declared ? [declared] : ["module", "commonjs"]) {
    const result = spawnSync(process.execPath, ["--check", `--input-type=${inputType}`], { input: source, env: CHILD_ENV(), timeout: TIMEOUT_MS, encoding: "utf8", shell: false });
    if (result.status === 0 && !result.signal && !result.error) return { parser: `node --check (${inputType})` };
    failures.push(childFailure(result, "node --check"));
  }
  throw new Error(failures[0]);
}

function parsePython(source, { file }) {
  const program = "import ast, sys\nast.parse(sys.stdin.buffer.read(), filename=sys.argv[1])";
  const result = spawnSync("python3", ["-I", "-c", program, file], { input: source, env: CHILD_ENV(), timeout: TIMEOUT_MS, encoding: "utf8", shell: false });
  if (result.status !== 0 || result.signal || result.error) throw new Error(childFailure(result, "python3 ast.parse"));
  return { parser: "python3 ast.parse" };
}

export const DEFAULT_PARSERS = Object.freeze({ typescript: parseTypeScript, javascript: parseJavaScript, python: parsePython });
