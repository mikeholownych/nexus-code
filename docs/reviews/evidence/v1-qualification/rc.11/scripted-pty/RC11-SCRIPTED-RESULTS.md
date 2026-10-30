# Nexus v1.0.0-rc.11 installed scripted PTY results

- Candidate tag/source: `v1.0.0-rc.11` / `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`
- Linux archive SHA-256: `72d73f3565a48fb83d0c9a13a93fe38c2a3ae8af75184dab3af73c0b749c4053`
- Installed command: `/var/tmp/nexus-rc11-artifact.Wx2lPi/prefix/bin/nexus`; reports `1.0.0-rc.11 (8d4e5319f1a3)`.
- Evidence windows: full scenario run 2026-10-30 00:23:53–00:26:16 UTC; additional s1 follow-up evidence through about 00:34 UTC is recorded in `RECOVERY-STATUS-20261030.md` and its checksummed subdirectory.
- Environment: isolated HOME/XDG and synthetic workspaces under this directory; loopback-only mock OpenAI-compatible gateway; no held-out data, real provider, or credentials.

## §5.2 observations

| Scenario | Observed result |
|---|---|
| s1 unreachable endpoint | Screen names `http://127.0.0.1:9/v1`, gives `nexus doctor`, `LOCAL_LLM_ENDPOINT`, and `/connect` guidance at startup; retry guidance remained visible and the turn stayed responsive. The first full-run attempt was interrupted at about 35s and is not counted. A full-window capture returned the turn to the composer after 118.92s with provider recovery exhausted and `nexus doctor`, endpoint configuration, and `/connect` guidance displayed. The corrected isolated retest's retained screen, raw PTY stream, and timestamped assertion log show the same guidance 120.34s after the prompt; the TUI remained usable and `/quit` exited cleanly. Ignored local `.nexus` task/session state is not part of the tracked packet and is not relied on. The §5.2 predicate is turn completion with guidance within 2.5 minutes, not TUI process exit. |
| s2 approval at 40×14 | Continuous typing, bracketed paste, burst input, and a lone `y` did not create the file. Deliberate arrow-key selection and Enter sequence did create it. |
| s3 completion | Screen says `Done · not verified` because no test command was run; this is an accurate completion disposition. |
| s4–s6 cancellation / steering | Ctrl-C cancellation and steering behavior are visible in the retained PTY captures. A corrected timestamped s5 rerun measured the first visible `cancelling…` state 2.266–3.366ms after the Ctrl-C write in 3/3 trials (within a 16.667ms, 60Hz one-frame budget); idle returned in 188.367–521.106ms, within 5s. Steering was applied at the next request boundary and both synthetic files were created. Esc during an active tool returned to idle in 0.40s. The timed probe, exact runtime, and raw output are in `raw/s5-cancel-ack-timing/`. |
| s7 resume | Relaunch shows the prior Unicode conversation contents and identifies the resumed session. |
| s8–s9 tool cancellation / quit | Esc left no `sleep 23.7` process. The corrected RC11 named-survivor probe passed 3/3 runs: each run observed its `sleep 23.7` child before quit, then recorded the TUI exited and no matching process remained after the second Ctrl-C. Raw outputs, probe source, and source hashes are in `raw/s9-named-survivor/`. |
| r1a / r1d REPL approval | Lone Enter and typed-ahead `y` followed by Enter both denied the write; no file was created. |

The `run_all.py` process exit status was not retained, so no overall pass is inferred from its exit code. Test scripts do not assert every acceptance condition; the table above is based on retained screen captures, raw PTY streams, assertion logs, and scenario-specific evidence included in the packet. No untracked runtime task/session state is used to support these results.

## Harness and environment notes

- The inherited `s1b_default_endpoint_rc10.py` standalone smoke initially failed because it passed obsolete `--sidecar` arguments. This was not part of `run_all.py`'s §5.2 matrix. A corrected RC11 default-endpoint probe then passed, showing `http://localhost:1234/v1` and doctor/config/connect guidance. Both attempt artifacts are retained.
- The inherited `s9_quit_tool.py` searched an RC10-specific path and therefore did not establish process cleanup. A separate RC11 named-survivor probe passed three times. It refuses to run if a pre-existing `sleep 23.7` exists, confirms the tool child is present before quit, and confirms both TUI exit and child absence after quit. Original attempts remain retained and are not counted as cleanup proof.
- A pre-existing user dogfood process for `/home/mike/.local/lib/nexus/v1.0.0-rc.10` was visible during post-run process inspection. It is outside the isolated test process groups and was left untouched.

## Disposition

The retained evidence supports the listed §5.2 observations against the exact installed RC11 artifact, including the corrected 3/3 s9 named-survivor probe and 3/3 timestamped one-frame cancellation-acknowledgment trials. The updated packet is awaiting independent review. This does not establish whole-RC acceptance. Held-out custody/evaluation, provider and standalone qualification, T3/T4, cross-runner reproducibility, independent exact-RC acceptance, and stable-release gates remain separate. The §5.3 manual matrix is waived for v1.0.0 under DEC-20; §5.1 CI PTY remains mandatory.
