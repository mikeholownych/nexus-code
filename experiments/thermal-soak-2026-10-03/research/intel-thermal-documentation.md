# Intel Arc Pro B65: what is (and is not) published about thermal limits

Retrieved 2026-10-03. Purpose: external evidence before turning measurements into monitoring/abort policy.

| Source | What it says about temperature / power |
|---|---|
| Intel ARK, Arc Pro B65 (https://www.intel.com/content/www/us/en/products/sku/245796/intel-arc-pro-b65-graphics/specifications.html) | The only thermal-related field is **TBP 200 W**. No operating, junction, case or memory temperature. |
| Intel B65 datasheet v1.0, 3 pages (https://www.intel.com/content/dam/www/central-libraries/us/en/documents/2026-03/datasheet-b65-gpu.pdf; sha256 `6633476cf6ceb6e8ef65...`) | Text extracted with pypdf and read in full: "200W Total Board Power"; no temperature limit, no throttle point, no cooling requirement. |
| Intel Arc Pro B-series quick reference guide v1.0 (2 pages) | No thermal content (0 matching lines). |
| Intel Arc Pro B60 GPU Management on Intel Xeon, doc 860316 v1.4 (39 pages; B60, not B65) | GPU **core** and **memory** temperature are reported separately; a management policy can throttle at a user-set temperature threshold. No default limits. Example readings only (21 C / 22 C). |
| Intel support article 000094044, "Overheating and Thermal Issues on Intel Arc Graphics" (gaming, A-series) | Reports users observing GPU and VRAM temperatures "over 90 Celsius"; states no threshold, no throttle behaviour. Advice is chassis airflow. |
| ASRock Arc Pro B65 Creator 32GB specification table (our boards are ASRock, PCI subsystem 1849:6027) | Dimensions, power connector, memory, clocks. No temperature, thermal solution, TBP or ambient range. |
| Linux kernel ABI `Documentation/ABI/testing/sysfs-driver-intel-xe-hwmon` (read via a summarising fetch tool, not the raw text) | `tempN_emergency`: "shutdown temperature". `tempN_crit`: "critical temperature" (function not stated). `temp2_max`: "package maximum temperature limit" (function not stated). `power1_cap`: "card burst (PL2) power limit". `power1_max` is the PL1 sustained limit (not exposed on this host). |

## Conclusion

Intel and the board vendor publish **no thermal limit, junction limit, memory-temperature limit or throttle point** for the B65. This is recorded as **unresolved publicly**; no number is derived from it.

The only authoritative figures are the **device-reported protection values** read from this host (and defined, in part, by the kernel ABI above):

| Sensor | critical | emergency (shutdown) | `max` |
|---|---|---|---|
| package | 100 C | 125 C | 60 C (meaning unexplained: the package ran at 66-70 C with no thermal throttle flag) |
| VRAM and every VRAM channel | 105 C | 120 C | not exposed |
| memory controller, PCIe | 100 C | 125 C | not exposed |

Confirmed on this host: card power cap (PL2) 200 W on both GPUs, equal to Intel's TBP.
