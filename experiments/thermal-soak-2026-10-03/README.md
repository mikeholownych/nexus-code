# Sustained-inference thermal soak (2026-10-03)

Question: what do the two Arc Pro B65 GPUs actually do thermally under *sustained, representative* llama.cpp inference on
this Dell Precision 5820 (Xeon W-2123, BIOS 2.51.1, kernel 7.0.0-34), and does anything justify the current thermal
policy (monitoring warning 75 C / critical 85 C, benchmark abort 90 C)?

**No threshold or guardrail was changed by this work.** It is evidence collection; the policy decisions are listed at the end.

## Method
- One 54-minute run through the gateway aliases `engineering/lead` (GPU 0, Qwen3-Coder-30B-A3B Q4_K_M) and `engineering/deep`
  (GPU 1, Qwen3.5-27B Q4_K_M), both GPUs loaded the whole time, closed-loop (next request starts when the last ends).
- Phases: 120 s idle baseline -> **decode-heavy 1320 s** (short prompt, 1500/700 generated tokens) -> **prefill-heavy 1320 s**
  (unique ~14k-token prompts, the mean agent context on this host, no cache reuse) -> 480 s cooldown. Started from a cool
  state (all GPU sensors <= 34 C).
- 1 Hz recording of every GPU sensor (20 per card), energy, graphics-tile idle residency, actual frequency, every throttle
  flag, GPU fan; host CPU temperatures/load, chassis fans, NVMe, five unlabeled `dell_smm` temperatures; per-request
  throughput; gateway engine metrics every 10 s.
- Safety: load would have stopped at 90 C on any GPU sensor (the existing guardrail, used only as a stop). It never tripped.
  The soak was not intended to approach the reported critical limits and did not.
- Not evidence: a 65 s dry run of the instrument (discarded) and three earlier short probes (GPU-to-worker mapping, a 100 s
  load, a prefill sizing request).

## Results (all from `analysis/analyze.py`; tables in `analysis/analysis_output.txt`, curves in `analysis/plots/`)

**Equilibrium.** Every sensor reached a plateau: 90% of the rise within 83-189 s of load start, and the last-5-minute slope of
every sensor is within +-0.14 C/min. The 22-minute phases are at thermal steady state.

| Steady state (last 5 min of phase), C | decode | prefill | peak (whole run) | idle |
|---|---|---|---|---|
| GPU 0 package | 66.0 (63-66) | 65.2 (62-67) | 67 | 30 |
| GPU 0 VRAM (hottest channel) | 76.0 (74-76) | 72.3 (70-74) | 76 | 32 |
| GPU 1 package | 69.0 (66-70) | 69.0 (63-70) | 70 | 31 |
| GPU 1 VRAM (hottest channel) | **82.6 (80-84)** | 79.9 (74-80) | **84** | 34 |
| memory controller / PCIe | 49-51 / 67-69 | 49-51 / 66-69 | 51 / 70 | 23 / 32 |

Decode (memory-bound) runs the VRAM 2.7-3.7 C hotter than prefill. The `vram` sensor does not exactly equal the hottest of the 16 channels: across the 3,244 samples the two differed in
10 GPU 0 samples and 27 GPU 1 samples, each observed difference exactly 2.0 C (discovered by the offline policy replay, see
`policy-replay/README.md` erratum and `policy-replay/tests/test_thermal_policy_replay.py`). The
hottest channel reads **6.0 C (GPU 0) / 8.2 C (GPU 1) above the median channel** at the decode plateau.

**Margins on the hottest observation.** GPU 1 VRAM peak 84 C is 21 C below the kernel `crit` (105), 36 C below the shutdown
`emergency` (120), 6 C below the 90 C benchmark abort and **1 C below the current 85 C critical**. Package peak 70 C is 30 C
below its `crit` (100).

**Throttling.** In 3,244 samples on both GPUs **no thermal flag was ever raised** (`thermal`, `prochot`, `vr_thermalert`,
`ratl` all zero). The only flag is **PL2 power limiting on GPU 1: raised in 2,482 of 2,640 loaded samples (94.0%; 96% in decode, 92% in prefill)**.
It engages during the first minute of load (64% of those samples) and from the second minute on holds at about 98%; card power
sits at 198 W (cap 200 W) and the actual frequency runs at a median 2333 MHz in decode and 2250 MHz in prefill against
2400 MHz (-2.8% / -6.3%). GPU 0 draws about 141 W and never throttles. **Throughput is flat over each
22-minute phase** (decode: lead 83.1 -> 83.6 tok/s, deep 21.5 -> 21.6; prefill: lead 1212 -> 1209, deep 759 -> 759;
|Spearman(rate, temperature)| <= 0.19; 0 failed requests): no temperature-related performance change was observed.

**Against the current policy (informational).** VRAM >= 75 C for **39% (GPU 0) and 95.5% (GPU 1) of the loaded time**, so the
75 C warning is effectively an "inference is running" signal, while the 85 C critical was never reached (peak 84 C).

**Single-sample behaviour (the abort evidence).** Sensors have 1 C resolution. Isolated one-sample upward excursions >= 2 C
occur in 0.66% (GPU 0) / 0.81% (GPU 1) of VRAM channel-samples under the primary definition (neighbours +-3 samples) and in
1.09% / 1.39% under the independent cross-check's stricter definition (neighbours +-2 samples); the share therefore depends on
the definition, but **the largest excursion is +2 C under both**. Larger sample-to-sample jumps are real transitions. So noise is small; the issue is proximity. What a threshold T with persistence N seconds would have done to the
hottest sensor in the loaded phases (separate trips):

| | N=1 s | 3 | 5 | 10 | 30 | 60 |
|---|---|---|---|---|---|---|
| GPU 0, T=75 C | 17 | 15 | 14 | 14 | 9 | 7 |
| GPU 1, T=75 C | 10 | 10 | 10 | 10 | 10 | 6 |
| GPU 1, T=80 C | 47 | 46 | 45 | 44 | 20 | 1 |
| T=85 C or 90 C (either GPU) | 0 | 0 | 0 | 0 | 0 | 0 |

**Cooling and host.** The hottest sensor loses 50% of its excess in 63-92 s and 90% in 346-379 s. GPU fans: GPU 0 idles at
about 1080 rpm and runs 1680; GPU 1 **idles at 0 rpm** and runs 2400-2460. During load the busiest CPU core is at **98%**
with total CPU at 28% (the single-thread bottleneck persists under llama.cpp). Ambient: no labeled sensor; `dell_smm` `temp5`
read a constant 25.0 C and `temp7` rose 26.2 -> 28.0 C, so the room was probably about 25-28 C. **Identity unverified.**

## Scoped conclusion
Within this workload, ambient condition (about 25-28 C, unverified), hardware configuration and observation period, the
cooling system reached thermal equilibrium while both GPUs sustained useful inference, with no observed thermal throttling and
no temperature-correlated throughput degradation. This says nothing about warmer rooms, restricted airflow, other workloads,
component aging or maximum safe temperatures; Intel's recommended continuous operating temperature remains unknown.

## Independent cross-check of the numbers
`analysis/verify_independent.py` recomputes the published figures from the raw files with a deliberately different
implementation (generic data walking, regex flag counting from the raw text, least-squares and Theil-Sen slopes, sustained
unsmoothed threshold crossings, a different spike definition, per-sample phase labels, requests bucketed by completion time)
and does not reuse `analyze.py`. Result (`analysis/independent_verification.txt`): **93 of 93 checks agree within their
stated tolerances**, covering raw-file integrity against the host hashes, run shape, every throttle flag, plateau mean/min/max
for package and VRAM in both phases, least-squares slopes and first-half/second-half drift, warm-up times, throughput,
time above 75 C, the persistence what-if table, power, frequency and cooldown. Two honest notes: Theil-Sen slopes are
identically 0.000 on 1 C-quantised flat data, so they do not test the published least-squares slopes (those are checked
separately and match); and the spike percentage is definition-dependent (above). This is a second implementation by the same
author, not third-party review.

## Operator observation (relayed, subjective)
As relayed by the operator in review commentary on 2026-10-03 (not witnessed or measured by the analysis): no conspicuous
fan-noise excursion was perceived during the sustained load, in a noisy multi-host environment. It is an uncalibrated
impression and is **not** used to infer fan RPM, cooling-controller behaviour or acoustic limits; the RPM figures above come
from the sensors.

## Observations preserved for future work (nothing was tuned)
- GPU 1 (27B) meets a **power-control boundary (PL2, 200 W card limit) before any thermal boundary**; whether changing power
  limits would improve useful performance is untested.
- The busiest CPU core is at 98% while total CPU is 28% during llama.cpp inference: a single-thread bottleneck remains in the path.
- The two phases exercise materially different regimes (memory-bound decode, compute-bound cold prefill), which also explains
  the different cache and throughput behaviour seen in the console during the run.

## Caveats and limits
- One soak, one ambient (about 25-28 C, unverified), llama.cpp workloads only, two 22-minute phases. Nothing here says what
  happens at higher ambient or lower airflow; no extrapolation is made.
- `temp2_max = 60 C` on the package is unexplained (exceeded by 6-10 C with no throttle flag).
- Data quality: `act_freq` reads 0 at request boundaries (medians used); a few `dell_smm` fan readings are missing (counted in
  `summary.json`); the GPU fan trace shows brief dips (medians used, 0 dropouts below 300 rpm while loaded).
- Intel/board-vendor documentation publishes no thermal limits: see `research/intel-thermal-documentation.md`.

## Decisions deliberately not taken (to be made from this evidence)
1. Package warning/critical. 2. VRAM warning/critical (separately). 3. The 90 C benchmark abort value and which sensors it
applies to. 4. Persistence/debounce semantics. 5. Whether to record the GPU 1 PL2 limiting (about 6% clock cost in prefill)
as a baseline for later power tuning (preserved here as an observation only).

## Layout
`raw/` original host files + `host-sha256.txt` (verified identical after copy) | `analysis/analyze.py`, `plots.py`,
`verify_independent.py`, `independent_verification.txt`, `summary.json`, `analysis_output.txt`, `plots/` | `research/` | `SHA256SUMS`.
