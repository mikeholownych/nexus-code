# Examples

Each example is exercised by `cli/test/examples.test.ts` (`embed/` by `cli/test/embed_example.test.ts`), so it stays true to the product. The scripts take the
inference endpoint from the usual settings (`LOCAL_LLM_ENDPOINT`, or `--provider` flags added through `NEXUS_ARGS`) and
run any `nexus` through `NEXUS` (default: `nexus` on your `PATH`). The runner example uses `NEXUS_BIN` and optional
`NEXUS_RUNNER_ENDPOINT` / `NEXUS_RUNNER_MODEL` settings.

| Example | Shows |
|---|---|
| [`verified-completion/`](verified-completion/) | A task that may only finish when a trusted verifier passes: the exit code is the gate. |
| [`worktree/`](worktree/) | Running a task in its own git worktree and merging it back only after it verified. |
| [`operation/isolate.json`](operation/isolate.json) | A two-unit operation spec with `git.isolate`, so concurrent units never share a checkout. |
| [`hooks/`](hooks/) | A pre-tool command hook that refuses `git push --force`, tried with `nexus hooks test` (no model needed; exercised by `cli/test/hooks_examples.test.ts`). |
| [`embed/`](embed/) | A Node program that uses Nexus as a library: it starts the sidecar through the library entry point, answers its approval requests and exits 0 only on a verified outcome. |
| [`runner/`](runner/) | A supervised runner completes a bounded, read-only job in a fresh worktree and leaves an unattended receipt. |
| [`github-actions/nexus.yml`](github-actions/nexus.yml) | A pull-request workflow that runs Nexus through the repository's `action/` wrapper and fails the job unless the task verified. |
