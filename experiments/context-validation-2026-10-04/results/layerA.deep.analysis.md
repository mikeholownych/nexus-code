| layout | reps | cumulative logical prompt tokens | cumulative UNCACHED tokens (prefill work) | cached share | mean wall/step s | total wall s | peak prompt tokens | est/provider ratio |
|---|---|---|---|---|---|---|---|---|
| L0 | 2 | 1027598 | 45206 | 95.6% | 2.72 | 81.5 | 45090 | 1.121 |
| L1 | 2 | 813122 | 36375 | 95.5% | 2.39 | 71.8 | 36259 | 1.104 |
| L2 | 2 | 438445 | 151230 | 65.5% | 7.26 | 217.7 | 21340 | 1.130 |
| L2b | 2 | 501098 | 52941 | 89.4% | 3.02 | 90.5 | 27055 | 1.121 |
| L3u | 2 | 789358 | 539783 | 31.6% | 25.87 | 776.2 | 33544 | 1.098 |
| L3s | 2 | 380101 | 116242 | 69.4% | 5.51 | 165.3 | 18030 | 1.119 |

contaminated rows (discarded): 0; gave-up blocks: []

relative to L0 (recorded):
  L0   logical tokens  100.0% | uncached (prefill) tokens   100.0% | total wall  100.0%
  L1   logical tokens   79.1% | uncached (prefill) tokens    80.5% | total wall   88.1%
  L2   logical tokens   42.7% | uncached (prefill) tokens   334.5% | total wall  267.0%
  L2b  logical tokens   48.8% | uncached (prefill) tokens   117.1% | total wall  110.9%
  L3u  logical tokens   76.8% | uncached (prefill) tokens  1194.1% | total wall  951.9%
  L3s  logical tokens   37.0% | uncached (prefill) tokens   257.1% | total wall  202.7%
