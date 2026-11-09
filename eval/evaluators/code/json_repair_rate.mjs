import { evaluatorResult } from "./result.mjs";

const KEYS = ["native", "trailing", "structural", "invalid"];

/**
 * Score tool-call argument syntax from the agent's own telemetry: the `toolCallSyntax` counts on each turn result
 * (`nexus run --json` → `turn.toolCallSyntax`). Native JSON scores 1, JSON recovered by a trailing or structural
 * repair 0.5, and arguments that did not parse 0. Any invalid call fails the pass bit; so does having no tool calls
 * recorded at all, since there is then nothing to score.
 */
export function evaluateJsonRepairRate(toolCallSyntax) {
  const list = Array.isArray(toolCallSyntax) ? toolCallSyntax : [toolCallSyntax];
  const counts = { native: 0, trailing: 0, structural: 0, invalid: 0 };
  for (const syntax of list) {
    if (syntax == null) continue; // a turn with no tool calls carries no counts
    if (typeof syntax !== "object") throw new TypeError("tool-call syntax counts must be objects");
    // A whole turn result (or any other shape) would otherwise read as zero calls; refuse it instead.
    if (Object.keys(syntax).some((key) => !KEYS.includes(key))) {
      throw new TypeError("expected the toolCallSyntax counts ({ native, trailing, structural, invalid }), not a turn result");
    }
    for (const key of KEYS) {
      const n = syntax[key] ?? 0;
      if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`tool-call syntax count ${key} must be a non-negative integer`);
      counts[key] += n;
    }
  }
  const total = KEYS.reduce((sum, key) => sum + counts[key], 0);
  const repaired = counts.trailing + counts.structural;
  const score = total ? (counts.native + 0.5 * repaired) / total : 0;
  return evaluatorResult("json_repair_rate", total > 0 && counts.invalid === 0, score, {
    total, ...counts, repaired, ...(total ? {} : { error: "no tool calls recorded" }),
  });
}
