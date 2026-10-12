/**
 * Recorded findings under memory pressure, and tool output that shows only part of what it covered.
 *
 * Findings are the model's notes on inspected output that compaction removed (see AutonomousAgent.recordFindings).
 * Their full text is kept for the conversation and persisted with it. The durable record shows each finding in full,
 * condensed (every claim's start, and what the claims it cannot show mention), or only indexed (what it mentions), and
 * names by id those it does not show; `read_findings` returns any of them in full. Nothing leaves the memory without
 * the memory saying so and saying how to get it back.
 *
 * Output cut short by a limit (a `head`/`tail` in a command, file_tree's depth, a search's result cap) says so before
 * it is shown, because what it does not show may still exist: such output cannot establish that something is absent.
 */
import type { CanonicalCapability } from "./capabilities.js";

/** Id of a finding recorded by this version ("F12"); findings lifted from older records have none. */
const FINDING_ID = /^Findings recorded from inspected output \[(F\d+); step \d+;/;
/** The end of a copy an earlier version shortened; its full text was never kept. */
const LEGACY_SHORTENED = " …[shortened to fit this memory]";
const CONDENSED_MARK = "[Condensed to fit this memory: ";
const INDEXED_MARK = "[Indexed only, to fit this memory: ";
/** Characters a condensed finding's claims may take, and the least each shown claim keeps. */
const CONDENSED_CLAIMS_CHARS = 640;
const CONDENSED_CLAIM_MIN = 90;
const MENTIONS_CHARS = 320;
const ELIDED_MENTIONS_CHARS = 900;
const READ_FINDINGS_CHARS = 16_000;
const HEADER_SOURCES_CHARS = 200;

export function findingId(note: string): string | undefined {
  return FINDING_ID.exec(note)?.[1];
}

function headerAndBody(note: string): [string, string] {
  const newline = note.indexOf("\n");
  return newline < 0 ? [note, ""] : [note.slice(0, newline), note.slice(newline + 1)];
}

/** Whether a findings note is shown condensed or only indexed (not in full). */
export function isCondensedFinding(note: string): boolean {
  const body = headerAndBody(note)[1];
  return body.startsWith(CONDENSED_MARK) || body.startsWith(INDEXED_MARK) || body.endsWith(LEGACY_SHORTENED);
}

export function isIndexedFinding(note: string): boolean {
  return headerAndBody(note)[1].startsWith(INDEXED_MARK);
}

/** The separate statements of a finding: its lines, and the sentences of long lines, without list markers. */
export function claimsOf(body: string): string[] {
  return body
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.;!?])\s+(?=[A-Z`"'(\[*-])/))
    .map((claim) => claim.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

/**
 * What a text refers to: paths (with line numbers), file names, `code spans`, and compound identifiers
 * (camelCase, PascalCase, snake_case, kebab-case), in first-mention order, cut to `limit` characters. Texts given as
 * several parts are read in order, only as far as the limit needs.
 */
export function mentionsOf(text: string | Iterable<string>, limit = MENTIONS_CHARS): string {
  const pattern = /`([^`\n]{2,80})`|((?:[\w.-]+\/)+[\w.-]+(?::\d+(?:[-–]\d+)?)?)|(\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|rs|md|json|toml|sh|py|ya?ml|lock)(?::\d+(?:[-–]\d+)?)?\b)|(\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b)/g;
  const seen = new Set<string>();
  let out = "";
  for (const part of typeof text === "string" ? [text] : text) {
    for (const match of part.matchAll(pattern)) {
      const term = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim().replace(/[.,;:)]+$/, "");
      if (term.length < 3 || seen.has(term)) continue;
      seen.add(term);
      const next = out ? `${out}, ${term}` : term;
      if (next.length > limit) return `${out}, …`;
      out = next;
    }
  }
  return out;
}

function claimStart(claim: string, chars: number): string {
  if (claim.length <= chars) return claim;
  const space = claim.lastIndexOf(" ", chars - 1);
  return `${claim.slice(0, space > chars / 2 ? space : chars - 1)}…`;
}

/**
 * A header whose list of sources is cut, for a finding not shown in full; read_findings returns it with its header
 * whole. A finding without an id keeps its header: nothing else lists its sources.
 */
function shortHeader(header: string): string {
  const from = header.indexOf("; from ");
  const label = header.lastIndexOf("; model-written");
  if (!FINDING_ID.test(header) || from < 0 || label < from) return header;
  const sources = header.slice(from + "; from ".length, label);
  if (sources.length <= HEADER_SOURCES_CHARS) return header;
  return `${header.slice(0, from + "; from ".length)}${claimStart(sources, HEADER_SOURCES_CHARS)} (more sources in its full text)${header.slice(label)}`;
}

function recovery(note: string): string {
  const id = findingId(note);
  if (!id) return "recorded in an earlier session; its full text is not kept";
  return note.endsWith(LEGACY_SHORTENED)
    ? `shortened in an earlier session, its full text not kept; read_findings {"id":"${id}"} returns what is`
    : `full text: read_findings {"id":"${id}"}`;
}

/**
 * A finding condensed to the start of every claim it makes, as many as fit, and what the claims it cannot show
 * mention, with how to get its full text. A finding already condensed or indexed is returned as it is.
 */
export function condenseFinding(note: string): string {
  const [header, body] = headerAndBody(note);
  if (isCondensedFinding(note)) return note;
  const claims = claimsOf(body);
  const each = Math.max(CONDENSED_CLAIM_MIN, Math.floor(CONDENSED_CLAIMS_CHARS / Math.max(1, claims.length)));
  const shown: string[] = [];
  let used = 0;
  for (const claim of claims) {
    const start = claimStart(claim, each);
    if (shown.length && used + start.length > CONDENSED_CLAIMS_CHARS) break;
    shown.push(start);
    used += start.length + 3;
  }
  const cut = shown.filter((start, index) => start !== claims[index]).length;
  const hidden = claims.slice(shown.length);
  const parts = [`${claims.length} claim${claims.length === 1 ? "" : "s"}`];
  if (cut) parts.push(`${cut} cut to ${cut === 1 ? "its" : "their"} start`);
  if (hidden.length) parts.push(`${hidden.length} not shown`);
  const lines = [`${CONDENSED_MARK}${parts.join(", ")}; ${recovery(note)}]`, ...shown.map((start) => `- ${start}`)];
  if (hidden.length) lines.push(`Claims not shown mention: ${mentionsOf(hidden.join("\n")) || "(no paths or symbols)"}`);
  return `${shortHeader(header)}\n${lines.join("\n")}`;
}

/** A finding reduced to what it mentions, with how to get its full text. */
export function indexFinding(note: string): string {
  const [header, body] = headerAndBody(note);
  if (isIndexedFinding(note)) return note;
  const text = body.startsWith(CONDENSED_MARK) ? body.slice(body.indexOf("\n") + 1) : body;
  const claims = claimsOf(text);
  return `${shortHeader(header)}\n${INDEXED_MARK}${claims.length} claim${claims.length === 1 ? "" : "s"} not shown; ${recovery(note)}. It mentions: ${mentionsOf(text) || "(no paths or symbols)"}]`;
}

function idRanges(ids: string[]): string {
  const numbers = ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    ranges.push(j > i ? `F${numbers[i]}–F${numbers[j]}` : `F${numbers[i]}`);
    i = j;
  }
  return ranges.join(", ");
}

/** The one note naming the findings the record does not show: their ids, what they mention, and how to read them. */
export function elidedFindingsNote(notes: string[]): string {
  const ids = notes.filter((note) => !note.endsWith(LEGACY_SHORTENED)).map(findingId).filter((id): id is string => Boolean(id));
  const shortened = notes.filter((note) => note.endsWith(LEGACY_SHORTENED)).map(findingId).filter((id): id is string => Boolean(id));
  const unkept = notes.length - ids.length - shortened.length;
  const parts: string[] = [];
  if (ids.length) parts.push(`${ids.length} (${idRanges(ids)}), whose full text is kept: read_findings {"id":"${ids[0]}"} returns one, {"query":"…"} searches all`);
  if (shortened.length) parts.push(`${shortened.length} (${idRanges(shortened)}) shortened in an earlier session, whose full text is not kept (read_findings returns what is)`);
  if (unkept) parts.push(`${unkept} recorded in an earlier session, whose full text is not kept`);
  const mentions = mentionsOf((function* () {
    for (const note of notes) yield headerAndBody(note)[1];
  })(), ELIDED_MENTIONS_CHARS);
  return `${ELIDED_FINDINGS_PREFIX}${parts.join("; ")}. They mention: ${mentions || "(no paths or symbols)"}]`;
}

export const ELIDED_FINDINGS_PREFIX = "[Nexus: recorded findings not shown here, to bound this memory: ";

/**
 * `read_findings`: the full text of recorded findings. Agent-level, read-only; it reads the conversation's memory, not
 * the workspace, so a search that matches nothing shows only that no recorded finding mentions the term.
 */
export const READ_FINDINGS_CAPABILITY: CanonicalCapability = {
  id: "orchestrate_read_findings",
  modelToolName: "read_findings",
  category: "orchestration",
  mutating: false,
  sideEffectContract: "Read findings recorded in this conversation (no workspace change)",
  backend: "ts_native",
  toolDefinition: {
    type: "function",
    function: {
      name: "read_findings",
      description:
        "Your recorded findings in full: one by id, those containing a query, or a list. Use it for findings your memory shows condensed or by id, and before claiming something is absent.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "e.g. F12" },
          query: { type: "string", description: "Case-insensitive text" },
        },
      },
    },
  },
} as CanonicalCapability;

/** What read_findings returns for `args` from `store` (full findings, oldest first). */
export function readFindings(store: readonly string[], args: { id?: unknown; query?: unknown }): { ok: boolean; text: string } {
  if (!store.length) return { ok: true, text: "No findings have been recorded in this conversation." };
  const fit = (blocks: string[], total: number, what: string) => {
    let text = "";
    let shown = 0;
    for (const block of blocks) {
      if (text && text.length + block.length > READ_FINDINGS_CHARS) break;
      text += `${text ? "\n\n" : ""}${block}`;
      shown++;
    }
    const rest = total - shown;
    return rest ? `${text}\n\n[${rest} more ${what} not shown here for space; ask for them by id.]` : text;
  };
  if (typeof args.id === "string" && args.id.trim()) {
    const wanted = args.id.trim().toUpperCase();
    const note = store.find((candidate) => findingId(candidate) === wanted);
    if (!note) return { ok: false, text: `No finding ${args.id}; recorded: ${idRanges(store.map(findingId).filter((id): id is string => Boolean(id))) || "none with ids"}.` };
    return { ok: true, text: note };
  }
  if (typeof args.query === "string" && args.query.trim()) {
    const query = args.query.trim().toLowerCase();
    const matches = store.filter((note) => note.toLowerCase().includes(query));
    if (!matches.length) {
      return { ok: true, text: `No recorded finding mentions "${args.query}". This searches only the findings recorded in this conversation, not the workspace: it does not show that the workspace lacks it.` };
    }
    return { ok: true, text: fit(matches, matches.length, "matching findings") };
  }
  const list = store.map((note) => {
    const [header, body] = headerAndBody(note);
    const claims = claimsOf(body);
    const label = header.slice(header.indexOf("[") + 1, header.indexOf("; from "));
    return `${findingId(note) ? "" : "(no id) "}${label}: ${claimStart(claims[0] ?? "", 140)} (${claims.length} claims, ${body.length} chars)`;
  });
  return { ok: true, text: fit(list, list.length, "findings") };
}

// -------------------------------------------------------------
// Output cut short by a limit
// -------------------------------------------------------------

const SEARCH_TOOLS = new Set(["search_code", "find_files", "search_symbols", "trigram_search"]);
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_TREE_DEPTH = 3;
/** The markers foldVoluminousOutput leaves where it cut or folded an output. */
const OUTPUT_CUT = "\n... [TRUNCATED]";
const OUTPUT_FOLDED = /\n\.\.\. \[\d+ lines folded for local context optimization\] \.\.\.\n/;

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Lines of output limiters in a shell command: `| head -20`, `| head -n 20`, `| tail -5`, `| head` (10). `| tail -n +5`
 * prints everything from a line on, so it is not one.
 */
function outputLimits(command: string): Array<{ text: string; lines: number }> {
  const limits: Array<{ text: string; lines: number }> = [];
  for (const match of command.matchAll(/\|\s*(head|tail)\b([^|;&\n)]*)/g)) {
    const options = match[2];
    if (/(^|\s)-c\b|--bytes/.test(options)) continue;
    if (match[1] === "tail" && /(?:-n\s*|--lines[= ]|^\s*|\s)\+\d/.test(options)) continue;
    const count = /(?:-n\s*|--lines[= ])\+?(\d+)|(?:^|\s)-(\d+)\b/.exec(options);
    const lines = count ? Number(count[1] ?? count[2]) : 10;
    limits.push({ text: `${match[1]}${options.replace(/\s+$/, "")}`.trim(), lines });
  }
  return limits;
}

/** Lines a run_command result printed on stdout (a lower bound when the result was itself cut). */
function stdoutLines(content: string): number | undefined {
  const parsed = parseJson(content);
  if (parsed && typeof parsed.stdout === "string") return parsed.stdout.split("\n").filter((line: string, index: number, all: string[]) => line || index < all.length - 1).length;
  const raw = /"stdout":\s*"((?:[^"\\]|\\.)*)/.exec(content)?.[1];
  return raw === undefined ? undefined : raw.split("\\n").filter(Boolean).length;
}

/**
 * The note an output cut short by a limit gets before it is shown, or undefined. It is derived from the output and the
 * call alone, so the same call with the same output always gets the same note.
 */
export function incompleteOutputNotice(toolName: string, args: any, content: string): string | undefined {
  if (toolName === "run_command" || toolName === "run_tests") {
    const cuts: string[] = [];
    const limits = toolName === "run_command" && typeof args?.command === "string" ? outputLimits(args.command) : [];
    const printed = limits.length ? stdoutLines(content) : undefined;
    const reached = printed === undefined ? [] : limits.filter((limit) => printed >= limit.lines);
    if (reached.length) {
      const limit = reached.reduce((least, candidate) => (candidate.lines < least.lines ? candidate : least));
      cuts.push(`the command limits what it prints (\`${limit.text}\`) and printed at least ${limit.lines} lines`);
    }
    if (content.endsWith(OUTPUT_CUT) || OUTPUT_FOLDED.test(content)) cuts.push("its output was cut to fit (see the [TRUNCATED] or folded marker)");
    if (!cuts.length) return undefined;
    return `[Nexus: this output may be incomplete: ${cuts.join("; and ")}. Anything it does not show may still exist: do not take a missing match here as absence; narrow the command, or run it without the limit, to settle it.]`;
  }
  if (toolName === "file_tree") {
    const parsed = parseJson(content);
    if (!parsed || typeof parsed.tree !== "string") return undefined;
    const depth = Number.isFinite(Number(args?.max_depth)) && Number(args?.max_depth) > 0 ? Number(args.max_depth) : DEFAULT_TREE_DEPTH;
    const unlisted = parsed.tree.split("\n").filter((line: string) => {
      const branch = line.indexOf("── ");
      return branch >= 0 && line.endsWith("/") && (branch + 3) / 4 - 1 === depth - 1;
    }).length;
    if (!unlisted) return undefined;
    return `[Nexus: file_tree stops at max_depth ${depth}: the contents of ${unlisted} director${unlisted === 1 ? "y" : "ies"} at that depth are not listed, and ignored and hidden files never are. total_files (${parsed.total_files}) and total_directories count only what is listed here, not the files in the workspace or in git.]`;
  }
  if (SEARCH_TOOLS.has(toolName)) {
    const parsed = parseJson(content);
    const cap = Number.isFinite(Number(args?.max_results)) && Number(args?.max_results) > 0 ? Number(args.max_results) : DEFAULT_MAX_RESULTS;
    if (!parsed || typeof parsed.total_matches !== "number" || parsed.total_matches < cap) return undefined;
    return `[Nexus: this search stopped at its limit of ${cap} results: total_matches (${parsed.total_matches}) counts only what is shown, and more matches may exist. Do not take a missing match here as absence; narrow the search or raise max_results.]`;
  }
  return undefined;
}
