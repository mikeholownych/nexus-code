import { ChatMessage, ToolDefinition } from "./types.js";
import pc from "picocolors";

const CJK_KANA_HANGUL_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ALL_DIGITS_RE = /^\s*\p{N}+\s*$/u;

// Conservative BPE subword regex (REQ-AGT-118):
// - >= 1 token per CJK, Hangul or kana character
// - 1 token per digit
// - len/3 for base64-like and long unbroken runs
const BPE_REGEX = /[A-Za-z0-9+/=_-]{16,}|'s|'t|'re|'ve|'m|'ll|'d| ?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]| ?\p{L}+| ?\p{N}| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/**
 * Fast, conservative BPE token counter estimation for local and remote LLMs
 */
export function countTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const matches = text.match(BPE_REGEX);
  if (!matches) {
    return Math.ceil(text.length / 3);
  }
  let count = 0;
  for (const m of matches) {
    if (ALL_DIGITS_RE.test(m)) {
      count += m.trim().length;
      continue;
    }
    const trimmed = m.trimStart();
    if (trimmed.length > 0 && !/\s/.test(trimmed) && !CJK_KANA_HANGUL_RE.test(trimmed)) {
      const codePoints = Array.from(trimmed);
      if (codePoints.some((cp) => (cp.codePointAt(0) ?? 0) > 0xffff)) {
        count += codePoints.length;
        continue;
      }
    }
    if (m.length > 8) {
      // Long unbroken strings/hashes/base64 split into ~3 chars per token (REQ-AGT-118)
      count += Math.ceil(m.length / 3);
    } else {
      count += 1;
    }
  }
  return count;
}

export interface TokenBudget {
  systemPromptTokens: number;
  toolsDefinitionTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolOutputTokens: number;
  totalActiveTokens: number;
  contextLimit: number;
  utilizationPercent: number;
}

export function isContextAdmissible(
  estimatedPromptTokens: number,
  contextLimit: number,
  completionReserveTokens: number,
  toolResponseReserveTokens: number,
): boolean {
  return estimatedPromptTokens >= 0 &&
    completionReserveTokens >= 0 &&
    toolResponseReserveTokens >= 0 &&
    estimatedPromptTokens + completionReserveTokens + toolResponseReserveTokens <= contextLimit;
}

/**
 * Calculate token breakdown across all parts of the LLM context
 */
export function calculateContextBudget(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  contextLimit: number = 65536
): TokenBudget {
  let systemPromptTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let toolOutputTokens = 0;

  for (const msg of messages) {
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content === undefined || msg.content === null
        ? ""
        : JSON.stringify(msg.content);
    const toolCallsLen = msg.tool_calls ? JSON.stringify(msg.tool_calls) : "";
    const tokens = countTokens(content) + countTokens(toolCallsLen) + 4; // 4 overhead tokens per message

    if (msg.role === "system") {
      systemPromptTokens += tokens;
    } else if (msg.role === "user") {
      userTokens += tokens;
    } else if (msg.role === "assistant") {
      assistantTokens += tokens;
    } else if (msg.role === "tool") {
      toolOutputTokens += tokens;
    }
  }

  const toolsStr = JSON.stringify(tools);
  const toolsDefinitionTokens = countTokens(toolsStr);

  const totalActiveTokens =
    systemPromptTokens + toolsDefinitionTokens + userTokens + assistantTokens + toolOutputTokens;
  const utilizationPercent = Math.min(100, Math.round((totalActiveTokens / contextLimit) * 1000) / 10);

  return {
    systemPromptTokens,
    toolsDefinitionTokens,
    userTokens,
    assistantTokens,
    toolOutputTokens,
    totalActiveTokens,
    contextLimit,
    utilizationPercent,
  };
}

/**
 * Render a visual terminal gauge showing token distribution
 */
export function renderTokenGauge(budget: TokenBudget): string {
  const barWidth = 24;
  const filledChars = Math.min(barWidth, Math.round((budget.totalActiveTokens / budget.contextLimit) * barWidth));
  const emptyChars = Math.max(0, barWidth - filledChars);

  let barColor = pc.green;
  if (budget.utilizationPercent > 85) {
    barColor = pc.red;
  } else if (budget.utilizationPercent > 65) {
    barColor = pc.yellow;
  }

  const bar = barColor("█".repeat(filledChars)) + pc.dim("░".repeat(emptyChars));
  const lines: string[] = [];

  lines.push(pc.bold("\n📊 Context Window & Token Accounting Gauge"));
  lines.push(`Usage: [${bar}] ${pc.bold(budget.totalActiveTokens.toLocaleString())} / ${budget.contextLimit.toLocaleString()} tokens (${pc.bold(budget.utilizationPercent + "%")})\n`);

  const fmt = (label: string, count: number) => {
    const pct = budget.totalActiveTokens > 0
      ? ((count / budget.totalActiveTokens) * 100).toFixed(1)
      : "0.0";
    return `  • ${label.padEnd(22)}: ${pc.bold(count.toLocaleString().padStart(7))} tokens (${pct.padStart(5)}%)`;
  };

  lines.push(fmt("System Instructions", budget.systemPromptTokens));
  lines.push(fmt("Tool Definitions", budget.toolsDefinitionTokens));
  lines.push(fmt("User Instructions", budget.userTokens));
  lines.push(fmt("Model Responses/Thoughts", budget.assistantTokens));
  lines.push(fmt("Tool Output Payloads", budget.toolOutputTokens));

  const headroom = Math.max(0, budget.contextLimit - budget.totalActiveTokens);
  lines.push(`\n  ${pc.dim("Available Headroom:")} ${pc.bold(pc.cyan(headroom.toLocaleString()))} tokens remaining.`);

  return lines.join("\n");
}

// Predictive next-request token estimation
export interface NextRequestEstimation {
  estimatedPromptTokens: number;
  estimatedTokens: number; // alias
  completionReserveTokens: number;
  toolResponseReserveTokens: number;
  safetyMarginTokens: number;
  totalPredictedTokens: number;
  utilizationPercent: number;
}

export function estimateNextRequestTokens(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  contextLimit: number = 65536,
  completionReserveTokens: number = 8192,
  toolResponseReserveTokens: number = 4096,
  safetyMarginTokens: number = 1000
): NextRequestEstimation {
  const budget = calculateContextBudget(messages, tools, contextLimit);

  // Estimate overhead for formatting/protocol
  const overhead = countTokens(JSON.stringify({ role: "assistant", content: "", tool_calls: [] })) * 2;

  const estimatedPromptTokens = budget.totalActiveTokens + overhead;
  const totalPredictedTokens = estimatedPromptTokens + completionReserveTokens + toolResponseReserveTokens + safetyMarginTokens;
  const utilizationPercent = Math.min(100, Math.round((totalPredictedTokens / contextLimit) * 1000) / 10);

  return {
    estimatedPromptTokens,
    estimatedTokens: estimatedPromptTokens,
    completionReserveTokens,
    toolResponseReserveTokens,
    safetyMarginTokens,
    totalPredictedTokens,
    utilizationPercent,
  };
}

export function isContextPressureHigh(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  contextLimit: number = 65536,
  softThresholdPercent: number = 80,
  completionReserveTokens: number = 8192,
  toolResponseReserveTokens: number = 4096,
  safetyMarginTokens: number = 1000
): boolean {
  const estimation = estimateNextRequestTokens(
    messages,
    tools,
    contextLimit,
    completionReserveTokens,
    toolResponseReserveTokens,
    safetyMarginTokens
  );
  return estimation.utilizationPercent >= softThresholdPercent ||
    !isContextAdmissible(estimation.estimatedPromptTokens, contextLimit, completionReserveTokens, toolResponseReserveTokens);
}
