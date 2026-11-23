# Using `nexus verify` in CI

`nexus verify` gives a pull request a verdict without a model, a provider or a secret: it runs the verifier on the base commit and on the change and applies the rules in the manual ([`nexus verify`](USER_MANUAL.md#nexus-verify)). The composite action `action/verify` installs Nexus and runs it; its exit code is the gate.

## The workflow

`examples/github-actions/nexus-verify.yml`:

```yaml
# Copy to .github/workflows/nexus-verify.yml. Gives every pull request a verdict and fails the job unless it is VERIFIED.
#
# What VERIFIED means: tests that already existed on the base commit failed there and pass on the pull request (when the
# pull request edits tests, the base's tests are run against its code and must pass), under the verifier the BASE
# defines, and those tests import every file listed under deliverable-files; no enforced type-check failed; and the
# pull request edits no CI, build or test configuration and weakens no test.
# What it does not mean: that the change is correct beyond what those tests check, that it is safe, or that anyone
# reviewed it. REGRESSION_FREE (exit 2) means the tests pass and nothing shows they test the change. BLOCKED (exit 3)
# means a person must decide: read the receipt, then approve the verifier or the listed verification edit in this file.
#
# No model and no secret is used. Keep it that way: this job runs the pull request's code.
# See docs/VERIFY_IN_CI.md for the exit codes, the sandbox and the limits.
name: nexus-verify
on:
  pull_request:   # never pull_request_target: that event runs with the base repository's secrets and write token

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0              # the base commit must be in the clone
          persist-credentials: false  # the pull request's code must not find the job's token in .git/config

      # The sandbox confines the pull request's tests: no write outside their own scratch copy, no network, HOME masked.
      # Bubblewrap needs unprivileged user namespaces, which current Ubuntu runners restrict. If it is still unusable,
      # the verify step ends BLOCKED (SANDBOX_UNAVAILABLE); it never runs the tests unconfined instead.
      - name: Enable the sandbox engine
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq bubblewrap
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true

      # Do NOT install the pull request's dependencies here (no `npm ci` on its lockfile): an installed `node_modules`
      # is linked into both sides, and a package the pull request chose could stand in for the test runner.

      - id: verify
        uses: mikeholownych/nexus-code/action/verify@v1.3.0   # pin a release tag (or its full commit SHA)
        with:
          version: v1.3.0
          # Your own command, fixed in this file. Leave it out to use the verifier the base commit defines; the first
          # run then ends BLOCKED and prints a digest to put under approve-verifier after you have read the command.
          verifier: npm test
          # The product files this repository's pull requests are meant to change (one per line). VERIFIED needs them.
          deliverable-files: |
            src/index.js
          sandbox: bwrap
          # approve-verification-edits: |
          #   test/parser.test.js

      - name: Keep the receipt
        if: always() && steps.verify.outputs.receipt-path != ''
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: nexus-verify-receipt
          path: ${{ steps.verify.outputs.receipt-path }}
```

Why each part is there:

- `pull_request`, not `pull_request_target`: the job runs the pull request's code, so it must not hold the base repository's secrets or a write token. `permissions: contents: read` and `persist-credentials: false` keep the token out of reach.
- `fetch-depth: 0`: the base commit must be in the clone. The action's default base is the event's `pull_request.base.sha`; its default head is the checked-out commit (`HEAD`, GitHub's merge commit of the pull request).
- `verifier` is your own command, written in the workflow file. It is a shell command and runs as given: never build it from an event field. Without it, the verifier is discovered in the **base** commit and the first run ends `BLOCKED` with a digest; put that digest under `approve-verifier` once you have read the command. There is no input that approves whatever is discovered.
- `deliverable-files`: without at least one, the verdict is never `VERIFIED`.
- `sandbox`: see below. Empty uses `auto`; for untrusted pull requests the action must not set it to `none`.

Every input and event field reaches the action's script as an environment variable and is passed to `nexus` as one quoted argument; no `${{ }}` expression appears in a script.

## Exit codes

| Code | Verdict | What the job should do |
|---|---|---|
| 0 | `VERIFIED` | Pass. |
| 1 | `UNVERIFIED` (the verifier or an enforced type-check failed or timed out on the change, the change redefines its own verifier, or `nexus verify` itself failed) | Fail. |
| 2 | `REGRESSION_FREE`, or `UNVERIFIED` because nothing could be established (no verifier, no test ran, nothing changed), or a usage error (no verdict) | Fail. The tests may pass: this code says nothing shows that they test the change. |
| 3 | `BLOCKED` | A person must decide: approve the verifier, approve an edit to the verification itself after reading it, make the sandbox available, or shrink the tree. |
| 130 | none | Interrupted. |

Only `VERIFIED` exits 0, and the action does not change that. To treat `BLOCKED` apart from a failure, set `fail-on-blocked: "false"`: the step then succeeds on exit code 3 and sets the output `blocked` to `true` (the outputs `verdict`, `reason` and `exit-code` still say `BLOCKED` and `3`), so a later step can ask for a review or label the pull request. A workflow that does this must not let the job count as a passed gate: check `steps.<id>.outputs.verdict == 'VERIFIED'` wherever the gate is decided.

Outputs: `verdict`, `reason`, `blocked`, `exit-code`, `receipt-path`. The receipt is the JSON result document (schema `docs/protocol/verify-result-v2.schema.json`); keep it as an artifact. Only the verdict and the reason are copied into outputs and the job summary: the document also holds text that came from the repository.

## The sandbox

By default, `nexus verify` uses `--sandbox auto`: Bubblewrap when usable, otherwise Docker. It blocks with `SANDBOX_UNAVAILABLE` if neither engine can confine the run; it never silently falls back to executing repository code with the caller's privileges. Every process it starts on repository code runs confined:

| | Default (`auto`) | Explicit `--sandbox none` |
|---|---|---|
| The run's own scratch tree | writable | writable |
| The other scratch trees, the pristine copy the head is judged on, the scratch Git index and objects | not visible | **writable** |
| Your checkout and its `.git` | read-only, or not visible when under HOME or `/tmp` | **writable** |
| Linked dependency directories (`node_modules`, `vendor`, `.venv`, `venv` of your checkout) | read-only | **writable** |
| HOME | masked; toolchain directories read-only | readable and writable |
| Network | none, unless `--sandbox-network` | the job's |
| Other processes (`/proc`), processes that outlive the run | not visible; end with the run | visible; can survive |
| Environment | the verifier's allowlist | the same allowlist |

`--sandbox none` is an explicit opt-out for trusted changes. The hostile scratch-index rewrite is still possible when an operator deliberately opts out; it is prevented by the default sandbox. The receipt records the effective sandbox in `sandbox.engine` (`bwrap`, `docker`, or `none`) and `sandboxed` on every run; `sandbox.requested` records whether the operator explicitly supplied `--sandbox`. A refusal is also a typed `sandboxEvents` entry with its engine, profile and reason, so an audit bundle that copies the receipt carries it; the event is evidence, never a verdict or approval. A sandbox changes no verdict rule; it only takes authority away from the code under test.

Engines: Bubblewrap needs unprivileged user namespaces. The Docker engine runs the commands in the pinned Alpine image of `nexus run --sandbox docker`, which has a shell and no toolchain, so a real verifier needs your own image (`NEXUS_SANDBOX_DOCKER_IMAGE`, pinned by digest, set in the workflow's `env`, never from the pull request).

## Dependencies

Dependency directories of the checkout that neither commit tracks are linked into both scratch trees, so whoever installed them chose part of what runs. Installing the pull request's lockfile (`npm ci` on the checked-out head) lets a package it added stand in for the test runner; with a `node_modules` directory an `npm test` verifier cannot be bound to the base anyway, so the verdict is at most `REGRESSION_FREE`. Prefer a verifier that needs no installation, or install from the base commit's lockfile before the verify step. A dependency directory that a commit itself tracks is never linked, and a head that adds one has changed the verifier's definition.

## What a hostile change can and cannot do

Each row is a test; "prevented" means no effect on the verdict, "lowered" means a verdict that is not `VERIFIED` and says why, "limit" is a documented limit the test pins.

| Attack | Outcome | Test (`cli/test/`) |
|---|---|---|
| The head rewrites `scripts.test`, or only the head defines a verifier | lowered: the verifier comes from the base; the head is not run | `verify_command`: "the head cannot choose its own verifier" |
| The head adds `pretest` / `posttest` hooks | lowered: `BLOCKED`, then `VERIFIER_DEFINITION_CHANGED`; the hooks never run | `verify_hostile`: "pretest and posttest hooks" |
| The head rewrites the `Makefile` test target, or adds a `GNUmakefile` that shadows it | lowered: `BLOCKED`, then `VERIFIER_DEFINITION_CHANGED`; the fake target never runs | `verify_hostile`: "GNUmakefile", "Makefile's test target" |
| The head adds an `.npmrc` with `script-shell` | lowered: `VERIFIER_DEFINITION_CHANGED` | `verify_hostile`: ".npmrc" |
| The head adds a `conftest.py` that passes every test | lowered: `BLOCKED`; approved, at most `REGRESSION_FREE` | `verify_hostile`: "conftest.py" |
| The head ships a relaxing `.nexus-security.json`; `NEXUS_TRUST_WORKSPACE=1` | prevented: the policy is the base's, read as untrusted | `verify_typecheck_guard`: "the policy is the base tree's" |
| The head deletes the base's stricter policy | lowered: the base's policy still applies; the deletion is a finding | `verify_hostile`: "deletes the base's stricter policy" |
| The head commits `node_modules/.bin/node` (a fake runner) | lowered: `VERIFIER_DEFINITION_CHANGED`; the shim never runs | `verify_hostile`: "node_modules/.bin/node" |
| The head adds a fake `node` in the tree, a `bin` entry, a `preinstall` hook | prevented: none is consulted; the real tests run | `verify_hostile`: "fake `node` at the top of the tree" |
| Product code reads the expected value from the test file | **limit**: `VERIFIED` claims what the tests check, no more | `verify_hostile`: "documented limit: product code that reads the expected value" |
| A test rewrites test files, the product or itself while it runs | prevented: judged on a copy no code ran in | `verify_command`: "restores itself while it runs"; `verify_hostile`: "rewrites the base's test file"; `verify_typecheck_guard`: "the pristine-copy rule" |
| A test rewrites the scratch state beside its tree | prevented by the default sandbox; possible only with explicit `--sandbox none` | `verify_hostile`: default confinement, explicit opt-out |
| A test writes the caller's checkout or its dependency directory | denied by the default sandbox; possible only with explicit `--sandbox none` | `verify_sandbox`: "a hostile test cannot write the caller's checkout" |
| `NEXUS_TRUST_WORKSPACE`, `NEXUS_TYPECHECK`, `NEXUS_VERIFIER_TIMEOUT_SECS`, `NEXUS_VERIFIER_ENV_PASSTHROUGH`, `NEXUS_SANDBOX_NETWORK` set by the caller | recorded by name; none raises the known-bad change (`NEXUS_TYPECHECK=off` disables type-checks, as documented) | `verify_hostile`: "each verdict-affecting environment variable"; `verify_command`: "recorded by name" |
| Base equal to head | lowered: `NOTHING_TO_VERIFY`, exit 2 | `verify_command`: "base equal to head" |
| A head that is an ancestor of the base; a base chosen after the weakening | lowered: `VERIFIER_FAILED`; at most `REGRESSION_FREE` | `verify_hostile`: "ancestor of the base", "base chosen after the commit that weakened" |
| Refs that look like options or hold shell text | prevented: usage error, nothing executed | `verify_hostile`: "refs that look like options" |
| A worktree path or a tree directory with spaces, quotes, line breaks, `$(...)` | prevented: paths are arguments, or quoted | `verify_hostile`: "a worktree path with spaces"; `verify_sandbox`: the composition tests |
| `--verifier` with shell metacharacters | by design the operator's shell command; recorded verbatim, source `configured` | `verify_hostile`: "a --verifier with shell metacharacters" |
| A test file replaced by a symlink leaving the tree; links to sensitive paths | lowered: `GUARD_INCOMPLETE`; nothing written through a link | `verify_hostile`: "symlink to a weakened copy outside the tree" |
| A submodule or gitlink; a repository planted in a subdirectory or a linked worktree | lowered: `UNSUPPORTED_TREE` / `UNTRUSTED_CHECKOUT`; its configuration runs nothing | `verify_command`: "a tree with a submodule", "a repository planted inside it"; `verify_hostile`: "a repository planted in a subdirectory" |
| `.gitattributes` naming filters and diff drivers, with `.git/config` defining them; `core.fsmonitor`; hooks | prevented: no repository-defined program runs while trees are staged or written | `verify_hostile`: "a checkout whose .git/config defines content filters" |
| A filter defined in the operator's own Git configuration, selected by the tree | **limit**: it is the operator's and runs | `verify_hostile`: "documented limit: a content filter defined in the operator's own" |
| A tree over the file or size limit | lowered: `TREE_LIMIT_EXCEEDED` | `verify_command`: "working tree over the file limit"; `verify_hostile`: "more files than the limit" |
| A path longer than the file system allows | lowered: `INTERNAL_ERROR`, exit 1, nothing run | `verify_hostile`: "a path longer than the file system allows" |
| A deeply nested tree | lowered: at most `REGRESSION_FREE` | `verify_hostile`: "60-level directory chain" |
| File names with control characters; names that are not valid UTF-8 | prevented (escaped in every output); lowered: `UNSUPPORTED_TREE` | `verify_hostile`: "ANSI escape", "not valid UTF-8" |
| Output that forges the verdict, the JSON document or terminal escapes | prevented: one document on stdout; repository output only behind a margin, escaped | `verify_hostile`: "a forged verdict" |
| Hostile action inputs and event fields | prevented: data, never shell | `verify_action`: "hostile input and event values" |
| `--sandbox` requested, engine unusable | lowered: `SANDBOX_UNAVAILABLE`, nothing run | `verify_sandbox`: "an engine that is not usable" |

## Limits that remain

- With explicit `--sandbox none`, a change written to attack the verification can raise its own verdict (above). The default fails closed; remaining trust is in the sandbox engine, in what you installed into dependency directories, and in your own `--verifier`.
- `VERIFIED` is a statement about tests, not about correctness, safety or review.
- An approved verification edit is your decision: read the file first. Approval never yields `VERIFIED`, but a runner configuration you approved (a `conftest.py`) can make failing tests report `REGRESSION_FREE`.
- Content filters in your own Git configuration (Git LFS) run when the tree's attributes select them; ones defined in the repository's own configuration do not, so a file they would have converted is read and written as stored.
- The steps of the example that enable Bubblewrap on a hosted runner (`apt-get install bubblewrap`, the AppArmor setting) and the Docker engine with a custom image are not exercised by this repository's CI. If an engine does not work there, the result is `BLOCKED`, not an unconfined run.
- The Docker engine removes a container whose run timed out by name; that path is not covered by a test.
