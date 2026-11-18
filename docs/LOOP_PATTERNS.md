# Loop patterns: what Nexus does (CS-11)

OpenHands' stuck detector names four patterns of an agent going nowhere. `cli/test/loop_patterns.test.ts` replays each as a scripted transcript against the real agent turn (scripted gateway, deterministic tool results) and asserts what Nexus **measurably does**, in both configurations: with continuation (the default, which runs the non-progress tracker as well) and with `--no-continuation` (only the repeated-call detector from CS-3, `cli/src/core/repeated_calls.ts`). The file is deterministic (five consecutive runs, 11 of 11 each at the time; now 13 tests); a changing result is produced by a counter file, never the clock.

| # | Pattern | With continuation (default) | `--no-continuation` (CS-3 alone) |
|---|---|---|---|
| 1 | The same action and the same result, repeated | A recovery note at the third repeat; the model then finishes (`COMPLETED`) | One "same arguments" note at the third repeat, no stop |
| 2a | The same command erroring with the same text | Ends `LIMIT_REACHED` / `STAGNATION_DETECTED` with the notes delivered, well before the script runs out | A note at the third repeat; the stop is deliberately at ten for a command |
| 2b | The same command erroring with only **volatile text** changing (a counter, a retry number, a port, a temp name) | A recovery note, then `LIMIT_REACHED` / `STAGNATION_DETECTED`, before the script runs out (was: not stopped, no note) | A note at the third repeat; the stop is deliberately at ten for a command (was: no note) |
| 2c | The same command failing with a **genuinely different** error each time | Not stopped, no note (`COMPLETED`): each new failure is progress | Same: no note, no stop |
| 3 | Consecutive messages without progress | Cannot build up: a text-only reply ends the turn and returns control to the operator | Same |
| 4a | An A/B observer ping-pong | Ends `LIMIT_REACHED` / `STAGNATION_DETECTED` | `BLOCKED` / `TOOL_CALL_LOOP` in the fifth cycle |
| 4b | An A/B command ping-pong | Ends `LIMIT_REACHED` / `STAGNATION_DETECTED` | Both calls noted at three; the stop is deliberately at ten each |

## The gap (CS-11 closed, measured)

Pattern 2b was a real gap against the reference: a command that kept failing with a message differing only in a counter, a timestamp or a path drew neither a note nor a stop, because a changed result counted as progress. It is closed by teaching `normalizeOutcomeText` (`cli/src/core/execution_tracking.ts`) more volatile text, **corpus first**: `cli/test/fixtures/volatile_text_corpus.json` holds 86 labelled pairs of command outputs (tsc, node test runner, pytest, go test, cargo, npm, curl, pip, make, docker, eslint, jest) and `cli/test/volatile_text_corpus.test.ts` measures the normaliser against it. A pair is "merged" when both outputs get the same outcome identity.

| | Total | Merged | Told apart |
|---|---|---|---|
| same-failure pairs, before | 38 | 6 | 32 (the gap) |
| same-failure pairs, after | 38 | 34 | 4 |
| different-failure pairs, before | 48 | 0 | 48 |
| different-failure pairs, after | 48 | **0** | 48 |

The number that must stay zero is a genuinely different failure merged into a repeat. The new patterns are therefore anchored to a context word or a unit and never replace a bare number (that would merge line 12 with line 40, and "3 failed" with "2 failed"): retry counters (`attempt 3 of 5`, `Retry 2/5`, `Retry(total=4`, `after 3 attempts`, `failed 17 times`), request/poll numbers, job/build/run ids, ephemeral ports (32768 and up; a fixed port such as 3000 or 8080 is part of the failure), temp directories (`/var/folders/..`, `/var/tmp/..`, `pytest-17`, mkdtemp names with a digit), artifact hashes (cargo `deps/x-<16 hex>`, webpack `name.<hash>.js`), progress counters (`[12/340]`, `Downloading .. 45%`, `processed 142 files`), compound and long-unit durations (`2m05s`, `milliseconds`, `duration_ms:`). `outcomeIdentity` still separates success from failure.

Same-failure pairs still told apart (deliberately not fixed, S35-S38): a random directory suffix with no digit and no `tmp` prefix (`/work/build-Xkqzpw/`), an unanchored counter (`consecutive failures: 4`), a queue depth (`depth 8921`), and a short git sha in a message. Each has only a bare number or random letters to go on; merging them needs a blanket rule that the corpus shows would also merge distinct failures. A loop of that shape is still bounded by the step limit, and by the verifier-failure stop (DV-2/VC-7) when the command is the verifier. The agent scenario (`loop_patterns.test.ts`, 2b and 2c) shows the effect on the real turn: a counter-only change is now noted and stopped; a genuinely different error each time is not. The corpus is a measurement, not a proof: a pattern is only as safe as the pairs that test it, so a new volatile pattern adds pairs on both sides first.
