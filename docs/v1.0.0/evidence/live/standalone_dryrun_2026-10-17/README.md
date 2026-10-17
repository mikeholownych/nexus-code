# Standalone dry run through the gateway (2026-10-17)

A procedure check before release-candidate qualification (DEC-16, ACCEPTANCE §4.2). It is not qualification evidence.

| Item | Value |
|---|---|
| Build | `a2abdf7` (clean snapshot) |
| Config | `standalone-llamacpp.json`: `serverProfile: "llamacpp"`, model `engineering/b0`, 1 run |
| Task | `t2-bugfix-csv` (development task, tuned in the pilot) |
| Result | COMPLETED / **VERIFIED**; hidden tests pass; regression suite passes; 10 steps; 83 s; 76,134 tokens (client estimates: the stripped endpoint offers no counting) |
| Proxy | 14 requests, 10 chat requests, 0 upstream failures, no faults injected |

What this shows: real gateway inference reached Nexus through a plain, llama.cpp-shaped endpoint (no gateway limits,
`/tokenize` or `X-AIHost-*` headers), and the run completed truthfully.

**Gap found.** Nexus reported `context 65536 (operator)`, because `eval/run.mjs` always passes `--context-limit` (from
`config.limits`, which defaults to 65536). In profile runs the discovered context (`/props` here) is therefore never
the source, while ACCEPTANCE §4.2 requires it to be. A boundary request has been logged for the owner of
`eval/run.mjs`. `discovery supported` confirms that the `/props` probe itself answered.
