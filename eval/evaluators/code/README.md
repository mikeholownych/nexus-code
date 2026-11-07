# Deterministic code evaluators (WP-1105)

Dependency-free scoring helpers for hard code checks. Every helper returns the same envelope,
`{ evaluator, passed, score, details }`. They never call a model, and they never infer success from task metadata or
from what the agent said about its own work.

- **`syntax_ast.mjs`**
  - Parses each modified file with a real parser.
  - The built-in parsers in `parsers.mjs` need nothing beyond the host's Node.js and Python:
    - **TypeScript** (`.ts`, `.mts`, `.cts`): Node's own TypeScript parser (`module.stripTypeScriptTypes`, transform
      mode). Requires Node.js 22.13 or later.
    - **JavaScript** (`.js`, `.mjs`, `.cjs`): `node --check` on the file, so the module type is decided exactly as
      Node would decide it.
    - **Python** (`.py`): `ast.parse` in an isolated interpreter.
  - Rust, TSX and JSX have no built-in parser. A caller can supply one for any language, or replace a built-in one.
  - Fails closed on: a language with no parser, an unsupported extension, an unreadable file, a path that is
    absolute, contains traversal, or escapes the workspace through a symlink, and an empty file list.
- **`build.mjs`**
  - Runs an explicit command and argv through `command.mjs` inside the Bubblewrap workspace sandbox.
  - The sandbox unshares networking, exposes the candidate workspace plus the exact runtime executable and system runtime mounts, and clears the inherited environment.
  - Wall time, captured output and process cleanup are bounded. If the sandbox or an allowlisted runtime is unavailable, the evaluator fails closed without a host fallback.
  - Passes only on exit status 0 with no timeout, signal or spawn error.
  - Runs in a pinned workspace: the pre-agent tree plus the candidate's changes to source and data files (additions, edits
    and deletions): the source extensions `syntax_ast` knows, plus `.json .css .scss .less .sql .proto .graphql .html .svg
    .txt .csv .yaml .yml .toml .go .c .h .cc .cpp .hpp .java .kt .cs .swift`.
  - Not carried, and reported in `details.ignoredCandidateChanges` (never silently): any changed path of another type
    (shell scripts, Gradle/Maven/Ruby/Just files, `.ini`, `.xml`, lockfiles, binaries), any symlink or special file, and
    build configuration or helpers the build or a checker obeys (`package.json`, `tsconfig*.json`, tool configs such as
    `.eslintrc*`, `pyrightconfig.json`, `ruff.toml`, `build.rs`, `setup.py`, `conftest.py`, `Makefile`, `Cargo.toml`,
    `go.mod`, `tools/*.js`). These keep their baseline content, so they never change the build. This deviates from the plan
    wording ("carry every candidate build input or fail closed and report ignored changed paths"): it carries an allowlist
    of input types, pins and reports the rest, and does not fail closed.
  - Skipped by the snapshot and not reported, at any depth: `node_modules/`, `__pycache__/`, `.venv/`, `venv/`,
    `.mypy_cache/`, `.pytest_cache/`, `.tox/`, and `target/` only where it is Cargo output (beside a `Cargo.toml` and
    holding Cargo's `CACHEDIR.TAG`). Any other `target/` is an ordinary directory. Skipping keeps a large dependency tree
    from tripping the snapshot limits.
  - Known limits:
    - A script in a carried language that the build invokes (for example `scripts/check.js` run by `npm run build`, or
      `jest.setup.js`) is carried like any other source file, so a candidate can edit it. The pinned list is a denylist
      for those; a `tsconfig` `extends` target with another name is carried.
    - Files the candidate produced in carried types are carried too (`dist/*.js`, generated sources). A build that only
      checks that an output exists can pass on the candidate's own output.
    - A very large directory that is not in the skip list (over 50,000 entries or 5 s to scan) still makes the evaluator
      fail closed.
- **`typecheck_clean.mjs`**
  - The candidate side runs in the same pinned workspace as `build.mjs` (so the carrying rules above apply, and `details.ignoredCandidateChanges` lists what was not carried). Runs the baseline and candidate typecheck commands in separate Bubblewrap workspaces under the same filesystem, network, environment, output and process limits as `build.mjs`.
  - Fails on any diagnostic line the candidate adds; existing diagnostics may remain. Duplicate lines are counted.
  - Also fails when the candidate exits non-zero and either the baseline exited 0 or the candidate printed nothing.
  - A containment failure, timeout, output overflow or signal on either side fails closed.
  - The comparison is exact, so callers should normalize paths that differ between revisions.
- **`diff_boundary.mjs`**
  - Checks Git-style relative paths against exact allowed paths and directory prefixes ending in `/`.
  - Absolute paths, traversal, empty or `.` segments, NUL bytes and backslashes fail closed.
  - `runner.mjs` supplies paths by comparing a bounded pre-agent workspace snapshot with the post-agent workspace; this includes modified, deleted and untracked files and does not depend on candidate-controlled Git metadata.
  - Missing or empty change evidence fails closed. Snapshot traversal skips only root `.git` metadata, never follows symlinks, rejects special files, and is bounded by depth, incrementally read entries, file bytes and wall time.
- **`json_repair_rate.mjs`**
  - Scores the agent's own tool-call syntax telemetry: the `toolCallSyntax` counts on each turn result
    (`nexus run --json` → `turn.toolCallSyntax`).
  - Scoring: native JSON is 1, JSON recovered by a trailing or structural repair is 0.5, and arguments that did not
    parse are 0.
  - Any invalid call fails the result. So does having no tool calls recorded, since there is nothing to score.
  - The counts come from the parser and cover every tool call it recognizes, including structurally repaired write
    calls that are rejected.
  - Tool calls made by a delegated subagent (`spawn_subagent`) are added to the parent turn's counts.
  - Not counted: calls in a response cut off at the output-token limit. Those are dropped and requested again before
    parsing, under the output-truncation recovery.

The modules are a library. The dataset runner (`eval/run.mjs`, WP-1103/1104) supplies the pre-agent workspace snapshot,
candidate and baseline workspaces, any extra parsers, and the turn results.
