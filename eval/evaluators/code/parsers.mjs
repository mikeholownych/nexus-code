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

function childFailure(result, what, timeoutMs) {
  if (result.error?.code === "ETIMEDOUT") return `${what} timed out after ${timeoutMs} ms`;
  if (result.error) return `${what} could not run: ${result.error.message}`;
  if (result.signal) return `${what} was terminated by ${result.signal}`;
  const text = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean);
  return text.slice(-3).join(" | ") || `${what} exited with status ${result.status}`;
}

// Parsed in a child process: the parser is synchronous, so only a child can be stopped when a file takes too long.
const TYPESCRIPT_CHILD = 'require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(0, "utf8"), { mode: "transform" })';

function parseTypeScript(source, { timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof module.stripTypeScriptTypes !== "function") throw new Error("no built-in TypeScript parser on this Node.js (requires >= 22.13)");
  const result = spawnSync(process.execPath, ["-e", TYPESCRIPT_CHILD], { input: source, env: CHILD_ENV(), timeout: timeoutMs, encoding: "utf8", shell: false });
  if (result.status !== 0 || result.signal || result.error) throw new Error(childFailure(result, "TypeScript parser", timeoutMs));
  return { parser: "node:module.stripTypeScriptTypes" };
}

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * The text of a package.json, or null when there is none. The file is opened without following a symlink and read in
 * capped chunks: `fstat().size` is 0 for procfs and similar files, so the size alone cannot bound the read.
 */
function readPackageJson(file) {
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    if (error?.code === "ELOOP") throw new Error(`${file} is a symlink; package metadata is not read through symlinks`);
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${file} is not a regular file`);
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65_536, MAX_PACKAGE_JSON_BYTES + 1 - total));
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_PACKAGE_JSON_BYTES) throw new Error(`${file} is larger than ${MAX_PACKAGE_JSON_BYTES} bytes`);
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { fs.closeSync(descriptor); }
}

function declaredModuleType(absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension === ".mjs") return "module";
  if (extension === ".cjs") return "commonjs";
  for (let directory = path.dirname(absolutePath); ; directory = path.dirname(directory)) {
    const text = readPackageJson(path.join(directory, "package.json"));
    if (text !== null) {
      // Malformed metadata propagates: node itself rejects such a file (ERR_INVALID_PACKAGE_CONFIG).
      const type = JSON.parse(text)?.type;
      return type === "module" || type === "commonjs" ? type : null;
    }
    if (path.dirname(directory) === directory) return null;
  }
}

function parseJavaScript(source, { absolutePath, timeoutMs = TIMEOUT_MS }) {
  const declared = declaredModuleType(absolutePath);
  const failures = [];
  for (const inputType of declared ? [declared] : ["module", "commonjs"]) {
    const result = spawnSync(process.execPath, ["--check", `--input-type=${inputType}`], { input: source, env: CHILD_ENV(), timeout: timeoutMs, encoding: "utf8", shell: false });
    if (result.status === 0 && !result.signal && !result.error) return { parser: `node --check (${inputType})` };
    failures.push(childFailure(result, "node --check", timeoutMs));
  }
  throw new Error(failures[0]);
}

function parsePython(source, { file, timeoutMs = TIMEOUT_MS }) {
  const program = "import ast, sys\nast.parse(sys.stdin.buffer.read(), filename=sys.argv[1])";
  const result = spawnSync("python3", ["-I", "-c", program, file], { input: source, env: CHILD_ENV(), timeout: timeoutMs, encoding: "utf8", shell: false });
  if (result.status !== 0 || result.signal || result.error) throw new Error(childFailure(result, "python3 ast.parse", timeoutMs));
  return { parser: "python3 ast.parse" };
}

export const DEFAULT_PARSERS = Object.freeze({ typescript: parseTypeScript, javascript: parseJavaScript, python: parsePython });
