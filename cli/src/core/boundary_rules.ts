/**
 * SI-5 / VC-1: operator-declared boundary rules, checked on a candidate diff by deterministic analysis.
 *
 * The operator declares what must not happen (an import from one layer into another, a change to a protected public
 * file, an import cycle between modules) and which files are public interfaces or schemas. The check reads the unified
 * diff of the candidate and reports:
 *  - violations (the review gate rejects on any),
 *  - advisories (an import outside the declared allow-list, a change that may break an interface or schema, or that
 *    could not be classified),
 *  - coverage: what was analysed, what was skipped and why, and the standing limits of line-based analysis.
 *
 * It reads added and removed lines, not a build: it does not resolve path aliases, re-exports or computed imports, and
 * it sees only what the diff contains. Those limits are part of every report, and an absent rule set means no check at
 * all (`checkBoundaries` returns undefined). Pass the cumulative diff of successive changes to find a breach none of
 * them has alone (an import cycle closed by the second change).
 */
import * as path from "node:path";
import { diffSidePath, extractModifiedFilesFromDiff, headerPath } from "./unified_diff.js";

export interface ImportRule {
  name: string;
  /** Files the rule applies to (globs, repository-relative). */
  from: string[];
  /** An added import whose target matches any of these is a violation. */
  deny?: string[];
  /** When present, an added import whose target matches none of these (and is not a Node built-in) is an advisory. */
  allow?: string[];
}

export interface BoundaryRules {
  imports?: ImportRule[];
  /** Files whose change needs the operator's authorisation (`authorizedScope`); otherwise a violation. */
  protected?: string[];
  /** Public interface files: changes are classified compatible / potentially breaking / unknown. */
  interfaces?: string[];
  /** Schema and persistence-format files: classified the same way. */
  schemas?: string[];
  /** Modules (globs) among which no import cycle may exist. */
  acyclic?: string[];
}

export class BoundaryRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryRulesError";
  }
}

const RULE_KEYS = ["imports", "protected", "interfaces", "schemas", "acyclic"] as const;
const IMPORT_KEYS = ["name", "from", "deny", "allow"] as const;
const MAX_GLOB = 200;
const MAX_ENTRIES = 200;

function globList(value: unknown, field: string, required = false): string[] | undefined {
  if (value === undefined) {
    if (required) throw new BoundaryRulesError(`${field}: required`);
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENTRIES) throw new BoundaryRulesError(`${field}: must be a non-empty list of at most ${MAX_ENTRIES} globs`);
  for (const g of value) {
    if (typeof g !== "string" || !g.trim() || g.length > MAX_GLOB || g.includes("\0") || g.startsWith("/") || g.split("/").includes("..")) {
      throw new BoundaryRulesError(`${field}: "${String(g).slice(0, 40)}" is not a repository-relative glob`);
    }
  }
  return value as string[];
}

/** Strict validation of operator-supplied rules; every error names the field. Unknown keys are refused, not ignored. */
export function parseBoundaryRules(raw: unknown): BoundaryRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BoundaryRulesError("boundaries: must be an object");
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!(RULE_KEYS as readonly string[]).includes(key)) throw new BoundaryRulesError(`boundaries.${key}: unknown field (known: ${RULE_KEYS.join(", ")})`);
  const out: BoundaryRules = {};
  if (r.imports !== undefined) {
    if (!Array.isArray(r.imports) || r.imports.length === 0 || r.imports.length > MAX_ENTRIES) throw new BoundaryRulesError(`boundaries.imports: must be a non-empty list of at most ${MAX_ENTRIES} rules`);
    out.imports = r.imports.map((entry, i) => {
      const f = `boundaries.imports[${i}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new BoundaryRulesError(`${f}: must be an object`);
      const e = entry as Record<string, unknown>;
      for (const key of Object.keys(e)) if (!(IMPORT_KEYS as readonly string[]).includes(key)) throw new BoundaryRulesError(`${f}.${key}: unknown field`);
      if (typeof e.name !== "string" || !/^[\w .:-]{1,80}$/.test(e.name)) throw new BoundaryRulesError(`${f}.name: a short name is required`);
      const deny = globList(e.deny, `${f}.deny`);
      const allow = globList(e.allow, `${f}.allow`);
      if (!deny && !allow) throw new BoundaryRulesError(`${f}: needs deny, allow or both`);
      return { name: e.name, from: globList(e.from, `${f}.from`, true)!, ...(deny ? { deny } : {}), ...(allow ? { allow } : {}) };
    });
  }
  for (const key of ["protected", "interfaces", "schemas", "acyclic"] as const) {
    const list = globList(r[key], `boundaries.${key}`);
    if (list) out[key] = list;
  }
  if (!Object.keys(out).length) throw new BoundaryRulesError("boundaries: declares no rule");
  return out;
}

// ------------------------------------------------------------------------------------------------ matching

/** `**` crosses directories, `*` and `?` do not. Case-sensitive. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i++;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|rs|go)$/;
const stripSourceExt = (p: string): string => p.replace(SOURCE_EXT, "").replace(/\/index$/, "");

/** Whether `target` (a file path or a module path, extension optional) matches a glob; an extension in the glob is ignored so `src/db/client.ts` also names the import `../db/client`. */
function matches(glob: string, target: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(target)) return true;
  const bare = stripSourceExt(target);
  return re.test(bare) || globToRegExp(stripSourceExt(glob)).test(bare);
}

const anyMatch = (globs: readonly string[] | undefined, target: string): boolean => Boolean(globs?.some((g) => matches(g, target)));

// ------------------------------------------------------------------------------------------------ diff

export interface FileChange {
  path: string;
  status: "added" | "deleted" | "modified";
  added: string[];
  removed: string[];
}

/**
 * Per-file added and removed lines of a unified diff. Hunk bodies are consumed by the counts in their `@@` header, so a
 * removed line that reads "-- note" or an added "++ note" is content, never a file header. A file whose header cannot be
 * read is listed in `unparsed` and not analysed.
 */
export function parseDiffFiles(diff: string): { files: FileChange[]; unparsed: string[] } {
  const files: FileChange[] = [];
  const unparsed: string[] = [];
  const lines = diff.split("\n");
  let current: FileChange | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && lines[i + 2]?.startsWith("@@")) {
        oldLeft = 0;
        newLeft = 0;
      } else if (line.startsWith("\\")) continue;
      else if (line.startsWith("+") && newLeft > 0) {
        current?.added.push(line.slice(1));
        newLeft--;
        continue;
      } else if (line.startsWith("-") && oldLeft > 0) {
        current?.removed.push(line.slice(1));
        oldLeft--;
        continue;
      } else if (line.startsWith(" ") || line === "") {
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
        continue;
      } else {
        oldLeft = 0;
        newLeft = 0;
      }
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const from = headerPath(line.slice(4));
      const to = headerPath(lines[i + 1].slice(4));
      const a = from === undefined ? undefined : diffSidePath(from, "a/");
      const b = to === undefined ? undefined : diffSidePath(to, "b/");
      const name = b ?? a;
      if (name === undefined) {
        unparsed.push(`<unreadable file header: ${line.slice(0, 60)}>`);
        current = undefined;
      } else {
        current = { path: name, status: a === undefined ? "added" : b === undefined ? "deleted" : "modified", added: [], removed: [] };
        files.push(current);
      }
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (counts) {
        oldLeft = counts[1] === undefined ? 1 : Number(counts[1]);
        newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
      }
    }
  }
  return { files, unparsed };
}

// ------------------------------------------------------------------------------------------------ imports

type Language = "js" | "py" | "rs" | "go";
const LANGUAGE_BY_EXT: Record<string, Language> = { ".ts": "js", ".tsx": "js", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".mts": "js", ".cts": "js", ".py": "py", ".rs": "rs", ".go": "go" };
const languageOf = (file: string): Language | undefined => LANGUAGE_BY_EXT[path.posix.extname(file).toLowerCase()];

interface ImportRef {
  spec: string;
  /** A specifier the analysis cannot read (a computed dynamic import). */
  computed?: true;
}

/** The import(s) one added line makes, by language. A line is read alone: no multi-line import continuation is followed. */
export function importsOnLine(line: string, language: Language): ImportRef[] {
  const found: ImportRef[] = [];
  if (language === "js") {
    const statement = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*${},\s]+?\s+from\s+)?["']([^"']+)["']/.exec(line);
    if (statement) found.push({ spec: statement[1] });
    for (const m of line.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) found.push({ spec: m[1] });
    for (const m of line.matchAll(/\bimport\(\s*(["'][^"']+["']|[^)]*)\)/g)) {
      const literal = /^["']([^"']+)["']$/.exec(m[1].trim());
      found.push(literal ? { spec: literal[1] } : { spec: "", computed: true });
    }
  } else if (language === "py") {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line);
    if (from) found.push({ spec: from[1] });
    else {
      const plain = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(line);
      if (plain) for (const part of plain[1].split(",")) found.push({ spec: part.trim() });
    }
  } else if (language === "rs") {
    const use = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/.exec(line);
    if (use) found.push({ spec: use[1] });
  } else {
    const go = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
    if (go) found.push({ spec: go[1] });
  }
  return found;
}

/** The target an import names, in the form rules are matched against: a repository path (extensionless) for a relative import, otherwise the specifier as written. */
export function resolveImportTarget(fromFile: string, spec: string, language: Language): string {
  if (language === "js") {
    if (!spec.startsWith(".")) return spec;
    return stripSourceExt(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
  }
  if (language === "py") {
    const dots = /^\.*/.exec(spec)![0].length;
    const rest = spec.slice(dots).replace(/\./g, "/");
    if (!dots) return rest;
    const base = path.posix.dirname(fromFile).split("/").slice(0, Math.max(0, path.posix.dirname(fromFile).split("/").length - (dots - 1))).join("/");
    return path.posix.normalize(path.posix.join(base || ".", rest)).replace(/^\.$/, "");
  }
  return spec;
}

const isNodeBuiltin = (target: string): boolean => target.startsWith("node:");

// ------------------------------------------------------------------------------------------------ classification

export type ChangeClass = "compatible" | "potentially_breaking" | "unknown";
export interface ChangeClassification {
  path: string;
  kind: "interface" | "schema";
  class: ChangeClass;
  reason: string;
}

const PUBLIC_DECLARATIONS: Record<Language, RegExp[]> = {
  js: [/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([\w$]+)/, /^\s*export\s+\{([^}]*)\}/],
  rs: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|const|static|type|mod|union)\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/, /^type\s+([A-Z]\w*)/, /^(?:var|const)\s+([A-Z]\w*)/],
  py: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/, /^class\s+([A-Za-z]\w*)/],
};

function publicSymbols(lines: string[], language: Language): Map<string, string> {
  const symbols = new Map<string, string>();
  for (const line of lines) {
    for (const re of PUBLIC_DECLARATIONS[language]) {
      const m = re.exec(line);
      if (!m) continue;
      const names = re === PUBLIC_DECLARATIONS.js[1] ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean) : [m[1]];
      for (const name of names) symbols.set(name, line.trim());
    }
  }
  return symbols;
}

function classifyInterface(change: FileChange): { class: ChangeClass; reason: string } {
  const language = languageOf(change.path);
  if (!language) return { class: "unknown", reason: "no declaration analysis for this file type" };
  if (change.status === "deleted") return { class: "potentially_breaking", reason: "the file was deleted" };
  const before = publicSymbols(change.removed, language);
  const after = publicSymbols(change.added, language);
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed = [...before.keys()].filter((name) => after.has(name) && after.get(name) !== before.get(name));
  if (removed.length) return { class: "potentially_breaking", reason: `public declaration(s) removed: ${removed.slice(0, 5).join(", ")}` };
  if (changed.length) return { class: "potentially_breaking", reason: `public declaration(s) changed: ${changed.slice(0, 5).join(", ")}` };
  const addedOnly = [...after.keys()].filter((name) => !before.has(name));
  return { class: "compatible", reason: addedOnly.length ? `public declaration(s) added: ${addedOnly.slice(0, 5).join(", ")}` : "no public declaration was removed or changed (only top-level declarations are read)" };
}

function classifySchema(change: FileChange): { class: ChangeClass; reason: string } {
  if (change.status === "deleted") return { class: "potentially_breaking", reason: "the schema file was deleted" };
  const ext = path.posix.extname(change.path).toLowerCase();
  const removed = change.removed.join("\n");
  const added = change.added.join("\n");
  if (ext === ".sql") {
    if (/\b(?:DROP|RENAME)\b|\bALTER\s+(?:TABLE\s+\S+\s+)?(?:ALTER\s+)?COLUMN\b[^;]*\bTYPE\b|\bNOT\s+NULL\b/i.test(added) || removed.trim()) return { class: "potentially_breaking", reason: "a migration drops, renames, retypes or tightens a column, or removes a statement" };
    return { class: "compatible", reason: "only additive statements" };
  }
  if (ext === ".proto") {
    const field = (text: string) => new Set([...text.matchAll(/^\s*(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)/gm)].map((m) => `${m[1]}=${m[2]}`));
    const was = field(removed);
    const now = field(added);
    const gone = [...was].filter((f) => !now.has(f));
    return gone.length ? { class: "potentially_breaking", reason: `field(s) removed or renumbered: ${gone.slice(0, 5).join(", ")}` } : { class: "compatible", reason: "no field was removed or renumbered" };
  }
  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    if (!change.removed.length) return { class: "compatible", reason: "only additions" };
    const keys = (text: string) => new Set([...text.matchAll(/["']?([\w$-]+)["']?\s*:/g)].map((m) => m[1]));
    const was = keys(removed);
    const now = keys(added);
    const gone = [...was].filter((k) => !now.has(k));
    if (gone.length || /"required"|"type"|required:|type:/.test(removed)) return { class: "potentially_breaking", reason: gone.length ? `key(s) removed: ${gone.slice(0, 5).join(", ")}` : "a type or required constraint line changed" };
    return { class: "unknown", reason: "lines were rewritten; only a value changed or the change is not a key removal, so compatibility is not decided" };
  }
  return change.removed.length ? { class: "unknown", reason: "no analysis for this file type and lines were removed" } : { class: "compatible", reason: "only additions" };
}

// ------------------------------------------------------------------------------------------------ the check

export interface BoundaryFinding {
  rule: string;
  path: string;
  detail: string;
}

export interface BoundaryReport {
  violations: BoundaryFinding[];
  advisories: BoundaryFinding[];
  classifications: ChangeClassification[];
  coverage: {
    filesInDiff: number;
    analysed: number;
    skipped: Array<{ path: string; reason: string }>;
    /** Standing limits plus anything specific to this diff (omitted sections, computed imports). */
    limits: string[];
  };
}

const STANDING_LIMITS = [
  "Analysis reads the lines the diff adds and removes, not a build: path aliases, re-exports and computed imports are not resolved.",
  "An import written across several lines is read only where its `from` clause is on the line the diff adds.",
  "Interface classification reads top-level declarations only; a change inside a declaration's body is not seen.",
  "Rust imports are matched as module paths (for example crate::db::x), Python imports as dotted paths turned into directories, Go imports as written; none are mapped to files.",
  "Import cycles are found among the imports this diff adds; a cycle that needs an import already in the repository is not found unless that import is in the diff.",
];

const OMISSION_NOTE = /^\[(\d+) (?:protected file section\(s\)|new file\(s\)|untracked nested git repositor(?:y|ies)) omitted[^\]]*\]$/;

export function checkBoundaries(diff: string, rules: BoundaryRules | undefined, context: { authorizedScope?: readonly string[] } = {}): BoundaryReport | undefined {
  if (!rules) return undefined;
  const violations: BoundaryFinding[] = [];
  const advisories: BoundaryFinding[] = [];
  const classifications: ChangeClassification[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const limits = [...STANDING_LIMITS];
  const parsed = parseDiffFiles(diff);
  for (const bad of parsed.unparsed) skipped.push({ path: bad, reason: "file header could not be read" });
  for (const line of diff.split("\n")) if (OMISSION_NOTE.test(line.trim())) limits.push(`Not analysed (hidden from this diff): ${line.trim().slice(1, -1)}.`);
  const touched = new Set([...extractModifiedFilesFromDiff(diff), ...parsed.files.map((f) => f.path)]);
  let analysed = 0;

  for (const file of touched) {
    if (file.startsWith("<unparseable")) {
      violations.push({ rule: "diff", path: file, detail: "a file header in the diff could not be read, so the boundary check cannot vouch for the change" });
      continue;
    }
    if (rules.protected && anyMatch(rules.protected, file) && !(context.authorizedScope ?? []).some((a) => a === "*" || file === a || file.startsWith(`${a}/`))) {
      violations.push({ rule: "protected", path: file, detail: "a protected public file changed without being in the authorised scope" });
    }
  }

  const computedImports: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (const change of parsed.files) {
    const language = languageOf(change.path);
    let importsRead = false;
    if (language && (rules.imports || rules.acyclic)) {
      const fromModule = stripSourceExt(change.path);
      for (const line of change.added) {
        for (const ref of importsOnLine(line, language)) {
          importsRead = true;
          if (ref.computed) {
            computedImports.push(change.path);
            continue;
          }
          const target = resolveImportTarget(change.path, ref.spec, language);
          for (const rule of rules.imports ?? []) {
            if (!anyMatch(rule.from, change.path)) continue;
            if (rule.deny && anyMatch(rule.deny, target)) violations.push({ rule: rule.name, path: change.path, detail: `imports ${target}, which this rule denies` });
            else if (rule.allow && !anyMatch(rule.allow, target) && !isNodeBuiltin(target)) advisories.push({ rule: rule.name, path: change.path, detail: `imports ${target}, outside the declared allow-list (an undeclared dependency)` });
          }
          if (rules.acyclic && anyMatch(rules.acyclic, change.path) && anyMatch(rules.acyclic, target) && target !== fromModule) {
            (edges.get(fromModule) ?? edges.set(fromModule, new Set()).get(fromModule)!).add(target);
          }
        }
      }
    }
    const isInterface = Boolean(rules.interfaces && anyMatch(rules.interfaces, change.path));
    const isSchema = Boolean(rules.schemas && anyMatch(rules.schemas, change.path));
    if (isInterface) classifications.push({ path: change.path, kind: "interface", ...classifyInterface(change) });
    if (isSchema) classifications.push({ path: change.path, kind: "schema", ...classifySchema(change) });
    if (importsRead || isInterface || isSchema || (language && (rules.imports || rules.acyclic))) analysed++;
    else if (rules.imports || rules.acyclic) skipped.push({ path: change.path, reason: "file type is not analysed for imports" });
  }
  if (computedImports.length) limits.push(`Computed dynamic imports (not resolvable) in: ${[...new Set(computedImports)].slice(0, 5).join(", ")}.`);

  const cycle = rules.acyclic ? findCycle(edges) : undefined;
  if (cycle) violations.push({ rule: "acyclic", path: cycle[0], detail: `import cycle among the diff's imports: ${cycle.join(" -> ")}` });

  for (const c of classifications) {
    if (c.class === "compatible") continue;
    advisories.push({ rule: c.kind, path: c.path, detail: c.class === "potentially_breaking" ? `potentially breaking ${c.kind} change: ${c.reason}` : `${c.kind} change could not be classified: ${c.reason}` });
  }
  return { violations, advisories, classifications, coverage: { filesInDiff: touched.size, analysed, skipped, limits } };
}

/** One import cycle in the edge map, as a closed path (`a -> b -> a`), or undefined. */
function findCycle(edges: Map<string, Set<string>>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return undefined;
  };
  for (const node of edges.keys()) if (!state.has(node)) {
    const found = visit(node);
    if (found) return found;
  }
  return undefined;
}

/** One line per finding, for a reviewer prompt or a verdict note. */
export function describeBoundaryReport(report: BoundaryReport): string[] {
  return [
    ...report.violations.map((f) => `VIOLATION [${f.rule}] ${f.path}: ${f.detail}`),
    ...report.advisories.map((f) => `advisory [${f.rule}] ${f.path}: ${f.detail}`),
  ];
}
