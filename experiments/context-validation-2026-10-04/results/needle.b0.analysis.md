| target | actual prompt tokens (mean) | n | correct | accuracy [95% CI] | lookalike chosen | mean wall s |
|---|---|---|---|---|---|---|
| 11000 | 10106 | 30 | 28 | 0.93 [0.78, 0.99] | 1 | 11.8 |
| 15000 | 13962 | 30 | 30 | 1.00 [0.88, 1.00] | 0 | 5.9 |
| 25000 | 23864 | 30 | 28 | 0.93 [0.78, 0.99] | 1 | 15.3 |
| 35000 | 33742 | 30 | 29 | 0.97 [0.83, 1.00] | 1 | 20.5 |
| 50000 | 48531 | 30 | 30 | 1.00 [0.88, 1.00] | 0 | 35.1 |

by position:
  early: 58/60
  middle: 50/50
  late: 37/40
by fact:
  flag: 35/35
  legacy_ts: 37/40
  region: 33/35
  rounding: 40/40
errors: 0
