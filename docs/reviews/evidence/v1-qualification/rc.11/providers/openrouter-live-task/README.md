# RC11 OpenRouter synthetic live task

- Candidate: `v1.0.0-rc.11`, source `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`.
- Installed binary: Nexus in an isolated installation prefix; version output `1.0.0-rc.11 (8d4e5319f1a3)`.
- Host: operator-managed Ubuntu desktop, x86_64; isolated temporary task workspace.
- Provider/model: OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Task scope: fix a deliberately incorrect arithmetic sum implementation so negatives and zero are included; keep API and supplied tests unchanged.
- Workspace contained only the synthetic source and test at task start. No held-out or user files were used.
- Nexus changed `math.js` from filtering positive numbers to reducing all values. The test command returned 2/2 passing during execution.
- Nexus then rejected `task_completed` with `The workspace-resolved verifier definition changed after its baseline` and ultimately reported `TURN ENDED - NOT ESTABLISHED` / `VERIFIER_FAILED: node --test test/math.test.js`. This is a failed Nexus completion/verification disposition, not a verified task success.
- Operator-reported independent post-run check: `node --test test/math.test.js` passed 2/2, 0 failures. The raw output and fixture were not retained, so this result is not independently reproducible from this packet.
- Final source SHA-256: `bc76f0d4e4eb65aa08a1f100e43d1f668c0bf575cf9e57f8d6088c208791b299`.
- Test SHA-256: `06cd51c8f5eb9c7ab6748bb4a69811d67c8abac01e83fbd08ca9fe7311afac51`.
- Run requested `--max-total-steps 8`, `--max-turn-minutes 4`, and `--stagnation-steps 3`; the operator reported 13 step records before the tool terminated with verifier failure. Raw task transcript and flightlog were not retained, so the count and enforcement behavior are not independently reproducible from this packet.
- Provider-reported usage: 13 requests, 86,778 input and 1,593 output tokens, `$0.00` reported.

The successful provider verification and operator-reported fixture test do not establish standalone, held-out, T3/T4, or overall RC acceptance. The Nexus task itself remains `NOT_ESTABLISHED` because its verifier gate failed.
