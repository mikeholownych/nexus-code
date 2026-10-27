# RC10 synthetic Detail overlay capture

Candidate: installed `v1.0.0-rc.10`, source `16ee8ca3643824741b6da67936b41f262414fdf0`, Linux x86_64 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`. The probe used `TERM=dumb`, 40×14, an isolated HOME/XDG tree, a disposable Git workspace, and a localhost synthetic gateway.

After a deliberately approved `echo synthetic-safe` tool call completed, `Tab`, `]`, and `Enter` opened the `Tool call` Detail overlay. The captured screen includes the command, succeeded status, arguments, and output. Esc closed the panel and returned focus to the transcript. The driver then timed out waiting for its overly specific `enter send` prompt; the panel was visibly closed, so that final predicate timeout is a harness limitation, not a product failure.

Together with `captured-8-of-9/overlay_dumb40.screens.txt`, this supplies observations for all nine source Overlay variants at the same terminal and size across two synthetic runs. It does not establish full accessibility acceptance: other terminal configurations and human matrix cells remain outstanding, and the earlier full-matrix cancellation timeouts are retained.
