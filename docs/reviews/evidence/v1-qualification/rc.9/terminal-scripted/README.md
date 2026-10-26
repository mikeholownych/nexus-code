# RC9 installed scripted terminal evidence

This evidence records scripted pseudo-terminal scenarios against the workflow-produced, installer-installed Nexus Code v1.0.0-rc.9 package. The launcher used was the installed `nexus` command, which starts the packaged TUI, sidecar, and `harness-core`. The synthetic mock gateway and synthetic workspaces are included in the test scripts; no user workspace or held-out task payload was used.

The package identity is source commit `4cae11cbc3b0eab9bd6f56df7cc34e946b5dc566`, archive SHA-256 `35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb`. The installed package `.provenance.json` binds that digest and source revision. The installed package manifest SHA-256 is `4cf1b288892891c3db6135c8bb9919e4a21e871ef2c5be5c211e39fa13bde0e6`.

## Observed scripted results

- **s1 startup/unreachable endpoint: PASS.** The UI names `http://127.0.0.1:9/v1`, recommends `nexus doctor`, checking `LOCAL_LLM_ENDPOINT`, or `/connect`; the run was cancelled at about 34 seconds, within 2.5 minutes.
- **s2 approval input isolation at 40×14: PASS.** Continuous typing, bracketed paste, an unbracketed burst, and a lone `y` did not approve. A deliberate Left selection followed by Enter approved and created the synthetic file.
- **s3 completion truthfulness: PASS.** A changed file with no test command was reported as “Done · not verified”. This is a UI truthfulness check, not a quality verification.
- **s4–s6 cancellation and steering: PASS for scripted checks.** A separate three-trial timing run observed the streaming Ctrl-C “cancelling” acknowledgment in 2.13–2.16 ms (within one 60 Hz frame) and return to idle under five seconds. Steering text was present in the next model request and both requested synthetic files were created. Esc during a running tool returned the UI to idle in about 0.79 seconds; no scoped `sleep` process remained.
- **s7 resume: PASS.** The prior conversation, including the synthetic Unicode phrase, appeared after resuming the session.
- **s8–s9 process cleanup: PASS.** Esc cancellation and quit during a synthetic tool left no scoped tool or RC9 TUI/sidecar/core process after exit.
- **r1a/r1d REPL approval: PASS.** A lone Enter and typed-ahead `y` followed by Enter did not create the synthetic file; cancellation was visible and typed-ahead input was discarded.

## Scope and remaining gates

These results cover scripted mock-gateway PTY scenarios only. They do not establish the manual five-terminal × three-size matrix (`ACC-TUI-MANUAL`), the full accessibility matrix for both `NO_COLOR` and `TERM=dumb` at 40×14 and 100×30, real provider qualification, held-out task quality, standalone gateway qualification, independent acceptance, or power-loss recovery. Failed or superseded harness attempts remain preserved outside this evidence directory under `/var/tmp/nexus-rc9-pty-4cae11c/attempt*`; they are not counted as passing evidence.

All files in this directory are covered by `SHA256SUMS`.
