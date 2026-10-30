# RC11 scripted PTY evidence recovery review

This recovery note supersedes the s1 disposition in `RC11-SCRIPTED-RESULTS.md`; the broader suite still needs independent review and criterion-by-criterion acceptance.

- Exact candidate: v1.0.0-rc.11, source `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`.
- Installed package archive SHA-256: `72d73f3565a48fb83d0c9a13a93fe38c2a3ae8af75184dab3af73c0b749c4053`.
- Full runner `run_all.py` ran from 2026-10-30 00:23:53–00:26:16 UTC and left scenario logs, but its process exit status was not retained in the recovery record. Do not infer an overall suite pass from the logs alone.
- The original s1 script captured helpful endpoint and retry guidance, then sent Ctrl-C at about 35 seconds. That first attempt was incomplete and does not establish the §5.2 result.
- A fresh isolated s1 retest ran against the same installed artifact and unreachable endpoint. Its retained screen, raw PTY stream, and timestamped assertion log show the required guidance after 120.34 seconds, with the TUI still available; `/quit` then exited cleanly. The first harness's `natural_process_exit=false` and `idle_or_turn_finished=false` checks were incorrect because §5.2 requires the turn to end, not the TUI process to exit. The corrected assertion log passes the actual criterion: the guidance screen appeared within 2.5 minutes and the TUI remained usable. Result: **PASS** for s1. The curated, checksummed artifacts are in `raw/s1-asserted-retest-curated/`. Ignored `.nexus` task/session records are absent from this packet and are not used to support the result.
- No held-out data, production provider, credentials, or power-loss scenario was used. This is not power-loss recovery evidence.
- s2–s9 and r1a/r1d have retained observations; their per-criterion evidence still needs review. §5.3 remains waived by DEC-20; mandatory §5.1 and §5.2 are not waived.

Artifacts for the earlier natural-completion attempt are in `raw/s1-natural-retest-curated/`; its local `SHA256SUMS` covers the retained harness, notes, screen, raw PTY stream, and run log. It does not cover runtime `.nexus` task/session state, which is not included or relied on.
