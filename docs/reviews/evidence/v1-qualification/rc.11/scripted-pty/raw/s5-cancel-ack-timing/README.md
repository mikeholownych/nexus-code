# RC11 s5 cancellation-acknowledgment timing rerun

Three trials against the exact installed RC11 binary and its local synthetic gateway. `measure.py` timestamps immediately before the Ctrl-C PTY write and at the first received terminal output whose rendered screen contains `cancelling`. It then records time to the visible `Cancelled` state and composer. All three acknowledgments were observed within the 16.667ms 60Hz frame budget; all three returned idle within 5s.

- Trial latencies: 3.366ms, 2.266ms, 2.990ms.
- Idle latencies: 188.367ms, 429.878ms, 521.106ms.
- Artifact SHA-256 and runner versions: `runtime.txt`.
- Raw measurements and per-trial screens: `measure.log`, `s5_ack_1.raw` through `s5_ack_3.raw`, and `s5_ack_1.screens.txt` through `s5_ack_3.screens.txt`.
- The initial runner setup attempt lacked `pyte` and stopped before a trial. That environment failure was fixed using the pinned test dependency in a disposable venv; it is not counted as a product result.

This synthetic PTY measures the first cancellation-state output observable by the runner; it does not claim physical-display refresh evidence.
