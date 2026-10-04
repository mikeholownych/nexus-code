| cond | seed | execution/outcome | steps | requests | peak est ctx | cum est ctx | tests pass | tests untouched | api untouched | notes | modules fixed | duration s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c0w | 3 | FAILED/NOT_ESTABLISHED | 0 | 3 | 5315 | 9313 | False | True | True | False | 0/8 | 54.6 |
| c2w | 4 | None/None | None | 55 | 27279 | 745959 | True | True | True | True | 8/8 | 1086.7 |
| c0large | 2 | None/None | None | 16 | 48033 | 507906 | True | True | True | True | 8/8 | 361.0 |
| c0w | 4 | FAILED/NOT_ESTABLISHED | 0 | 3 | 5232 | 9236 | False | True | True | False | 0/8 | 49.3 |
| c2w | 3 | None/None | None | 45 | 27232 | 593285 | True | True | True | True | 8/8 | 796.0 |
| c0w | 2 | FAILED/NOT_ESTABLISHED | 0 | 3 | 5322 | 9329 | False | True | True | False | 0/8 | 54.5 |
| c0large | 4 | None/None | None | 15 | 47986 | 479737 | True | True | True | True | 8/8 | 381.7 |
| c0w | 1 | FAILED/NOT_ESTABLISHED | 1 | 1 | 855 | 855 | False | True | True | False | 0/8 | 0.6 |
| c0large | 1 | None/None | None | 8 | 47828 | 204290 | True | True | True | True | 8/8 | 336.1 |
| c0large | 3 | None/None | None | 8 | 47847 | 204287 | True | True | True | True | 8/8 | 324.8 |
| c2w | 1 | None/None | None | 53 | 27210 | 722606 | True | True | True | True | 8/8 | 1056.0 |
| c2w | 2 | None/None | None | 47 | 27274 | 647870 | True | True | True | True | 8/8 | 903.2 |

c0w: full success 0/4; mean peak est ctx 4181; mean cumulative est ctx 7183; mean requests 2.5; mean duration 40s
c2w: full success 4/4; mean peak est ctx 27249; mean cumulative est ctx 677430; mean requests 50.0; mean duration 960s
c0large: full success 4/4; mean peak est ctx 47924; mean cumulative est ctx 349055; mean requests 11.8; mean duration 351s
