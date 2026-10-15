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
  /**
   * Opaque provider-owned replay state (reasoning signatures / encrypted reasoning items). Never sent to any provider
   * other than `owner` ("<provider>:<model>"); `digest` detects alteration (e.g. by persistence redaction).
   */
  provider_state?: { owner: string; items: any[]; digest: string };
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
  maxSteps: number;          // Steps per segment (default 30). With `continuation` (the default), a segment boundary is a durable checkpoint, never the end of the task.
  /**
   * Automatic continuation past `maxSteps` while the work makes progress (see AutonomousAgent.runTurn). Absent:
   * `maxSteps` ends the turn (LIMIT_REACHED), the legacy single-segment behaviour.
   */
  continuation?: ContinuationBudget;
  temperature: number;       // Default 0.2 for precise coding
  workspace: string;         // Working directory for tools
  shell: string;             // Linux shell: "bash", "zsh", "sh" (default: "bash")
  coreBinaryPath?: string;   // Path to compiled harness-core executable
  dryRun?: boolean;          // Dry-run simulation mode without persisting file modifications
  readOnly?: boolean;        // Reject all mutating tool executions and commands
  approvalMode?: "auto" | "review" | "read-only"; // Execution posture: auto, review, or read-only (DEC-01 option C)
  yes?: boolean;             // Run non-interactively without confirmation prompts (forces auto mode)
  fullAccess?: boolean;      // Broad full-access mode executing without confirmation prompts (AUTH-007, AUTH-008)
  taskClass?: string;        // Routing hint sent to the gateway as X-Task-Class (e.g. "review", "architecture")
  plannerTaskClass?: string; // Same, for the planner client
  fallbackEndpoints?: string[]; // Failover endpoint URLs if primary endpoint is unavailable
  pinEndpoint?: boolean;     // Use only `endpoint` (no fallbacks): the operation scheduler owns resource selection
  credentialOrigin?: string;     // Origin apiKey belongs to (default: endpoint's origin); never sent elsewhere
  contextLimit?: number;     // Maximum model context window token limit (default: 65536)
  completionReserveTokens?: number; // Context reserved for each model completion (default: 8192)
  toolResponseReserveTokens?: number; // Tool-output headroom policy for the following tool results (default: min(4096, context/8))
  /**
   * Operator opt-in: refuse a request that could not be counted on a worker by the connection's request counting.
   * Off by default: without it an unmeasured request proceeds on the labelled client estimate (provider_capabilities.ts).
   */
  strictTokenCount?: boolean;
  sandbox?: boolean | string; // Linux namespace / bwrap / container isolation (default: false)
  worktree?: boolean;        // Isolated ephemeral git worktree execution (default: false)
  authoritativeVerifierCommand?: string; // Explicit trusted verifier: gates every task completion and authorizes automatic worktree merge
  verifierTimeoutSecs?: number; // Deadline for the completion verifier (default 300); env NEXUS_VERIFIER_TIMEOUT_SECS
  recordFlight?: boolean;    // Deterministic .flightlog session recording (default: false)
  plannerModel?: string;     // Deep reasoning / architecture planner (e.g. Claude 3.7 Thinking / o3 / DeepSeek R1)
  plannerEndpoint?: string;  // Dedicated endpoint for planner model
  plannerApiKey?: string;    // API key for planner model
  coderModel?: string;       // Ultra-fast surgical implementation model (e.g. Qwen 2.5 Coder 32B @ 150 tok/s)
  coderEndpoint?: string;    // Dedicated endpoint for coder model
  coderApiKey?: string;      // API key for coder model
  tdd?: boolean;             // Enforce strict RED-GREEN-REFACTOR protocol
  provider?: string;         // Cloud provider id (see providers.ts); undefined = the appliance/endpoint path
  plannerProvider?: string;  // Provider for the planner role; undefined inherits the rules in agent.ts
  coderProvider?: string;    // Provider for the coder role
  /** Origins the operator authorized to receive task content when they are cloud destinations. */
  authorizedDisclosureOrigins?: string[];
  /** Origins that look local but forward to a cloud service (treated as cloud disclosure). */
  cloudRoutedOrigins?: string[];
  reasoningEffort?: string;  // OpenAI Responses reasoning effort; enables owner-scoped reasoning replay
  anthropicThinkingBudget?: number; // Anthropic extended-thinking budget tokens; enables signed thinking replay
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  /** The operation's deadline expired before an answer was received (bridge-level; the runner reports its own via `timed_out`). */
  timedOut?: boolean;
  /** The operator's cancel ended the operation (the runner ended the command's process group). */
  cancelled?: boolean;
}

/**
 * How an automatically continued turn ends. Progressing work has no step or time ceiling by default: it ends on
 * completion, cancellation, demonstrated lack of progress, or an actionable failure. A step or time limit applies
 * only when the operator sets one explicitly; each limit has its own termination reason.
 */
export interface ContinuationBudget {
  /** Operator-set total steps for one turn (STEP_BUDGET_EXHAUSTED); Infinity (the default) when none was set. */
  maxTotalSteps: number;
  /** Operator-set wall-clock minutes for one turn (TIME_BUDGET_EXHAUSTED); Infinity (the default) when none was set. */
  maxTurnMinutes: number;
  /**
   * Consecutive steps without observed progress before the turn stops (STAGNATION_DETECTED). A repeated-state
   * threshold, not a task length: any progressing step resets it (core/execution_tracking.ts defines progress).
   */
  stagnationSteps: number;
  /** Recovery notes the agent may inject for a repeated identical action before stopping (bounded recovery). */
  maxRecoveries: number;
  /** Times the agent may be asked to continue when it stops with acceptance requirements still open. */
  maxCompletionNudges: number;
}

export const DEFAULT_CONTINUATION: ContinuationBudget = {
  maxTotalSteps: Number.POSITIVE_INFINITY,
  maxTurnMinutes: Number.POSITIVE_INFINITY,
  stagnationSteps: 12,
  maxRecoveries: 2,
  maxCompletionNudges: 2,
};

export type ApprovalMode = "auto" | "review" | "read-only";
