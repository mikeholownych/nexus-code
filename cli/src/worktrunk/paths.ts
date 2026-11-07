/**
 * Branch-name validation and the worktree path template.
 *
 * The evaluator is deliberately small: `{{ name | filter | filter }}` with fixed variables and three filters. No
 * expressions, no conditionals, no template dependency. A rendered path is only ever used after
 * `resolveWorktreePath` has proven it lies below the allowed root.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { ancestryProblem } from "../safe_fs.js";

export class WorktreePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreePathError";
  }
}

const MAX_BRANCH = 200;
const FORBIDDEN = /[\u0000-\u001f\u007f\s~^:?*[\\]/u;

/** Why `name` is not an acceptable branch name, or undefined. Stricter than `git check-ref-format`. */
export function validateBranchName(name: string): string | undefined {
  if (typeof name !== "string" || name.length === 0) return "branch name is empty";
  if (name.length > MAX_BRANCH) return `branch name is longer than ${MAX_BRANCH} characters`;
  if (name.startsWith("-")) return "branch name must not start with '-'";
  if (name === "@") return "'@' is not a branch name";
  if (FORBIDDEN.test(name)) return "branch name contains a control, whitespace or reserved character";
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return "branch name contains '..', '@{' or '//'";
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return "branch name has an invalid start or end";
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return "branch name has a component starting with '.' or ending in '.lock'";
  return undefined;
}

/** A file-system-safe name for a branch: `[A-Za-z0-9._-]` only, no leading dot or dash, bounded length. */
export function sanitizeBranch(branch: string): string {
  const flat = branch.replace(/[\/\\]+/g, "-");
  let out = flat.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/-{2,}/g, "-");
  out = out.replace(/^[.\-]+/, "").replace(/[.\-]+$/, "");
  if (!out) out = "branch";
  // A lossy or long name stays unique by branch: names that sanitise alike are told apart by the suffix.
  if (out.length > 60 || out !== flat) {
    return `${out.slice(0, 60).replace(/[.\-]+$/, "")}-${crypto.createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
  }
  return out;
}

const WORDS_A = ["amber", "brisk", "calm", "dusty", "eager", "frosty", "gentle", "hazy", "ivory", "jolly", "keen", "lucid", "mellow", "noble", "olive", "plucky"];
const WORDS_B = ["badger", "comet", "dune", "ember", "falcon", "glacier", "harbor", "island", "juniper", "kestrel", "lagoon", "meadow", "nebula", "orchid", "pebble", "quartz"];

const FILTERS: Record<string, (value: string) => string> = {
  sanitize: sanitizeBranch,
  hash_port: (value) => String(10000 + (crypto.createHash("sha256").update(value).digest().readUInt32BE(0) % 50000)).padStart(5, "0"),
  codename: (value) => {
    const digest = crypto.createHash("sha256").update(value).digest();
    return `${WORDS_A[digest[0] % WORDS_A.length]}-${WORDS_B[digest[1] % WORDS_B.length]}`;
  },
};

export interface TemplateVars { repo_path: string; repo: string; owner: string; branch: string }

export function renderTemplate(template: string, vars: TemplateVars): string {
  const known = vars as unknown as Record<string, string>;
  let out = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{{", index);
    if (open < 0) {
      out += template.slice(index);
      break;
    }
    out += template.slice(index, open);
    const close = template.indexOf("}}", open + 2);
    if (close < 0) throw new WorktreePathError("path template is malformed: unterminated '{{'");
    const parts = template.slice(open + 2, close).split("|").map((part) => part.trim());
    const variable = parts[0];
    if (!/^[a-z_]+$/.test(variable)) throw new WorktreePathError(`path template is malformed near '${variable.slice(0, 20)}'`);
    if (!Object.prototype.hasOwnProperty.call(known, variable)) throw new WorktreePathError(`path template has an unknown variable '${variable}'`);
    let value = known[variable];
    for (const name of parts.slice(1)) {
      if (!Object.prototype.hasOwnProperty.call(FILTERS, name)) throw new WorktreePathError(`path template has an unknown filter '${name.slice(0, 20)}'`);
      value = FILTERS[name](value);
    }
    out += value;
    index = close + 2;
  }
  if (out.includes("\u0000")) throw new WorktreePathError("path template produced a NUL byte");
  return out;
}

export type WorktreeLayout = "nexus" | "sibling";

export const DEFAULT_TEMPLATES: Record<WorktreeLayout, string> = {
  nexus: "{{ repo_path }}/.nexus/worktrees/{{ branch | sanitize }}",
  sibling: "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}",
};

export interface ResolveInput {
  repoPath: string;
  repo: string;
  owner: string;
  branch: string;
  layout: WorktreeLayout;
  template?: string;
  allowOutside?: boolean;
}

/** The directory under which this layout may place worktrees. */
export function allowedRoot(repoPath: string, layout: WorktreeLayout): string {
  return layout === "nexus" ? path.join(repoPath, ".nexus", "worktrees") : path.dirname(repoPath);
}

export function resolveWorktreePath(input: ResolveInput): { path: string; root: string } {
  const template = input.template ?? DEFAULT_TEMPLATES[input.layout];
  const rendered = renderTemplate(template, { repo_path: input.repoPath, repo: input.repo, owner: input.owner, branch: input.branch });
  if (!path.isAbsolute(rendered)) throw new WorktreePathError("rendered worktree path is not absolute");
  const target = path.resolve(rendered);
  const root = allowedRoot(input.repoPath, input.layout);
  const relative = path.relative(root, target);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside && !input.allowOutside) {
    throw new WorktreePathError(`worktree path is outside ${input.layout === "nexus" ? ".nexus/worktrees/" : "the repository's parent directory"}; refusing (operator config worktree.allowOutside overrides)`);
  }
  if (target === path.resolve(input.repoPath) || target.split(path.sep).includes(".git")) {
    throw new WorktreePathError("worktree path must not be the repository itself or inside .git");
  }
  if (inside) {
    const problem = ancestryProblem(root, target);
    if (problem) throw new WorktreePathError(`worktree path is not safe: ${problem}`);
  }
  return { path: target, root };
}
