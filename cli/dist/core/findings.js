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
export function findingId(note) {
    return FINDING_ID.exec(note)?.[1];
}
function headerAndBody(note) {
    const newline = note.indexOf("\n");
    return newline < 0 ? [note, ""] : [note.slice(0, newline), note.slice(newline + 1)];
}
/** Whether a findings note is shown condensed or only indexed (not in full). */
export function isCondensedFinding(note) {
    const body = headerAndBody(note)[1];
    return body.startsWith(CONDENSED_MARK) || isIndexedBody(body) || body.endsWith(LEGACY_SHORTENED);
}
/** An indexed body: the marker, optionally after the finding's first claim. */
function isIndexedBody(body) {
    return body.startsWith(INDEXED_MARK) || (body.startsWith("First claim: ") && body.includes(`\n${INDEXED_MARK}`));
}
export function isIndexedFinding(note) {
    return isIndexedBody(headerAndBody(note)[1]);
}
/** The separate statements of a finding: its lines, and the sentences of long lines, without list markers. */
export function claimsOf(body) {
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
export function mentionsOf(text, limit = MENTIONS_CHARS) {
    const pattern = /`([^`\n]{2,80})`|((?:[\w.-]+\/)+[\w.-]+(?::\d+(?:[-–]\d+)?)?)|(\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|rs|md|json|toml|sh|py|ya?ml|lock)(?::\d+(?:[-–]\d+)?)?\b)|(\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b)/g;
    const seen = new Set();
    let out = "";
    for (const part of typeof text === "string" ? [text] : text) {
        for (const match of part.matchAll(pattern)) {
            const term = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim().replace(/[.,;:)]+$/, "");
            if (term.length < 3 || seen.has(term))
                continue;
            seen.add(term);
            const next = out ? `${out}, ${term}` : term;
            if (next.length > limit)
                return `${out}, …`;
            out = next;
        }
    }
    return out;
}
function claimStart(claim, chars) {
    if (claim.length <= chars)
        return claim;
    const space = claim.lastIndexOf(" ", chars - 1);
    return `${claim.slice(0, space > chars / 2 ? space : chars - 1)}…`;
}
/**
 * A header whose list of sources is cut, for a finding not shown in full; read_findings returns it with its header
 * whole. A finding without an id keeps its header: nothing else lists its sources.
 */
function shortHeader(header) {
    const from = header.indexOf("; from ");
    const label = header.lastIndexOf("; model-written");
    if (!FINDING_ID.test(header) || from < 0 || label < from)
        return header;
    const sources = header.slice(from + "; from ".length, label);
    if (sources.length <= HEADER_SOURCES_CHARS)
        return header;
    return `${header.slice(0, from + "; from ".length)}${claimStart(sources, HEADER_SOURCES_CHARS)} (more sources in its full text)${header.slice(label)}`;
}
function recovery(note) {
    const id = findingId(note);
    if (!id)
        return "recorded in an earlier session; its full text is not kept";
    return note.endsWith(LEGACY_SHORTENED)
        ? `shortened in an earlier session, its full text not kept; read_findings {"id":"${id}"} returns what is`
        : `full text: read_findings {"id":"${id}"}`;
}
/**
 * A finding condensed to the start of every claim it makes, as many as fit, and what the claims it cannot show
 * mention, with how to get its full text. A finding already condensed or indexed is returned as it is.
 */
export function condenseFinding(note) {
    const [header, body] = headerAndBody(note);
    if (isCondensedFinding(note))
        return note;
    const claims = claimsOf(body);
    const each = Math.max(CONDENSED_CLAIM_MIN, Math.floor(CONDENSED_CLAIMS_CHARS / Math.max(1, claims.length)));
    const shown = [];
    let used = 0;
    for (const claim of claims) {
        const start = claimStart(claim, each);
        if (shown.length && used + start.length > CONDENSED_CLAIMS_CHARS)
            break;
        shown.push(start);
        used += start.length + 3;
    }
    const cut = shown.filter((start, index) => start !== claims[index]).length;
    const hidden = claims.slice(shown.length);
    const parts = [`${claims.length} claim${claims.length === 1 ? "" : "s"}`];
    if (cut)
        parts.push(`${cut} cut to ${cut === 1 ? "its" : "their"} start`);
    if (hidden.length)
        parts.push(`${hidden.length} not shown`);
    const lines = [`${CONDENSED_MARK}${parts.join(", ")}; ${recovery(note)}]`, ...shown.map((start) => `- ${start}`)];
    if (hidden.length)
        lines.push(`Claims not shown mention: ${mentionsOf(hidden.join("\n")) || "(no paths or symbols)"}`);
    return `${shortHeader(header)}\n${lines.join("\n")}`;
}
/** Characters of a finding's first claim its indexed form keeps (CTX-07: what it says, not only what it names). */
const INDEXED_CLAIM_CHARS = 240;
/** A finding reduced to its first claim and what it mentions, with how to get its full text. */
export function indexFinding(note) {
    const [header, body] = headerAndBody(note);
    if (isIndexedFinding(note))
        return note;
    const text = body.startsWith(CONDENSED_MARK) ? body.slice(body.indexOf("\n") + 1) : body;
    const claims = claimsOf(text).map((claim) => claim.replace(/^- /, ""));
    const first = claims.length ? claimStart(claims[0], INDEXED_CLAIM_CHARS) : "";
    const rest = claims.length - (first ? 1 : 0);
    const head = first ? `First claim: ${first}\n` : "";
    return `${shortHeader(header)}\n${head}${INDEXED_MARK}${rest} more claim${rest === 1 ? "" : "s"} not shown; ${recovery(note)}. It mentions: ${mentionsOf(text) || "(no paths or symbols)"}]`;
}
function idRanges(ids) {
    const numbers = ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b);
    const ranges = [];
    for (let i = 0; i < numbers.length; i++) {
        let j = i;
        while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1)
            j++;
        ranges.push(j > i ? `F${numbers[i]}–F${numbers[j]}` : `F${numbers[i]}`);
        i = j;
    }
    return ranges.join(", ");
}
/** The one note naming the findings the record does not show: their ids, what they mention, and how to read them. */
export function elidedFindingsNote(notes) {
    const ids = notes.filter((note) => !note.endsWith(LEGACY_SHORTENED)).map(findingId).filter((id) => Boolean(id));
    const shortened = notes.filter((note) => note.endsWith(LEGACY_SHORTENED)).map(findingId).filter((id) => Boolean(id));
    const unkept = notes.length - ids.length - shortened.length;
    const parts = [];
    if (ids.length)
        parts.push(`${ids.length} (${idRanges(ids)}), whose full text is kept: read_findings {"id":"${ids[0]}"} returns one, {"query":"…"} searches all`);
    if (shortened.length)
        parts.push(`${shortened.length} (${idRanges(shortened)}) shortened in an earlier session, whose full text is not kept (read_findings returns what is)`);
    if (unkept)
        parts.push(`${unkept} recorded in an earlier session, whose full text is not kept`);
    const mentions = mentionsOf((function* () {
        for (const note of notes)
            yield headerAndBody(note)[1];
    })(), ELIDED_MENTIONS_CHARS);
    return `${ELIDED_FINDINGS_PREFIX}${parts.join("; ")}. They mention: ${mentions || "(no paths or symbols)"}]`;
}
export const ELIDED_FINDINGS_PREFIX = "[Nexus: recorded findings not shown here, to bound this memory: ";
/**
 * `read_findings`: the full text of recorded findings. Agent-level, read-only; it reads the conversation's memory, not
 * the workspace, so a search that matches nothing shows only that no recorded finding mentions the term.
 */
export const READ_FINDINGS_CAPABILITY = {
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
            description: "Your recorded findings in full: one by id, those containing a query, or a list. Use it for findings your memory shows condensed or by id, and before claiming something is absent.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "e.g. F12" },
                    query: { type: "string", description: "Case-insensitive text" },
                },
            },
        },
    },
};
export const READ_ARCHIVE_CAPABILITY = {
    id: "orchestrate_read_archive",
    modelToolName: "read_archive",
    category: "orchestration",
    mutating: false,
    sideEffectContract: "Search the messages context compaction replaced in this conversation (no workspace change)",
    backend: "ts_native",
    toolDefinition: {
        type: "function",
        function: {
            name: "read_archive",
            description: "Search the earlier conversation that left your context when it was compacted (tool outputs, replies, requests). Returns the matching passages verbatim. Use it when a detail you need is no longer in your memory or findings.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Case-insensitive text to find" },
                },
                required: ["query"],
            },
        },
    },
};
const READ_ARCHIVE_CHARS = 12_000;
const ARCHIVE_PASSAGE_CHARS = 1_200;
/** What read_archive returns for `args` from the archived (compacted-away) messages, oldest first. */
export function readArchive(archive, args) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query)
        return { ok: false, text: "read_archive needs a query." };
    if (!archive.length)
        return { ok: true, text: "Nothing has been compacted out of this conversation: everything is still in your context." };
    const needle = query.toLowerCase();
    const passages = [];
    let total = 0;
    archive.forEach((message, index) => {
        const raw = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
        const calls = (message.tool_calls ?? []).map((call) => `${call.function.name} ${call.function.arguments ?? ""}`).join("\n");
        const text = calls ? `${raw}\n${calls}`.trim() : raw;
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0)
            return;
        total++;
        const start = Math.max(0, at - ARCHIVE_PASSAGE_CHARS / 2);
        const passage = text.slice(start, start + ARCHIVE_PASSAGE_CHARS);
        const who = message.role === "tool" ? `tool ${message.name ?? ""}`.trim() : message.role;
        passages.push(`[#${index + 1} ${who}]${start > 0 ? " …" : ""}${passage}${start + ARCHIVE_PASSAGE_CHARS < text.length ? "…" : ""}`);
    });
    if (!total)
        return { ok: true, text: `No archived message contains "${query}" (${archive.length} archived messages searched). That is not evidence it never existed outside this conversation.` };
    let text = "";
    let shown = 0;
    for (const passage of passages) {
        if (text && text.length + passage.length > READ_ARCHIVE_CHARS)
            break;
        text += `${text ? "\n\n" : ""}${passage}`;
        shown++;
    }
    const more = total - shown;
    return { ok: true, text: `${total} archived message${total === 1 ? "" : "s"} contain "${query}"${more ? `; showing the first ${shown} (narrow the query to see the rest)` : ""}:\n\n${text}` };
}
/** What read_findings returns for `args` from `store` (full findings, oldest first). */
export function readFindings(store, args) {
    if (!store.length) {
        // An id the memory names but the store does not have was lost (e.g. a save failed before a restart): say so,
        // rather than suggesting it was never recorded.
        if (typeof args.id === "string" && /^F\d+$/.test(args.id.trim())) {
            return { ok: false, text: `${args.id.trim()} is named in your memory but its full text is not kept in this session (it was lost, for example when a save failed before a restart). Do not rely on it: re-establish the fact from the source if you need it.` };
        }
        return { ok: true, text: "No findings have been recorded in this conversation." };
    }
    const fit = (blocks, total, what) => {
        let text = "";
        let shown = 0;
        for (const block of blocks) {
            if (text && text.length + block.length > READ_FINDINGS_CHARS)
                break;
            text += `${text ? "\n\n" : ""}${block}`;
            shown++;
        }
        const rest = total - shown;
        return rest ? `${text}\n\n[${rest} more ${what} not shown here for space; ask for them by id.]` : text;
    };
    if (typeof args.id === "string" && args.id.trim()) {
        const wanted = args.id.trim().toUpperCase();
        const note = store.find((candidate) => findingId(candidate) === wanted);
        if (!note)
            return { ok: false, text: `No finding ${args.id}; recorded: ${idRanges(store.map(findingId).filter((id) => Boolean(id))) || "none with ids"}.` };
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
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/**
 * Lines of output limiters in a shell command: `| head -20`, `| head -n 20`, `| tail -5`, `| head` (10); `grep -m N` /
 * `--max-count`; `sed -n 'A,Bp'`, `sed -n 'Np'`, `sed Nq`; `awk 'NR<=N'` (also `NR<N`, `NR==N`, `NR>=A && NR<=B`).
 * `| tail -n +5` prints everything from a line on, so it is not one.
 */
function outputLimits(command) {
    const limits = [];
    for (const match of command.matchAll(/\b(?:e|f)?grep\b[^|;&\n]*?(?:\s-m\s*(\d+)|\s--max-count[= ](\d+)|\s-[a-zA-Z]*m(\d+))/g)) {
        limits.push({ text: match[0].trim(), lines: Number(match[1] ?? match[2] ?? match[3]) });
    }
    for (const match of command.matchAll(/\bsed\s+(?:-[a-zA-Z]*n[a-zA-Z]*\s+)['"]?(\d+)(?:,(\d+))?p['"]?/g)) {
        const first = Number(match[1]);
        const last = match[2] === undefined ? first : Number(match[2]);
        limits.push({ text: match[0].trim(), lines: Math.max(1, last - first + 1) });
    }
    for (const match of command.matchAll(/\bsed\s+['"]?(\d+)q['"]?/g)) {
        limits.push({ text: match[0].trim(), lines: Number(match[1]) });
    }
    for (const match of command.matchAll(/\bawk\s+['"]([^'"]*\bNR\s*(?:<=|<|==)\s*\d+[^'"]*)['"]/g)) {
        const program = match[1];
        const upper = /\bNR\s*(<=|<|==)\s*(\d+)/.exec(program);
        const lower = /\bNR\s*(>=|>)\s*(\d+)/.exec(program);
        const last = upper[1] === "<" ? Number(upper[2]) - 1 : Number(upper[2]);
        const first = upper[1] === "==" ? last : lower ? (lower[1] === ">" ? Number(lower[2]) + 1 : Number(lower[2])) : 1;
        limits.push({ text: match[0].trim(), lines: Math.max(1, last - first + 1) });
    }
    for (const match of command.matchAll(/\|\s*(head|tail)\b([^|;&\n)]*)/g)) {
        const options = match[2];
        if (/(^|\s)-c\b|--bytes/.test(options))
            continue;
        if (match[1] === "tail" && /(?:-n\s*|--lines[= ]|^\s*|\s)\+\d/.test(options))
            continue;
        const count = /(?:-n\s*|--lines[= ])\+?(\d+)|(?:^|\s)-(\d+)\b/.exec(options);
        const lines = count ? Number(count[1] ?? count[2]) : 10;
        limits.push({ text: `${match[1]}${options.replace(/\s+$/, "")}`.trim(), lines });
    }
    return limits;
}
/** Lines a run_command result printed on stdout (a lower bound when the result was itself cut). */
function stdoutLines(content) {
    const parsed = parseJson(content);
    if (parsed && typeof parsed.stdout === "string")
        return parsed.stdout.split("\n").filter((line, index, all) => line || index < all.length - 1).length;
    const raw = /"stdout":\s*"((?:[^"\\]|\\.)*)/.exec(content)?.[1];
    return raw === undefined ? undefined : raw.split("\\n").filter(Boolean).length;
}
/**
 * The note an output cut short by a limit gets before it is shown, or undefined. It is derived from the output and the
 * call alone, so the same call with the same output always gets the same note.
 */
export function incompleteOutputNotice(toolName, args, content) {
    if (toolName === "run_command" || toolName === "run_tests") {
        const cuts = [];
        const limits = toolName === "run_command" && typeof args?.command === "string" ? outputLimits(args.command) : [];
        const printed = limits.length ? stdoutLines(content) : undefined;
        const reached = printed === undefined ? [] : limits.filter((limit) => printed >= limit.lines);
        if (reached.length) {
            const limit = reached.reduce((least, candidate) => (candidate.lines < least.lines ? candidate : least));
            cuts.push(`the command limits what it prints (\`${limit.text}\`) and printed at least ${limit.lines} lines`);
        }
        if (content.endsWith(OUTPUT_CUT) || OUTPUT_FOLDED.test(content))
            cuts.push("its output was cut to fit (see the [TRUNCATED] or folded marker)");
        if (!cuts.length)
            return undefined;
        return `[Nexus: this output may be incomplete: ${cuts.join("; and ")}. Anything it does not show may still exist: do not take a missing match here as absence; narrow the command, or run it without the limit, to settle it.]`;
    }
    if (toolName === "file_tree") {
        const parsed = parseJson(content);
        if (!parsed || typeof parsed.tree !== "string")
            return undefined;
        const depth = Number.isFinite(Number(args?.max_depth)) && Number(args?.max_depth) > 0 ? Number(args.max_depth) : DEFAULT_TREE_DEPTH;
        const unlisted = parsed.tree.split("\n").filter((line) => {
            const branch = line.indexOf("── ");
            return branch >= 0 && line.endsWith("/") && (branch + 3) / 4 - 1 === depth - 1;
        }).length;
        if (!unlisted)
            return undefined;
        return `[Nexus: file_tree stops at max_depth ${depth}: the contents of ${unlisted} director${unlisted === 1 ? "y" : "ies"} at that depth are not listed, and ignored and hidden files never are. total_files (${parsed.total_files}) and total_directories count only what is listed here, not the files in the workspace or in git.]`;
    }
    if (SEARCH_TOOLS.has(toolName)) {
        const parsed = parseJson(content);
        const cap = Number.isFinite(Number(args?.max_results)) && Number(args?.max_results) > 0 ? Number(args.max_results) : DEFAULT_MAX_RESULTS;
        if (!parsed || typeof parsed.total_matches !== "number" || parsed.total_matches < cap)
            return undefined;
        return `[Nexus: this search stopped at its limit of ${cap} results: total_matches (${parsed.total_matches}) counts only what is shown, and more matches may exist. Do not take a missing match here as absence; narrow the search or raise max_results.]`;
    }
    return undefined;
}
