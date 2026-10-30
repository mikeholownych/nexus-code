# RC11 scripted PTY evidence recovery review

This recovery note supersedes the s1 disposition in `RC11-SCRIPTED-RESULTS.md`; the broader suite still needs independent review and criterion-by-criterion acceptance.

- Exact candidate: v1.0.0-rc.11, source `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`.
- Installed package archive SHA-256: `72d73f3565a48fb83d0c9a13a93fe38c2a3ae8af75184dab3af73c0b749c4053`.
- Full runner `run_all.py` ran from 2026-10-30 00:23:53–00:26:16 UTC and left scenario logs, but its process exit status was not retained in the recovery record. Do not infer an overall suite pass from the logs alone.
- The original s1 script captured helpful endpoint and retry guidance, then sent Ctrl-C at about 35 seconds. That first attempt was incomplete and does not establish the §5.2 result.
- A fresh isolated s1 retest ran against the same installed artifact and unreachable endpoint. The durable task record shows first-contact recovery exhausted at 120 seconds, with the turn marked failed and the actionable doctor/config/connect guidance visible. The TUI correctly remained open at its composer for another turn. The first harness's `natural_process_exit=false` and `idle_or_turn_finished=false` checks were incorrect because §5.2 requires the turn to end, not the TUI process to exit. A corrected assertion then passed: the required screen appeared 120.34 seconds after the prompt, the TUI remained available, and `/quit` exited cleanly. Result: **PASS** for s1 within the 2.5-minute bound. The corrected run is in `s1-asserted-retest-20261030T0038Z/`; its local `SHA256SUMS` verifies all saved non-Git evidence files.
- No held-out data, production provider, credentials, or power-loss scenario was used. This is not power-loss recovery evidence.
- s2–s9 and r1a/r1d have retained observations; their per-criterion evidence still needs review. §5.3 remains waived by DEC-20; mandatory §5.1 and §5.2 are not waived.

Artifacts for the fresh s1 run are in `s1-natural-retest-20261030T0032Z/`; its local `SHA256SUMS` covers the saved harness, notes, screen, raw PTY stream, durable task/session state, and run log.
