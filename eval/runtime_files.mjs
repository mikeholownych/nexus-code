// The evaluator runtime: every file the packaged `nexus eval` needs, and every file the harness identity digests.
// scripts/stage_eval_runtime.mjs copies exactly these into the package and eval/run.mjs harnessIdentity() hashes exactly
// these, so a run's recorded identity covers what was shipped. Add a new runtime module here and nowhere else.
export const EVAL_RUNTIME_FILES = [
  "eval/run.mjs", "eval/runtime_files.mjs", "eval/validate.mjs", "eval/t4_fixtures.mjs", "eval/isolate.mjs",
  "eval/hide_oracle.cjs", "eval/hide_oracle.py", "eval/unlink_then_exec.sh",
  "eval/agent_sandbox.mjs", "eval/model_proxy.mjs", "eval/score.mjs", "eval/dataset.mjs",
  "eval/runner_integrity.mjs", "eval/runner_api.mjs", "eval/oracle.mjs", "eval/infra.mjs",
  "eval/workspace.mjs", "eval/resources.mjs", "eval/cgroup_supervisor.mjs", "eval/t3.mjs",
  "eval/hardened_check.mjs", "eval/check_phase.mjs", "eval/toolchain-versions.json", "eval/scan-compiler-exposure.mjs",
  "eval/evaluators/code/index.mjs",
  "eval/evaluators/code/syntax_ast.mjs",
  "eval/evaluators/code/build.mjs",
  "eval/evaluators/code/typecheck_clean.mjs",
  "eval/evaluators/code/diff_boundary.mjs",
  "eval/evaluators/code/runner.mjs",
  "eval/evaluators/code/json_repair_rate.mjs",
  "eval/evaluators/code/parsers.mjs",
  "eval/evaluators/code/command.mjs",
  "eval/evaluators/code/result.mjs",
  "eval/evaluators/code/README.md",
];
