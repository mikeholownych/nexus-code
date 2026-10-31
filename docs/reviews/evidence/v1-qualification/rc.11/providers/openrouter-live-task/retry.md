# Corrected RC11 OpenRouter synthetic task run

- Repeated 2026-10-30, immediately after the first synthetic task attempt.
- Candidate: `v1.0.0-rc.11`, source `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`; installed binary reported `1.0.0-rc.11 (8d4e5319f1a3)`.
- Host: operator-managed Ubuntu desktop, x86_64.
- Provider/model: OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Fresh temporary fixture; the only initial files were `math.js` and `test/math.test.js`.
- The operator-declared deliverable was `math.js`. Nexus was instructed to include negatives and zero in the sum, preserve the API and test files, and use `node --test test/math.test.js` as the authoritative verifier.
- Nexus edited only `math.js`, ran the verifier, and returned `TASK COMPLETED - VERIFIED (node --test test/math.test.js)`.
- Independent post-run validation: `node --test test/math.test.js` passed 2/2, 0 failures, 0 skipped.
- Final source SHA-256: `bc76f0d4e4eb65aa08a1f100e43d1f668c0bf575cf9e57f8d6088c208791b299`.
- Test SHA-256: `06cd51c8f5eb9c7ab6748bb4a69811d67c8abac01e83fbd08ca9fe7311afac51`, matching the first-run fixture: tests were unchanged.
- Nexus was reported to use 5 provider requests, 27,841 input tokens, 607 output tokens, and `$0.00` provider-reported cost. The raw task transcript and flightlog were not retained, so this attempt is not independently reproducible from the packet; no configured step cap or observed step count is available.

The first workspace's verifier refusal is documented in `README.md`. The repeat changed only task setup by declaring the product deliverable explicitly; the task and tests were the same. Its `VERIFIED` disposition and post-run test result are operator-reported observations, not independently reproducible from retained raw artifacts. No held-out content or user data was used.
