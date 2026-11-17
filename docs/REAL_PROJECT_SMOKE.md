# Real-project smoke (MQ-3)

`scripts/real_project_smoke.mjs` runs the built headless CLI (`node cli/dist/index.js run --json`) on repositories it builds on the fly in a temporary directory, against a scripted local gateway that answers with a fixed tool-call sequence: write a file, run the verifier, `task_completed`. It asserts the JSON result per repository. The `real-project-smoke` workflow runs it nightly (03:43 UTC) and on demand. It is not a required check.

Why it exists: in v1.1.4 a verifier whose definition could not be bound (a `node_modules` tree, a `make` target that references more than 128 files) blocked every completion. Unit tests of the verifier did not see it; any run on such a repository did. Fixed in v1.2.0 (#496): such a pass is REGRESSION_FREE, never VERIFIED.

| Repository | Shape | Expected |
|---|---|---|
| `js-node_modules` | `npm test`, populated `node_modules` | REGRESSION_FREE |
| `makefile-large-graph` | `make test`, Makefile naming 140 files | REGRESSION_FREE |
| `deeply-nested` | code and tests 24 directories down | REGRESSION_FREE |
| `python-pytest` | `pyproject.toml` pytest config | REGRESSION_FREE |

A repository is red when the run hangs (killed after 120 s, `NEXUS_SMOKE_TIMEOUT_MS` to change), prints no JSON result, does not complete, ends in anything other than REGRESSION_FREE or VERIFIED (or the expected one), or exits with the wrong code (0 for VERIFIED, 2 for REGRESSION_FREE).

```sh
npm --prefix cli run build            # and the Rust core: the run does not verify without it
node scripts/real_project_smoke.mjs   # --only a,b  --require-all  --json  --cli <path>
node scripts/real_project_smoke.mjs --seed-regression   # must exit 1
```

`--seed-regression` has the scripted model deliver a fix the verifier rejects in every repository. It proves the job can go red; it does not reintroduce the v1.1.4 defect. `--require-all` (used in CI) makes a missing `pytest` a failure instead of a skip. The test `cli/test/real_project_smoke.test.ts` checks green on the clean repositories, red on the seeded regression, and red on each failure mode through a stand-in CLI.

## What it does not cover

- The gateway is a mock: no live model, no real tool-call quality, no streaming faults.
- The repositories are synthetic and small, shaped like the failing cases; they are not real third-party projects, and there is no Rust project yet.
- No network, no sandbox mode, no worktree mode, no resume.
