import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

export interface FunctionTarget {
  file: string;
  name: string;
  owner?: string;
}

export interface ComplexityMetrics {
  cyclomatic: number;
  maxNesting: number;
  lines: number;
}

export interface ComplexityBaseline {
  schemaVersion: 1;
  baselineRevision: string;
  policy: string;
  functions: FunctionTarget[];
}

interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number }; end: { line: number } };
  [key: string]: unknown;
}

export interface ComplexityComparison {
  baseline: ComplexityMetrics;
  current: ComplexityMetrics;
  violations: string[];
}

const CONTROL_NODES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
  "ConditionalExpression",
]);

const NON_AST_FIELDS = new Set([
  "loc", "start", "end", "comments", "tokens", "leadingComments", "trailingComments", "innerComments",
]);

/**
 * Metric definition: CC starts at 1; each if/loop/catch/ternary, each non-default switch case, and each &&, || or ??
 * adds 1. Maximum nesting is the deepest nested if/loop/catch/ternary/switch construct. Nested functions are measured
 * separately when named in the baseline, so a callback does not inflate its enclosing function's result. This is a
 * targeted regression measure, not a full cognitive-complexity score.
 */

function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof value === "object" && "type" in value && typeof value.type === "string";
}

function children(node: AstNode): AstNode[] {
  const found: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (NON_AST_FIELDS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) found.push(item);
    } else if (isAstNode(value)) {
      found.push(value);
    }
  }
  return found;
}

function functionLike(node: AstNode): boolean {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(node.type);
}

function identifier(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if ((node.type === "StringLiteral" || node.type === "NumericLiteral") && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  return undefined;
}

function functionName(node: AstNode): string | undefined {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") return identifier(isAstNode(node.id) ? node.id : undefined);
  if (node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod") return identifier(isAstNode(node.key) ? node.key : undefined);
  return undefined;
}

function findTargetFunction(root: AstNode, target: FunctionTarget, filename: string): AstNode {
  const matches: AstNode[] = [];
  const visit = (node: AstNode, owner?: string): void => {
    if (functionLike(node) && functionName(node) === target.name && owner === target.owner) matches.push(node);
    const nextOwner = node.type === "ClassDeclaration" || node.type === "ClassExpression"
      ? identifier(isAstNode(node.id) ? node.id : undefined)
      : owner;
    for (const child of children(node)) visit(child, nextOwner);
  };
  visit(root);
  if (matches.length !== 1) {
    const label = target.owner ? `${target.owner}.${target.name}` : target.name;
    throw new Error(`${filename}: expected one function ${label}; found ${matches.length}`);
  }
  return matches[0];
}

function measureNode(root: AstNode): ComplexityMetrics {
  let cyclomatic = 1;
  let maxNesting = 0;

  const visit = (node: AstNode, depth: number, isRoot = false): void => {
    if (!isRoot && functionLike(node)) return;

    let childDepth = depth;
    if (CONTROL_NODES.has(node.type)) {
      cyclomatic += 1;
      childDepth = depth + 1;
      maxNesting = Math.max(maxNesting, childDepth);
    } else if (node.type === "SwitchStatement") {
      const cases = Array.isArray(node.cases) ? node.cases.filter((item): item is AstNode => isAstNode(item)) : [];
      cyclomatic += cases.filter((clause) => clause.test !== null).length;
      childDepth = depth + 1;
      maxNesting = Math.max(maxNesting, childDepth);
    }

    if (node.type === "LogicalExpression" && ["&&", "||", "??"].includes(String(node.operator))) cyclomatic += 1;
    for (const child of children(node)) visit(child, childDepth);
  };

  visit(root, 0, true);
  const lines = root.loc ? root.loc.end.line - root.loc.start.line + 1 : 0;
  return { cyclomatic, maxNesting, lines };
}

export function measureFunction(source: string, target: FunctionTarget, filename = target.file): ComplexityMetrics {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"], sourceFilename: filename }) as unknown as AstNode;
  return measureNode(findTargetFunction(ast, target, filename));
}

export function compareMetrics(baseline: ComplexityMetrics, current: ComplexityMetrics): ComplexityComparison {
  const violations: string[] = [];
  if (current.cyclomatic > baseline.cyclomatic) violations.push(`cyclomatic complexity increased ${baseline.cyclomatic} -> ${current.cyclomatic}`);
  if (current.maxNesting > baseline.maxNesting) violations.push(`maximum control nesting increased ${baseline.maxNesting} -> ${current.maxNesting}`);
  return { baseline, current, violations };
}

function readBaseline(root: string): ComplexityBaseline {
  const baselinePath = path.join(root, "cli/critical-complexity-baseline.json");
  const raw: unknown = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("complexity baseline must be a JSON object");
  const value = raw as Partial<ComplexityBaseline>;
  if (value.schemaVersion !== 1 || typeof value.baselineRevision !== "string" || !/^[0-9a-f]{40}$/i.test(value.baselineRevision)) {
    throw new Error("complexity baseline must name schemaVersion 1 and a full 40-character baselineRevision");
  }
  if (typeof value.policy !== "string" || !value.policy.trim() || !Array.isArray(value.functions) || value.functions.length === 0) {
    throw new Error("complexity baseline must include a policy and at least one tracked function");
  }
  const seen = new Set<string>();
  for (const target of value.functions) {
    if (!target || typeof target.file !== "string" || !target.file.startsWith("cli/src/") || target.file.includes("..") || path.isAbsolute(target.file) || typeof target.name !== "string" || !target.name) {
      throw new Error("complexity baseline contains an invalid function path or name");
    }
    if (target.owner !== undefined && (typeof target.owner !== "string" || !target.owner)) throw new Error(`invalid owner for ${target.file}::${target.name}`);
    const key = `${target.file}::${target.owner ?? ""}::${target.name}`;
    if (seen.has(key)) throw new Error(`duplicate complexity baseline function ${key}`);
    seen.add(key);
  }
  return value as ComplexityBaseline;
}

export function checkCriticalComplexity(root: string): { baselineRevision: string; rows: Array<{ target: FunctionTarget; comparison: ComplexityComparison }> } {
  const baseline = readBaseline(root);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", baseline.baselineRevision, "HEAD"], { cwd: root, encoding: "utf8" });
  if (ancestry.error) throw ancestry.error;
  if (ancestry.status !== 0) throw new Error(`complexity baseline ${baseline.baselineRevision} is not an ancestor of HEAD`);

  const rows = baseline.functions.map((target) => {
    const baselineSource = execFileSync("git", ["show", `${baseline.baselineRevision}:${target.file}`], { cwd: root, encoding: "utf8" });
    const currentSource = fs.readFileSync(path.join(root, target.file), "utf8");
    const comparison = compareMetrics(
      measureFunction(baselineSource, target, `${baseline.baselineRevision}:${target.file}`),
      measureFunction(currentSource, target, target.file),
    );
    return { target, comparison };
  });
  return { baselineRevision: baseline.baselineRevision, rows };
}

function main(): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const result = checkCriticalComplexity(root);
    let failed = false;
    console.log(`Critical TypeScript complexity baseline: ${result.baselineRevision}`);
    for (const { target, comparison } of result.rows) {
      const label = `${target.file}::${target.owner ? `${target.owner}.` : ""}${target.name}`;
      const { baseline, current, violations } = comparison;
      console.log(`${label}: CC ${baseline.cyclomatic}->${current.cyclomatic}; nesting ${baseline.maxNesting}->${current.maxNesting}; lines ${baseline.lines}->${current.lines}`);
      for (const violation of violations) {
        failed = true;
        console.error(`FAIL ${label}: ${violation}`);
      }
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(`critical complexity check could not establish the baseline: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
