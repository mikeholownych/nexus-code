# Installed RC10 scripted terminal evidence

Candidate: v1.0.0-rc.10, source commit 16ee8ca3643824741b6da67936b41f262414fdf0, Linux x86_64 archive SHA-256 444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7. Each scenario launched the installed RC10 package. The installer provenance record binds that exact tag, source commit, and archive digest; strict SLSA verification for the archive and checksum index was completed separately on the host.

All workspaces and gateway responses were synthetic. No user workspace, credentials, held-out tasks, or real provider inference were used. Runtime and dependency identity are in runtime.txt and requirements.txt. Raw terminal streams, readable screen captures, scenario scripts, and mock gateway logs are retained and checksummed.

## Scenario results

- s1 unreachable endpoint: PASS. The installed TUI named http://127.0.0.1:9/v1 and showed nexus doctor, LOCAL_LLM_ENDPOINT, and /connect guidance. Corrected default-endpoint probe also passed and showed http://localhost:1234/v1 guidance. The first RC9-derived default-endpoint harness attempt is retained but incomplete because it passed obsolete --sidecar arguments and received unknown option.
- s2 approval input isolation at 40x14: PASS. Continuous typing, bracketed paste, an unbracketed burst, and a lone y did not write the synthetic file; a deliberate selection and confirmation did.
- s3 completion truthfulness: PASS. A changed file without a test command was reported as Done · not verified.
- s4 cancellation and steering: steering appeared in the next request; Esc during a running tool returned to idle in 1.09 s with no surviving sleep 23.7 process. The separate cancellation measurement below covers Ctrl-C timing.
- s5 Ctrl-C during streaming: PARTIAL / unresolved timing outlier. One original-style run showed cancelling but took 27.89 s to return idle, beyond the 5 s acceptance limit. A retained original-style retry and five exact-pattern repeats all returned idle in 2.21 s. Three separate controlled late-stream trials acknowledged Ctrl-C in 2.14–2.23 ms and returned idle in 0.21–0.58 s. The outlier is retained and has not been discarded; this E3 cancellation row is not marked accepted pending owner disposition or a justified rerun.
- s6 steering: PASS. Steering text appeared in the next model request and both synthetic files were created.
- s7 resume: PASS. The prior synthetic Unicode conversation was visible after resuming.
- s8 Esc cancellation and quit during a tool: PASS. No scoped sleep 23.7 process remained after cancellation or quit. A separate Esc timing probe returned idle and confirmed no scoped process survivors.
- s9 Ctrl-C quit during a tool: PASS. The installed RC10 TUI, sidecar, core and synthetic sleep process were absent after quit.
- r1a/r1d REPL approval: PASS. Lone Enter and typed-ahead y followed by Enter both denied the write; typed-ahead input was visibly discarded.
- Cancellation timing: the three late-stream Ctrl-C trials above passed one-frame acknowledgement and 5 s idle; the separate Esc-during-tool trial acknowledged in 398 ms and returned idle. The 398 ms Esc timing is reported as observed; the criterion for cancellation timing in ACCEPTANCE section 5.2 applies to s4–s6.

The first late-cancel diagnostic and its retry attempt with incorrectly escaped control input are retained as incomplete harness attempts; neither is counted as a product result. The final corrected test used a real Ctrl-C byte.

- ACC-TUI-A11Y sampled-state probe: PARTIAL_NOT_ACCEPTED. Ten states were captured with no color-setting SGR in the captured streams and a complete 40-column approval hint. Two full runs timed out waiting for Esc tool cancellation at TERM=dumb 100×30; one isolated retry passed in about 0.4 s. The state coverage is incomplete (eight of nine overlay variants were later observed in one TERM=dumb 40x14 supplemental subcase; the Detail overlay remains untested). A subsequent targeted TERM=dumb 100x30 cancellation recheck passed five of five attempts at 0–1 s delays, but the two original full-matrix timeouts remain unresolved. See accessibility/README.md and retained attempts.

## Disposition and remaining scope

Runner exit codes were zero for the 12 original scripts, but the original scripts do not assert every acceptance limit. Manual review found the s5 timing outlier above; therefore this evidence does not claim a clean pass of the entire scripted E3 gate. The source artifact and installed package identities are exact.

This evidence does not establish the manual five-terminal by three-size human matrix, full ACC-TUI-A11Y acceptance, standalone gateway qualification, real-provider qualification, held-out T2/T3, T4 fault injection, independent X5 acceptance, or power-loss recovery. Application process-death recovery is a separate gate and is not labeled power-loss evidence.
