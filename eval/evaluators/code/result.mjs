/** Build the stable result envelope shared by deterministic code evaluators. */
export function evaluatorResult(name, passed, score, details = {}) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("evaluator name must be non-empty");
  if (typeof passed !== "boolean") throw new TypeError("evaluator passed must be boolean");
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new RangeError("evaluator score must be between 0 and 1");
  return { evaluator: name, passed, score, details };
}
