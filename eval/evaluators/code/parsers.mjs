import { spawnSync } from "node:child_process";
import module from "node:module";

/**
 * Built-in syntax parsers that need nothing beyond the evaluation host's own Node.js and Python:
 * - TypeScript (.ts, .mts, .cts): Node's built-in TypeScript parser (`module.stripTypeScriptTypes`, transform mode),
 *   which parses the whole file and throws on any syntax error. Requires Node.js >= 22.13; older hosts have no default.
 * - JavaScript (.js, .mjs, .cjs): `node --check` on the file itself, so the module type follows the file's extension
 *   and nearest package.json exactly as Node would run it.
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

function parseJavaScript(_source, { absolutePath }) {
  const result = spawnSync(process.execPath, ["--check", absolutePath], { env: CHILD_ENV(), timeout: TIMEOUT_MS, encoding: "utf8", shell: false });
  if (result.status !== 0 || result.signal || result.error) throw new Error(childFailure(result, "node --check"));
  return { parser: "node --check" };
}

function parsePython(source, { file }) {
  const program = "import ast, sys\nast.parse(sys.stdin.buffer.read(), filename=sys.argv[1])";
  const result = spawnSync("python3", ["-I", "-c", program, file], { input: source, env: CHILD_ENV(), timeout: TIMEOUT_MS, encoding: "utf8", shell: false });
  if (result.status !== 0 || result.signal || result.error) throw new Error(childFailure(result, "python3 ast.parse"));
  return { parser: "python3 ast.parse" };
}

export const DEFAULT_PARSERS = Object.freeze({ typescript: parseTypeScript, javascript: parseJavaScript, python: parsePython });
