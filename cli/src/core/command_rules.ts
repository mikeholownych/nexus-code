/**
 * Operator command rules (CS-9): prefix rules that decide, for a shell command the model wants to run, whether Nexus asks
 * the operator, runs it without asking, or refuses it. Modelled on the data-not-code shape of Codex's `execpolicy`:
 * a three-level outcome (allow < prompt < forbidden), load-time examples that must agree with the rule, and a record of
 * which rule decided.
 *
 *   ~/.config/nexus/command_rules.json (operator home only; a project file is never read)
 *   { "version": 1, "rules": [
 *       { "prefix": ["git", ["status", "log", "diff"]], "decision": "allow", "justification": "read-only git",
 *         "match": ["git status", "git diff --stat"], "notMatch": ["git push"] },
 *       { "prefix": ["git", "push"], "decision": "prompt", "match": ["git push origin main"] },
 *       { "prefix": ["rm", "-rf"], "decision": "forbidden", "justification": "never recursive-delete", "match": ["rm -rf build"] } ] }
 *
 * What a rule can and cannot do:
 * - A rule narrows or widens the *prompt*, never the other controls. Read-only mode, the sandbox, verification-path
 *   protection and the unknown-outcome re-issue gate still apply to a command a rule allows.
 * - `allow` is granted only when every segment of the command (split on `;`, `&&`, `||`, `|`, `&`) matches an allow rule
 *   and the command contains no shell-active character (`$ ` ( ) { } < > * ? !`, a backslash, a newline, or a `~` or `#` that
 *   starts a word) anywhere: a heuristic
 *   never qualifies. A command that cannot be allowed falls back to the normal approval policy.
 * - `prompt` and `forbidden` match any segment, so they cannot be dodged by chaining. Like the destructive-command
 *   tripwire this is a convenience layer, not a sandbox: a command hidden in `$(...)` or a script is not seen, and the
 *   sandbox remains the security boundary.
 * - `forbidden` holds in every mode, including `--yes`. `prompt` holds unless the operator passed `--yes`.
 * - A file that fails to load (bad field, or an example the rules contradict) is refused whole and reported; the normal
 *   approval policy then applies, so a broken file never silently widens or narrows anything.
 */
import fs from "node:fs";
import { splitSubcommands } from "../security.js";

export type RuleDecision = "allow" | "prompt" | "forbidden";

const SEVERITY: Record<RuleDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };
const DECISIONS: readonly RuleDecision[] = ["allow", "prompt", "forbidden"];
const KNOWN_FIELDS = new Set(["prefix", "decision", "justification", "match", "notMatch"]);
const MAX_RULES = 200;
const MAX_PREFIX_TOKENS = 16;
const MAX_EXAMPLES = 20;
const MAX_TEXT = 200;
/** Characters that let a shell run or redirect something this module does not parse. Their presence anywhere blocks `allow`. */
const SHELL_ACTIVE = /[\n\r$`(){}<>*?!\\]|(?:^|\s)[~#]/;

export interface CommandRule {
  /** Position in the file, 1-based, as the operator counts rules. */
  index: number;
  /** One entry per command word; each entry lists the words accepted at that position. */
  prefix: readonly (readonly string[])[];
  decision: RuleDecision;
  justification?: string;
  match: readonly string[];
  notMatch: readonly string[];
}

export interface CommandRuleSet {
  rules: readonly CommandRule[];
  /** Where the rules came from, for the report; absent for an empty set. */
  file?: string;
}

export const NO_COMMAND_RULES: CommandRuleSet = { rules: [] };

/** Which rule decided and what it did to the approval, kept for the session export. */
export interface CommandRuleDecision {
  timestamp: string;
  tool: string;
  /** The command, redacted and truncated. */
  command: string;
  decision: RuleDecision;
  /** What changed: a prompt removed, a prompt added, or the command refused. */
  effect: "allowed without prompt" | "prompted" | "refused";
  rule: number;
  /** Every rule that took part (an allowed chain can involve several). */
  rules: number[];
  prefix: string;
  justification?: string;
}

export interface CommandVerdict {
  decision: RuleDecision;
  /** The rule that decided (the most severe one for prompt/forbidden, the first allow for allow). */
  rule: CommandRule;
  rules: CommandRule[];
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function text(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${field}: required`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${field}: must be a non-empty string of at most ${MAX_TEXT} characters`);
  return value;
}

function parsePrefix(raw: unknown, field: string): (readonly string[])[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PREFIX_TOKENS) throw new Error(`${field}: must be a non-empty array of at most ${MAX_PREFIX_TOKENS} words`);
  return raw.map((entry, i) => {
    const alternatives = Array.isArray(entry) ? entry : [entry];
    if (alternatives.length === 0 || alternatives.length > 16) throw new Error(`${field}[${i}]: a list of alternatives needs 1 to 16 words`);
    return alternatives.map((word, j) => {
      if (typeof word !== "string" || !word || word.length > MAX_TEXT || /\s/.test(word)) throw new Error(`${field}[${i}]${Array.isArray(entry) ? `[${j}]` : ""}: must be a single word with no whitespace`);
      return word;
    });
  });
}

function parseExamples(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_EXAMPLES) throw new Error(`${field}: must be an array of at most ${MAX_EXAMPLES} example commands`);
  return raw.map((example, i) => {
    if (typeof example !== "string" || !example.trim() || example.length > 400) throw new Error(`${field}[${i}]: must be a non-empty command string`);
    return example;
  });
}

function matchesSegment(rule: CommandRule, segment: readonly string[]): boolean {
  if (segment.length < rule.prefix.length) return false;
  return rule.prefix.every((alternatives, i) => alternatives.includes(segment[i]));
}

/**
 * The rules' verdict on a command, or null when no rule applies (the normal approval policy then decides).
 * `forbidden` and `prompt` act on any matching segment; `allow` needs every segment allowed and no shell-active character.
 */
export function decideCommand(set: CommandRuleSet, command: string): CommandVerdict | null {
  if (set.rules.length === 0 || typeof command !== "string" || !command.trim()) return null;
  const segments = splitSubcommands(command);
  if (segments.length === 0) return null;
  let strictest: { decision: RuleDecision; rule: CommandRule } | undefined;
  const perSegment: (CommandRule | undefined)[] = [];
  for (const segment of segments) {
    let allowRule: CommandRule | undefined;
    for (const rule of set.rules) {
      if (!matchesSegment(rule, segment)) continue;
      if (rule.decision === "allow") allowRule ??= rule;
      else if (!strictest || SEVERITY[rule.decision] > SEVERITY[strictest.decision]) strictest = { decision: rule.decision, rule };
    }
    perSegment.push(allowRule);
  }
  if (strictest) {
    const involved = set.rules.filter((r) => segments.some((s) => matchesSegment(r, s)) && SEVERITY[r.decision] === SEVERITY[strictest!.decision]);
    return { decision: strictest.decision, rule: strictest.rule, rules: involved };
  }
  if (!SHELL_ACTIVE.test(command) && perSegment.every((r) => r !== undefined)) {
    const rules = [...new Set(perSegment as CommandRule[])];
    return { decision: "allow", rule: rules[0], rules };
  }
  return null;
}

/** Parses and validates a rules document. Every error names the field. Examples are checked against the whole set. */
export function parseCommandRules(doc: unknown, file?: string): CommandRuleSet {
  if (!isObject(doc)) throw new Error("command_rules.json: must be an object");
  for (const key of Object.keys(doc)) if (key !== "version" && key !== "rules") throw new Error(`command_rules.json.${key}: unknown field`);
  if (doc.version !== 1) throw new Error("command_rules.json.version: must be 1");
  if (!Array.isArray(doc.rules) || doc.rules.length > MAX_RULES) throw new Error(`command_rules.json.rules: must be an array of at most ${MAX_RULES} rules`);
  const rules: CommandRule[] = doc.rules.map((raw, i) => {
    const f = `rules[${i + 1}]`;
    if (!isObject(raw)) throw new Error(`${f}: must be an object`);
    for (const key of Object.keys(raw)) if (!KNOWN_FIELDS.has(key)) throw new Error(`${f}.${key}: unknown field`);
    const decision = raw.decision;
    if (typeof decision !== "string" || !DECISIONS.includes(decision as RuleDecision)) throw new Error(`${f}.decision: must be one of ${DECISIONS.join(", ")}`);
    return {
      index: i + 1,
      prefix: parsePrefix(raw.prefix, `${f}.prefix`),
      decision: decision as RuleDecision,
      justification: text(raw.justification, `${f}.justification`),
      match: parseExamples(raw.match, `${f}.match`),
      notMatch: parseExamples(raw.notMatch, `${f}.notMatch`),
    };
  });
  const set: CommandRuleSet = { rules, ...(file ? { file } : {}) };
  // Examples are the rule's own test: each must agree with what the whole set actually decides.
  for (const rule of rules) {
    rule.match.forEach((example, i) => {
      const verdict = decideCommand(set, example);
      if (!verdict) throw new Error(`rules[${rule.index}].match[${i}]: "${example}" is decided by no rule (an allow rule never covers a command with shell-active characters)`);
      if (verdict.decision !== rule.decision || !verdict.rules.some((r) => r.index === rule.index)) {
        throw new Error(`rules[${rule.index}].match[${i}]: "${example}" is ${verdict.decision} by rule ${verdict.rule.index}, not ${rule.decision} by rule ${rule.index}`);
      }
    });
    rule.notMatch.forEach((example, i) => {
      const verdict = decideCommand(set, example);
      if (verdict?.rules.some((r) => r.index === rule.index)) throw new Error(`rules[${rule.index}].notMatch[${i}]: "${example}" is ${verdict.decision} by this rule, but is listed as not matching`);
    });
  }
  return set;
}

/** Reads the operator's rules file. A missing file is an empty set; an unreadable or invalid one throws with the reason. */
export function readCommandRulesFile(file: string): CommandRuleSet {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return NO_COMMAND_RULES;
    throw new Error(`command_rules.json: cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`command_rules.json: ${file} is not valid JSON`);
  }
  return parseCommandRules(parsed, file);
}

export function describePrefix(rule: CommandRule): string {
  return rule.prefix.map((alternatives) => (alternatives.length === 1 ? alternatives[0] : `(${alternatives.join("|")})`)).join(" ");
}
