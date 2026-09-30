export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | any[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterProperty>;
      required?: string[];
    };
  };
}

export interface HarnessConfig {
  endpoint: string;          // e.g. "http://localhost:1234/v1" (LM Studio) or "http://localhost:8000/v1" (vLLM)
  model: string;             // e.g. "qwen2.5-coder-32b-instruct"
  apiKey?: string;           // Optional for local servers (defaults to "local")
  maxSteps: number;          // Default 30
  temperature: number;       // Default 0.2 for precise coding
  workspace: string;         // Working directory for tools
  shell: string;             // Linux shell: "bash", "zsh", "sh" (default: "bash")
  coreBinaryPath?: string;   // Path to compiled harness-core executable
  dryRun?: boolean;          // Dry-run simulation mode without persisting file modifications
  readOnly?: boolean;        // Reject all mutating tool executions and commands
  fallbackEndpoints?: string[]; // Failover endpoint URLs if primary endpoint is unavailable
  contextLimit?: number;     // Maximum model context window token limit (default: 65536)
  completionReserveTokens?: number; // Context reserved for each model completion (default: 8192)
  toolResponseReserveTokens?: number; // Context reserved for the following tool results (default: 4096)
  sandbox?: boolean | string; // Linux namespace / bwrap / container isolation (default: false)
  worktree?: boolean;        // Isolated ephemeral git worktree execution (default: false)
  recordFlight?: boolean;    // Deterministic .flightlog session recording (default: false)
  plannerModel?: string;     // Deep reasoning / architecture planner (e.g. Claude 3.7 Thinking / o3 / DeepSeek R1)
  plannerEndpoint?: string;  // Dedicated endpoint for planner model
  plannerApiKey?: string;    // API key for planner model
  coderModel?: string;       // Ultra-fast surgical implementation model (e.g. Qwen 2.5 Coder 32B @ 150 tok/s)
  coderEndpoint?: string;    // Dedicated endpoint for coder model
  coderApiKey?: string;      // API key for coder model
  tdd?: boolean;             // Enforce strict RED-GREEN-REFACTOR protocol
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}
