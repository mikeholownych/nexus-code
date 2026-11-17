# Examples

Each example is exercised by `cli/test/examples.test.ts`, so it stays true to the product. The scripts take the
inference endpoint from the usual settings (`LOCAL_LLM_ENDPOINT`, or `--provider` flags added through `NEXUS_ARGS`) and
run any `nexus` through `NEXUS` (default: `nexus` on your `PATH`).

| Example | Shows |
|---|---|
| [`verified-completion/`](verified-completion/) | A task that may only finish when a trusted verifier passes: the exit code is the gate. |
| [`worktree/`](worktree/) | Running a task in its own git worktree and merging it back only after it verified. |
| [`operation/isolate.json`](operation/isolate.json) | A two-unit operation spec with `git.isolate`, so concurrent units never share a checkout. |
| [`github-actions/nexus.yml`](github-actions/nexus.yml) | A pull-request workflow that runs Nexus through the repository's `action/` wrapper and fails the job unless the task verified. |
