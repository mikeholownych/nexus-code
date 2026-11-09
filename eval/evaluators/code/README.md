# Deterministic code evaluators (WP-1105)

Dependency-free scoring helpers for hard code checks. Every helper returns the same envelope,
`{ evaluator, passed, score, details }`. They never call a model, and they never infer success from task metadata or
from what the agent said about its own work.

- **`syntax_ast.mjs`**
  - Parses each modified file with a real parser.
  - The built-in parsers in `parsers.mjs` need nothing beyond the host's Node.js and Python:
    - **TypeScript** (`.ts`, `.mts`, `.cts`): Node's own TypeScript parser (`module.stripTypeScriptTypes`, transform
      mode). Requires Node.js 22.13 or later.
    - **JavaScript** (`.js`, `.mjs`, `.cjs`): `node --check` of the source as a module or as CommonJS, decided by the
      extension and the nearest `package.json` `type`. An undeclared `.js` passes when it parses as either. (`node
      --check <file>` alone accepts ESM syntax errors in such a file.) A malformed nearest `package.json` fails the file, as it does in Node. So does one that is a symlink (which makes every `.js` file below it fail),
      not a regular file, or over 1 MiB: it is opened without following links and read in capped chunks.
    - **Python** (`.py`): `ast.parse` in an isolated interpreter.
  - A file over `maxSourceBytes` (default 8 MiB) is refused unparsed; built-in parsers run in a child process stopped after
    `parserTimeoutMs` (default 30 s).
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
  - One pinning policy. A file the build or a checker obeys keeps its baseline content, and an edit to it is reported in
    `details.ignoredCandidateChanges`. Only two kinds of path are pinned:
    - names that are unambiguous at any depth: `package.json`, lockfiles, `tsconfig*.json`, `jsconfig.json`,
      `pyrightconfig.json`, `build.rs`, `setup.py`/`setup.cfg`, `pyproject.toml`, `conftest.py`, `noxfile.py`, `tox.ini`,
      `pytest.ini`, `Makefile`, `CMakeLists.txt`, `Cargo.toml`/`Cargo.lock`, `go.mod`/`go.sum`/`go.work`,
      `rust-toolchain*`, `.cargo/config*`, `.npmrc`, `.yarnrc*`;
    - tool configuration and build scripts at the project root, or at a package root that the baseline's own workspace
      manifests name: `package.json` `workspaces` (array or `{ packages }`), `pnpm-workspace.yaml` `packages` (block or flow
      style), `lerna.json` `packages`, `rush.json` project folders, `nx.json` `workspaceLayout`, a Cargo
      `[workspace]` `members` list, and `go.work` `use` entries (`*` is one directory level, `**` any depth; `!` entries are
      ignored). The conventional folders `packages/`, `apps/`, `libs/`, `crates/`, `modules/` and `services/` (one level) are package
      roots too, as a union, so a layout whose manifest the parser does not understand keeps its pins. The manifests
      themselves (`pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `rush.json`, `package.json`, `go.work`, `Cargo.toml`) are
      pinned at any depth, and the roots are read from the pre-agent tree, so a candidate cannot add or remove a package root. The pinned
      names are `.babelrc*`, `.eslintrc*`, `.mocharc.*`, `eslint.config.*`, `<tool>.config.*` for webpack, vite, vitest,
      rollup, postcss, babel, jest, next, nuxt, tsup, turbo, metro, tailwind, prettier, astro, playwright, cypress, karma,
      esbuild, gulp, stylelint, commitlint and svelte, `ruff.toml`, `clippy/rustfmt/deny.toml`, `biome.json*`, `deno.json*`,
      `.swcrc`, `tslint.json`, `.golangci.y*ml`, `.rubocop.yml`, `angular.json`, `project.json`, `nx.json`, `lerna.json`,
      `build`/`compile`/`typecheck`/`gulpfile`/`Gruntfile`/`Jakefile` `.js/.ts` variants, `scripts/build|compile|typecheck.*s`,
      and `tools/*.js`.
    A layout that neither a manifest nor the conventional folders declare (a directory of plugins with no `workspaces` entry)
    has no package roots below the project root, and its nested tool configs are carried like ordinary source.
    Over-pinning is visible but not scored. A pinned path is listed in `ignoredCandidateChanges`, and its edit does not reach
    the build, so a legitimate change to a source file that happens to carry a pinned name below a package root (for example
    `packages/x/build.ts`) is not counted toward the build or typecheck result. Task authors should read that list: a task
    whose deliverable lives in a pinned name needs a different layout, not a wider carry rule.
    A YAML alias or merge key in `pnpm-workspace.yaml` is not resolved: the roots found literally and the conventional folders
    still apply, and the gap is reported as `details.workspaceNotes`. Trailing comments and `&anchor` on `packages:` are handled.
    Everything else is carried if it is a source or data type, so ordinary source such as `src/config/database.config.ts`
    or `src/build.ts` reaches the build. A changed path that is not a source or data type (shell scripts, Gradle/Maven/
    Ruby/Just files, `.ini`, `.xml`, binaries) and any symlink or special file is not carried either, and is reported.
    This deviates from the plan wording ("carry every candidate build input or fail closed and report ignored changed
    paths"): it carries an allowlist of input types, pins and reports the rest, and does not fail closed.
  - Skipped by the snapshot, at any depth, so a large tree does not trip its limits and nothing under them is overlaid
    or deleted: `node_modules/` and `__pycache__/` (never reported); a virtualenv (`.venv/`, `venv/` holding
    `pyvenv.cfg`); `.mypy_cache/` and `.pytest_cache/` holding `CACHEDIR.TAG`; and `target/` only where it is Cargo output
    (beside a `Cargo.toml` and holding Cargo's `CACHEDIR.TAG`). The marker-recognised directories are reported
    (`target/`) in `details.ignoredCandidateChanges` whenever the baseline and the candidate disagree about skipping them,
    so a candidate cannot make edits vanish by adding a marker. A directory with such a name but no marker is ordinary.
    A skipped directory that is present in both trees is not compared: edits inside a real Cargo `target/` or virtualenv
    are not seen.
  - Known limits:
    - A script in a carried language that the build invokes (for example `scripts/check.js` run by `npm run build`, or
      `jest.setup.js`) is carried like any other source file, so a candidate can edit it. The pinned list is a denylist
      for those; a `tsconfig` `extends` target with another name is carried.
    - Files the candidate produced in carried types are carried too (`dist/*.js`, generated sources). A build that only
      checks that an output exists can pass on the candidate's own output.
    - A very large directory that is not in the skip list (over 50,000 entries or 5 s to scan) still makes the evaluator
      fail closed.
  - The pinned copy is created under the run's scratch root (the size-capped tmpfs under the resource contract), and an
    explicit candidate typecheck `cwd` inside the workspace maps to the same directory in the copy; one outside it fails.
  - Budgets: the run's resource contract (`config.resources`: cgroup CPU, memory and process limits) applies to these
    commands; independently, a single file write is capped (`maxFileBytes`, default 1 GiB, via `prlimit`) and core dumps
    are off. A relative command must stay inside its working directory after `..` and symlinks resolve (the check is against
    the command's `cwd`, not the workspace root, so `../tool` from a subdirectory is refused). It runs
    as `/workspace/<path>` inside the sandbox, so no host runtime mount is needed. A command killed by the memory limit
    (cgroup `oomKills` above zero, which also counts a kill of any descendant) fails with an error rather than comparing
    its partial output; this is deliberately conservative. `maxFileBytes` can be set on a
    `build` or `typecheck_clean` spec (or `task.build` / `task.typecheck`).
- **`typecheck_clean.mjs`**
  - The candidate side runs in the same pinned workspace as `build.mjs` (so the carrying rules above apply, and `details.ignoredCandidateChanges` lists what was not carried). Runs the baseline and candidate typecheck commands in separate Bubblewrap workspaces under the same filesystem, network, environment, output and process limits as `build.mjs`.
  - Fails on any diagnostic line the candidate adds; existing diagnostics may remain. Duplicate lines are counted.
  - Also fails when the candidate exits non-zero and either the baseline exited 0 or the candidate printed nothing.
  - A containment failure, timeout, output overflow or signal on either side fails closed.
  - Diagnostics are compared by message: ANSI colour (`--pretty`), source excerpts, summary counts, and line and
    column numbers are ignored, so an insertion above an existing error does not make it new. A second copy of the
    same message is still new. Paths that differ between revisions must still be normalized by the caller.
  - Recognised diagnostics are TypeScript (`error TS1234:`) and rustc (`error[E0123]:`). For another checker, set
    `diagnosticPattern` (a regular expression, case-insensitive) on the evaluator spec or `task.typecheck`; without a
    match a non-zero exit is an infrastructure failure, not a comparison. A pattern that is not a string, or is not a valid regular expression, is a failed result with `details.error`, not an exception.
  - Locations are normalized in the leading position only: `file(l,c):`, `file:l:c - `, `--> file:l:c`, `file:l:c:` and `file:l:`. The path must end in a file extension and may contain spaces and parentheses (`app/(auth)/page.tsx`) but no colon, so a
    location-free header such as `error[E0080]: ... step:1: failed` is compared as printed. A diagnostic's code (used for
    the configuration-error check and to open a code frame) is read only at its leading position, after any location;
    a code quoted in a message or a source excerpt does not count.
  - A configuration error from the checker (`TS5057` or `TS5081` missing tsconfig (the code depends on the compiler version), `TS5058`, `TS5083`, `TS5012`, `TS18003`,
    `TS6053`) on either side fails closed: nothing was type-checked.
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
  - The counts come from the parser and cover every tool call it recognizes: native `tool_calls`, `<tool_call>` tags, a
    reply that is solely one fenced JSON call, and, under `NEXUS_TEXT_TOOL_PARSING=legacy`, fenced code blocks and
    balanced JSON objects in prose. Structurally repaired write calls that are rejected are counted too. Native
    arguments wrapped in a Markdown fence count as repaired, not native.
  - The function takes the `toolCallSyntax` counts object (or an array of them), not a turn result; any other shape
    throws.
  - Tool calls made by a delegated subagent (`spawn_subagent`) are added to the parent turn's counts.
  - Not counted: calls in a response cut off at the output-token limit. Those are dropped and requested again before
    parsing, under the output-truncation recovery.

The modules are a library. The dataset runner (`eval/run.mjs`, WP-1103/1104) supplies the pre-agent workspace snapshot,
candidate and baseline workspaces, any extra parsers, and the turn results.
