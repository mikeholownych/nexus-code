# Offline thermal-policy replay

Strictly analytical, read-only tool. It replays an explicit candidate policy over the preserved raw 1 Hz soak
evidence (`../raw/samples.jsonl`) and reports what that policy *would have done*. It does not choose, recommend
or modify any threshold, alert rule, benchmark guardrail, service, hardware setting or raw evidence.

## Guarantees
- Raw evidence is opened read-only; its sha256 is recorded before and after (exit 3 on mismatch).
- Refuses to write output inside the raw directory (exit 2).
- Stdlib only; deterministic (same trace + policy -> identical output).
- `--drop` injects missing samples **in memory only**, and the report is stamped SYNTHETIC.

## Usage
    python3 thermal_policy_replay.py --policy examples/<policy>.json [--compare-persistence 1,5,10,30,60]
                                     [--drop gpu1:vram_hottest_channel:1200:1230] [--quiet]
    ./run_examples.sh          # regenerate every report under output/<policy>/{report.txt,result.json}
    python3 -m unittest discover -s tests

## Policy inputs (JSON)
`name`, `status` (`reference_current_configuration` | `illustrative_example` | `candidate_under_evaluation`), `rules[]`, each with:
sensor `class`, `state` (warning/critical/abort), `threshold_c`, `persistence_s`, `hysteresis_c`, `clear_persistence_s`,
`missing` (hold | clear | fail_closed), `gpus`.
Classes: `package`, `vram` (the `vram` sensor), `vram_hottest_channel` (max of the 16 channels, never averaged),
`memory_controller`, `pcie`, `any_sensor`. Package and VRAM are always distinct classes.

## Semantics
- Active when value >= threshold for N consecutive samples (N = ceil(persistence_s / dt)); N=1 is instantaneous.
- Clears when value < threshold - hysteresis for the clear persistence.
- Missing samples: `hold` keeps state, `clear` counts toward clearing, `fail_closed` activates.
- Combined state per GPU and `system` = highest active rule. Flap = escalation then de-escalation within 60 s.
- Every transition carries the raw observation (line number, timestamp, value, responsible sensor, phase) that caused it.
- `--compare-persistence` prints instantaneous vs persistent behaviour side by side (trips / active s / short episodes).

## Tests
31 deterministic tests: synthetic traces for threshold crossing, persistence, hysteresis, single-sample excursions,
oscillation around a boundary, missing samples (all three modes), sensor classes, combined state, policy validation,
read-only/determinism, plus real-data tests reproducing the published soak what-if counts. Six deliberate engine
mutations were each caught.

## Examples are illustrations, not recommendations
Everything in `examples/` and `output/` demonstrates tool behaviour. Values were chosen to straddle observed data so
the behaviour is visible. `reference-current-75-85-90` only restates the existing configuration. No policy selection
has been made.

## Erratum to the soak README
The soak README states that the `vram` sensor equals the hottest of the 16 channels. This is inexact: they differ in
10 (gpu0) and 27 (gpu1) of 3,244 samples, always by exactly 2.0 C (agree 99.7% / 99.2%). The soak's conclusions
(based on hottest-of-all-sensors and channel-vs-median figures) are unaffected. The soak README has been left
unchanged as instructed; the one-line correction is left to the owner's decision.
