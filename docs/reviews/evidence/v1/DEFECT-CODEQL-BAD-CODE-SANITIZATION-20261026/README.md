# CodeQL alerts 48/49: code construction from temporary marker paths

| | |
|---|---|
| Base revision | `e61255ec6b3ae0a1ed007ce6e53132324e2e80e9` (`origin/main`, RC8 version bump) |
| Branch | `v1/defect-codeql-code-sanitization` |
| Alerts | [#48](https://github.com/mikeholownych/nexus-code/security/code-scanning/48), [#49](https://github.com/mikeholownych/nexus-code/security/code-scanning/49) |
| Rule | `js/bad-code-sanitization` (CodeQL 2.27.3, severity `error`, security severity `medium`, CWE-79/94/116) |
| Location | `cli/test/eval_integrity.test.ts:815`, columns 104–132 (`JSON.stringify(signalMarker)`) and 205–232 (`JSON.stringify(readyMarker)`) |
| Latest analysis | analysis `2024651921`, ref `refs/heads/main`, commit `e61255e`, 2026-10-26T04:23:43Z, 3 results |

## Review

Both open alerts are the same finding at one line: the SIGTERM-grace test built a Node program as a template literal and
interpolated the two marker paths into it, then executed it with `node -e`. The paths are
`fs.mkdtempSync(path.join(os.tmpdir(), …))`, so they derive from the environment's temporary directory. CodeQL treats
the interpolated value as flowing into executable code and does not accept `JSON.stringify` as a code-injection
sanitizer.

Risk assessment:

- **Test-only.** The location is an evaluation-integrity test; no production path builds code this way.
- **Not exploitable as written.** `JSON.stringify` produces a correctly escaped JS string literal, so a quote or
  backslash in `TMPDIR` cannot break into the child program. An attacker who controls `TMPDIR` already controls the
  test process environment.
- **Still worth fixing.** The values never needed to be in the source; passing them as `argv` removes the pattern
  instead of dismissing the alert, and avoids relying on `JSON.stringify` as a security boundary.

The third result in the same analysis is the already-dismissed alert #34
(`js/insufficient-password-hash`, `cli/src/protocols/common.ts`, reason "false positive", 2026-10-20); it is not an
open alert and is unchanged by this slice.

## Fix

The fixture now passes both marker paths as process arguments:

- the child program reads `process.argv.slice(1)` for `signal` and `ready`;
- the parent program forwards its own `process.argv[1]`/`[2]` to the child;
- `spawnContained` is invoked with `["-e", parentScript, signalMarker, readyMarker]`.

No temporary-directory value is interpolated into executable source any more. Test semantics are unchanged: the child
registers its SIGTERM handler, writes the ready marker, and flushes `flushed` 400 ms after the supervisor's SIGTERM.

## Verification

- Standalone argv check: `node -e <childScript> <signal> <ready>` with a marker path containing a space writes `ready`
  and flushes `flushed` on SIGTERM.
- Standalone parent→child check: a detached `node -e <parentScript> <signal> <ready>` writes `ready`, and a
  process-group SIGTERM flushes `flushed`.
- `tsc --noEmit`, `git diff --check`: clean.
- Focused execution under the `SUITE` claim (isolated `HOME`/`XDG_CONFIG_HOME`):
  `npx tsx --test --test-concurrency=1 --test-name-pattern="SIGTERM grace" test/eval_integrity.test.ts`
  → **1/1 pass** (2.8 s), log `/tmp/opencode/codeql-sigterm.log`. The test needs the systemd user manager
  (`XDG_RUNTIME_DIR`, `systemd-run`), which is present on this host.

## Closure

No alert suppression or dismissal was used. After this branch is merged to `main`, the next CodeQL analysis of
`refs/heads/main` should mark alerts 48 and 49 fixed because the tainted interpolation no longer exists.

## Residual risk

- Other evaluation fixtures in the same file still build programs for `node -e` (candidate probes, sandbox scripts) but
  were not flagged by this analysis; they are outside this alert pair and were not changed.
- The test remains dependent on a working systemd user scope (`XDG_RUNTIME_DIR`, `systemd-run`) and Bubblewrap, as before.
