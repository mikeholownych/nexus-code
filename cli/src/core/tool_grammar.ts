/**
 * Tools whose schemas the vLLM strict function-schema path (tool_grammar_provider.ts) may constrain. A GBNF compiler
 * for these schemas was removed in v1.1.4 (WP-1303): it had no runtime caller. Reintroduce it together with its
 * consumer (llama.cpp `grammar`, Ollama `format`) and a live measurement; it remains in git history before this change.
 */
export const GBNF_TOOL_ALLOWLIST = ["read_file", "write_file", "edit_file", "run_command"] as const;
export type GbnfToolName = (typeof GBNF_TOOL_ALLOWLIST)[number];
