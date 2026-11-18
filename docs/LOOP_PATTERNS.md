# Loop patterns: what Nexus does (CS-11)

OpenHands' stuck detector names four patterns of an agent going nowhere. `cli/test/loop_patterns.test.ts` replays each as a scripted transcript against the real agent turn (scripted gateway, deterministic tool results) and asserts what Nexus **measurably does**, in both configurations: with continuation (the default, which runs the non-progress tracker as well) and with `--no-continuation` (only the repeated-call detector from CS-3, `cli/src/core/repeated_calls.ts`). The file is deterministic (five consecutive runs, 11 of 11 each); a changing result is produced by a counter file, never the clock.

| # | Pattern | With continuation (default) | `--no-continuation` (CS-3 alone) |
|---|---|---|---|
| 1 | The same action and the same result, repeated | A recovery note at the third repeat; the model then finishes (`COMPLETED`) | One "same arguments" note at the third repeat, no stop |
| 2a | The same command erroring with the same text | Ends `LIMIT_REACHED` / `STAGNATION_DETECTED` with the notes delivered, well before the script runs out | A note at the third repeat; the stop is deliberately at ten for a command |
| 2b | The same command erroring with **different** text each time | **Not stopped, and no note.** Six failing calls complete (`COMPLETED`); only the step limit bounds it | No note, no stop (a changing result is progress to CS-3 by design) |
| 3 | Consecutive messages without progress | Cannot build up: a text-only reply ends the turn and returns control to the operator | Same |
| 4a | An A/B observer ping-pong | Ends `LIMIT_REACHED` / `STAGNATION_DETECTED` | `BLOCKED` / `TOOL_CALL_LOOP` in the fifth cycle |
| 4b | An A/B command ping-pong | Ends `LIMIT_REACHED` / `STAGNATION_DETECTED` | Both calls noted at three; the stop is deliberately at ten each |

## The gap

Pattern 2b is a real gap against the reference: a command that keeps failing with a different message each time (a counter, a timestamp, a path) draws neither a note nor a stop, so a loop of that shape runs to the step limit. It is by design in the current guards (a changed result counts as progress, which is what keeps a legitimate edit-test-fix loop alive), and it is bounded by the step limit; the verifier-failure stop (DV-2/VC-7) covers it when the command is the verifier. A fix would have to tell "the failure text changed" from "the failure changed", which needs a normalisation of volatile text (numbers, times, paths) and was not attempted here. It is listed in [`docs/v1.2.2/BACKLOG.md`](v1.2.2/BACKLOG.md).
