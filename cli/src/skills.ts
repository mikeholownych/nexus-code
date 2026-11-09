import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isWorkspaceTrusted } from "./workspace_trust.js";
import { redactSecrets } from "./ui.js";

/**
 * Share of the context window the skill catalog in the system prompt may take. A user with hundreds of installed
 * skills otherwise sends ~37K tokens of catalog with every request and cannot start a turn on a 64K-context model.
 */
export const SKILL_CATALOG_CONTEXT_SHARE = 0.05;
/** The client token estimator's rate for prose (tokens.ts counts ~3 characters per token). */
const CHARS_PER_TOKEN = 3;
/** Character budget for the skill catalog in a window of `contextLimit` tokens. */
export function skillCatalogBudget(contextLimit: number): number {
  return Math.floor(Math.max(0, contextLimit) * SKILL_CATALOG_CONTEXT_SHARE * CHARS_PER_TOKEN);
}
/** The budget when no window is known: the client default context of 65,536 tokens. */
export const SKILL_CATALOG_MAX_CHARS = skillCatalogBudget(65_536);
/** Share of the context window one per-prompt skill note may take (see `formatSkillNote`). */
export const SKILL_NOTE_CONTEXT_SHARE = 0.02;
/** Character budget for one skill note in a window of `contextLimit` tokens. */
export function skillNoteBudget(contextLimit: number): number {
  return Math.floor(Math.max(0, contextLimit) * SKILL_NOTE_CONTEXT_SHARE * CHARS_PER_TOKEN);
}
/** Most skills a note or a lookup lists. */
export const MAX_SKILL_MATCHES = 5;
/** Heading of the catalog section in the system prompt. */
export const SKILL_CATALOG_HEADING = "### Specialized Agent Skills Available:";
/** First line under the heading, unchanged since v1.0: with the heading it marks the catalog (rules may quote the heading). */
const SKILL_CATALOG_INTRO = "You have access to specialized skills.";
/** Prefix of the per-prompt skill note; `[Nexus ` marks it as a harness note, never an operator request. */
export const SKILL_NOTE_PREFIX = "[Nexus skill note]";
/** Descriptions shorter than this stop helping the model pick a skill; below it the catalog lists names only. */
const MIN_DESCRIPTION_CHARS = 40;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const STOPWORDS = new Set(
  ("the and for with this that from into your you are can will use used using when then than not but any all has have how what why who which where its our out per via too very just also should would could about after before over under only some more most make made need needs want wants like please file files code task work skill skills " +
    // common request verbs and fillers: they say what the operator wants done, not which domain it is in
    "write writes wrote read reads add adds create creates build builds run runs fix fixes update updates change changes check checks help get gets set sets show find list look give take new now see tell explain implement make test tests try let can't dont does did done say hello thanks thank").split(" "),
);
/** Two-letter words that never name a domain, even inside a skill name (`pdf-to-text`). */
const SHORT_STOPWORDS = new Set("to of in on an at by is it be do as or if we my me up so no us am he".split(" "));
/** Longest operator text (characters) and number of distinct terms the ranker will look at. */
export const MAX_QUERY_CHARS = 2_000;
const MAX_QUERY_TERMS = 200;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/**
 * Lower-case word stems of `text`: Unicode letters and digits (accents folded: u-umlaut to u), short words and stop
 * words dropped, English plural/-ing/-ed folded. Runs of CJK text, which have no spaces, become character bigrams.
 * Two-character words (`go`, `ci`, `db`, `ml`, `ui`) are kept only when `keepShort` accepts them: they carry meaning
 * when a skill is named after them and are noise otherwise.
 */
function tokenize(text: string, keepShort: (word: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const folded = text.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "");
  for (const raw of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      const chars = Array.from(raw);
      if (chars.length === 1) out.push(raw);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (raw.length === 2 && !SHORT_STOPWORDS.has(raw) && keepShort(raw)) {
      out.push(raw);
      continue;
    }
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const stem = /^[a-z0-9]+$/.test(raw) ? (raw.length > 5 ? raw.replace(/(?:ing|ed|es|s)$/, "") : raw.replace(/s$/, "")) : raw;
    if (stem.length >= 3) out.push(stem);
  }
  return out;
}

/** Bracketed markers a description could use to pose as a Nexus, operator or tool message. */
const CONTROL_MARKER = /\[\s*(?:nexus|operator|system|assistant|user|tool|git status|active plan|work unit)[^\]]*\]?/gi;
/**
 * Chat-template control tokens a description could use to open its own turn once a local server renders the prompt
 * as text: ChatML and Llama 3 specials (`<|im_start|>`, `<|eot_id|>`, any `<|...|>`), `<system>` tags and the Llama 2
 * `[INST]` / `<<SYS>>` markers.
 */
const TEMPLATE_TOKEN = /<\|[^|<>\n]{0,64}\|>|<\s*\/?\s*system\s*>|\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>/gi;
/** A skill's text as one safe line: control markers, template tokens and secrets removed, whitespace collapsed (a trusted skill is still untrusted text). */
export function oneLine(text: string): string {
  return redactSecrets(text.replace(TEMPLATE_TOKEN, " ").replace(CONTROL_MARKER, " ")).replace(/\s+/g, " ").trim();
}

/** Whether a user-role message is a per-prompt skill note (never an operator request). */
export function isSkillNote(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(SKILL_NOTE_PREFIX);
}

/**
 * The per-prompt note naming skills whose descriptions fit the operator's message, at most `maxChars` long (""
 * when nothing fits). It advertises descriptions only; it never activates a skill or loads a body.
 */
export function formatSkillNote(matches: Skill[], maxChars: number): string {
  const head = `${SKILL_NOTE_PREFIX} Installed skills that may fit this request. Descriptions only; nothing is activated. Call \`activate_skill\` with a name to load one.\n`;
  const lines = new Map<Skill, string>();
  const line = (s: Skill): string => lines.get(s) ?? (lines.set(s, oneLine(s.description)), lines.get(s)!);
  const fit = (shown: Skill[], per: number) =>
    head + shown.map((s) => `- **${oneLine(s.name)}**: ${line(s).length <= per ? line(s) : `${line(s).slice(0, Math.max(0, per - 1)).trimEnd()}…`}\n`).join("");
  for (let n = matches.length; n > 0; n--) {
    const shown = matches.slice(0, n);
    // Longest uniform description length that fits, down to the bare name.
    let lo = 0;
    let hi = Math.max(...shown.map((s) => line(s).length));
    if (fit(shown, 0).length > maxChars) continue;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fit(shown, mid).length <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    return fit(shown, lo);
  }
  return "";
}

/**
 * The catalog section of a system prompt written by any release: its heading directly followed by the catalog's intro
 * line (workspace rules, placed before the catalog, may quote the heading alone), to the next `###` section or the
 * end, ending after the catalog's own final newline (the blank lines that separate sections are not part of it).
 */
export function findCatalogSpan(content: string): { start: number; end: number } | null {
  const start = content.indexOf(`${SKILL_CATALOG_HEADING}\n${SKILL_CATALOG_INTRO}`);
  if (start < 0) return null;
  const next = content.indexOf("\n### ", start + 1);
  const stop = next < 0 ? content.length : next;
  let end = stop;
  while (end > start && content[end - 1] === "\n") end--;
  return { start, end: Math.min(end + 1, stop) };
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  content: string;
  trusted?: boolean;
  isWorkspaceSkill?: boolean;
}

export interface SkillManagerOptions {
  readOnly?: boolean;
  trusted?: boolean;
}

export class SkillManager {
  private workspace: string;
  private readOnly: boolean;
  private explicitTrusted?: boolean;
  private skills: Map<string, Skill> = new Map();
  private untrustedSkills: Map<string, Skill> = new Map();

  constructor(workspace: string, options: SkillManagerOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.readOnly = Boolean(options.readOnly);
    this.explicitTrusted = options.trusted;
    this.refresh();
  }

  public setWorkspace(workspace: string, options: SkillManagerOptions = {}): void {
    this.workspace = path.resolve(workspace);
    if (options.readOnly !== undefined) this.readOnly = options.readOnly;
    if (options.trusted !== undefined) this.explicitTrusted = options.trusted;
    this.refresh();
  }

  public refresh(): void {
    this.skills.clear();
    this.untrustedSkills.clear();
    this.rankCache = undefined;

    const isTrusted =
      this.explicitTrusted !== undefined
        ? this.explicitTrusted
        : isWorkspaceTrusted(this.workspace, this.readOnly);

    // Real paths already scanned: skill installers link one skill into several agent directories,
    // and a symlink cycle must not recurse forever.
    const visited = new Set<string>();

    // User home locations (always loaded & trusted)
    const homeDirs = [
      path.join(os.homedir(), ".nexus", "skills"),
      path.join(os.homedir(), ".config", "nexus", "skills"),
      // Shared Agent Skills location (`npx skills add -g --agent nexus` installs here)
      path.join(os.homedir(), ".agents", "skills"),
      path.join(os.homedir(), ".config", "opencode", "skills"),
      path.join(os.homedir(), ".claude", "skills"),
    ];

    for (const dir of homeDirs) {
      if (fs.existsSync(dir)) {
        this.scanDir(dir, { isWorkspace: false, trusted: true }, visited);
      }
    }

    // Project workspace locations (gated by workspace trust)
    const workspaceDirs = [
      path.join(this.workspace, ".nexus", "skills"),
      // Shared Agent Skills location (`npx skills add --agent nexus` installs here)
      path.join(this.workspace, ".agents", "skills"),
      path.join(this.workspace, ".claude", "skills"),
      path.join(this.workspace, "skills"),
    ];

    for (const dir of workspaceDirs) {
      if (fs.existsSync(dir)) {
        this.scanDir(dir, { isWorkspace: true, trusted: isTrusted }, visited);
      }
    }
  }

  private scanDir(baseDir: string, context: { isWorkspace: boolean; trusted: boolean }, visited: Set<string>): void {
    try {
      const real = fs.realpathSync(baseDir);
      if (visited.has(real)) return;
      visited.add(real);
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(baseDir, entry.name);
        // Skill installers (e.g. `npx skills add`) link skill directories rather than copy them.
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const target = fs.statSync(fullPath);
            isDirectory = target.isDirectory();
            isFile = target.isFile();
          } catch {
            continue; // dangling link
          }
        }

        if (isDirectory) {
          // Check for SKILL.md inside directory
          const skillFile = path.join(fullPath, "SKILL.md");
          if (fs.existsSync(skillFile)) {
            this.loadSkillFile(skillFile, entry.name, context);
          } else {
            // Also check single-level subdirectories
            this.scanDir(fullPath, context, visited);
          }
        } else if (isFile && entry.name === "SKILL.md") {
          const parentDirName = path.basename(baseDir);
          this.loadSkillFile(fullPath, parentDirName, context);
        } else if (isFile && entry.name.endsWith(".skill.md")) {
          const skillName = entry.name.replace(/\.skill\.md$/, "");
          this.loadSkillFile(fullPath, skillName, context);
        }
      }
    } catch {
      // Ignore permission or read errors
    }
  }

  private loadSkillFile(
    filePath: string,
    fallbackName: string,
    context: { isWorkspace: boolean; trusted: boolean }
  ): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { metadata, body } = this.parseFrontmatter(content);

      const name = metadata.name || fallbackName;
      const description = metadata.description || "Specialized skill instructions";

      const skillItem: Skill = {
        name,
        description,
        path: filePath,
        content: body.trim(),
        trusted: context.trusted,
        isWorkspaceSkill: context.isWorkspace,
      };

      if (context.trusted) {
        if (!this.skills.has(name)) {
          this.skills.set(name, skillItem);
        }
      } else {
        if (!this.untrustedSkills.has(name)) {
          this.untrustedSkills.set(name, skillItem);
        }
      }
    } catch {
      // Ignore corrupted skill files
    }
  }

  /**
   * Reads the top-level scalar keys of a SKILL.md YAML frontmatter block. Only `name` and `description` are used;
   * no other key (e.g. `allowed-tools`) has any effect. Supports plain, quoted, multi-line plain, and block
   * (`|`, `>`, with `-`/`+` chomping) scalars; nested mappings are skipped, never merged into the top level.
   */
  private parseFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split("\n");
    if (lines[0]?.trim() !== "---") {
      return { metadata: {}, body: text };
    }
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (close === -1) {
      return { metadata: {}, body: text };
    }

    const yamlLines = lines.slice(1, close);
    const body = lines.slice(close + 1).join("\n").trim();
    const metadata: Record<string, string> = {};

    for (let i = 0; i < yamlLines.length; i++) {
      const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(yamlLines[i].trimEnd());
      if (!match) continue; // indented (nested or continuation) lines, comments, list items
      const key = match[1];
      let val = (match[2] ?? "").trim();
      const continuation: string[] = [];
      while (i + 1 < yamlLines.length && (/^\s/.test(yamlLines[i + 1]) || yamlLines[i + 1].trim() === "")) {
        continuation.push(yamlLines[++i]);
      }
      const block = /^([|>])([+-]?)$/.exec(val);
      if (block) {
        const indent = Math.min(...continuation.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
        const content = continuation.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).trimEnd());
        while (content.length && content[content.length - 1] === "") content.pop();
        val = block[1] === "|" ? content.join("\n") : content.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
      } else if (val === "" || !/^["'{[]/.test(val)) {
        val = [val, ...continuation.map((l) => l.trim())].filter(Boolean).join(" ");
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      metadata[key] = val;
    }

    return { metadata, body };
  }

  public listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  public listUntrustedSkills(): Skill[] {
    return Array.from(this.untrustedSkills.values());
  }

  public getSkill(name: string): Skill | null {
    return this.skills.get(name) || null;
  }

  /**
   * Trusted skills ranked against free text by a local lexical scorer (BM25 over name and description, the name
   * counted double; no model call, no dependency). Only trusted skills are ever scored: matching advertises a
   * description and nothing else. Returns at most `limit` skills whose score clears a threshold that grows with the
   * number of installed skills and that are within reach of the best match; an unrelated text returns nothing.
   */
  public findSkills(text: string, limit: number = MAX_SKILL_MATCHES): Skill[] {
    const index = this.rankIndex();
    if (!index) return [];
    const query = new Set(tokenize(text.slice(0, MAX_QUERY_CHARS), (w) => index.shortNames.has(w)).slice(0, MAX_QUERY_TERMS));
    if (query.size === 0) return [];
    const { skills, docs, df, avg } = index;
    const N = docs.length;
    const scored = skills.map((skill, i) => {
      const { tf, len } = docs[i];
      let score = 0;
      for (const term of query) {
        const f = tf.get(term);
        if (!f) continue;
        const d = df.get(term) ?? 1;
        const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
        score += (idf * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * len) / avg));
      }
      return { skill, score };
    });
    // The floor never exceeds what one name term found in this skill alone scores at average length (f = 2, d = 1):
    // with one or two skills installed, idf is small and a fixed 0.5 floor would refuse even an exact name.
    const uniqueNameScore = (Math.log(1 + (N - 0.5) / 1.5) * 2 * (BM25_K1 + 1)) / (2 + BM25_K1);
    const threshold = Math.min(Math.max(0.5, Math.min(2, 0.35 * Math.log(N + 1))), uniqueNameScore);
    const best = Math.max(...scored.map((m) => m.score));
    if (best < threshold) return [];
    return scored
      .filter((m) => m.score >= threshold && m.score >= 0.4 * best)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit)
      .map((m) => m.skill);
  }

  private rankCache?: { skills: Skill[]; docs: Array<{ tf: Map<string, number>; len: number }>; df: Map<string, number>; avg: number; shortNames: Set<string> };
  /** The term statistics of the trusted skills, built once per catalog (`refresh` drops it). */
  private rankIndex() {
    if (this.rankCache) return this.rankCache;
    const skills = this.listSkills();
    if (skills.length === 0) return undefined;
    const df = new Map<string, number>();
    // Two-character words that occur in some skill's name: the only short words worth scoring.
    const shortNames = new Set(skills.flatMap((s) => tokenize(s.name, () => true).filter((t) => t.length === 2)));
    const docs = skills.map((s) => {
      const tf = new Map<string, number>();
      for (const t of tokenize(s.name, () => true)) tf.set(t, (tf.get(t) ?? 0) + 2);
      for (const t of tokenize(s.description, (w) => shortNames.has(w))) tf.set(t, (tf.get(t) ?? 0) + 1);
      let len = 0;
      for (const n of tf.values()) len += n;
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      return { tf, len };
    });
    const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;
    return (this.rankCache = { skills, docs, df, avg, shortNames });
  }

  public getUntrustedSkill(name: string): Skill | null {
    return this.untrustedSkills.get(name) || null;
  }

  /**
   * The skill catalog for the system prompt, at most `maxChars` long. Every discovered skill is advertised on every
   * request, so a large install (hundreds of skills under ~/.agents and ~/.claude) must not crowd out the task: when
   * the full listing does not fit, descriptions are shortened, then dropped, then names past the budget are counted.
   * Source and trust stay on the `activate_skill` output either way. The result is never longer than `maxChars`.
   */
  public getPromptSection(maxChars: number = SKILL_CATALOG_MAX_CHARS): string {
    // Workspace skills first: they are the most specific to the task and survive any cut.
    // Names and descriptions as one safe line each (template tokens, control markers and secrets removed), as in the
    // per-prompt note: a description is untrusted text whether or not its skill is trusted.
    const skills = this.listSkills()
      .sort((a, b) => Number(Boolean(b.isWorkspaceSkill)) - Number(Boolean(a.isWorkspaceSkill)))
      .map((s) => ({ ...s, name: oneLine(s.name), description: oneLine(s.description) }));
    if (skills.length === 0) {
      return "";
    }

    const head =
      `${SKILL_CATALOG_HEADING}\n${SKILL_CATALOG_INTRO}` +
      " If a user task matches a skill's description, call the `activate_skill` tool with the skill's name to load its specialized workflows and guidelines into context.\n";

    const full = head + "\n" + skills.map((s) => `- **${s.name}** [source: ${s.path}] [trust: ${s.trusted ? "trusted" : "untrusted"}]: ${s.description}\n`).join("");
    if (full.length <= maxChars) return full;

    const note = `The list below is abbreviated to fit the context window (${skills.length} skills); \`activate_skill\` shows each skill's source and full instructions.\n\n`;
    const clip = (d: string, n: number) => (d.length <= n ? d : `${d.slice(0, Math.max(0, n - 1)).trimEnd()}…`);
    const described = (n: number) => head + note + skills.map((s) => `- **${s.name}**: ${clip(s.description, n)}\n`).join("");

    // Longest uniform description length that fits; below MIN_DESCRIPTION_CHARS a description no longer helps choose.
    let lo = MIN_DESCRIPTION_CHARS;
    let hi = Math.max(...skills.map((s) => s.description.length));
    if (described(lo).length <= maxChars) {
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (described(mid).length <= maxChars) lo = mid;
        else hi = mid - 1;
      }
      return described(lo);
    }

    // Names only, then as many names as fit with a count of the rest.
    const names = skills.map((s) => s.name);
    const listing = (shown: number) =>
      head + note + [...names.slice(0, shown), ...(shown < names.length ? [`…and ${names.length - shown} more (pass words describing the task to \`activate_skill\` to search them)`] : [])].join(", ") + "\n";
    let shown = names.length;
    let result = listing(shown);
    while (shown > 0 && result.length > maxChars) result = listing(--shown);
    // A window too small for even the heading gets no catalog; `activate_skill` still works by name.
    return result.length <= maxChars ? result : "";
  }

  private watchers: fs.FSWatcher[] = [];
  private reloadDebounceTimer: NodeJS.Timeout | null = null;

  public startWatcher(onReload?: (skills: Skill[]) => void): void {
    this.stopWatcher();

    const watchDirs = [
      path.join(this.workspace, ".nexus", "skills"),
      path.join(this.workspace, ".agents", "skills"),
      path.join(this.workspace, "skills"),
      path.join(os.homedir(), ".nexus", "skills"),
      path.join(os.homedir(), ".agents", "skills"),
    ];

    for (const dir of watchDirs) {
      if (fs.existsSync(dir)) {
        try {
          const watcher = fs.watch(dir, { recursive: true }, () => {
            if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
            this.reloadDebounceTimer = setTimeout(() => {
              this.refresh();
              if (onReload) onReload(this.listSkills());
            }, 250);
          });
          this.watchers.push(watcher);
        } catch {
          // Ignore watcher errors
        }
      }
    }
  }

  public stopWatcher(): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }

  public scaffoldSkill(name: string, description?: string, inWorkspace: boolean = true): { skillPath: string; dirPath: string } {
    const targetDir = inWorkspace
      ? path.join(this.workspace, ".nexus", "skills")
      : path.join(os.homedir(), ".nexus", "skills");
    const res = scaffoldSkill(name, description, targetDir);
    this.refresh();
    return res;
  }
}

/**
 * Scaffold a new agent skill directory and SKILL.md template (Candidate #40)
 */
export function scaffoldSkill(
  name: string,
  description: string = "Specialized engineering instructions and workflows",
  targetDir?: string
): { skillPath: string; dirPath: string } {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const baseDir = targetDir || path.join(process.cwd(), ".nexus", "skills");
  const skillDir = path.join(baseDir, cleanName);

  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  const skillFile = path.join(skillDir, "SKILL.md");
  const template = `---
name: ${cleanName}
description: ${description}
---

# ${cleanName} Skill

## Overview
${description}

## Workflows & Instructions
1. Step 1: Analyze context and verify preconditions.
2. Step 2: Apply changes adhering to project conventions.
3. Step 3: Run automated test suite to confirm correctness.

## Guidelines
- Always verify outputs with diagnostic tools.
- Maintain existing codebase comments and formatting.
`;

  fs.writeFileSync(skillFile, template, "utf-8");
  return { skillPath: skillFile, dirPath: skillDir };
}
