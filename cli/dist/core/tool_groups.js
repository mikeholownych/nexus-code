/**
 * Tools offered to the model only when a task needs them. Every request carries every offered tool's schema (36 built-in
 * tools were ~5.2K tokens, 88 % of a first prompt); these groups are rarely used in coding tasks. A group is offered once
 * the operator's request mentions it, the model asks for it with enable_tools, or the model calls one of its tools
 * (hidden tools still execute: dispatch resolves tools from the registry, not from the offered list). Once offered, a
 * group stays for the conversation, so the provider's prompt cache is broken at most once per group.
 */
export const TOOL_GROUPS = {
    browser: {
        tools: ["browser_navigate", "browser_click", "browser_type", "browser_screenshot", "browser_console_logs"],
        summary: "drive a headless browser: open a page, click, type, screenshot, read console logs",
        trigger: /\b(browser|web ?page|screenshots?|localhost|front-?end|playwright)\b/i,
    },
    lsp: {
        tools: ["lsp_definition", "lsp_hover", "lsp_diagnostics"],
        summary: "language-server lookups: go to definition, hover types, diagnostics",
        trigger: /\b(lsp|language server|go to definition|hover|diagnostics)\b/i,
    },
    web: {
        tools: ["search_web", "fetch_web"],
        summary: "search the web and fetch a URL",
        trigger: /(https?:\/\/|\b(search the web|web search|online docs?|on the internet|look (it )?up online)\b)/i,
    },
    search: {
        tools: ["hybrid_search", "trigram_search", "cst_symbols"],
        summary: "extra code search: ranked hybrid search, trigram substring index, syntax-tree symbols (search_code and search_symbols are always available)",
        trigger: null,
    },
    knowledge: {
        tools: ["manage_knowledge"],
        summary: "the persistent project knowledge store (save and recall facts across sessions)",
        trigger: /\b(knowledge (base|store|graph)|remember (this|that)|across sessions)\b/i,
    },
};
const GROUP_OF = new Map(Object.entries(TOOL_GROUPS).flatMap(([group, g]) => g.tools.map((tool) => [tool, group])));
/** The group a tool belongs to, or undefined for tools that are always offered. */
export function toolGroupOf(tool) {
    return GROUP_OF.get(tool);
}
/** Groups the operator's request mentions. */
export function groupsTriggeredBy(text) {
    return Object.entries(TOOL_GROUPS)
        .filter(([, g]) => g.trigger?.test(text))
        .map(([name]) => name);
}
export const ENABLE_TOOLS_CAPABILITY = {
    id: "orchestrate_enable_tools",
    modelToolName: "enable_tools",
    category: "orchestration",
    mutating: false,
    effect: "internal",
    sideEffectContract: "Offer more tools to the model for the rest of the conversation (no workspace change)",
    backend: "ts_native",
    toolDefinition: {
        type: "function",
        function: {
            name: "enable_tools",
            description: "Make more tools available from your next step. Groups: " +
                Object.entries(TOOL_GROUPS)
                    .map(([name, g]) => `${name} — ${g.summary}`)
                    .join("; ") +
                ".",
            parameters: {
                type: "object",
                properties: {
                    groups: { type: "array", items: { type: "string", enum: Object.keys(TOOL_GROUPS) }, description: "Groups to enable" },
                },
                required: ["groups"],
            },
        },
    },
};
