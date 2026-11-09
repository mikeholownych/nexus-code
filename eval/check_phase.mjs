/**
 * The post-agent phase of one run, in the only order that keeps the candidate workspace the agent's own.
 *
 * The code evaluators discover changed paths by comparing the candidate workspace with the pre-agent snapshot, and the
 * build/typecheck evaluators copy it. In a non-hardened run the hidden check stages its tests into that workspace and the
 * regression check writes caches there, so the evaluators must finish first or diff_boundary counts the harness's own files
 * as agent changes. Each step is passed in as a function so the ordering can be tested without the sandbox fixtures.
 */
export async function runPostAgentPhase({ evaluators, hidden, regression }) {
  const evaluatorResults = await evaluators();
  const hiddenResult = await hidden();
  const regressionResult = await regression();
  return { evaluators: evaluatorResults, hidden: hiddenResult, regression: regressionResult };
}
