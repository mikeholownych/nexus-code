/** Tools whose schemas the vLLM strict function-schema path (tool_grammar_provider.ts) may constrain. */
export const GBNF_TOOL_ALLOWLIST = ["read_file", "write_file", "edit_file", "run_command"] as const;
